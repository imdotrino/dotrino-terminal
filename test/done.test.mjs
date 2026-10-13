// Cuándo suena el trino: cuando una consola lleva 60 s terminada y nadie la ha atendido.
import test from 'node:test'
import assert from 'node:assert/strict'
import { doneWatcher, RING_AFTER_MS } from '../src/done.js'

/** A watcher on a clock the test moves by hand. */
function setup () {
  const s = { t: 1_000_000, rings: 0, timers: [] }
  s.w = doneWatcher({ onRing: () => { s.rings++ }, now: () => s.t, setTimer: (fn, ms) => s.timers.push({ at: s.t + ms, fn }) })
  s.pass = (ms) => {
    s.t += ms
    const due = s.timers.filter((x) => x.at <= s.t)
    s.timers = s.timers.filter((x) => x.at > s.t)
    for (const x of due) x.fn()
  }
  return s
}

test('it is one minute', () => assert.equal(RING_AFTER_MS, 60_000))

test('turning green does not ring; a minute later, still unattended, it does, once', () => {
  const s = setup()
  s.w.list('m', [{ id: 'a', doneAt: null }])
  s.w.list('m', [{ id: 'a', doneAt: s.t }])
  assert.equal(s.rings, 0, 'not when it finishes')
  s.pass(59_000); s.w.list('m', [{ id: 'a', doneAt: s.t - 59_000 }])
  assert.equal(s.rings, 0)
  s.pass(1_000)
  assert.equal(s.rings, 1)
  s.pass(120_000); s.w.list('m', [{ id: 'a', doneAt: s.t - 180_000 }])
  assert.equal(s.rings, 1, 'and not again for the same finish')
})

test('attended before the minute: no ring', () => {
  const s = setup()
  s.w.list('m', [{ id: 'a', doneAt: s.t }])
  s.pass(30_000); s.w.list('m', [{ id: 'a', doneAt: null }])
  s.pass(60_000)
  assert.equal(s.rings, 0)
})

test('finished again restarts the minute', () => {
  const s = setup()
  const first = s.t
  s.w.list('m', [{ id: 'a', doneAt: first }])
  s.pass(40_000); s.w.one('m', { id: 'a', doneAt: s.t })
  s.pass(30_000)
  assert.equal(s.rings, 0, 'the first finish no longer counts')
  s.pass(30_000)
  assert.equal(s.rings, 1)
})

test('what was already finished long ago when the app opened does not ring', () => {
  const s = setup()
  s.w.list('m', [{ id: 'a', doneAt: s.t - 600_000 }])
  s.pass(120_000)
  assert.equal(s.rings, 0)
})

test('finished a moment before the app opened: it rings when ITS minute is up', () => {
  const s = setup()
  s.w.list('m', [{ id: 'a', doneAt: s.t - 20_000 }])
  s.pass(39_000); assert.equal(s.rings, 0)
  s.pass(1_000); assert.equal(s.rings, 1)
})

test('the list and the push of the same console ring once between the two', () => {
  const s = setup()
  s.w.one('m', { id: 'a', doneAt: s.t })
  s.w.list('m', [{ id: 'a', doneAt: s.t }])
  s.pass(60_000)
  assert.equal(s.rings, 1)
})

test('a console that is gone does not ring', () => {
  const s = setup()
  s.w.list('m', [{ id: 'a', doneAt: s.t }])
  s.pass(10_000); s.w.list('m', [])
  s.pass(60_000)
  assert.equal(s.rings, 0)
})
