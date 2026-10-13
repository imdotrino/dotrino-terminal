/**
 * `dotrino-terminal agents` y `dotrino-terminal restart`: tras actualizar el paquete, el agente
 * en marcha sigue con la versión anterior. La app de escritorio pregunta con `agents --json` y,
 * si la persona acepta cerrar sus consolas, lo para con `restart --stale --yes`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '../bin/terminal.js')
const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (_) { return false } }

test('agents dice la versión que corre; restart --stale no toca al que está al día y restart lo para', async () => {
  const { connectLocal } = await import('../local.js')
  // Corto a propósito: la ruta del socket no puede pasar de 103 bytes.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtr-'))
  const dir = path.join(home, 'terminal-agent/p')
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, DOTRINO_AGENT_HOME: home, DOTRINO_NO_UPDATE_NOTICE: '1', SHELL: '/bin/sh' }
  delete env.DOTRINO_TERMINAL_PROFILE_DIR
  const run = (...a) => execFileSync(process.execPath, [CLIENT, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let pid = 0
  try {
    assert.deepEqual(JSON.parse(run('agents', '--json')), { installed: VERSION, agents: [{ name: 'p', running: false, version: null, consoles: 0, stale: false }] })

    // El primer `ls` levanta el agente; se le abre una consola por su socket.
    run('ls', '--name', 'p')
    pid = Number(fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8'))
    const conn = await connectLocal(dir)
    const attached = new Promise((resolve) => conn.on('message', (m) => { if (m.type === 'attached') resolve(m) }))
    conn.send({ type: 'open', cols: 80, rows: 24 })
    await attached
    assert.deepEqual(JSON.parse(run('agents', '--json')).agents, [{ name: 'p', running: true, version: VERSION, consoles: 1, stale: false }])

    assert.match(run('restart', '--stale', '--yes'), /Ningún agente|No agent/)
    assert.ok(alive(pid), 'al día: no se toca')

    const closed = new Promise((resolve) => conn.on('close', resolve))
    run('restart', '--name', 'p', '--yes')
    assert.ok(!alive(pid), 'el agente terminó')
    await Promise.race([closed, sleep(2000).then(() => assert.fail('la ventana no se enteró'))])
    assert.equal(JSON.parse(run('agents', '--json')).agents[0].running, false)
  } finally {
    if (pid && alive(pid)) process.kill(pid)
    fs.rmSync(home, { recursive: true, force: true })
  }
})
