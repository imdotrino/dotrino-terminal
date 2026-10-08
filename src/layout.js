/**
 * layout.js — el reparto de una pestaña en paneles (split, dueño 2026-10-07), sin DOM: un árbol
 * `{ pane } | { dir: 'row'|'col', ratio, a, b }` donde `row` reparte a lo ancho (a | b) y `col` a
 * lo alto (a encima de b). `ratio` es la parte de `a`.
 *
 * Los nodos se cambian EN SU SITIO: quien tiene la raíz (`s.layout`) la sigue teniendo después de
 * dividir o cerrar, sea cual sea el panel tocado.
 */

/** El divisor no deja un panel por debajo del 15 %. */
export const clampRatio = (f) => Math.min(0.85, Math.max(0.15, f))

/** El nodo hoja de `p` y su padre, o `null` si `p` no está en el árbol. */
export function findLeaf (n, p, parent = null) {
  if ('pane' in n) return n.pane === p ? { node: n, parent } : null
  return findLeaf(n.a, p, n) || findLeaf(n.b, p, n)
}

/** Los paneles, en el orden en que se leen (izquierda a derecha, arriba abajo). */
export const leaves = (n) => 'pane' in n ? [n.pane] : [...leaves(n.a), ...leaves(n.b)]

/** Divide la hoja de `p`: `p` se queda en `a` y `q` entra en `b`. `false` si `p` no está. */
export function splitLeaf (layout, p, dir, q, ratio = 0.5) {
  const found = findLeaf(layout, p); if (!found) return false
  const { node } = found
  delete node.pane
  Object.assign(node, { dir, ratio, a: { pane: p }, b: { pane: q } })
  return true
}

/**
 * Quita la hoja de `p`: su hermano ocupa el sitio del padre. `false` si `p` no está o es el único
 * panel (el último no se quita: para eso está la pestaña).
 */
export function removeLeaf (layout, p) {
  const found = findLeaf(layout, p)
  if (!found || !found.parent) return false
  const { node, parent } = found
  const sibling = parent.a === node ? parent.b : parent.a
  for (const k of Object.keys(parent)) delete parent[k]
  Object.assign(parent, sibling)
  return true
}

/** El árbol con `idOf(pane)` en las hojas (lo que se guarda para recordarlo al recargar). */
export const layoutIds = (n, idOf) => 'pane' in n
  ? (idOf(n.pane) || null)
  : { dir: n.dir, ratio: n.ratio, a: layoutIds(n.a, idOf), b: layoutIds(n.b, idOf) }

/** La primera hoja de un árbol guardado: la consola con la que se abre la pestaña. */
export const firstSaved = (n) => n && typeof n === 'object' ? firstSaved(n.a) : n

/**
 * Rehace un reparto guardado a partir de su PRIMER panel (`first`, que ya tiene la primera hoja).
 * Por cada división llama a `split(pane, dir, ratio, id)`, que divide `pane` con la consola `id` y
 * devuelve el panel nuevo, o `null` si no se pudo: esa rama entonces no se sigue.
 */
export async function restoreSaved (saved, first, split) {
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
