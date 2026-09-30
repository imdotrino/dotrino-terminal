import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'

// Inyecta <meta name="commit"> con el hash del build (§3): permite verificar qué
// versión sirve el dominio y diagnosticar cachés viejas de SW/CDN.
function commitMeta () {
  let hash = 'dev'
  try { hash = execSync('git rev-parse --short HEAD').toString().trim() } catch {}
  return {
    name: 'commit-meta',
    transformIndexHtml (html) {
      return html.replace('</head>', `  <meta name="commit" content="${hash}" />\n</head>`)
    }
  }
}

// GitHub Pages no sabe de rutas de una SPA (patrón de dotrino-vault/web): una carpeta por
// ruta con la misma app, y `404.html` como red de seguridad para cualquier otra.
//  · `/`          la portada (informativa, §5.1): qué es, descargar, cómo instalar.
//  · `/consoles`  las consolas (administrativa). La PWA instalada abre aquí.
function spaRoutes () {
  return {
    name: 'spa-routes',
    closeBundle () {
      copyFileSync('dist/index.html', 'dist/404.html')
      mkdirSync('dist/consoles', { recursive: true })
      copyFileSync('dist/index.html', 'dist/consoles/index.html')
    }
  }
}

// base '/' → rutas absolutas: la misma página se sirve en `/` y en `/consoles/`. Los assets
// PWA viven en public/ y se copian tal cual a la raíz de dist/.
export default defineConfig({
  base: '/',
  plugins: [commitMeta(), spaRoutes()],
  // @dotrino/vault declara @dotrino/identity y @dotrino/proxy-client como peerDeps:
  // deduplicar para que use LA copia de esta app (una sola instancia; y no arrastre
  // otra versión por el symlink `file:` en desarrollo).
  resolve: { dedupe: ['@dotrino/identity', '@dotrino/proxy-client'] },
  server: { port: 3400, host: true }
})
