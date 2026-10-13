/**
 * El CLIENTE de una ventana que mira OTRA máquina (`--machine`), en una TTY de verdad: el agente de
 * aquí hace de puente (far.js) con una «otra máquina» en memoria, como en far.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { serveSession, serveLocal, makeHub, loadPty } from '../index.js'
import { listenLocal } from '../local.js'
import { makeFar } from '../far.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '../bin/terminal.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(50) } return false }

test('Ctrl+] n en una ventana que mira otra máquina abre una consola NUEVA allí, no pasa a otra', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-'))
  const dir = path.join(home, 'terminal-agent/p')
  fs.mkdirSync(dir, { recursive: true })
  // La otra máquina: su hub, y una sesión remota con ella por colas en memoria.
  const other = makeHub(loadPty(), { shell: '/bin/sh' })
  const connect = () => {
    const toMachine = { message: [], close: [] }
    const toClient = { message: [], error: [], resumed: [] }
    serveSession({
      device: 'the-window-machine',
      on (ev, cb) { toMachine[ev].push(cb); return this },
      async send (p) { queueMicrotask(() => { for (const cb of [...toClient.message]) cb(p) }) }
    }, other, { origin: 'remote' })
    return {
      on (ev, cb) { toClient[ev].push(cb); return () => { toClient[ev] = toClient[ev].filter((f) => f !== cb) } },
      async send (m) { queueMicrotask(() => { for (const cb of toMachine.message) cb(m) }) },
      close () { for (const cb of toMachine.close) cb() }
    }
  }
  const hub = makeHub(loadPty(), { shell: '/bin/sh' })
  const far = makeFar({ dir, kind: 'terminal-agent', refreshMs: 0, loadLink: () => ({ fake: true }), discover: async () => [{ sub: 's1', id: 'AB12-CD34', name: 'Lejana' }], connect: async () => connect() })
  const local = await listenLocal({ dir, serve: (s) => serveLocal(s, hub, far) })
  fs.writeFileSync(path.join(dir, 'agent.pid'), String(process.pid))
  // Una consola suelta en la otra máquina: a la que NO hay que ir.
  const loose = other.create({ cols: 80, rows: 24, origin: 'local' })
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1' }
  delete env.TERM_PROGRAM
  // Desde una carpeta que solo existe AQUÍ.
  const onlyHere = fs.mkdtempSync(path.join(os.tmpdir(), 'only-here-'))
  const term = pty.spawn(process.execPath, [CLIENT, '--machine', 'AB12-CD34', '--name', 'p'], { cols: 80, rows: 24, env, cwd: onlyHere })
  let out = ''
  term.onData((d) => { out += d })
  try {
    assert.ok(await until(() => other.list().length === 2), 'la ventana abre su consola en la otra máquina')
    fs.rmSync(onlyHere, { recursive: true, force: true })       // esa carpeta no existe en «la otra»
    term.write('echo UNA-$((1+1))\r')
    assert.ok(await until(() => out.includes('UNA-2')))
    term.write('\x1dn')                                         // el «+» del panel
    assert.ok(await until(() => other.list().length === 3), 'una consola nueva, no la suelta')
    assert.equal(other.list().find((c) => c.id === loose.id).viewers, 0, 'la suelta sigue sin nadie')
    assert.equal(hub.list().length, 0, 'y en esta máquina no se creó nada')
  } finally {
    term.kill()
    hub.killAll(); other.killAll(); far.close(); local.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('si la OTRA máquina se reinicia y queda sin consolas, el cliente termina SIN error y lo dice (la app vuelve a las de aquí)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtf-'))
  const dir = path.join(home, 'terminal-agent/p')
  fs.mkdirSync(dir, { recursive: true })
  const other = makeHub(loadPty(), { shell: '/bin/sh' })
  const resumed = []
  const connect = () => {
    const toMachine = { message: [], close: [] }
    const toClient = { message: [], error: [], resumed }
    serveSession({
      device: 'the-window-machine',
      on (ev, cb) { toMachine[ev].push(cb); return this },
      async send (p) { queueMicrotask(() => { for (const cb of [...toClient.message]) cb(p) }) }
    }, other, { origin: 'remote' })
    return {
      on (ev, cb) { toClient[ev].push(cb); return () => { toClient[ev] = toClient[ev].filter((f) => f !== cb) } },
      async send (m) { queueMicrotask(() => { for (const cb of toMachine.message) cb(m) }) },
      close () { for (const cb of toMachine.close) cb() }
    }
  }
  const hub = makeHub(loadPty(), { shell: '/bin/sh' })
  const far = makeFar({ dir, kind: 'terminal-agent', refreshMs: 0, loadLink: () => ({ fake: true }), discover: async () => [{ sub: 's1', id: 'AB12-CD34', name: 'Lejana' }], connect: async () => connect() })
  const local = await listenLocal({ dir, serve: (s) => serveLocal(s, hub, far) })
  fs.writeFileSync(path.join(dir, 'agent.pid'), String(process.pid))
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1' }
  delete env.TERM_PROGRAM
  const term = pty.spawn(process.execPath, [CLIENT, '--machine', 'AB12-CD34', '--name', 'p'], { cols: 80, rows: 24, env })
  let out = ''
  let exited = null
  term.onData((d) => { out += d })
  term.onExit((e) => { exited = e.exitCode })
  try {
    assert.ok(await until(() => other.list().length === 1), 'la ventana abre su consola en la otra máquina')
    term.write('echo UNA-$((1+1))\r')
    assert.ok(await until(() => out.includes('UNA-2')))
    // «Cerrar todas las terminales» en la otra máquina: se van sus consolas y, al volver su
    // agente, la sesión se reanuda y avisa.
    out = ''
    other.killAll()
    for (const cb of [...resumed]) cb()
    assert.ok(await until(() => /ya no tiene consolas|no open consoles left/.test(out)), 'lo dice')
    assert.ok(await until(() => exited !== null), 'y termina')
    assert.equal(exited, 0, 'sin error: no es un fallo, esa máquina cerró sus terminales')
    assert.equal(hub.list().length, 0, 'sin crear nada en esta máquina')
  } finally {
    term.kill()
    hub.killAll(); other.killAll(); far.close(); local.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
