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
 */
const MIN_WRAP = 40
const MARGIN = 15
const LONG_TOKEN = 30
const URL = /https?:\/\/|www\./
const END = /[.:;!?]$/

const len = (s) => [...s].length
const indent = (s) => s.length - s.trimStart().length
const lastToken = (s) => { const t = s.split(/\s+/).filter(Boolean); return t.length ? t[t.length - 1] : '' }
const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase()
const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase()

export function unwrap (text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd())
  if (lines.length < 2) return text.trim()
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
  return out.trim()
}
