/**
 * Una imagen que manda un aparato de la cuenta se guarda en esta máquina (uploads.js) y la
 * sesión contesta dónde quedó. Lo que fija esta suite: llega en trozos y en orden, qué es lo
 * decide el contenido, el nombre lo pone el agente y lo viejo se borra solo.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeUploads, imageExt, pruneUploads, UPLOAD_KEEP_MS, UPLOAD_MAX } from '../uploads.js'
import { serveSession } from '../index.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dt-up-'))
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000, 7)])
const b64 = (buf) => buf.toString('base64')

test('qué imagen es lo dicen sus primeros bytes', () => {
  assert.equal(imageExt(PNG), 'png')
  assert.equal(imageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg')
  assert.equal(imageExt(Buffer.from('GIF89a......')), 'gif')
  assert.equal(imageExt(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(imageExt(Buffer.from('#!/bin/sh\nrm -rf ~\n')), null)
  assert.equal(imageExt(Buffer.alloc(0)), null)
})

test('llega en trozos, cada uno con su acuse, y el último dice dónde quedó', () => {
  const dir = path.join(tmp(), 'uploads')
  const up = makeUploads(dir)
  assert.deepEqual(up.take({ up: 'a', seq: 0, data: b64(PNG.subarray(0, 2000)) }), { up: 'a', seq: 0 })
  assert.deepEqual(up.take({ up: 'a', seq: 1, data: b64(PNG.subarray(2000, 4000)) }), { up: 'a', seq: 1 })
  const r = up.take({ up: 'a', seq: 2, data: b64(PNG.subarray(4000)), last: true })
  assert.equal(path.dirname(r.path), dir)
  assert.match(path.basename(r.path), /^img-\d{8}-\d{6}-[0-9a-f]{6}\.png$/, 'el nombre lo pone el agente')
  assert.ok(fs.readFileSync(r.path).equals(PNG))
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  }
})

test('lo que no es una imagen no se guarda', () => {
  const dir = path.join(tmp(), 'uploads')
  const up = makeUploads(dir)
  assert.throws(() => up.take({ up: 'x', seq: 0, data: b64(Buffer.from('#!/bin/sh\necho hola\n')), last: true }), (e) => e.code === 'not-image')
  assert.equal(fs.existsSync(dir), false)
})

test('un trozo fuera de orden, o de otra imagen, descarta lo que iba', () => {
  const up = makeUploads(path.join(tmp(), 'uploads'))
  up.take({ up: 'a', seq: 0, data: b64(PNG.subarray(0, 100)) })
  assert.throws(() => up.take({ up: 'a', seq: 2, data: 'AAAA' }), (e) => e.code === 'bad-file')
  assert.throws(() => up.take({ up: 'a', seq: 1, data: 'AAAA' }), (e) => e.code === 'bad-file', 'ya se descartó')
  up.take({ up: 'b', seq: 0, data: b64(PNG.subarray(0, 100)) })
  assert.throws(() => up.take({ up: 'c', seq: 1, data: 'AAAA' }), (e) => e.code === 'bad-file')
  assert.throws(() => up.take({ seq: 0, data: 'AAAA' }), (e) => e.code === 'bad-file')
})

test('una imagen por encima del tope se rechaza', () => {
  const up = makeUploads(path.join(tmp(), 'uploads'))
  const piece = b64(Buffer.alloc(180 * 1024, 1))
  assert.throws(() => {
    for (let seq = 0; seq * 180 * 1024 <= UPLOAD_MAX + 180 * 1024; seq++) up.take({ up: 'big', seq, data: seq ? piece : b64(Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(180 * 1024 - 8, 1)])) })
  }, (e) => e.code === 'too-big')
  assert.throws(() => up.take({ up: 'p', seq: 0, data: 'A'.repeat(300 * 1024) }), (e) => e.code === 'too-big')
})

test('las imágenes viejas se borran solas; lo que no es una imagen subida no se toca', () => {
  const dir = tmp()
  const old = path.join(dir, 'img-20260101-000000-abcdef.png')
  const fresh = path.join(dir, 'img-20261012-000000-abcdef.jpg')
  const other = path.join(dir, 'notas.txt')
  for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x')
  const past = new Date(Date.now() - UPLOAD_KEEP_MS - 60_000)
  fs.utimesSync(old, past, past); fs.utimesSync(other, past, past)
  pruneUploads(dir)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['img-20261012-000000-abcdef.jpg', 'notas.txt'])
  pruneUploads(path.join(dir, 'no-existe'))
})

/** Una sesión de mentira contra `serveSession`: lo que el agente contesta queda en `got`. */
function session () {
  const h = { message: [], close: [] }
  const got = []
  return { got, say: (m) => { for (const cb of h.message) cb(m) }, end: () => { for (const cb of h.close) cb() }, s: { device: 'phone', on (ev, cb) { h[ev].push(cb); return this }, send: (p) => { got.push(p) } } }
}
const hub = { list: () => [], get: () => null }

test('por la sesión: `file` se acusa con `filed` y la ruta; los fallos llegan con su código', () => {
  const dir = path.join(tmp(), 'uploads')
  const a = session()
  serveSession(a.s, hub, { origin: 'remote', uploadsDir: dir })
  a.say({ type: 'file', up: 'u1', seq: 0, data: b64(PNG.subarray(0, 3000)) })
  a.say({ type: 'file', up: 'u1', seq: 1, data: b64(PNG.subarray(3000)), last: true })
  assert.deepEqual(a.got[0], { type: 'filed', up: 'u1', seq: 0 })
  assert.equal(a.got[1].type, 'filed')
  assert.ok(fs.readFileSync(a.got[1].path).equals(PNG))
  a.say({ type: 'file', up: 'u2', seq: 0, data: b64(Buffer.from('no soy una imagen')), last: true })
  assert.equal(a.got[2].type, 'fail')
  assert.equal(a.got[2].code, 'not-image')
  // Irse a medias no deja nada: la siguiente sesión no hereda trozos.
  a.say({ type: 'file', up: 'u3', seq: 0, data: b64(PNG.subarray(0, 100)) })
  a.end()
  assert.equal(fs.readdirSync(dir).length, 1)
})

test('sin carpeta para guardarlas, se dice', () => {
  const a = session()
  serveSession(a.s, hub, { origin: 'remote' })
  a.say({ type: 'file', up: 'u1', seq: 0, data: b64(PNG), last: true })
  assert.equal(a.got[0].code, 'no-uploads')
})
