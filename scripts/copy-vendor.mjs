// Copia a web/vendor/ solo los archivos de three.js y Spark que usa el visor,
// para que la página funcione sin CDN ni node_modules en el servidor.
// Uso: npm install && npm run vendor
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(web, "node_modules");
const files = [
  ["three/build/three.module.js", "vendor/three/three.module.js"],
  ["three/build/three.core.js", "vendor/three/three.core.js"],
  ["three/examples/jsm/controls/OrbitControls.js", "vendor/three/addons/controls/OrbitControls.js"],
  ["three/examples/jsm/postprocessing/Pass.js", "vendor/three/addons/postprocessing/Pass.js"],
  ["three/LICENSE", "vendor/three/LICENSE"],
  ["@sparkjsdev/spark/dist/spark.module.min.js", "vendor/spark/spark.module.min.js"],
  ["@sparkjsdev/spark/LICENSE", "vendor/spark/LICENSE"],
];
for (const [src, dst] of files) {
  mkdirSync(dirname(join(web, dst)), { recursive: true });
  cpSync(join(nm, src), join(web, dst));
  console.log(`${src} -> ${dst}`);
}
