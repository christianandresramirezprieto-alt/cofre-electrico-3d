// Servidor estático mínimo (sin dependencias) para probar el visor en local.
// Uso: node server.mjs [puerto]   ->   http://localhost:8080
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".spz": "application/octet-stream",
  ".glb": "model/gltf-binary",
};
const compressible = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);
const blocked = ["node_modules", "scripts", "server.mjs", "package.json", "package-lock.json"];

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  const rel = file.slice(root.length);
  if (!file.startsWith(root) || blocked.some((b) => rel === b || rel.startsWith(b + sep))) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = statSync(file);
    if (!st.isFile()) throw new Error();
  } catch {
    res.writeHead(404).end("No encontrado");
    return;
  }
  const ext = extname(file).toLowerCase();
  const headers = { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" };
  if (compressible.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.writeHead(200, { ...headers, "Content-Encoding": "gzip" });
    createReadStream(file).pipe(createGzip()).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    createReadStream(file).pipe(res);
  }
}).listen(port, () => console.log(`Visor disponible en http://localhost:${port}`));
