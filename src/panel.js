/**
 * panel.js — lo que el panel dice de una consola, cada cosa en SU línea: la máquina
 * (`usuario@máquina`) solo si es OTRA, la carpeta, y el título que puso el programa.
 *
 * Una shell titula «usuario@máquina: carpeta»: en su máquina le queda la carpeta, y tras un `ssh`
 * sale además a dónde entró. Un programa que se nombra solo (Claude: su sesión) muestra la carpeta
 * y su título. El mismo reparto que el escritorio, Android e iOS (`panel_lines` / `panelLines`).
 *
 * @param {string} title  el título de la consola
 * @param {string|null} [cwd]  su carpeta, si la máquina la dice (agente ≥ 0.22)
 * @param {string|null} [me]  `usuario@máquina` de la máquina de la consola (agente ≥ 0.24)
 * @returns {{ host: string|null, dir: string|null, name: string|null }}
 */
export function panelLines (title, cwd = null, me = null) {
  const m = /^([^\s:]+@[^\s:]+):\s*(.*)$/.exec((title || '').trim())
  const host = m ? m[1] : null
  const rest = (m ? m[2] : (title || '')).trim()
  // Sin carpeta de la máquina (un agente anterior, o macOS), la de una shell es lo que sigue a la máquina.
  const dir = (cwd || '').trim() || (host && rest) || null
  const name = rest && rest !== dir ? rest : null
  return { host: host && host !== me ? host : null, dir, name }
}

/**
 * A dónde va una consola que se suelta sobre otra al arrastrarla: toma el SITIO de esa. Hacia
 * arriba queda delante de ella; hacia abajo, detrás (o sea, delante de la siguiente, o al final).
 *
 * @param {string[]} ids  las consolas, en el orden del panel
 * @param {string} id  la que se arrastra
 * @param {string} over  sobre la que se suelta
 * @returns {{ before: string|null }|null}  `null`: no se mueve (la misma, o alguna ya no está)
 */
export function dropTarget (ids, id, over) {
  const from = ids.indexOf(id)
  const to = ids.indexOf(over)
  if (from < 0 || to < 0 || from === to) return null
  return { before: to < from ? over : (ids[to + 1] ?? null) }
}
