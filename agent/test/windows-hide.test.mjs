import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHide } from '../windows-hide.js'

const cb = () => {}

test('withHide: añade windowsHide sin tocar lo demás', () => {
  // node-pty: fork(modulo, [pid]) sin opciones
  assert.deepEqual(withHide([['42']]), [['42'], { windowsHide: true }])
  assert.deepEqual(withHide([]), [{ windowsHide: true }])
  assert.deepEqual(withHide([['a'], { cwd: 'x' }]), [['a'], { cwd: 'x', windowsHide: true }])
  assert.deepEqual(withHide([['a'], undefined, cb]), [['a'], { windowsHide: true }, cb])
  assert.deepEqual(withHide([undefined, { cwd: 'x' }]), [undefined, { cwd: 'x', windowsHide: true }])
  // exec(cmd, cb) y exec(cmd, opts, cb)
  assert.deepEqual(withHide([cb]), [{ windowsHide: true }, cb])
  assert.deepEqual(withHide([{ env: {} }, cb]), [{ env: {}, windowsHide: true }, cb])
})

test('withHide: respeta un windowsHide explícito', () => {
  assert.deepEqual(withHide([['a'], { windowsHide: false }]), [['a'], { windowsHide: false }])
})
