import test from 'node:test'
import assert from 'node:assert/strict'
import { panelLines, dropTarget } from '../src/panel.js'

const me = 'seyacat@loca'
const L = (host, dir, name) => ({ host, dir, name })

test('the panel gives the machine, the folder and the title a line each, the machine always first', () => {
  // Local: the machine leads (the title's, or the console's when the title names a program).
  assert.deepEqual(panelLines('seyacat@loca: ~', '~', me), L(me, '~', null))
  assert.deepEqual(panelLines('seyacat@loca: ~/p/dotrino', null, me), L(me, '~/p/dotrino', null)) // an older agent
  assert.deepEqual(panelLines('✳ Sefjr improvement', '/mnt/sda1/Dotrino', me), L(me, '/mnt/sda1/Dotrino', '✳ Sefjr improvement'))
  assert.deepEqual(panelLines('vim: notas.txt', '~', me), L(me, '~', 'vim: notas.txt'))
  // After an ssh the title names ANOTHER machine: that is shown. The folder the agent gives is the
  // local ssh process's, so the remote one stays as the title.
  assert.deepEqual(panelLines('dotrino@proxy1: /var/www', '~', me), L('dotrino@proxy1', '~', '/var/www'))
  assert.deepEqual(panelLines('dotrino@proxy1: ~', null, me), L('dotrino@proxy1', '~', null))
  // Without the machine's name (an older agent), only a host in the title can be shown.
  assert.deepEqual(panelLines('seyacat@loca: ~', '~', null), L('seyacat@loca', '~', null))
  assert.deepEqual(panelLines('', '~', null), L(null, '~', null))
  assert.deepEqual(panelLines('', null, null), L(null, null, null))
})

test('a console dropped on another takes its place', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(dropTarget(ids, 'c', 'a'), { before: 'a' })   // up: in front of it
  assert.deepEqual(dropTarget(ids, 'a', 'c'), { before: 'd' })   // down: behind it
  assert.deepEqual(dropTarget(ids, 'a', 'd'), { before: null })  // down to the last: the end
  assert.deepEqual(dropTarget(ids, 'b', 'c'), { before: 'd' })
  assert.equal(dropTarget(ids, 'b', 'b'), null)
  assert.equal(dropTarget(ids, 'x', 'b'), null)
})
