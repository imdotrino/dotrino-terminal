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

test('si OTRA pantalla le cierra la consola, la ventana no se va: abre una nueva', async () => {
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
    assert.ok(await until(async () => { const l = await list(); return l.length === 1 && l[0].id !== before[0].id }), 'hay una consola nueva en su lugar')
    assert.equal(exited, null, 'el cliente sigue vivo')
    term.write('echo NUEVA-$((3+3))\r')
    assert.ok(await until(() => out.includes('NUEVA-6')), 'y la consola nueva responde')
  } finally {
    term.kill()
    try { other.conn?.close() } catch (_) {}
    try { process.kill(Number(fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8').trim())) } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true })
  }
})

