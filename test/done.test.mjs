// Cuándo suena el trino: una consola que termina mientras miras, una vez por cada «terminó».
import test from 'node:test'
import assert from 'node:assert/strict'
import { doneWatcher } from '../src/done.js'

test('what was already finished when the app opened does not ring', () => {
  const w = doneWatcher()
  assert.equal(w.list('m', [{ id: 'a', doneAt: 10 }, { id: 'b', doneAt: null }]), false)
  assert.equal(w.list('m', [{ id: 'a', doneAt: 10 }, { id: 'b', doneAt: null }]), false)
})

test('a console that finishes rings once', () => {
  const w = doneWatcher()
  w.list('m', [{ id: 'a', doneAt: null }])
  assert.equal(w.list('m', [{ id: 'a', doneAt: 20 }]), true)
  assert.equal(w.list('m', [{ id: 'a', doneAt: 20 }]), false)
})

test('attended and finished again rings again', () => {
  const w = doneWatcher()
  w.list('m', [{ id: 'a', doneAt: null }])
  assert.equal(w.list('m', [{ id: 'a', doneAt: 20 }]), true)
  assert.equal(w.list('m', [{ id: 'a', doneAt: null }]), false)
  assert.equal(w.list('m', [{ id: 'a', doneAt: 30 }]), true)
})

test('the list and the push of the same console ring once between the two', () => {
  const w = doneWatcher()
  w.list('m', [{ id: 'a', doneAt: null }])
  assert.equal(w.one('m', { id: 'a', doneAt: 20 }), true)
  assert.equal(w.list('m', [{ id: 'a', doneAt: 20 }]), false)
})

test('each machine has its own first list, and its own consoles', () => {
  const w = doneWatcher()
  w.list('m', [{ id: 'a', doneAt: null }])
  assert.equal(w.list('n', [{ id: 'a', doneAt: 5 }]), false)
  assert.equal(w.list('m', [{ id: 'a', doneAt: 6 }]), true)
})

test('a console that is gone is forgotten', () => {
  const w = doneWatcher()
  w.list('m', [{ id: 'a', doneAt: null }])
  w.list('m', [{ id: 'a', doneAt: 20 }])
  w.list('m', [])
  assert.equal(w.list('m', [{ id: 'a', doneAt: 20 }]), true)
})
