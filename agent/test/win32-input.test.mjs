import { test } from 'node:test'
import assert from 'node:assert/strict'
import { win32InputFilter } from '../win32-input.js'

test('win32InputFilter: quita la petición de win32-input-mode y deja lo demás', () => {
  const f = win32InputFilter()
  assert.equal(f('\x1b[?9001h\x1b[?1004hPS C:\\> '), '\x1b[?1004hPS C:\\> ')
  assert.equal(f('hola'), 'hola')
  assert.equal(f('\x1b[?9001l'), '\x1b[?9001l')
})

test('win32InputFilter: la secuencia partida entre dos trozos', () => {
  const f = win32InputFilter()
  assert.equal(f('a\x1b[?90'), 'a')
  assert.equal(f('01hb'), 'b')
  assert.equal(f('c\x1b'), 'c')
  assert.equal(f('[31mx'), '\x1b[31mx')
})
