/**
 * La clave de una máquina (`dotrino-terminal lock`), de punta a punta: el cliente de la PWA
 * (`src/agentClient.js`) contra el agente de verdad (`agent/index.js`), sin transporte.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentClient } from '../src/agentClient.js'
import { serveSession, makeHub, loadPty } from '../agent/index.js'
import { makeGate, setAccessCode } from '../agent/access.js'

/** Une un AgentClient con una sesión del agente: lo que uno manda, el otro lo recibe. */
function wire (dir, hub, pub) {
  const client = new AgentClient({}, { agentPubkey: pub })
  const toClient = []
  const toAgent = { message: [], close: [] }
  const session = { on (ev, cb) { toAgent[ev].push(cb); return this }, async send (p) { queueMicrotask(() => toClient.forEach((cb) => cb(p))) } }
  serveSession(session, hub, { origin: 'remote', gate: makeGate(dir) })
  client.rc = {
    key: true,
    on (ev, cb) { if (ev === 'message') toClient.push(cb) },
    async connect () {},
    async send (msg) { queueMicrotask(() => toAgent.message.forEach((cb) => cb(msg))) },
    async close () { toAgent.close.forEach((cb) => cb()) }
  }
  return client
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'term-code-'))
const hub = () => makeHub(loadPty(), { shell: '/bin/sh' })

test('la máquina pide su clave: el cliente la pregunta, insiste si es mala y sigue con lo que hacía', async () => {
  const dir = tmp(); const h = hub()
  setAccessCode(dir, '4821')
  const c = wire(dir, h, 'maquina-1')
  const asked = []
  c.askCode = async ({ wrong }) => { asked.push(wrong?.code || null); return asked.length === 1 ? '0000' : '4821' }
  await c.connect()
  assert.deepEqual(await c.list(), [])
  assert.deepEqual(asked, [null, 'bad-code'])
  const opened = await c.open(80, 24)
  assert.ok(opened.id)
  assert.equal(asked.length, 2, 'ya dentro, no vuelve a preguntar')

  // Otra pestaña con la misma máquina: usa la clave ya tecleada en esta página.
  const d = wire(dir, h, 'maquina-1')
  d.askCode = async () => { throw new Error('should not ask again') }
  await d.connect()
  assert.equal((await d.list()).length, 1)
  h.killAll()
})

test('si la persona lo deja, lo que pedía falla con `locked` y no se abre nada', async () => {
  const dir = tmp(); const h = hub()
  setAccessCode(dir, '4821')
  const c = wire(dir, h, 'maquina-2')
  c.askCode = async () => null
  await c.connect()
  await assert.rejects(c.open(80, 24), { code: 'locked' })
  assert.equal(h.list().length, 0)
  h.killAll()
})

test('le ponen clave con la pestaña ya dentro: la pide sin dar error y sigue', async () => {
  const dir = tmp(); const h = hub()
  const c = wire(dir, h, 'maquina-3')
  let asked = 0; const errors = []
  c.askCode = async () => { asked++; return '4821' }
  c.onError = (e) => errors.push(e)
  await c.connect()
  await c.open(80, 24)
  setAccessCode(dir, '4821')                        // `dotrino-terminal lock`, en caliente
  await c.input('echo hola\r')
  await new Promise((r) => setTimeout(r, 1500))     // scrypt
  assert.equal(asked, 1)
  assert.deepEqual(errors, [])
  assert.equal((await c.list()).length, 1)
  h.killAll()
})
