# Visor web del cofre eléctrico

**Ver en línea:** https://christianandresramirezprieto-alt.github.io/cofre-electrico-3d/

Página estática (HTML + JavaScript) que muestra el modelo 3D del cofre como Gaussian Splats
con [Three.js](https://threejs.org) 0.186.1 y [Spark](https://sparkjs.dev) 2.3.1. No requiere
instalar nada en el equipo de quien la visita: basta un navegador moderno con WebGL 2
(Chrome, Edge, Firefox o Safari recientes, en escritorio o móvil).

## Contenido

```
web/
├── index.html            página
├── app.js                visor: carga, controles de cámara, restablecer vista
├── style.css             estilos (fondo neutro, modo claro/oscuro, móvil)
├── og.jpg                imagen de vista previa al compartir el enlace (1200 × 630)
├── assets/
│   ├── cofre.spz         modelo 3D (Gaussian Splats comprimidos, formato SPZ)
│   └── scene.json        vista inicial y límites de la cámara
├── vendor/               three.js y Spark copiados de npm (sin CDN)
├── server.mjs            servidor estático mínimo para pruebas locales (Node.js, sin dependencias)
├── package.json          versiones exactas de three y Spark
└── scripts/copy-vendor.mjs  vuelve a copiar vendor/ desde node_modules
```

## Ejecutar en local

La página debe servirse por HTTP: abrir `index.html` con doble clic (`file://`) no funciona,
porque el navegador bloquea la carga del modelo.

Con Node.js (18 o posterior), desde la carpeta `web/`:

```bash
node server.mjs 8080
```

O con Python 3:

```bash
python -m http.server 8080
```

Después se abre `http://localhost:8080` en el navegador.

## Controles

| Acción | Ratón | Pantalla táctil |
|---|---|---|
| Girar | arrastrar con el botón izquierdo | un dedo |
| Acercar / alejar | rueda | pellizcar |
| Desplazar | arrastrar con el botón derecho | dos dedos |
| Centrar en un punto | doble clic sobre el cofre | doble toque |
| Restablecer la vista | botón ↺ o tecla R | botón ↺ |

El giro horizontal está limitado a la zona que cubrió el video (de −110° a +72° respecto
al frente): la cara trasera, pegada a la pared, y la cara inferior nunca se filmaron. Para
quitar el límite, sustituye `azimuthLimitDeg` y `polarLimitDeg` por `null` en
`assets/scene.json`.

## Publicar en Internet

La carpeta `web/` es un sitio estático: se puede subir tal cual a cualquier alojamiento de
archivos estáticos. Hay que subir `index.html`, `app.js`, `style.css`, `assets/` y `vendor/`;
`node_modules/`, `server.mjs` y `scripts/` no hacen falta.

- **GitHub Pages:** crear un repositorio, subir el contenido de `web/` y activar
  *Settings → Pages → Deploy from a branch*. La URL será `https://<usuario>.github.io/<repo>/`.
- **Netlify / Cloudflare Pages / Vercel:** arrastrar la carpeta `web/` al panel de despliegue
  (Netlify Drop) o conectar el repositorio sin paso de compilación.
- **Servidor propio (Nginx, Apache, IIS):** copiar la carpeta al directorio público. Conviene
  activar la compresión gzip o brotli para `.js`; el `.spz` ya está comprimido.

Si publicas en otra dirección, cambia en `index.html` las URL absolutas de `og:url`, `og:image` y
`twitter:image`: las aplicaciones de mensajería necesitan la dirección completa de la imagen.

No hay que configurar cabeceras especiales. Si el sitio se publica en un subdirectorio,
todas las rutas son relativas y siguen funcionando.

Si el alojamiento no sirve archivos `.spz`, publica el modelo como SOG sin empaquetar
(`meta.json` + imágenes WebP) y cambia `"model"` en `assets/scene.json` a la ruta de ese
`meta.json`; el visor detecta el formato por el nombre. Para convertirlo:

```bash
npx @playcanvas/splat-transform@3.10.1 ../modelo/cofre_limpio.ply -H 1 assets/sog/meta.json
```

## Actualizar dependencias

```bash
npm install
npm run vendor
```
