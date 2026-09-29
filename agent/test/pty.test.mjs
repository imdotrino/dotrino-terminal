/**
 * Lo único que este paquete añade a `@dotrino/remote-agent` es la shell. Se prueba con una
 * sesión de mentira y un PTY de verdad: abrir, escribir, leer lo que sale y cerrar.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { servePty, loadPty } from '../index.js'

/** Una sesión como la que entrega `onSession`, sin transporte ni cifrado. */
function fakeSession () {
  const h = { message: [], close: [] }
  const sent = []
  return {
    sent,
    on (ev, cb) { h[ev].push(cb); return this },
    send (p) { sent.push(p) },
    close () { this.closed = true; for (const cb of h.close) cb() },
    deliver (msg) { for (const cb of h.message) cb(msg) }
  }
}

const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('abre una shell, ejecuta lo que se escribe y devuelve la salida', async () => {
  const s = fakeSession()
  servePty(s, loadPty(), { shell: '/bin/sh' })
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  s.deliver({ type: 'input', data: 'echo dotrino-$((40+2))\r' })
  await until(() => s.sent.some((p) => p.type === 'out' && p.data.includes('dotrino-42')))
  s.deliver({ type: 'close' })
  assert.equal(s.closed, true)
})

test('al salir la shell se avisa con su código', async () => {
  const s = fakeSession()
  servePty(s, loadPty(), { shell: '/bin/sh' })
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  s.deliver({ type: 'input', data: 'exit 3\r' })
  await until(() => s.sent.some((p) => p.type === 'exit'))
  assert.equal(s.sent.find((p) => p.type === 'exit').code, 3)
})

test('cerrar la sesión mata la shell', async () => {
  const s = fakeSession()
  servePty(s, loadPty(), { shell: '/bin/sh' })
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  s.close()
  // Tras cerrar, lo que se escriba ya no llega a ninguna shell.
  s.deliver({ type: 'input', data: 'echo tarde\r' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(s.sent.some((p) => p.type === 'out' && p.data.includes('tarde')), false)
})
