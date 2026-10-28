/**
 * links.js — los enlaces y las rutas de una línea de la consola, para abrirlos con Ctrl+clic, el
 * clic derecho o, en el teléfono, un toque.
 *
 * La MISMA regla en las cuatro versiones (web, escritorio, Android, iOS), y los mismos casos de
 * prueba (`test/links.vectors.json`): si una reconoce algo que otra no, el usuario ve dos
 * terminales distintas.
 *
 * La línea se parte en trozos por los espacios, las comillas y `<>|;()[]{}`. A cada trozo se le
 * quita la puntuación del final (`.,:;!?`) y se mira qué es:
 *   - un enlace: empieza por `http://`, `https://`, `ftp://`, `file://` o `mailto:`;
 *   - una ruta: empieza por `/`, `~/`, `./` o `../` (o va tras un `=`: `--out=/tmp/x`), y tiene
 *     al menos una letra o un número (así `//` o `/` sueltos no cuentan).
 * De una ruta, `target` quita el `:línea:columna` del final (`src/a.js:12:3`), que no es parte
 * del nombre del archivo.
 */

const SEP = /[\s'"`<>|;()[\]{}]/
const TRAIL = /[.,:;!?]+$/
const URL_START = /^(?:(?:https?|ftp|file):\/\/|mailto:)/i
const PATH_START = /^(?:\/|~\/|\.\.?\/)/

/**
 * @param {string} line
 * @returns {{ start: number, end: number, text: string, kind: 'url'|'path', target: string }[]}
 *   `start`/`end`: posiciones en `line` (`end` sin incluir).
 */
export function findLinks (line) {
  const out = []
  let i = 0
  while (i < line.length) {
    if (SEP.test(line[i])) { i++; continue }
    let j = i
    while (j < line.length && !SEP.test(line[j])) j++
    const link = classify(line.slice(i, j))
    if (link) out.push({ ...link, start: i + link.at, end: i + link.at + link.text.length })
    i = j
  }
  return out.map(({ at, ...l }) => l)
}

function classify (token) {
  const text = token.replace(TRAIL, '')
  if (URL_START.test(text)) return text.length > text.match(URL_START)[0].length ? { at: 0, text, kind: 'url', target: text } : null
  let at = 0
  if (!PATH_START.test(text)) {
    const eq = text.lastIndexOf('=')
    if (eq < 0 || !PATH_START.test(text.slice(eq + 1))) return null
    at = eq + 1
  }
  const p = text.slice(at)
  if (p.startsWith('//') || !/[\p{L}\p{N}]/u.test(p)) return null
  return { at, text: p, kind: 'path', target: p.replace(/:\d+(?::\d+)?$/, '') }
}

/** El enlace de `line` que pasa por la posición `col`, o null. */
export const linkAt = (line, col) => findLinks(line).find((l) => col >= l.start && col < l.end) || null

/** Lo que el sistema sabe abrir por su nombre: el tipo de archivo, para dárselo al navegador. */
export const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/plain', log: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', zip: 'application/zip'
}
export const mimeOf = (name) => MIME[(name.match(/\.([^./]+)$/)?.[1] || '').toLowerCase()] || 'application/octet-stream'
