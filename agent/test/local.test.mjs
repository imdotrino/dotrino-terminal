/**
 * Las ventanas de esta máquina: el socket local, quién mata qué al cerrarse, y el aviso de
 * que alguien la abrió desde otro aparato. PTY de verdad; el socket, también.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveSession, makeHub, loadPty } from '../index.js'
import { listenLocal, connectLocal } from '../local.js'
import { titleFilter } from '../title.js'

const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function setup () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-'))
  const hub = makeHub(loadPty(), { shell: '/bin/sh' })
  const local = await listenLocal({ dir, serve: (s) => serveSession(s, hub, { origin: 'local' }) })
  return { dir, hub, local, done: () => { hub.killAll(); local.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

async function win (dir) {
  const c = await connectLocal(dir)
  const got = []
  c.on('message', (m) => got.push(m))
  return { c, got, out: () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('') }
}

/** Una sesión remota como la que entrega `onSession`, sin transporte. */
function remoteSession (device) {
  const h = { message: [], close: [] }
  const sent = []
  return { device, sent, on (ev, cb) { h[ev].push(cb); return this }, async send (p) { sent.push(p) }, close () { for (const cb of h.close) cb() }, deliver (m) { for (const cb of h.message) cb(m) } }
}

test('una ventana local abre una consola por el socket y la usa', async () => {
  const { dir, hub, done } = await setup()
  assert.equal((fs.statSync(dir).mode & 0o777), 0o700, 'la carpeta del socket es solo del usuario')
  const w = await win(dir)
  w.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => w.got.some((m) => m.type === 'attached'))
  assert.equal(hub.list()[0].origin, 'local')
  w.c.send({ type: 'input', data: 'echo local-$((40+2))\r' })
  await until(() => w.out().includes('local-42'))
  done()
})

test('cerrar la ventana que ABRIÓ la consola la mata; soltarla antes, no', async () => {
  const { dir, hub, done } = await setup()
  const a = await win(dir)
  a.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => a.got.some((m) => m.type === 'attached'))
  a.c.close()
  await until(() => hub.list().length === 0)

  const b = await win(dir)
  b.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => b.got.some((m) => m.type === 'attached'))
  b.c.send({ type: 'detach' })
  b.c.close()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(hub.list().length, 1, 'soltada, sigue viva')
  done()
})

test('una ventana que solo se ENGANCHÓ no mata la consola al cerrarse', async () => {
  const { dir, hub, done } = await setup()
  const a = await win(dir)
  a.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => a.got.some((m) => m.type === 'attached'))
  const id = a.got.find((m) => m.type === 'attached').id
  const b = await win(dir)
  b.c.send({ type: 'attach', id, cols: 100, rows: 30 })
  await until(() => b.got.some((m) => m.type === 'attached'))
  b.c.close()
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(hub.list().length, 1)
  done()
})

test('la ventana local se entera de que un aparato remoto abrió su consola, y de quién', async () => {
  const { dir, hub, done } = await setup()
  const w = await win(dir)
  w.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => w.got.some((m) => m.type === 'attached'))
  const id = w.got.find((m) => m.type === 'attached').id

  const r = remoteSession('PUBKEY-DEL-TELEFONO')
  serveSession(r, hub, { origin: 'remote' })
  r.deliver({ type: 'list' })
  await until(() => r.sent.some((m) => m.type === 'consoles'))
  assert.deepEqual(r.sent.find((m) => m.type === 'consoles').list.map((c) => [c.id, c.origin]), [[id, 'local']], 'el remoto ve la ventana local')

  r.deliver({ type: 'attach', id, cols: 80, rows: 24 })
  const remoteWatching = (m) => m.type === 'meta' && m.console.watchers.some((x) => x.origin === 'remote' && x.device === 'PUBKEY-DEL-TELEFONO')
  await until(() => w.got.some(remoteWatching))

  r.deliver({ type: 'input', data: 'echo desde-fuera\r' })
  await until(() => w.out().includes('desde-fuera\r\n'), 5000)

  r.close()
  await until(() => w.got.filter((m) => m.type === 'meta').at(-1).console.watchers.every((x) => x.origin !== 'remote'))
  assert.equal(hub.list().length, 1, 'el remoto se va y la ventana local sigue')
  done()
})

test('el título que pone la shell se aparta de la salida, aunque llegue partido', () => {
  const titles = []
  const f = titleFilter((t) => titles.push(t))
  let out = f('hola \x1b]0;us')
  out += f('er@host: ~\x07mundo \x1b]8;;http://x\x1b\\enlace\x1b')
  out += f(']2;otro\x1b\\fin')
  assert.deepEqual(titles, ['user@host: ~', 'otro'])
  assert.equal(out, 'hola mundo \x1b]8;;http://x\x1b\\enlacefin', 'lo que no es título pasa tal cual')
})

test('el título de la shell llega a la lista de consolas', async () => {
  const { dir, hub, done } = await setup()
  const w = await win(dir)
  w.c.send({ type: 'open', cols: 80, rows: 24 })
  await until(() => w.got.some((m) => m.type === 'attached'))
  w.c.send({ type: 'input', data: "printf '\\033]2;mi-proyecto\\007'\r" })
  await until(() => hub.list()[0]?.title === 'mi-proyecto')
  done()
})

test('un segundo agente en la misma carpeta se para y lo dice', async () => {
  const { dir, done } = await setup()
  await assert.rejects(listenLocal({ dir, serve: () => {} }), (e) => e.code === 'EALREADY')
  done()
})

test('la consola abre en la carpeta que pide la ventana, y una que no existe se rechaza', async () => {
  const { dir, done } = await setup()
  const w = await win(dir)
  w.c.send({ type: 'open', cols: 80, rows: 24, cwd: os.tmpdir() })
  await until(() => w.got.some((m) => m.type === 'attached'))
  w.c.send({ type: 'input', data: 'pwd\r' })
  await until(() => w.out().includes(fs.realpathSync(os.tmpdir()) + '\r\n') || w.out().includes(os.tmpdir() + '\r\n'))

  const x = await win(dir)
  x.c.send({ type: 'open', cols: 80, rows: 24, cwd: '/no/existe/esto' })
  await until(() => x.got.some((m) => m.type === 'fail'))
  assert.equal(x.got.find((m) => m.type === 'fail').code, 'bad-cwd')
  done()
})

test('quien mira dice su etiqueta: una ventana reconoce su consola en la lista', async () => {
  const { dir, hub, done } = await setup()
  const w = await win(dir)
  w.c.send({ type: 'open', cols: 80, rows: 24, tag: 'ventana-1' })
  await until(() => w.got.some((m) => m.type === 'attached'))
  const x = await win(dir)
  x.c.send({ type: 'attach', id: hub.list()[0].id, cols: 80, rows: 24, tag: 'ventana-2' })
  await until(() => x.got.some((m) => m.type === 'attached'))
  assert.deepEqual(hub.list()[0].watchers.map((v) => v.tag).sort(), ['ventana-1', 'ventana-2'])
  done()
})
