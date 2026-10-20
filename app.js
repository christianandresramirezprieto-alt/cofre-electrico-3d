import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

const SCENE_URL = "assets/scene.json";
const HOTSPOTS_URL = "assets/hotspots.json";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const loader = $("loader");
const loaderFill = $("loader-fill");
const loaderText = $("loader-text");
const hint = $("hint");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

let toastTimer = 0;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2400);
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

  const [cfg, hotspotData] = await Promise.all([
    fetchJSON(SCENE_URL),
    fetchJSON(HOTSPOTS_URL).catch(() => ({ puntos: [] })),
  ]);

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.fov ?? 40, stage.clientWidth / stage.clientHeight, 0.01, 100);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  // ---------- Encuadre ----------
  const deg = THREE.MathUtils.degToRad;
  const dirFromAzEl = (az, el) =>
    new THREE.Vector3(Math.cos(deg(el)) * Math.sin(deg(az)), Math.sin(deg(el)), Math.cos(deg(el)) * Math.cos(deg(az)));
  const center = new THREE.Vector3(...cfg.camera.target);
  const homeDir = new THREE.Vector3(...cfg.camera.position).sub(center).normalize();
  const VIEW_DIRS = {
    home: homeDir,
    front: dirFromAzEl(0, 8),
    left: dirFromAzEl(-90, 10),
    right: dirFromAzEl(70, 10),
    top: dirFromAzEl(0, 89),
  };
  const VIEW_KEYS = ["home", "front", "left", "right", "top"];

  // Distancia mínima para que la caja del modelo quepa en pantalla con un margen, en
  // horizontal y en vertical (en un móvil vertical manda el ancho).
  const corners = [];
  if (cfg.bounds) {
    const [a, b] = [cfg.bounds.min, cfg.bounds.max];
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) corners.push(new THREE.Vector3(x, y, z));
  }
  const probe = new THREE.PerspectiveCamera();
  function fitDistance(dir, target) {
    if (!corners.length) return 2;
    const tanV = Math.tan(deg(camera.fov) / 2) * (cfg.fitMargin ?? 0.9);
    const tanH = tanV * camera.aspect;
    const fits = (r) => {
      probe.position.copy(target).addScaledVector(dir, r);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      return corners.every((c) => {
        const p = c.clone().applyMatrix4(probe.matrixWorldInverse);
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
    return hi;
  }
  const viewPose = (name) => {
    const dir = VIEW_DIRS[name];
    return { pos: center.clone().addScaledVector(dir, fitDistance(dir, center)), target: center.clone() };
  };
  let home = viewPose("home");
  camera.position.copy(home.pos);

  // ---------- Controles de órbita ----------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
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
  const azLimits = Array.isArray(cfg.azimuthLimitDeg) ? cfg.azimuthLimitDeg.map(deg) : null;
  if (azLimits) [controls.minAzimuthAngle, controls.maxAzimuthAngle] = azLimits;
  if (Array.isArray(cfg.polarLimitDeg)) [controls.minPolarAngle, controls.maxPolarAngle] = cfg.polarLimitDeg.map(deg);
  controls.update();

  // ---------- Modelo ----------
  const showProgress = (loaded, total) => {
    if (total > 0) {
      const p = Math.min(100, Math.round((100 * loaded) / total));
      loaderFill.style.width = `${p}%`;
      loaderText.textContent = `Cargando modelo… ${p} %`;
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
  const count = splat.packedSplats?.numSplats;
  if (count) $("stat-splats").textContent = count.toLocaleString("es-CO");

  // ---------- Transiciones de cámara ----------
  let tween = null;
  let interacted = false;
  function flyTo(position, target, ms = 750) {
    tween = {
      t0: performance.now(),
      ms: reduceMotion ? 1 : ms,
      fromP: camera.position.clone(),
      fromT: controls.target.clone(),
      toP: position.clone(),
      toT: target.clone(),
    };
  }

  const viewButtons = [...document.querySelectorAll("[data-view]")];
  function markView(name) {
    for (const b of viewButtons) b.setAttribute("aria-pressed", String(b.dataset.view === name));
  }
  function setView(name) {
    const p = name === "home" ? home : viewPose(name);
    closeCard();
    setOrbit(false);
    flyTo(p.pos, p.target, 850);
    markView(name);
  }
  const resetView = () => setView("home");
  for (const b of viewButtons) b.addEventListener("click", () => setView(b.dataset.view));
  $("btn-reset").addEventListener("click", resetView);

  // ---------- Giro automático (vaivén dentro de la zona filmada) ----------
  let orbiting = false;
  let orbitPhase = 0;
  const btnOrbit = $("btn-orbit");
  const sph = new THREE.Spherical();
  const azRange = azLimits ? { mid: (azLimits[0] + azLimits[1]) / 2, amp: (azLimits[1] - azLimits[0]) / 2 - deg(6) } : null;
  function setOrbit(on) {
    orbiting = on;
    btnOrbit.setAttribute("aria-pressed", String(on));
    if (on) {
      tween = null;
      sph.setFromVector3(camera.position.clone().sub(controls.target));
      if (azRange) orbitPhase = Math.asin(THREE.MathUtils.clamp((sph.theta - azRange.mid) / azRange.amp, -1, 1));
      markView(null);
    }
  }
  btnOrbit.addEventListener("click", () => setOrbit(!orbiting));

  // ---------- Puntos de interés ----------
  const markersEl = $("markers");
  const card = $("card");
  const pad = (n) => String(n).padStart(2, "0");
  const points = (hotspotData.puntos || []).map((p, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "marker hidden";
    el.setAttribute("aria-label", `Punto ${i + 1}: ${p.titulo}`);
    el.innerHTML = `<span class="dot">${i + 1}</span><span class="label"></span>`;
    el.querySelector(".label").textContent = p.titulo;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      select(i);
    });
    markersEl.appendChild(el);
    return { ...p, el, v: new THREE.Vector3(...p.pos), n: new THREE.Vector3(...p.normal).normalize() };
  });
  let active = -1;
  function select(i) {
    if (!points.length) return;
    active = (i + points.length) % points.length;
    const p = points[active];
    points.forEach((q, k) => q.el.classList.toggle("active", k === active));
    $("card-idx").textContent = `${pad(active + 1)} / ${pad(points.length)}`;
    $("card-title").textContent = p.titulo;
    $("card-text").textContent = p.texto;
    card.hidden = false;
    setDrawer(false);
    setOrbit(false);
    markView(null);
    const dir = dirFromAzEl(p.vista.az, p.vista.el);
    flyTo(p.v.clone().addScaledVector(dir, p.vista.dist), p.v, 950);
  }
  function closeCard() {
    if (active < 0 && card.hidden) return;
    active = -1;
    card.hidden = true;
    points.forEach((q) => q.el.classList.remove("active"));
  }
  $("card-close").addEventListener("click", closeCard);
  $("card-prev").addEventListener("click", () => select(active - 1));
  $("card-next").addEventListener("click", () => select(active + 1));

  let pointsOn = true;
  const btnPoints = $("btn-points");
  function setPoints(on) {
    pointsOn = on;
    document.body.classList.toggle("no-points", !on);
    btnPoints.setAttribute("aria-pressed", String(on));
    if (!on) closeCard();
  }
  btnPoints.addEventListener("click", () => setPoints(!pointsOn));
  if (!points.length) btnPoints.hidden = true;

  const camDir = new THREE.Vector3();
  const proj = new THREE.Vector3();
  function updateMarkers() {
    if (!pointsOn) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    for (const p of points) {
      camDir.copy(camera.position).sub(p.v).normalize();
      const facing = p.n.dot(camDir);
      proj.copy(p.v).project(camera);
      const onScreen = proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05;
      const visible = onScreen && facing > 0.08;
      p.el.classList.toggle("hidden", !visible);
      if (!visible) continue;
      p.el.style.opacity = String(Math.min(1, (facing - 0.08) / 0.25));
      p.el.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px)`;
    }
  }

  // ---------- Panel de información ----------
  const drawer = $("drawer");
  const btnInfo = $("btn-info");
  function setDrawer(open) {
    drawer.hidden = !open;
    btnInfo.setAttribute("aria-expanded", String(open));
    if (open) closeCard();
  }
  btnInfo.addEventListener("click", () => setDrawer(drawer.hidden));
  $("drawer-close").addEventListener("click", () => setDrawer(false));

  // ---------- Pantalla completa ----------
  const btnFull = $("btn-full");
  const fullEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  if (!fullEnabled) btnFull.hidden = true;
  function toggleFull() {
    const el = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      Promise.resolve(req && req.call(el)).catch(() => toast("La pantalla completa no está disponible aquí"));
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  }
  function onFullChange() {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btnFull.querySelector("use").setAttribute("href", on ? "#i-shrink" : "#i-expand");
    btnFull.setAttribute("aria-label", on ? "Salir de pantalla completa" : "Pantalla completa");
    btnFull.dataset.tip = on ? "Salir de pantalla completa · F" : "Pantalla completa · F";
  }
  document.addEventListener("fullscreenchange", onFullChange);
  document.addEventListener("webkitfullscreenchange", onFullChange);
  btnFull.addEventListener("click", toggleFull);

  // ---------- Captura ----------
  function capture() {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const g = ctx.createRadialGradient(out.width / 2, out.height * 0.38, 0, out.width / 2, out.height * 0.38, Math.max(out.width, out.height) * 0.75);
    g.addColorStop(0, css.getPropertyValue("--bg-1").trim() || "#f1f0ec");
    g.addColorStop(1, css.getPropertyValue("--bg-2").trim() || "#d9d8d2");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    out.toBlob((blob) => {
      if (!blob) {
        toast("No se pudo crear la imagen");
        return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "cofre-electrico-3d.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Imagen guardada");
    }, "image/png");
  }
  $("btn-capture").addEventListener("click", capture);

  // ---------- Ocultar interfaz ----------
  const showUi = $("show-ui");
  function setUiHidden(hide) {
    document.body.classList.toggle("ui-hidden", hide);
    showUi.hidden = !hide;
    if (hide) hint.classList.add("fade");
  }
  $("btn-hide").addEventListener("click", () => setUiHidden(true));
  showUi.addEventListener("click", () => setUiHidden(false));

  // ---------- Ayuda inicial ----------
  const touch = window.matchMedia("(pointer: coarse)").matches;
  hint.textContent = touch
    ? "Arrastra para girar · Pellizca para acercar · Toca un punto amarillo"
    : "Arrastra para girar · Rueda para acercar · Pulsa un punto amarillo para ver su ficha";
  hint.hidden = false;
  const hideHint = () => hint.classList.add("fade");
  setTimeout(hideHint, 7000);
  controls.addEventListener("start", hideHint, { once: true });

  controls.addEventListener("start", () => {
    tween = null;
    interacted = true;
    setOrbit(false);
    markView(null);
  });

  // ---------- Teclado ----------
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= "5") setView(VIEW_KEYS[Number(k) - 1]);
    else if (k === "r") resetView();
    else if (k === "p") setPoints(!pointsOn);
    else if (k === "a") setOrbit(!orbiting);
    else if (k === "f") toggleFull();
    else if (k === "h") setUiHidden(!document.body.classList.contains("ui-hidden"));
    else if (k === "i") setDrawer(drawer.hidden);
    else if (k === "c") capture();
    else if (e.key === "ArrowRight" && pointsOn) select(active + 1);
    else if (e.key === "ArrowLeft" && pointsOn) select(active < 0 ? -1 : active - 1);
    else if (e.key === "Escape") {
      if (!card.hidden) closeCard();
      else if (!drawer.hidden) setDrawer(false);
      else if (document.body.classList.contains("ui-hidden")) setUiHidden(false);
    } else return;
    e.preventDefault();
  });

  // ---------- Doble clic / doble toque: centrar la órbita en el punto señalado ----------
  const raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener("dblclick", (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
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
    markView(null);
  });

  // ---------- Tamaño de ventana ----------
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    home = viewPose("home");
    if (!interacted && !tween) camera.position.copy(home.pos);
  }
  window.addEventListener("resize", resize);

  // Acceso para inspección desde la consola del navegador.
  window.visor = { camera, controls, splat, flyTo, setView, resetView, select, capture };

  // ---------- Bucle de dibujo ----------
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.ms);
      const k = ease(t);
      camera.position.lerpVectors(tween.fromP, tween.toP, k);
      controls.target.lerpVectors(tween.fromT, tween.toT, k);
      if (t >= 1) tween = null;
    } else if (orbiting) {
      sph.setFromVector3(camera.position.clone().sub(controls.target));
      if (azRange) {
        orbitPhase += dt * 0.22;
        sph.theta = azRange.mid + azRange.amp * Math.sin(orbitPhase);
      } else {
        sph.theta += dt * 0.25;
      }
      camera.position.setFromSpherical(sph).add(controls.target);
    }
    controls.update();
    renderer.render(scene, camera);
    updateMarkers();
  });
}

main().catch((err) => {
  console.error(err);
  fail("No se pudo cargar el modelo. Revisa la consola del navegador.");
});
