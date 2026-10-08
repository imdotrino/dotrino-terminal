import test from 'node:test'
import assert from 'node:assert/strict'
import { clampRatio, findLeaf, leaves, splitLeaf, removeLeaf, layoutIds, firstSaved, restoreSaved } from '../src/layout.js'

// A pane is whatever the app says it is; here, an object carrying the console it shows.
const pane = (id) => ({ id })
const idOf = (p) => p.id
const ids = (layout) => layoutIds(layout, idOf)

/** Rebuilds a saved layout the way the app does: each split adds a pane with the console asked for. */
async function rebuild (saved, { failing = [] } = {}) {
  const first = pane(firstSaved(saved))
  const layout = { pane: first }
  const asked = []
  await restoreSaved(saved, first, async (p, dir, ratio, id) => {
    asked.push(id)
    const q = pane(id)
    splitLeaf(layout, p, dir, q, ratio)
    if (failing.includes(id)) { removeLeaf(layout, q); return null }
    return q
  })
  return { layout, asked }
}

test('splitting a pane keeps it first and puts the new one to its right or below', () => {
  const a = pane('a'); const b = pane('b'); const c = pane('c')
  const layout = { pane: a }
  assert.equal(splitLeaf(layout, a, 'row', b), true)
  assert.deepEqual(ids(layout), { dir: 'row', ratio: 0.5, a: 'a', b: 'b' })
  // A nested split only touches the pane it was asked on.
  assert.equal(splitLeaf(layout, b, 'col', c), true)
  assert.deepEqual(ids(layout), { dir: 'row', ratio: 0.5, a: 'a', b: { dir: 'col', ratio: 0.5, a: 'b', b: 'c' } })
  assert.deepEqual(leaves(layout), [a, b, c])
  // A leaf is exactly { pane }: nothing left over from when it was a branch, or the other way round.
  assert.deepEqual(Object.keys(layout).sort(), ['a', 'b', 'dir', 'ratio'])
  assert.deepEqual(Object.keys(layout.a), ['pane'])
})

test('splitting a pane that is not in the layout changes nothing', () => {
  const a = pane('a')
  const layout = { pane: a }
  assert.equal(splitLeaf(layout, pane('x'), 'row', pane('b')), false)
  assert.deepEqual(layout, { pane: a })
  assert.equal(findLeaf(layout, pane('a')), null) // found by identity, not by looks
})

test('closing a pane gives its room to the sibling, at any depth', () => {
  const a = pane('a'); const b = pane('b'); const c = pane('c'); const d = pane('d')
  const layout = { pane: a }
  splitLeaf(layout, a, 'row', b)
  splitLeaf(layout, b, 'col', c)
  splitLeaf(layout, a, 'col', d, 0.3)
  assert.deepEqual(ids(layout), {
    dir: 'row', ratio: 0.5,
    a: { dir: 'col', ratio: 0.3, a: 'a', b: 'd' },
    b: { dir: 'col', ratio: 0.5, a: 'b', b: 'c' },
  })
  // Closing one of a pair leaves the other alone in that half.
  assert.equal(removeLeaf(layout, b), true)
  assert.deepEqual(ids(layout), { dir: 'row', ratio: 0.5, a: { dir: 'col', ratio: 0.3, a: 'a', b: 'd' }, b: 'c' })
  // Closing a whole half promotes the other branch, with its own split and ratio.
  assert.equal(removeLeaf(layout, c), true)
  assert.deepEqual(ids(layout), { dir: 'col', ratio: 0.3, a: 'a', b: 'd' })
  // Closing the first pane too: the root object stays the same one the tab holds.
  const root = layout
  assert.equal(removeLeaf(layout, a), true)
  assert.equal(layout, root)
  assert.deepEqual(layout, { pane: d })
})

test('the only pane is never closed, and a stranger closes nothing', () => {
  const a = pane('a'); const b = pane('b')
  const layout = { pane: a }
  assert.equal(removeLeaf(layout, a), false)
  assert.deepEqual(layout, { pane: a })
  splitLeaf(layout, a, 'row', b)
  assert.equal(removeLeaf(layout, pane('x')), false)
  assert.deepEqual(leaves(layout), [a, b])
})

test('a pane still without a console is saved as an empty leaf, not dropped', () => {
  const a = pane('a'); const pending = pane(undefined)
  const layout = { pane: a }
  splitLeaf(layout, a, 'col', pending)
  assert.deepEqual(ids(layout), { dir: 'col', ratio: 0.5, a: 'a', b: null })
  // And it survives the trip through sessionStorage.
  assert.deepEqual(JSON.parse(JSON.stringify(ids(layout))), ids(layout))
})

test('the divider never squeezes a pane under 15%', () => {
  assert.equal(clampRatio(0), 0.15)
  assert.equal(clampRatio(-3), 0.15)
  assert.equal(clampRatio(1), 0.85)
  assert.equal(clampRatio(0.4), 0.4)
})

test('a saved layout comes back the same after a reload', async () => {
  const shapes = [
    { dir: 'row', ratio: 0.5, a: 'a', b: 'b' },
    { dir: 'col', ratio: 0.3, a: 'a', b: { dir: 'row', ratio: 0.7, a: 'b', b: 'c' } },
    { dir: 'row', ratio: 0.6, a: { dir: 'col', ratio: 0.25, a: 'a', b: 'b' }, b: 'c' },
    {
      dir: 'row', ratio: 0.5,
      a: { dir: 'col', ratio: 0.3, a: 'a', b: { dir: 'row', ratio: 0.4, a: 'b', b: 'c' } },
      b: { dir: 'col', ratio: 0.8, a: { dir: 'row', ratio: 0.2, a: 'd', b: 'e' }, b: 'f' },
    },
  ]
  for (const saved of shapes) {
    const { layout } = await rebuild(JSON.parse(JSON.stringify(saved)))
    assert.deepEqual(ids(layout), saved)
  }
})

test('a tab saved before the split (one console) opens with one pane', async () => {
  const { layout, asked } = await rebuild('a')
  assert.deepEqual(ids(layout), 'a')
  assert.deepEqual(asked, [])
})

test('each pane is rebuilt with the console it had', async () => {
  const saved = { dir: 'row', ratio: 0.5, a: { dir: 'col', ratio: 0.5, a: 'a', b: 'b' }, b: { dir: 'col', ratio: 0.5, a: 'c', b: null } }
  const { asked } = await rebuild(saved)
  // 'a' is the tab's own; an empty leaf asks for no console in particular (a free one, or a new one).
  assert.deepEqual(asked, ['c', 'b', null])
})

test('a pane that cannot be rebuilt is left out, and the rest still comes back', async () => {
  const saved = {
    dir: 'row', ratio: 0.5,
    a: { dir: 'col', ratio: 0.3, a: 'a', b: 'b' },
    b: { dir: 'col', ratio: 0.5, a: 'gone', b: 'c' },
  }
  const { layout, asked } = await rebuild(saved, { failing: ['gone'] })
  // The right half hung from the pane that failed: it does not come back, and nothing throws.
  assert.deepEqual(ids(layout), { dir: 'col', ratio: 0.3, a: 'a', b: 'b' })
  assert.deepEqual(asked, ['gone', 'b'])
})

test('a saved layout that was tampered with is read without trusting it', async () => {
  const { layout } = await rebuild({ dir: 'diagonal', ratio: 9, a: 'a', b: { ratio: 'x', a: 'b', b: 'c' } })
  assert.deepEqual(ids(layout), { dir: 'row', ratio: 0.85, a: 'a', b: { dir: 'row', ratio: 0.5, a: 'b', b: 'c' } })
})
