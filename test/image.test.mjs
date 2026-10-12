/**
 * Adjuntar una imagen: qué sale tal cual y qué se reduce (image.js), y cómo viaja a la máquina
 * (agentClient.sendImage): en trozos, cada uno con su acuse, contra el agente de verdad
 * (agent/uploads.js por `serveSession`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fitSide, goesAsIs, imageIn, IMAGE_MAX_SIDE } from '../src/image.js'
import { AgentClient, FILE_CHUNK, toBase64 } from '../src/agentClient.js'
import { serveSession } from '../agent/index.js'

test('una imagen pequeña y de un tipo admitido sale tal cual; el resto se reduce', () => {
  assert.equal(goesAsIs('image/png', 200_000), true)
  assert.equal(goesAsIs('image/jpeg', 5_000_000), false, 'la foto del teléfono se reduce')
  assert.equal(goesAsIs('image/heic', 200_000), false, 'un tipo que la máquina no guarda se convierte')
  assert.deepEqual(fitSide(4000, 3000), { w: IMAGE_MAX_SIDE, h: 1500 })
  assert.deepEqual(fitSide(800, 600), { w: 800, h: 600 }, 'nunca se agranda')
  assert.deepEqual(fitSide(9000, 3), { w: IMAGE_MAX_SIDE, h: 1 })
})

test('de un pegado se toma la imagen, no el texto', () => {
  const img = { type: 'image/png' }
  assert.equal(imageIn({ files: [{ type: 'text/plain' }, img] }), img)
  assert.equal(imageIn({ files: [], items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/jpeg', getAsFile: () => img }] }), img)
  assert.equal(imageIn({ files: [], items: [{ kind: 'string', type: 'text/plain' }] }), null)
  assert.equal(imageIn(null), null)
})

test('toBase64 da lo mismo que Buffer, también con muchos bytes', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
})

/** Un `AgentClient` hablando con `serveSession` sin red: lo que manda llega al agente y vuelve. */
function wired (uploadsDir, { answer = true } = {}) {
  const c = new AgentClient({}, { agentPubkey: 'machine' })
  const toAgent = { message: [], close: [] }
  const toClient = []
  const sent = []
  if (answer) {
    serveSession({ device: 'phone', on (ev, cb) { toAgent[ev].push(cb); return this }, send: (p) => { queueMicrotask(() => { for (const cb of toClient) cb(p) }) } },
      { list: () => [], get: () => null }, { origin: 'remote', uploadsDir })
  }
  c.rc = {
    on (ev, cb) { if (ev === 'message') toClient.push(cb) },
    async connect () {},
    async send (m) { sent.push(m); queueMicrotask(() => { for (const cb of toAgent.message) cb(m) }) }
  }
  return { c, sent }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(FILE_CHUNK * 2 + 500, 9)])

test('sendImage: va en trozos con acuse y devuelve la ruta donde quedó en la máquina', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-img-')), 'uploads')
  const { c, sent } = wired(dir)
  await c.connect()
  const seen = []
  const where = await c.sendImage(new Uint8Array(PNG), { onProgress: (a, b) => seen.push([a, b]) })
  assert.equal(sent.length, 3, 'tres trozos')
  assert.deepEqual(sent.map((m) => [m.type, m.seq, !!m.last]), [['file', 0, false], ['file', 1, false], ['file', 2, true]])
  assert.equal(new Set(sent.map((m) => m.up)).size, 1)
  assert.ok(fs.readFileSync(where).equals(PNG), 'llegó entera')
  assert.equal(path.dirname(where), dir)
  assert.deepEqual(seen.at(-1), [PNG.length, PNG.length])
})

test('sendImage: lo que la máquina rechaza llega con su código', async () => {
  const { c } = wired(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dt-img-')), 'uploads'))
  await c.connect()
  await assert.rejects(c.sendImage(new TextEncoder().encode('no soy una imagen')), (e) => e.code === 'not-image')
  await assert.rejects(c.sendImage(new Uint8Array(0)), (e) => e.code === 'not-image')
})
