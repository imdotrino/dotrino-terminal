/**
 * Cambiarse de consola a media pantalla: lo que todavía iba saliendo de la consola que se
 * dejó NO sigue saliendo, y lo que sale lleva el `id` de su consola. Sin esto, el historial
 * de A (que va en trozos y empieza por un reinicio de la terminal) seguía llegando después de
 * cambiarse a B y tapaba su pantalla (2026-10-14).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serveSession, makeHub, loadPty } from '../index.js'

const until = async (cond, ms = 10000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Una sesión remota sin transporte. `send` tarda: así hay tiempo de cambiar de consola entre trozo y trozo. */
function slowSession ({ sendMs = 30, direct = () => true } = {}) {
  const h = { message: [], close: [] }
  const sent = []
  return {
    device: 'phone',
    sent,
    on (ev, cb) { h[ev].push(cb); return this },
    async send (p) { await new Promise((r) => setTimeout(r, sendMs)); sent.push(p) },
    direct,
    whenDirect: async () => direct(),
    close () { for (const cb of h.close) cb() },
    deliver (m) { for (const cb of h.message) cb(m) }
  }
}

test('la salida lleva el id de su consola, y al cambiarse no sigue saliendo lo de la anterior', async () => {
  const hub = makeHub(loadPty(), { shell: '/bin/sh' })
  try {
    // La consola A, con historial de sobra (varios trozos de `pieces`).
    const a = hub.create({ cols: 80, rows: 24, origin: 'remote' })
    const b = hub.create({ cols: 80, rows: 24, origin: 'remote' })
    const probe = slowSession({ sendMs: 0 })
    serveSession(probe, hub, { origin: 'remote' })
    probe.deliver({ type: 'attach', id: a.id, cols: 80, rows: 24 })
    await until(() => probe.sent.some((m) => m.type === 'attached'))
    probe.deliver({ type: 'input', data: 'i=0; while [ $i -lt 3000 ]; do echo "line $i ................................................................"; i=$((i+1)); done; echo FIN-A\r' })
    await until(() => probe.sent.some((m) => m.type === 'out' && m.data.includes('FIN-A')))
    assert.ok(a.hasHistory(), 'A tiene historial')
    assert.ok(probe.sent.filter((m) => m.type === 'out').every((m) => m.id === a.id), 'cada `out` dice de qué consola es')
    probe.deliver({ type: 'detach' })

    // El teléfono: sin canal directo al engancharse (solo la pantalla), y el directo abre enseguida
    // (el historial sale después, en trozos lentos).
    let isDirect = false
    const s = slowSession({ sendMs: 30, direct: () => isDirect })
    serveSession(s, hub, { origin: 'remote' })
    s.deliver({ type: 'attach', id: a.id, cols: 80, rows: 24 })
    await until(() => s.sent.some((m) => m.type === 'attached' && m.id === a.id))
    isDirect = true
    // En cuanto sale el primer trozo del historial de A, se cambia a B.
    await until(() => s.sent.filter((m) => m.type === 'replay' && m.id === a.id).length >= 2)
    const atSwitch = s.sent.length
    s.deliver({ type: 'attach', id: b.id, cols: 80, rows: 24 })
    await until(() => s.sent.some((m) => m.type === 'attached' && m.id === b.id))
    await new Promise((r) => setTimeout(r, 300))
    const attachedB = s.sent.findIndex((m) => m.type === 'attached' && m.id === b.id)
    const lateA = s.sent.slice(attachedB).filter((m) => (m.type === 'replay' || m.type === 'out') && m.id === a.id)
    assert.equal(lateA.length, 0, 'nada de A después de engancharse a B')
    // Como mucho el trozo que ya estaba en camino: el resto del historial de A no sale.
    assert.ok(s.sent.slice(atSwitch).filter((m) => m.type === 'replay' && m.id === a.id).length <= 1, 'el historial de A se cortó')
    // Y lo que B escribe desde entonces llega con su id.
    s.deliver({ type: 'input', data: 'echo FIN-B\r' })
    await until(() => s.sent.some((m) => m.type === 'out' && m.id === b.id && m.data.includes('FIN-B')))
  } finally {
    hub.killAll()
  }
})
