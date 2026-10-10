/**
 * Las consolas de las OTRAS máquinas, desde una ventana de esta (far.js + serveLocal).
 * Todo de verdad —el socket local, el PTY, `serveSession` en la «otra máquina»— menos la red:
 * la sesión con el otro agente es un par de colas en memoria.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveSession, serveLocal, makeHub, loadPty } from '../index.js'
import { listenLocal, connectLocal } from '../local.js'
import { makeFar } from '../far.js'
import { makeGate, setAccessCode } from '../access.js'

const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Una «otra máquina»: su hub, y `connect()` que entrega una sesión remota con ella. */
function otherMachine ({ sub, id, name, code = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-far-'))
  if (code) setAccessCode(dir, code)
  const hub = makeHub(loadPty(), { shell: '/bin/sh' })
  const gate = makeGate(dir)
  let sessions = 0
  const connect = () => {
    sessions++
    const toMachine = { message: [], close: [] }
    const toClient = { message: [], error: [], resumed: [] }
    serveSession({
      device: 'the-window-machine',
      on (ev, cb) { toMachine[ev].push(cb); return this },
      async send (p) { queueMicrotask(() => { for (const cb of [...toClient.message]) cb(p) }) }
    }, hub, { origin: 'remote', gate })
    return {
      on (ev, cb) { toClient[ev].push(cb); return () => { toClient[ev] = toClient[ev].filter((f) => f !== cb) } },
      async send (m) { queueMicrotask(() => { for (const cb of toMachine.message) cb(m) }) },
      close () { for (const cb of toMachine.close) cb() }
    }
  }
  return { sub, id, name, hub, connect, sessions: () => sessions, done: () => { hub.killAll(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

async function setup (others, { linked = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-'))
  const hub = makeHub(loadPty(), { shell: '/bin/sh' })
  const far = makeFar({
    dir, kind: 'terminal-agent', refreshMs: 0,
    loadLink: () => (linked ? { fake: true } : null),
    discover: async () => others.map(({ sub, id, name }) => ({ sub, id, name })),
    connect: async ({ sub }) => others.find((o) => o.sub === sub).connect()
  })
  const local = await listenLocal({ dir, serve: (s) => serveLocal(s, hub, far) })
  return { dir, hub, far, done: () => { hub.killAll(); far.close(); local.close(); for (const o of others) o.done(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

async function win (dir) {
  const c = await connectLocal(dir)
  const got = []
  c.on('message', (m) => got.push(m))
  return { c, got, out: () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join(''), last: (type) => got.filter((m) => m.type === type).pop() }
}

test('una ventana ve las consolas de otra máquina de la cuenta', async () => {
  const b = otherMachine({ sub: 'pub-b', id: 'BBBB-0001', name: 'oficina' })
  b.hub.create({ cols: 80, rows: 24, origin: 'local' })
  const { dir, done } = await setup([b])
  const w = await win(dir)
  w.c.send({ type: 'machines' })
  await until(() => w.last('machines'))
  const list = w.last('machines').list
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'BBBB-0001')
  assert.equal(list[0].name, 'oficina')
  assert.equal(list[0].consoles.length, 1)
  assert.equal(list[0].locked, false)
  done()
})

test('con `via` la ventana abre y usa una consola EN la otra máquina, no en esta', async () => {
  const b = otherMachine({ sub: 'pub-b', id: 'BBBB-0001', name: 'oficina' })
  const { dir, hub, done } = await setup([b])
  const w = await win(dir)
  w.c.send({ type: 'via', machine: 'oficina' })
  w.c.send({ type: 'open', cols: 80, rows: 24 })          // llega antes de que el tubo esté: se guarda
  await until(() => w.last('attached'))
  assert.equal(w.last('via').machine.id, 'BBBB-0001')
  assert.equal(hub.list().length, 0, 'aquí no se abrió nada')
  assert.equal(b.hub.list().length, 1, 'se abrió allí')
  assert.equal(b.hub.list()[0].watchers[0].origin, 'remote', 'allí se ve como lo que es: otro aparato')
  w.c.send({ type: 'input', data: 'echo far-$((40+2))\r' })
  await until(() => w.out().includes('far-42'))
  // Cerrar la ventana suelta la consola de allí; no la mata.
  w.c.close()
  await until(() => b.hub.list()[0].viewers === 0)
  assert.equal(b.hub.list().length, 1)
  done()
})

test('la máquina se nombra por su id, con o sin guion, y un nombre que no existe se dice', async () => {
  const b = otherMachine({ sub: 'pub-b', id: 'BBBB-0001', name: 'oficina' })
  const { dir, done } = await setup([b])
  for (const ref of ['BBBB-0001', 'bbbb0001', 'pub-b']) {
    const w = await win(dir)
    w.c.send({ type: 'via', machine: ref })
    await until(() => w.last('via') || w.last('fail'))
    assert.equal(w.last('via')?.machine.sub, 'pub-b', ref)
    w.c.close()
  }
  const w = await win(dir)
  w.c.send({ type: 'via', machine: 'casa' })
  await until(() => w.last('fail'))
  assert.equal(w.last('fail').code, 'no-machine')
  done()
})

test('una máquina con clave sale cerrada; tras escribirla en una ventana, el panel ya lista sus consolas', async () => {
  const b = otherMachine({ sub: 'pub-b', id: 'BBBB-0001', name: 'oficina', code: 'secreto' })
  b.hub.create({ cols: 80, rows: 24, origin: 'local' })
  const { dir, done } = await setup([b])
  const panel = await win(dir)
  panel.c.send({ type: 'machines' })
  await until(() => panel.last('machines'))
  assert.equal(panel.last('machines').list[0].locked, true)
  assert.equal(panel.last('machines').list[0].consoles, null, 'cerrada no enseña nada')

  const w = await win(dir)
  w.c.send({ type: 'via', machine: 'oficina' })
  await until(() => w.last('via'))
  w.c.send({ type: 'list' })
  await until(() => w.last('fail'))
  assert.equal(w.last('fail').code, 'locked')
  w.c.send({ type: 'unlock', code: 'mala' })
  await until(() => w.last('fail').code === 'bad-code')
  w.c.send({ type: 'unlock', code: 'secreto' })
  await until(() => w.last('unlocked'))

  panel.got.length = 0
  await until(() => {
    panel.c.send({ type: 'machines' })
    const m = panel.last('machines')
    return m && m.list[0].consoles?.length === 1
  })
  assert.equal(panel.last('machines').list[0].locked, false)
  done()
})

test('una orden suelta (cerrar una consola de otra máquina) llega sin abrir ventana', async () => {
  const b = otherMachine({ sub: 'pub-b', id: 'BBBB-0001', name: 'oficina' })
  const c = b.hub.create({ cols: 80, rows: 24, origin: 'local' })
  const { dir, done } = await setup([b])
  const w = await win(dir)
  w.c.send({ type: 'far', machine: 'BBBB-0001', msg: { type: 'kill', id: c.id } })
  await until(() => b.hub.list().length === 0)
  done()
})

test('sin enlace no hay otras máquinas, y se dice por qué', async () => {
  const { dir, done } = await setup([], { linked: false })
  const w = await win(dir)
  w.c.send({ type: 'machines' })
  await until(() => w.last('fail'))
  assert.equal(w.last('fail').code, 'not-linked')
  // Y lo de siempre sigue igual: la ventana abre su consola de aquí.
  w.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => w.last('attached'))
  done()
})

test('una máquina que deja de contestar sale con su error, sin tumbar la lista de las demás', async () => {
  const b = otherMachine({ sub: 'pub-b', id: 'BBBB-0001', name: 'oficina' })
  const dead = { sub: 'pub-c', id: 'CCCC-0002', name: 'vieja', connect: () => { throw Object.assign(new Error('el agente no respondió'), { code: 'unreachable' }) }, done () {} }
  const { dir, done } = await setup([b, dead])
  const w = await win(dir)
  w.c.send({ type: 'machines' })
  await until(() => w.last('machines'))
  const list = w.last('machines').list
  assert.equal(list.find((m) => m.id === 'BBBB-0001').consoles.length, 0)
  assert.equal(list.find((m) => m.id === 'CCCC-0002').error.code, 'unreachable')
  done()
})
