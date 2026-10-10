/**
 * Toda consola que se pone en pantalla toma el tamaño de ESTA pantalla (dueño, 2026-10-09): el
 * cliente de la PWA (`src/agentClient.js`) contra el agente de verdad, sin transporte.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentClient } from '../src/agentClient.js'
import { serveSession, makeHub, loadPty } from '../agent/index.js'
import { makeGate } from '../agent/access.js'

function wire (hub, device) {
  const client = new AgentClient({}, { agentPubkey: 'maquina' })
  const toClient = []
  const toAgent = { message: [], close: [] }
  const session = { device, on (ev, cb) { toAgent[ev].push(cb); return this }, async send (p) { queueMicrotask(() => toClient.forEach((cb) => cb(p))) } }
  serveSession(session, hub, { origin: 'remote', gate: makeGate(fs.mkdtempSync(path.join(os.tmpdir(), 'term-size-'))) })
  client.rc = {
    key: true,
    on (ev, cb) { if (ev === 'message') toClient.push(cb) },
    async connect () {},
    async send (msg) { queueMicrotask(() => toAgent.message.forEach((cb) => cb(msg))) },
    async close () { toAgent.close.forEach((cb) => cb()) }
  }
  return client
}
const tick = () => new Promise((r) => setTimeout(r, 30))

test('el tamaño lo toma quien abre, se cambia, pulsa ⤢ o teclea; reconectarse no, y nada queda fijado', async () => {
  const h = makeHub(loadPty(), { shell: '/bin/sh' })
  const phone = wire(h, 'telefono'); await phone.connect()
  const tablet = wire(h, 'tablet'); await tablet.connect()
  const size = async () => { await tick(); const c = (await phone.list())[0]; return [c.cols, c.rows, c.sizeBy?.device] }

  // 1) Abrir.
  const { id } = await phone.open(40, 20)
  assert.deepEqual(await size(), [40, 20, 'telefono'])

  // 2) Cambiarse a la consola.
  await tablet.attach(id, 100, 30)
  assert.deepEqual(await size(), [100, 30, 'tablet'])

  // Girar el teléfono, que no puso el tamaño, no lo cambia.
  await phone.resize(20, 40)
  assert.deepEqual(await size(), [100, 30, 'tablet'])

  // 3) ⤢, y no queda fijado: 4) la tablet teclea y lo toma.
  await phone.take()
  assert.deepEqual(await size(), [20, 40, 'telefono'])
  await tablet.input('a')
  assert.deepEqual(await size(), [100, 30, 'tablet'])

  // Volver a engancharse tras una reconexión no lo toca.
  await phone.attach(id, 20, 40, { keep: true })
  assert.deepEqual(await size(), [100, 30, 'tablet'])
  h.killAll()
})
