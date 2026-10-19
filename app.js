import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const SCENE_URL = "assets/scene.json";

const stage = document.getElementById("stage");
const loader = document.getElementById("loader");
const loaderFill = document.getElementById("loader-fill");
const loaderText = document.getElementById("loader-text");
const hint = document.getElementById("hint");
const resetBtn = document.getElementById("reset");

function fail(message) {
  loader.classList.add("error");
  loaderFill.style.width = "0";
  loaderText.textContent = message;
}

function hasWebGL2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

// --- SOG sin empaquetar -------------------------------------------------------------
// Spark lee SOG empaquetado en ZIP (.sog). Algunos alojamientos solo sirven tipos web
// estándar, así que el modelo puede publicarse como meta.json + WebP y aquí se descarga
// archivo por archivo y se arma en memoria un ZIP sin compresión con la misma estructura.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function storeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function loadSogAsZip(metaUrl, onProgress) {
  const base = metaUrl.slice(0, metaUrl.lastIndexOf("/") + 1);
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`${metaUrl}: HTTP ${metaRes.status}`);
  const metaBytes = new Uint8Array(await metaRes.arrayBuffer());
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  const names = [...new Set(Object.values(meta).flatMap((v) => (v && Array.isArray(v.files) ? v.files : [])))];
  const loaded = new Array(names.length).fill(0);
  const totals = new Array(names.length).fill(0);
  const report = () => onProgress(loaded.reduce((a, b) => a + b, 0), totals.reduce((a, b) => a + b, 0));
  const files = await Promise.all(
    names.map(async (name, i) => {
      const res = await fetch(base + name);
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      totals[i] = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded[i] += value.length;
        report();
      }
      const bytes = new Uint8Array(loaded[i]);
      let o = 0;
      for (const c of chunks) {
        bytes.set(c, o);
        o += c.length;
      }
      return [name, bytes];
    }),
  );
  return storeZip([["meta.json", metaBytes], ...files]);
}

async function main() {
  if (!hasWebGL2()) {
    fail("Este navegador no admite WebGL 2, necesario para mostrar el modelo.");
    return;
  }
  if (location.protocol === "file:") {
    fail("Abre la página desde un servidor web (consulta LEEME.md).");
    return;
  }

  const cfg = await fetch(SCENE_URL).then((r) => {
    if (!r.ok) throw new Error(`${SCENE_URL}: HTTP ${r.status}`);
    return r.json();
  });

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.fov ?? 40, stage.clientWidth / stage.clientHeight, 0.01, 100);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const home = {
    position: new THREE.Vector3(...cfg.camera.position),
    target: new THREE.Vector3(...cfg.camera.target),
  };
  const homeDir = home.position.clone().sub(home.target).normalize();

  // Distancia mínima para que la caja del modelo quepa en pantalla con un margen,
  // tanto en horizontal como en vertical (en un móvil vertical manda el ancho).
  const corners = [];
  if (cfg.bounds) {
    const [a, b] = [cfg.bounds.min, cfg.bounds.max];
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) corners.push(new THREE.Vector3(x, y, z));
  }
  function fitHome() {
    if (!corners.length) return;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (cfg.fitMargin ?? 0.86);
    const tanH = tanV * camera.aspect;
    const probe = new THREE.PerspectiveCamera();
    const fits = (r) => {
      probe.position.copy(home.target).addScaledVector(homeDir, r);
      probe.lookAt(home.target);
      probe.updateMatrixWorld();
      const inv = probe.matrixWorldInverse;
      return corners.every((c) => {
        const p = c.clone().applyMatrix4(inv);
        const depth = -p.z;
        return depth > 0 && Math.abs(p.x) <= tanH * depth && Math.abs(p.y) <= tanV * depth;
      });
    };
    let lo = 0.2, hi = 20;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    home.position.copy(home.target).addScaledVector(homeDir, hi);
  }
  fitHome();
  camera.position.copy(home.position);
  let interacted = false;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(home.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.minDistance = cfg.minDistance ?? 0.2;
  controls.maxDistance = cfg.maxDistance ?? 10;
  // Límites de órbita: la parte trasera y la inferior del cofre no aparecen en el video.
  // Se pueden quitar poniendo null en assets/scene.json.
  const deg = THREE.MathUtils.degToRad;
  if (Array.isArray(cfg.azimuthLimitDeg)) {
    controls.minAzimuthAngle = deg(cfg.azimuthLimitDeg[0]);
    controls.maxAzimuthAngle = deg(cfg.azimuthLimitDeg[1]);
  }
  if (Array.isArray(cfg.polarLimitDeg)) {
    controls.minPolarAngle = deg(cfg.polarLimitDeg[0]);
    controls.maxPolarAngle = deg(cfg.polarLimitDeg[1]);
  }
  controls.update();

  const showProgress = (loaded, total) => {
    if (total > 0) {
      const p = Math.min(100, Math.round((100 * loaded) / total));
      loaderFill.style.width = `${p}%`;
      loaderText.textContent = `Cargando modelo… ${p}%`;
    }
  };
  // Formatos: un único archivo (.spz, .ply…) o SOG sin empaquetar (meta.json + imágenes WebP).
  const source = /meta\.json$/i.test(cfg.model)
    ? { fileBytes: await loadSogAsZip(cfg.model, showProgress), fileType: "pcsogszip" }
    : { url: cfg.model, onProgress: (e) => e.lengthComputable && showProgress(e.loaded, e.total) };
  const splat = new SplatMesh(source);
  scene.add(splat);
  await splat.initialized;

  loaderFill.style.width = "100%";
  loader.classList.add("done");
  resetBtn.hidden = false;
  const touch = window.matchMedia("(pointer: coarse)").matches;
  hint.textContent = touch
    ? "Un dedo: girar · Pellizco: acercar · Dos dedos: desplazar"
    : "Arrastrar: girar · Rueda: acercar · Clic derecho: desplazar · Doble clic: centrar";
  hint.hidden = false;
  const hideHint = () => hint.classList.add("fade");
  setTimeout(hideHint, 6000);
  controls.addEventListener("start", hideHint, { once: true });

  // Restablecer la vista inicial con una transición suave.
  let tween = null;
  function flyTo(position, target, ms = 650) {
    tween = {
      t0: performance.now(),
      ms,
      fromP: camera.position.clone(),
      fromT: controls.target.clone(),
      toP: position.clone(),
      toT: target.clone(),
    };
  }
  const resetView = () => flyTo(home.position, home.target);
  // Acceso para inspección desde la consola del navegador.
  window.visor = { camera, controls, splat, flyTo, resetView };
  resetBtn.addEventListener("click", resetView);
  window.addEventListener("keydown", (e) => {
    if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) resetView();
  });
  controls.addEventListener("start", () => {
    tween = null;
    interacted = true;
  });

  // Doble clic / doble toque: centra la órbita en el punto del cofre señalado.
  const raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener("dblclick", (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    let hit = null;
    try {
      hit = raycaster.intersectObject(splat, false)[0];
    } catch {
      hit = null;
    }
    if (!hit) return;
    const offset = camera.position.clone().sub(controls.target);
    flyTo(hit.point.clone().add(offset), hit.point, 450);
  });

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    fitHome();
    if (!interacted && !tween) camera.position.copy(home.position);
  }
  window.addEventListener("resize", resize);

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  renderer.setAnimationLoop(() => {
    if (tween) {
      const t = Math.min(1, (performance.now() - tween.t0) / tween.ms);
      const k = ease(t);
      camera.position.lerpVectors(tween.fromP, tween.toP, k);
      controls.target.lerpVectors(tween.fromT, tween.toT, k);
      if (t >= 1) tween = null;
    }
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((err) => {
  console.error(err);
  fail("No se pudo cargar el modelo. Revisa la consola del navegador.");
});
