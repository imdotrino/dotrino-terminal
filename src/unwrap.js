/**
 * «Copiar sin saltos»: deshace los saltos de línea que mete quien ajusta el texto al ancho de la
 * pantalla (Claude Code y otras TUI parten las líneas largas con saltos de verdad y una sangría,
 * así que un enlace copiado sale roto). La regla es la misma en el escritorio, Android e iOS, y
 * la prueban los mismos casos (`test/unwrap.vectors.json`).
 *
 * Una línea cuenta como ajustada si no está en blanco, mide al menos MIN_WRAP caracteres, no es
 * un fin de frase seguido de mayúscula (salvo dentro de un enlace) y (a) llega a menos de MARGIN
 * del ancho de la línea más larga, o (b) la siguiente empieza en minúscula. Si el corte cae
 * dentro de un enlace o de una palabra de LONG_TOKEN caracteres o más (un hash, una clave), se
 * pega sin espacio; si no, con un espacio. Las líneas que no se juntan conservan su sangría
 * menos la común.
 *
 * Y dentro de un enlace se quita todo hueco de dos o más espacios seguido de algo que puede ir en
 * un enlace: es la sangría de la fila siguiente cuando el terminal juntó las filas al copiar (sin
 * salto, pero con los espacios). Un espacio solo no se toca: ahí acaba el enlace.
 */
const MIN_WRAP = 40
const MARGIN = 15
const LONG_TOKEN = 30
const URL = /https?:\/\/|www\./
const END = /[.:;!?]$/

const URL_CHAR = /[A-Za-z0-9%&=?\/._~:+#@!$'()*,;[\]-]/

/** Quita los huecos de 2+ espacios que caen dentro de un enlace. */
function closeUrlGaps (s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    const m = s.slice(i).match(URL)
    if (!m) { out += s.slice(i); break }
    const start = i + m.index
    out += s.slice(i, start)
    let j = start
    for (;;) {
      while (j < s.length && s[j] !== ' ' && s[j] !== '\n' && s[j] !== '\t') out += s[j++]
      let k = j
      while (k < s.length && s[k] === ' ') k++
      if (k - j >= 2 && k < s.length && URL_CHAR.test(s[k])) { j = k; continue }
      break
    }
    i = j
  }
  return out
}

const len = (s) => [...s].length
const indent = (s) => s.length - s.trimStart().length
const lastToken = (s) => { const t = s.split(/\s+/).filter(Boolean); return t.length ? t[t.length - 1] : '' }
const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase()
const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase()

export function unwrap (text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd())
  if (lines.length < 2) return closeUrlGaps(text.trim())
  const width = Math.max(...lines.map(len))
  const rest = lines.slice(1).filter((l) => l !== '')
  const common = rest.length ? Math.min(...rest.map(indent)) : 0
  let out = lines[0].trimStart()
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]
    const cur = lines[i].trim()
    if (cur === '') { out += '\n'; continue }
    const n = len(prev)
    const last = lastToken(out)
    const inUrl = URL.test(last)
    const sentence = !inUrl && END.test(prev) && isUpper(cur[0])
    const wrapped = prev !== '' && n >= MIN_WRAP && !sentence && (n >= width - MARGIN || isLower(cur[0]))
    if (!wrapped) out += '\n' + lines[i].slice(Math.min(common, indent(lines[i])))
    else if (inUrl || len(last) >= LONG_TOKEN) out += cur
    else out += ' ' + cur
  }
  return closeUrlGaps(out.trim())
}
