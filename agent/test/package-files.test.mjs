/**
 * Lo que se publica tiene que arrancar. La 0.19.0 salió a npm sin `access.js` (faltaba en
 * `files`): las pruebas corren en el repo, donde el archivo sí está, y nada lo vio. Aquí se
 * comprueba que todo lo que importan los archivos publicados va DENTRO del paquete.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Los archivos que entran en el paquete, según `files`. */
function published () {
  const out = new Set()
  const walk = (rel) => {
    const abs = path.join(root, rel)
    if (fs.statSync(abs).isDirectory()) { for (const f of fs.readdirSync(abs)) walk(path.join(rel, f)) } else out.add(path.normalize(rel))
  }
  for (const f of pkg.files) walk(f)
  return out
}

test('todo import relativo de un archivo publicado está dentro del paquete', () => {
  const files = published()
  const missing = []
  for (const f of files) {
    if (!/\.(m?js)$/.test(f)) continue
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.normalize(path.join(path.dirname(f), m[1]))
      if (target === 'package.json') continue
      if (!files.has(target)) missing.push(`${f} → ${m[1]}`)
    }
  }
  assert.deepEqual(missing, [])
})
