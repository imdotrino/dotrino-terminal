/**
 * Un archivo de esta máquina se manda en trozos al aparato que lo pide (downloads.js). Lo que
 * fija esta suite: los trozos rehacen el archivo, cada uno dice tamaño y fecha, las rutas
 * relativas cuelgan de la carpeta de la consola y lo que no es un archivo normal no sale.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPiece, resolvePath, FETCH_CHUNK } from '../downloads.js'
import { serveSession } from '../index.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dt-down-'))
const code = (fn) => { try { fn() } catch (e) { return e.code } return null }

test('los trozos rehacen el archivo, y el último lo dice', () => {
  const dir = tmp()
  const file = path.join(dir, 'informe.pdf')
  const body = Buffer.alloc(FETCH_CHUNK * 2 + 123, 9)
  fs.writeFileSync(file, body)
  const parts = []
  for (let seq = 0; ; seq++) {
    const r = readPiece({ id: 'a', path: file, seq })
    assert.equal(r.size, body.length)
    assert.equal(r.name, 'informe.pdf')
    parts.push(Buffer.from(r.data, 'base64'))
    if (r.last) { assert.equal(seq, 2); break }
  }
  assert.ok(Buffer.concat(parts).equals(body))
})

test('un archivo vacío sale en un trozo vacío', () => {
  const file = path.join(tmp(), 'vacio.txt')
  fs.writeFileSync(file, '')
  const r = readPiece({ id: 'a', path: file, seq: 0 })
  assert.equal(r.last, true)
  assert.equal(r.data, '')
})

test('una ruta relativa cuelga de la carpeta de la consola, y sin ella no se adivina', () => {
  assert.equal(resolvePath('a/b.txt', '/srv/x'), '/srv/x/a/b.txt')
  assert.equal(resolvePath('~/b.txt'), path.join(os.homedir(), 'b.txt'))
  assert.equal(resolvePath('x.txt', '~/docs'), path.join(os.homedir(), 'docs', 'x.txt'))
  assert.equal(code(() => resolvePath('x.txt', null)), 'no-cwd')
})

test('lo que no es un archivo normal no sale', () => {
  const dir = tmp()
  assert.equal(code(() => readPiece({ id: 'a', path: dir, seq: 0 })), 'is-dir')
  assert.equal(code(() => readPiece({ id: 'a', path: path.join(dir, 'no-existe'), seq: 0 })), 'no-file')
  assert.equal(code(() => readPiece({ id: 'a', path: '', seq: 0 })), 'bad-fetch')
  assert.equal(code(() => readPiece({ id: '', path: '/etc/hostname', seq: 0 })), 'bad-fetch')
  fs.writeFileSync(path.join(dir, 'f'), 'hola')
  assert.equal(code(() => readPiece({ id: 'a', path: path.join(dir, 'f'), seq: 1 })), 'bad-fetch', 'un trozo después del final')
})

test('la sesión contesta `fetched`, o `fail` con el código', () => {
  const file = path.join(tmp(), 'n.txt')
  fs.writeFileSync(file, 'hola')
  const sent = []
  const h = {}
  const session = { device: null, send: (p) => { sent.push(p); return Promise.resolve() }, on (ev, cb) { h[ev] = cb; return this } }
  serveSession(session, { list: () => [] }, { origin: 'local' })
  h.message({ type: 'fetch', id: 'x', path: file, seq: 0 })
  assert.equal(sent[0].type, 'fetched')
  assert.equal(Buffer.from(sent[0].data, 'base64').toString(), 'hola')
  h.message({ type: 'fetch', id: 'x', path: file + '.no', seq: 0 })
  assert.deepEqual([sent[1].type, sent[1].code], ['fail', 'no-file'])
})
