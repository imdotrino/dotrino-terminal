/**
 * layout.js — el reparto de una pestaña en paneles (split, dueño 2026-10-07), sin DOM: un árbol
 * `{ pane } | { dir: 'row'|'col', ratio, a, b }` donde `row` reparte a lo ancho (a | b) y `col` a
 * lo alto (a encima de b). `ratio` es la parte de `a`.
 *
 * Los nodos se cambian EN SU SITIO: quien tiene la raíz (`s.layout`) la sigue teniendo después de
 * dividir o cerrar, sea cual sea el panel tocado.
 */

/**
 * @template P
 * @typedef {import('./types').Layout<P>} Layout
 */
/** @typedef {import('./types').SavedLayout} SavedLayout */

/** El divisor no deja un panel por debajo del 15 %. @param {number} f */
export const clampRatio = (f) => Math.min(0.85, Math.max(0.15, f))

/**
 * El nodo hoja de `p` y su padre, o `null` si `p` no está en el árbol.
 * @template P
 * @param {Layout<P>} n
 * @param {P} p
 * @param {Layout<P> | null} [parent]
 * @returns {{ node: Layout<P>, parent: Layout<P> | null } | null}
 */
export function findLeaf (n, p, parent = null) {
  if ('pane' in n) return n.pane === p ? { node: n, parent } : null
  return findLeaf(n.a, p, n) || findLeaf(n.b, p, n)
}

/**
 * Los paneles, en el orden en que se leen (izquierda a derecha, arriba abajo).
 * @template P
 * @param {Layout<P>} n
 * @returns {P[]}
 */
export const leaves = (n) => 'pane' in n ? [n.pane] : [...leaves(n.a), ...leaves(n.b)]

/**
 * Divide la hoja de `p`: `p` se queda en `a` y `q` entra en `b`. `false` si `p` no está.
 * @template P
 * @param {Layout<P>} layout
 * @param {P} p
 * @param {'row' | 'col'} dir
 * @param {P} q
 * @param {number} [ratio]
 */
export function splitLeaf (layout, p, dir, q, ratio = 0.5) {
  const found = findLeaf(layout, p); if (!found) return false
  // La hoja se convierte EN SU SITIO en una división: quien tiene la raíz la sigue teniendo.
  const node = /** @type {Record<string, unknown>} */ (found.node)
  delete node.pane
  Object.assign(node, { dir, ratio, a: { pane: p }, b: { pane: q } })
  return true
}

/**
 * Quita la hoja de `p`: su hermano ocupa el sitio del padre. `false` si `p` no está o es el único
 * panel (el último no se quita: para eso está la pestaña).
 * @template P
 * @param {Layout<P>} layout
 * @param {P} p
 */
export function removeLeaf (layout, p) {
  const found = findLeaf(layout, p)
  if (!found || !found.parent || 'pane' in found.parent) return false
  const { node, parent } = found
  const sibling = parent.a === node ? parent.b : parent.a
  // El padre se convierte EN SU SITIO en el hermano.
  const box = /** @type {Record<string, unknown>} */ (parent)
  for (const k of Object.keys(box)) delete box[k]
  Object.assign(box, sibling)
  return true
}

/**
 * El árbol con `idOf(pane)` en las hojas (lo que se guarda para recordarlo al recargar).
 * @template P
 * @param {Layout<P>} n
 * @param {(pane: P) => string | null | undefined} idOf
 * @returns {SavedLayout}
 */
export const layoutIds = (n, idOf) => 'pane' in n
  ? (idOf(n.pane) || null)
  : { dir: n.dir, ratio: n.ratio, a: layoutIds(n.a, idOf), b: layoutIds(n.b, idOf) }

/**
 * La primera hoja de un árbol guardado: la consola con la que se abre la pestaña.
 * @param {SavedLayout} n
 * @returns {string | null}
 */
export const firstSaved = (n) => n && typeof n === 'object' ? firstSaved(n.a) : n

/**
 * Rehace un reparto guardado a partir de su PRIMER panel (`first`, que ya tiene la primera hoja).
 * Por cada división llama a `split(pane, dir, ratio, id)`, que divide `pane` con la consola `id` y
 * devuelve el panel nuevo, o `null` si no se pudo: esa rama entonces no se sigue.
 * @template P
 * @param {SavedLayout} saved
 * @param {P} first
 * @param {(pane: P, dir: 'row' | 'col', ratio: number, id: string | null) => Promise<P | null>} split
 */
export async function restoreSaved (saved, first, split) {
  /** @type {(n: SavedLayout, pane: P) => Promise<void>} */
  const walk = async (n, pane) => {
    if (!n || typeof n !== 'object') return
    // `pane` ya es la primera hoja de `n.a`: se divide con la primera de `n.b` y se sigue por las dos.
    const ratio = typeof n.ratio === 'number' ? clampRatio(n.ratio) : 0.5
    const q = await split(pane, n.dir === 'col' ? 'col' : 'row', ratio, firstSaved(n.b))
    await walk(n.a, pane)
    if (q) await walk(n.b, q)
  }
  await walk(saved, first)
}
