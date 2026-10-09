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

test('al engancharse, la consola queda fijada al tamaño de esta pantalla y otra que solo mira no lo cambia', async () => {
  const h = makeHub(loadPty(), { shell: '/bin/sh' })
  const phone = wire(h, 'telefono'); await phone.connect()
  const tablet = wire(h, 'tablet'); await tablet.connect()
  const { id } = await phone.open(40, 20)
  await tick()
  let c = (await phone.list())[0]
  assert.deepEqual([c.cols, c.rows, c.sizeBy.device, c.sizeBy.pinned], [40, 20, 'telefono', true])

  // La tablet pasa a esa consola: ahora manda ella.
  await tablet.attach(id, 100, 30)
  await tick()
  c = (await phone.list())[0]
  assert.deepEqual([c.cols, c.rows, c.sizeBy.device, c.sizeBy.pinned], [100, 30, 'tablet', true])

  // El teléfono gira: solo mira, no cambia el tamaño.
  await phone.resize(20, 40)
  await tick()
  c = (await phone.list())[0]
  assert.deepEqual([c.cols, c.rows], [100, 30])
  h.killAll()
})
