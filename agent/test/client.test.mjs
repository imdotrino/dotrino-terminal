/**
 * El CLIENTE de una ventana (`bin/terminal.js`) en una TTY de verdad, contra un agente de verdad.
 *
 * Cubre el fallo del 2026-10-05: elegir en el panel una consola que ya no existía (el panel de la
 * app iba un instante por detrás) hacía que el cliente recibiera `no-console`, lo tratara como
 * fatal y terminara — y la ventana se cerraba con él. El agente rechaza ANTES de soltar la consola
 * actual, así que lo correcto es seguir en ella.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '../bin/terminal.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('pedir una consola que ya no existe NO termina el cliente: sigue en la suya', async () => {
  // Corto a propósito: la ruta del socket no puede pasar de 103 bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-'))
  fs.mkdirSync(path.join(home, 'terminal-agent/p'), { recursive: true })
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1', SHELL: '/bin/sh' }
  const term = pty.spawn(process.execPath, [CLIENT, 'open', '--name', 'p'], { cols: 80, rows: 24, env })
  let out = ''
  let exited = null
  term.onData((d) => { out += d })
  term.onExit((e) => { exited = e.exitCode })
  const until = async (fn, ms = 8000) => { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(50) } return false }
  try {
    term.write('echo ANTES-$((1+1))\r')
    assert.ok(await until(() => out.includes('ANTES-2')), 'la consola arranca y responde')

    out = ''
    term.write('\x1dadeadbeefdeadbeef\r')            // Ctrl+] a <id que no existe> Enter
    assert.ok(await until(() => out.includes('ANTES-2')), 'repinta la consola que tenía')
    assert.equal(exited, null, 'y el cliente sigue vivo')

    term.write('echo DESPUES-$((2+2))\r')
    assert.ok(await until(() => out.includes('DESPUES-4')), 'sigue aceptando teclas')
  } finally {
    term.kill()
    const pidFile = path.join(home, 'terminal-agent/p/agent.pid')
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim())) } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('si OTRA pantalla le cierra la consola y no queda ninguna, la ventana sigue SIN consola: no crea una hasta que se pide', async () => {
  const { connectLocal } = await import('../local.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-'))
  const dir = path.join(home, 'terminal-agent/p')
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1', SHELL: '/bin/sh' }
  const term = pty.spawn(process.execPath, [CLIENT, 'open', '--name', 'p'], { cols: 80, rows: 24, env })
  let out = ''
  let exited = null
  term.onData((d) => { out += d })
  term.onExit((e) => { exited = e.exitCode })
  const until = async (fn, ms = 8000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(50) } return false }
  const other = { conn: null }
  const list = () => new Promise((resolve) => {
    const c = other.conn
    const on = (m) => { if (m.type === 'consoles') { c.off?.('message', on); resolve(m.list) } }
    c.on('message', on); c.send({ type: 'list' })
  })
  try {
    term.write('echo VIEJA-$((1+1))\r')
    assert.ok(await until(() => out.includes('VIEJA-2')))
    other.conn = await connectLocal(dir)
    const before = await list()
    assert.equal(before.length, 1)
    out = ''
    other.conn.send({ type: 'kill', id: before[0].id })          // otra pantalla la cierra
    assert.ok(await until(() => /No hay consolas|No open consoles/.test(out)), 'lo dice')
    await sleep(300)
    assert.equal(exited, null, 'el cliente sigue vivo')
    assert.equal((await list()).length, 0, 'y no creó una consola nueva')
    term.write('echo PERDIDO\r')                                  // sin consola: no va a ningún sitio
    term.write('\x1dn')                                           // Ctrl+] n: ahora sí, una nueva
    assert.ok(await until(async () => (await list()).length === 1), 'se abre al pedirla')
    out = ''
    term.write('echo NUEVA-$((3+3))\r')
    assert.ok(await until(() => out.includes('NUEVA-6')), 'y responde')
    assert.ok(!out.includes('PERDIDO'), 'lo tecleado sin consola no llegó a la nueva')
  } finally {
    term.kill()
    try { other.conn?.close() } catch (_) {}
    try { process.kill(Number(fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8').trim())) } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('si OTRA pantalla le cierra la consola y queda otra, pasa a esa: no crea una nueva, aunque esté abierta en otro lado', async () => {
  const { connectLocal } = await import('../local.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-'))
  const dir = path.join(home, 'terminal-agent/p')
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1', SHELL: '/bin/sh' }
  const term = pty.spawn(process.execPath, [CLIENT, 'open', '--name', 'p'], { cols: 80, rows: 24, env })
  let out = ''
  let exited = null
  term.onData((d) => { out += d })
  term.onExit((e) => { exited = e.exitCode })
  const until = async (fn, ms = 8000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(50) } return false }
  const other = { conn: null }
  const list = () => new Promise((resolve) => {
    const c = other.conn
    const on = (m) => { if (m.type === 'consoles') { c.off?.('message', on); resolve(m.list) } }
    c.on('message', on); c.send({ type: 'list' })
  })
  try {
    term.write('echo VIEJA-$((1+1))\r')
    assert.ok(await until(() => out.includes('VIEJA-2')))
    other.conn = await connectLocal(dir)
    const before = await list()
    assert.equal(before.length, 1)
    // La otra pantalla abre SU consola y se queda mirándola: es la única que quedará.
    other.conn.send({ type: 'open', cols: 80, rows: 24 })
    let kept = null
    assert.ok(await until(async () => { kept = (await list()).find((c) => c.id !== before[0].id); return kept?.watchers.length === 1 }), 'la que queda está abierta en otro lado')
    out = ''
    other.conn.send({ type: 'kill', id: before[0].id })          // y le cierra la suya a la ventana
    assert.ok(await until(async () => { const l = await list(); return l.length === 1 && l[0].watchers.length === 2 }), 'la ventana pasó a la que quedaba')
    assert.deepEqual((await list()).map((c) => c.id), [kept.id], 'sin consola nueva')
    assert.equal(exited, null, 'el cliente sigue vivo')
    assert.ok(!out.includes('Esta es una nueva') && !out.includes('This is a new one'), 'no anuncia una consola nueva')
    term.write('echo SIGUE-$((4+4))\r')
    assert.ok(await until(() => out.includes('SIGUE-8')), 'y la consola responde')
  } finally {
    term.kill()
    try { other.conn?.close() } catch (_) {}
    try { process.kill(Number(fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8').trim())) } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('`exit` cierra la consola, no la ventana: pasa a otra que nadie mira y, sin ninguna, queda sin consola', async () => {
  const { connectLocal } = await import('../local.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtc-'))
  const dir = path.join(home, 'terminal-agent/p')
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1', SHELL: '/bin/sh' }
  const term = pty.spawn(process.execPath, [CLIENT, 'open', '--name', 'p'], { cols: 80, rows: 24, env })
  let out = ''
  let exited = null
  term.onData((d) => { out += d })
  term.onExit((e) => { exited = e.exitCode })
  const until = async (fn, ms = 8000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(50) } return false }
  let other = null
  const list = () => new Promise((resolve) => {
    const on = (m) => { if (m.type === 'consoles') { other.off?.('message', on); resolve(m.list) } }
    other.on('message', on); other.send({ type: 'list' })
  })
  try {
    term.write('echo UNA-$((1+1))\r')
    assert.ok(await until(() => out.includes('UNA-2')))
    other = await connectLocal(dir)
    other.send({ type: 'open', cols: 80, rows: 24 })               // una segunda consola…
    assert.ok(await until(async () => (await list()).length === 2))
    other.send({ type: 'detach' })                                 // …que nadie mira
    assert.ok(await until(async () => (await list()).some((c) => !c.watchers.length)))
    term.write('exit\r')
    assert.ok(await until(async () => { const l = await list(); return l.length === 1 && l[0].watchers.length === 1 }), 'pasa a la otra')
    assert.equal(exited, null, 'el cliente sigue vivo')
    out = ''
    term.write('echo OTRA-$((3+3))\r')
    assert.ok(await until(() => out.includes('OTRA-6')), 'y la otra responde')
    term.write('exit\r')
    assert.ok(await until(() => /No hay consolas|No open consoles/.test(out)), 'sin ninguna, lo dice')
    assert.equal(exited, null, 'y sigue vivo')
    assert.equal((await list()).length, 0)
  } finally {
    term.kill()
    try { other?.close() } catch (_) {}
    try { process.kill(Number(fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8').trim())) } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true })
  }
})
