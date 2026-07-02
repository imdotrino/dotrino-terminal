import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

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

// base './' → rutas relativas, para servir bajo terminal.dotrino.com. Los assets
// PWA viven en public/ y se copian tal cual a la raíz de dist/.
export default defineConfig({
  base: './',
  plugins: [commitMeta()],
  server: { port: 3400, host: true }
})
