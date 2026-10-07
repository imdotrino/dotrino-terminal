/**
 * La clave de la máquina (access.js): opcional, y cuando está puesta ninguna sesión remota
 * hace nada sin escribirla. Sesiones de mentira, como en pty.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveSession, makeHub, loadPty } from '../index.js'
import { makeGate, setAccessCode, clearAccessCode, hasAccessCode, checkAccessCode, ACCESS_FILE, FREE_TRIES } from '../access.js'

function fakeSession () {
  const h = { message: [], close: [] }
  const sent = []
  return {
    sent,
    on (ev, cb) { h[ev].push(cb); return this },
    async send (p) { sent.push(p) },
    close () { for (const cb of h.close) cb() },
    deliver (msg) { for (const cb of h.message) cb(msg) },
    last () { return sent[sent.length - 1] }
  }
}
const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'term-access-'))
const hub = () => makeHub(loadPty(), { shell: '/bin/sh' })

test('sin clave puesta, una sesión remota entra como siempre', async () => {
  const dir = tmp(); const h = hub()
  assert.equal(hasAccessCode(dir), false)
  const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate: makeGate(dir) })
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => s.sent.some((p) => p.type === 'attached'))
  h.killAll()
})

test('con clave, sin escribirla no se lista, no se abre y no se escribe', async () => {
  const dir = tmp(); const h = hub()
  setAccessCode(dir, '4821')
  const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate: makeGate(dir) })
  for (const msg of [{ type: 'list' }, { type: 'open', cols: 80, rows: 24 }, { type: 'input', data: 'id\r' }, { type: 'kill', id: 'x' }]) {
    s.deliver(msg)
    assert.equal(s.last().type, 'fail'); assert.equal(s.last().code, 'locked')
  }
  assert.equal(h.list().length, 0, 'no se abrió ninguna consola')
  h.killAll()
})

test('con la clave buena la conexión queda abierta; la mala dice bad-code y no abre', async () => {
  const dir = tmp(); const h = hub()
  setAccessCode(dir, 'una contraseña larga')
  const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate: makeGate(dir) })
  s.deliver({ type: 'unlock', code: 'otra' })
  assert.equal(s.last().code, 'bad-code')
  s.deliver({ type: 'list' })
  assert.equal(s.last().code, 'locked')
  s.deliver({ type: 'unlock', code: 'una contraseña larga' })
  assert.equal(s.last().type, 'unlocked')
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => s.sent.some((p) => p.type === 'attached'))
  h.killAll()
})

test('la clave vale por conexión: otra sesión la tiene que escribir', () => {
  const dir = tmp(); const h = hub(); const gate = makeGate(dir)
  setAccessCode(dir, '4821')
  const a = fakeSession(); serveSession(a, h, { origin: 'remote', gate })
  a.deliver({ type: 'unlock', code: '4821' })
  assert.equal(a.last().type, 'unlocked')
  const b = fakeSession(); serveSession(b, h, { origin: 'remote', gate })
  b.deliver({ type: 'list' })
  assert.equal(b.last().code, 'locked')
  h.killAll()
})

test('las ventanas de esta máquina no la piden', async () => {
  const dir = tmp(); const h = hub()
  setAccessCode(dir, '4821')
  const s = fakeSession(); serveSession(s, h, { origin: 'local', gate: makeGate(dir) })
  s.deliver({ type: 'list' })
  await until(() => s.sent.some((p) => p.type === 'consoles'))
  h.killAll()
})

test('los fallos se frenan por agente: abrir otra conexión no da intentos nuevos', () => {
  const dir = tmp(); const h = hub()
  let t = 1_000_000
  const gate = makeGate(dir, { now: () => t })
  setAccessCode(dir, '4821')
  for (let i = 0; i < FREE_TRIES; i++) {
    const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate })
    s.deliver({ type: 'unlock', code: 'mala' })
    assert.equal(s.last().code, 'bad-code')
  }
  const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate })
  s.deliver({ type: 'unlock', code: '4821' })               // la buena, pero toca esperar
  assert.equal(s.last().code, 'wait')
  assert.ok(s.last().retryMs > 0)
  t += s.last().retryMs + 1
  s.deliver({ type: 'unlock', code: '4821' })
  assert.equal(s.last().type, 'unlocked')
  h.killAll()
})

test('un archivo de clave que no se puede leer NO es «sin clave»: nadie entra', () => {
  const dir = tmp(); const h = hub()
  fs.writeFileSync(path.join(dir, ACCESS_FILE), '{ roto')
  const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate: makeGate(dir) })
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  assert.equal(s.last().code, 'access-unreadable')
  s.deliver({ type: 'unlock', code: 'lo que sea' })
  assert.equal(s.last().code, 'access-unreadable')
  assert.equal(h.list().length, 0)
  h.killAll()
})

test('poner, comprobar y quitar; en el disco no queda la clave', () => {
  const dir = tmp()
  assert.throws(() => setAccessCode(dir, '123'), { code: 'too-short' })
  setAccessCode(dir, '4821')
  assert.equal(checkAccessCode(dir, '4821'), true)
  assert.equal(checkAccessCode(dir, '4822'), false)
  assert.ok(!fs.readFileSync(path.join(dir, ACCESS_FILE), 'utf8').includes('4821'))
  clearAccessCode(dir)
  assert.equal(hasAccessCode(dir), false)
})

test('en caliente: poner la clave con el agente en marcha cierra el paso a quien ya estaba; quitarla lo abre', async () => {
  const dir = tmp(); const h = hub()
  const s = fakeSession(); serveSession(s, h, { origin: 'remote', gate: makeGate(dir) })
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => s.sent.some((p) => p.type === 'attached'))
  setAccessCode(dir, '4821')                          // `dotrino-terminal lock`, sin reiniciar nada
  s.deliver({ type: 'input', data: 'id\r' })
  assert.equal(s.last().code, 'locked')
  clearAccessCode(dir)                                // `dotrino-terminal lock --off`
  s.deliver({ type: 'list' })
  await until(() => s.sent.some((p) => p.type === 'consoles'))
  h.killAll()
})

test('tres fallos seguidos de UN aparato avisan una vez; acertar corta la racha', () => {
  const dir = tmp(); setAccessCode(dir, 'buena')
  const avisos = []
  let t = 0
  const g = makeGate(dir, { now: () => t, onIncident: (i) => avisos.push(i) })
  const falla = (dev) => { try { g.check('mala', dev); assert.fail('tenía que fallar') } catch (e) { return e } }
  // Dos aparatos distintos: los fallos se cuentan por aparato, el freno por agente.
  falla('A'); falla('B')
  // Tercer fallo del agente: empieza la espera local (bloqueo del servicio, nada más).
  const tercero = falla('A')
  assert.equal(tercero.code, 'bad-code')
  assert.ok(tercero.retryMs > 0, 'a los tres fallos del agente ya toca esperar')
  assert.equal(avisos.length, 0, 'A lleva dos: todavía no es incidente')
  t = tercero.retryMs + 1
  falla('A')
  assert.deepEqual(avisos, [{ device: 'A', tries: 3 }], 'avisa de A, que es quien lleva tres')
  t += 60 * 60_000
  falla('A')
  assert.equal(avisos.length, 1, 'no se repite en cada fallo')
  // Acierta: la racha de A se corta y el próximo tercer fallo vuelve a avisar.
  t += 2 * 60 * 60_000
  g.check('buena', 'A')
  falla('A'); falla('A'); falla('A')
  assert.equal(avisos.length, 2)
  // Sin aparato (la clave local) no hay a quién señalar.
  t += 60 * 60_000
  falla(null); falla(null); falla(null)
  assert.equal(avisos.length, 2)
})
