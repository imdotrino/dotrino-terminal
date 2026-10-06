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

test('el TAMAÑO con tres aparatos: lo tiene quien lo fija (⤢) o el último que llegó; escribir no lo cambia', async () => {
  const h = hub()
  try {
    const sizeOf = (id) => `${h.get(id).cols}x${h.get(id).rows}`
    const pc = fakeSession(); serveSession(pc, h, { origin: 'local' })
    pc.deliver({ type: 'open', cols: 120, rows: 40 })
    await until(() => pc.sent.some((p) => p.type === 'attached'))
    const id = pc.sent.find((p) => p.type === 'attached').id
    assert.equal(sizeOf(id), '120x40', 'quien la abre tiene el tamaño')

    const tel = fakeSession(); tel.device = 'TEL'; serveSession(tel, h, { origin: 'remote' })
    tel.deliver({ type: 'attach', id, cols: 40, rows: 20 })
    await until(() => sizeOf(id) === '40x20')
    await until(() => pc.sent.some((p) => p.type === 'meta' && p.console.cols === 40), 2000)

    pc.deliver({ type: 'input', data: 'x' })
    pc.deliver({ type: 'resize', cols: 130, rows: 40 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(sizeOf(id), '40x20', 'ni escribir ni redimensionar desde quien NO tiene el tamaño lo cambia')

    const tab = fakeSession(); tab.device = 'TAB'; serveSession(tab, h, { origin: 'remote' })
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

    // La elección es de la PANTALLA, no de la conexión: el PC pasa a otra consola y vuelve, y la
    // recupera aunque el teléfono haya llegado después.
    pc.deliver({ type: 'attach', id, cols: 130, rows: 40 })
    await until(() => sizeOf(id) === '130x40')
    assert.equal(h.get(id).info().sizeBy.pinned, true, 'al volver, sigue siendo la que eligió')
    tel.deliver({ type: 'resize', cols: 30, rows: 40 })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(sizeOf(id), '130x40', 'y el teléfono no se lo quita')
  } finally { h.killAll() }
})

test('quien cierra una consola: las DEMÁS pantallas saben que no fueron ellas (closedBy)', async () => {
  const h = hub()
  try {
    const exitOf = (s) => s.sent.find((p) => p.type === 'exit')
    // La ventana del PC abre una consola; el teléfono la mira y la cierra.
    const pc = fakeSession(); serveSession(pc, h, { origin: 'local' })
    pc.deliver({ type: 'open', cols: 80, rows: 24 })
    await until(() => pc.sent.some((p) => p.type === 'attached'))
    const id = pc.sent.find((p) => p.type === 'attached').id
    const tel = fakeSession(); tel.device = 'TEL'; serveSession(tel, h, { origin: 'remote' })
    tel.deliver({ type: 'attach', id, cols: 40, rows: 20 })
    await until(() => tel.sent.some((p) => p.type === 'attached'))
    tel.deliver({ type: 'kill', id })
    await until(() => exitOf(pc) && exitOf(tel))
    assert.equal(exitOf(pc).closedBy, 'other', 'a la ventana se la cerró otra pantalla')
    assert.equal(exitOf(tel).closedBy, undefined, 'el teléfono la cerró él mismo')

    // La shell que termina sola (exit) no es «otra pantalla» para nadie.
    const w = fakeSession(); serveSession(w, h, { origin: 'local' })
    w.deliver({ type: 'open', cols: 80, rows: 24 })
    await until(() => w.sent.some((p) => p.type === 'attached'))
    w.deliver({ type: 'input', data: 'exit\r' })
    await until(() => exitOf(w))
    assert.equal(exitOf(w).closedBy, undefined)
  } finally { h.killAll() }
})

test('ACTIVIDAD: un título que cambia de seguido es trabajo (así giran Claude y Codex), y «terminó» dura hasta que alguien la atiende', async () => {
  const h = makeHub(loadPty(), { shell: '/bin/sh', quietMs: 2000 })
  try {
    const s = fakeSession(); serveSession(s, h, { origin: 'local' })
    s.deliver({ type: 'open', cols: 80, rows: 24 })
    await until(() => s.sent.some((p) => p.type === 'attached'))
    const id = s.sent.find((p) => p.type === 'attached').id
    const info = () => h.get(id).info()
    assert.equal(info().activity, 'idle')
    // Solo cambia el título, una vez por segundo; en la pantalla no sale nada. No se lee QUÉ dice.
    s.deliver({ type: 'input', data: "for i in 1 2 3 4 5; do printf '\\033]0;paso %s\\007' $i; sleep 1; done\r" })
    await until(() => info().activity === 'busy', 4000)
    assert.equal(info().doneAt, null, 'trabajando no es terminado')
    await until(() => info().activity === 'idle' && info().doneAt != null, 9000)
    assert.ok(s.sent.some((p) => p.type === 'meta' && p.console.activity === 'busy'), 'y quien mira se entera sin preguntar')
    // Atenderla (teclear en ella) apaga el «terminó».
    s.deliver({ type: 'input', data: ' ' })
    await until(() => info().doneAt == null)
  } finally { h.killAll() }
})

test('ACTIVIDAD: contenido que cambia de seguido es trabajo, el eco de teclear no, y el silencio la termina', async () => {
  // Diez segundos sin cambios por defecto; aquí, 2 s para no esperar.
  const h = makeHub(loadPty(), { shell: '/bin/sh', quietMs: 2000 })
  try {
    const s = fakeSession(); serveSession(s, h, { origin: 'local' })
    s.deliver({ type: 'open', cols: 80, rows: 24 })
    await until(() => s.sent.some((p) => p.type === 'attached'))
    const id = s.sent.find((p) => p.type === 'attached').id
    const info = () => h.get(id).info()
    // Teclear (y su eco) no es trabajar.
    for (const ch of 'echo hola') { s.deliver({ type: 'input', data: ch }); await new Promise((r) => setTimeout(r, 60)) }
    s.deliver({ type: 'input', data: '\r' })
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(info().activity, 'idle', 'un comando instantáneo no enciende nada')
    // Dos ráfagas sueltas, separadas por segundos, tampoco (el prompt al cambiar de tamaño…).
    s.deliver({ type: 'input', data: 'sleep 0.6; echo uno; sleep 2.6; echo dos\r' })
    await new Promise((r) => setTimeout(r, 4200))
    assert.equal(info().activity, 'idle', 'ráfagas sueltas no son trabajo')
    // Un comando que va escribiendo durante un rato, sí.
    s.deliver({ type: 'input', data: 'for i in 1 2 3 4 5 6 7 8; do echo paso $i; sleep 0.5; done\r' })
    await until(() => info().activity === 'busy', 5000)
    await until(() => info().activity === 'idle' && info().doneAt != null, 9000)
  } finally { h.killAll() }
})


