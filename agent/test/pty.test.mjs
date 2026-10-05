/**
 * Lo que este paquete añade a `@dotrino/remote-agent`: las consolas. Se prueba con sesiones
 * de mentira y un PTY de verdad. Lo que se fija es la promesa de las sesiones persistentes:
 * irse no mata la shell, y al volver se ve la pantalla como estaba.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { serveSession, makeHub, loadPty } from '../index.js'

/** Una sesión como la que entrega `onSession`, sin transporte ni cifrado. */
function fakeSession () {
  const h = { message: [], close: [] }
  const sent = []
  return {
    sent,
    on (ev, cb) { h[ev].push(cb); return this },
    async send (p) { sent.push(p) },
    close () { for (const cb of h.close) cb() },
    deliver (msg) { for (const cb of h.message) cb(msg) },
    out () { return this.sent.filter((p) => p.type === 'out' || p.type === 'replay').map((p) => p.data).join('') }
  }
}

const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const hub = () => makeHub(loadPty(), { shell: '/bin/sh' })

test('abre una consola, ejecuta lo que se escribe y devuelve la salida', async () => {
  const h = hub()
  const s = fakeSession(); serveSession(s, h)
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => s.sent.some((p) => p.type === 'attached' && p.fresh))
  s.deliver({ type: 'input', data: 'echo dotrino-$((40+2))\r' })
  await until(() => s.out().includes('dotrino-42'))
  h.killAll()
})

test('irse NO mata la consola, y al volver se ve lo que había en pantalla', async () => {
  const h = hub()
  const a = fakeSession(); serveSession(a, h)
  a.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => a.sent.some((p) => p.type === 'attached'))
  const id = a.sent.find((p) => p.type === 'attached').id
  a.deliver({ type: 'input', data: 'echo antes-de-irme\r' })
  await until(() => a.out().includes('antes-de-irme\r\n'))
  a.close()                                             // el navegador se fue

  assert.equal(h.list().length, 1, 'la consola sigue viva')
  assert.equal(h.list()[0].viewers, 0, 'y sin nadie mirando')

  const b = fakeSession(); serveSession(b, h)             // otro aparato, o el mismo tras recargar
  b.deliver({ type: 'list' })
  await until(() => b.sent.some((p) => p.type === 'consoles'))
  assert.deepEqual(b.sent.find((p) => p.type === 'consoles').list.map((c) => c.id), [id])

  b.deliver({ type: 'attach', id, cols: 80, rows: 24 })
  await until(() => b.sent.some((p) => p.type === 'attached'))
  const replay = b.sent.filter((p) => p.type === 'replay')
  assert.ok(replay.length >= 1 && replay.at(-1).last, 'la repetición termina con last')
  assert.ok(replay.map((p) => p.data).join('').includes('antes-de-irme'), 'la pantalla vuelve como estaba')

  b.deliver({ type: 'input', data: 'echo ya-volvi\r' })
  await until(() => b.out().includes('ya-volvi\r\n'))
  h.killAll()
})

test('la × (close) sí mata la consola, y quien vuelva se entera de que no existe', async () => {
  const h = hub()
  const a = fakeSession(); serveSession(a, h)
  a.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => a.sent.some((p) => p.type === 'attached'))
  const id = a.sent.find((p) => p.type === 'attached').id
  a.deliver({ type: 'close' })
  await until(() => a.sent.some((p) => p.type === 'exit'))
  assert.equal(h.list().length, 0)

  const b = fakeSession(); serveSession(b, h)
  b.deliver({ type: 'attach', id, cols: 80, rows: 24 })
  await until(() => b.sent.some((p) => p.type === 'fail'))
  assert.equal(b.sent.find((p) => p.type === 'fail').code, 'no-console')
})

test('dos aparatos mirando la misma consola ven lo mismo', async () => {
  const h = hub()
  const a = fakeSession(); serveSession(a, h)
  a.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => a.sent.some((p) => p.type === 'attached'))
  const id = a.sent.find((p) => p.type === 'attached').id
  const b = fakeSession(); serveSession(b, h)
  b.deliver({ type: 'attach', id, cols: 80, rows: 24 })
  await until(() => b.sent.some((p) => p.type === 'attached'))
  b.deliver({ type: 'input', data: 'echo los-dos\r' })
  await until(() => a.out().includes('los-dos\r\n') && b.out().includes('los-dos\r\n'))
  h.killAll()
})

test('si la shell termina sola, se avisa con su código y deja de listarse', async () => {
  const h = hub()
  const s = fakeSession(); serveSession(s, h)
  s.deliver({ type: 'open', cols: 80, rows: 24 })
  await until(() => s.sent.some((p) => p.type === 'attached'))
  s.deliver({ type: 'input', data: 'exit 3\r' })
  await until(() => s.sent.some((p) => p.type === 'exit'))
  assert.equal(s.sent.find((p) => p.type === 'exit').code, 3)
  assert.equal(h.list().length, 0)
})

test('cada consola tiene un número fijo: al cerrar la 1, la 2 sigue siendo 2 y la próxima es la 1', async () => {
  const h = hub()
  const open = async () => {
    const s = fakeSession(); serveSession(s, h)
    s.deliver({ type: 'open', cols: 80, rows: 24 })
    await until(() => s.sent.some((p) => p.type === 'attached'))
    return s.sent.find((p) => p.type === 'attached').id
  }
  const a = await open(); const b = await open()
  assert.deepEqual(h.list().map((c) => c.n), [1, 2])
  h.kill(a)
  await until(() => h.list().length === 1)
  assert.equal(h.list()[0].n, 2, 'la 2 sigue siendo la 2')
  await open()
  assert.deepEqual(h.list().map((c) => [c.n, c.id === b]), [[1, false], [2, true]], 'la nueva toma el 1')
  h.killAll()
})

test('el TAMAÑO con tres aparatos: lo tiene quien lo fija (📌) o el último que llegó; escribir no lo cambia', async () => {
  const h = hub()
  try {
    const sizeOf = (id) => `${h.get(id).cols}x${h.get(id).rows}`
    const pc = fakeSession(); serveSession(pc, h, { origin: 'local' })
    pc.deliver({ type: 'open', cols: 120, rows: 40 })
    await until(() => pc.sent.some((p) => p.type === 'attached'))
    const id = pc.sent.find((p) => p.type === 'attached').id
    assert.equal(sizeOf(id), '120x40', 'quien la abre tiene el tamaño')

    const tel = fakeSession(); serveSession(tel, h, { origin: 'remote', device: 'TEL' }); tel.device = 'TEL'
    tel.deliver({ type: 'attach', id, cols: 40, rows: 20 })
    await until(() => sizeOf(id) === '40x20')
    await until(() => pc.sent.some((p) => p.type === 'meta' && p.console.cols === 40), 2000)

    pc.deliver({ type: 'input', data: 'x' })
    pc.deliver({ type: 'resize', cols: 130, rows: 40 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(sizeOf(id), '40x20', 'ni escribir ni redimensionar desde quien NO tiene el tamaño lo cambia')

    const tab = fakeSession(); serveSession(tab, h, { origin: 'remote' })
    tab.deliver({ type: 'attach', id, cols: 80, rows: 30 })
    await until(() => sizeOf(id) === '80x30')
    assert.equal(h.get(id).info().sizeBy.pinned, false, 'el último que llegó, sin fijar')

    tel.deliver({ type: 'pin', on: true })
    await until(() => sizeOf(id) === '40x20')
    tab.deliver({ type: 'resize', cols: 90, rows: 30 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(sizeOf(id), '40x20', 'con el teléfono fijado, la tablet no lo cambia')
    tel.deliver({ type: 'resize', cols: 20, rows: 40 })
    await until(() => sizeOf(id) === '20x40')  // girar el teléfono fijado: se sigue

    pc.deliver({ type: 'pin', on: true })
    await until(() => sizeOf(id) === '130x40')
    assert.equal(h.get(id).info().sizeBy.pinned, true, 'el último que fija se lo queda')

    pc.deliver({ type: 'detach' })
    await until(() => sizeOf(id) === '90x30')  // se fue el fijado: vuelve al último que llegó (la tablet)

    tab.deliver({ type: 'detach' })
    await until(() => sizeOf(id) === '20x40')  // y si se va también, al que queda
  } finally { h.killAll() }
})
