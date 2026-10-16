/**
 * Windows, de verdad: la tubería con nombre, PowerShell por ConPTY y el servicio de inicio de
 * sesión (`HKCU\…\Run` + supervisor). Corre solo en Windows (el runner `windows-latest` de CI).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveSession, makeHub, loadPty } from '../index.js'
import { listenLocal, connectLocal, pipeFile } from '../local.js'
import { installService, uninstallService, serviceStatus, RUN_KEY, runValue, supervisorPidFile } from '../service.js'

const skip = process.platform !== 'win32'
const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

const until = async (cond, ms = 15000) => {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const readPid = (file) => { try { return Number(fs.readFileSync(file, 'utf8')) || 0 } catch (_) { return 0 } }

async function setup () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-'))
  const hub = makeHub(loadPty(), { shell: 'powershell.exe' })
  const local = await listenLocal({ dir, serve: (s) => serveSession(s, hub, { origin: 'local' }) })
  return { dir, hub, local, done: () => { hub.killAll(); local.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('una ventana abre PowerShell por la tubería con nombre y la usa', { skip }, async () => {
  const { dir, local, done } = await setup()
  assert.match(local.path, /^\\\\\.\\pipe\\dotrino-terminal-[0-9a-f]{32}$/)
  const c = await connectLocal(dir)
  const got = []
  c.on('message', (m) => got.push(m))
  const out = () => got.filter((m) => m.type === 'out' || m.type === 'replay').map((m) => m.data).join('')
  c.send({ type: 'open', cols: 100, rows: 30 })
  await until(() => got.some((m) => m.type === 'attached'))
  c.send({ type: 'input', data: 'Write-Output "win-$(40+2)"\r' })
  await until(() => out().includes('win-42'))
  c.close()
  done()
})

test('sin la llave el agente corta sin contestar', { skip }, async () => {
  const { dir, hub, local, done } = await setup()
  const sock = net.connect(local.path)
  let data = ''
  sock.setEncoding('utf8')
  sock.on('data', (d) => { data += d })
  sock.on('error', () => {})
  await new Promise((r) => sock.once('connect', r))
  sock.write(JSON.stringify({ type: 'list' }) + '\n')
  await new Promise((r) => sock.once('close', r))
  assert.equal(data, '', 'no se contesta nada')
  sock.destroy()
  // Con una llave equivocada, igual.
  const bad = net.connect(local.path)
  bad.on('error', () => {})
  await new Promise((r) => bad.once('connect', r))
  bad.write(JSON.stringify({ type: 'local-auth', key: 'x'.repeat(64) }) + '\n' + JSON.stringify({ type: 'open', cols: 80, rows: 24 }) + '\n')
  await new Promise((r) => bad.once('close', r))
  assert.equal(hub.list().length, 0, 'no se abrió ninguna consola')
  assert.ok(fs.existsSync(pipeFile(dir)))
  done()
})

test('un segundo agente en la misma carpeta no arranca; al cerrar se borra el archivo', { skip }, async () => {
  const { dir, done } = await setup()
  await assert.rejects(listenLocal({ dir, serve: () => {} }), (e) => e.code === 'EALREADY')
  done()
  assert.equal(fs.existsSync(pipeFile(dir)), false)
})

test('connectLocal sin agente: ENOAGENT', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-'))
  await assert.rejects(connectLocal(dir), (e) => e.code === 'ENOAGENT')
  // Un archivo de un agente que murió: la tubería ya no existe.
  fs.writeFileSync(pipeFile(dir), JSON.stringify({ pipe: '\\\\.\\pipe\\dotrino-terminal-' + '0'.repeat(32), key: 'k' }))
  await assert.rejects(connectLocal(dir), (e) => e.code === 'ENOAGENT')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('el servicio: arranca el agente sin ventana, lo vuelve a levantar si muere, y se quita', { skip, timeout: 90000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'))
  const prev = process.env.DOTRINO_AGENT_HOME
  process.env.DOTRINO_AGENT_HOME = home                       // el supervisor lo hereda
  process.env.DOTRINO_NO_UPDATE_NOTICE = '1'
  const name = `ci${process.pid}`
  const dir = path.join(home, 'terminal-agent', name)
  try {
    const r = installService({ name, cli: CLI, dir })
    assert.equal(r.kind, 'run-key')
    assert.equal(r.started, true)
    const reg = execFileSync('reg', ['query', RUN_KEY, '/v', runValue(name)], { encoding: 'utf8' })
    assert.match(reg, /supervise --name/)

    // El agente contesta por la tubería.
    await until(async () => { try { (await connectLocal(dir)).close(); return true } catch (_) { return false } }, 30000)
    const st = serviceStatus({ name, dir })
    assert.equal(st.installed, true)
    assert.equal(st.active, true)

    // Muere el agente: el supervisor lo vuelve a levantar.
    const first = readPid(path.join(dir, 'agent.pid'))
    assert.ok(first && alive(first))
    process.kill(first)
    await until(() => { const p = readPid(path.join(dir, 'agent.pid')); return p && p !== first && alive(p) }, 30000)
    await until(async () => { try { (await connectLocal(dir)).close(); return true } catch (_) { return false } }, 30000)

    // Quitar: se para todo y se borra la entrada.
    const sup = readPid(supervisorPidFile(dir))
    const agent = readPid(path.join(dir, 'agent.pid'))
    assert.equal(uninstallService({ name, dir }).removed, true)
    await until(() => !alive(sup) && !alive(agent))
    assert.throws(() => execFileSync('reg', ['query', RUN_KEY, '/v', runValue(name)], { stdio: 'pipe' }))
    assert.equal(serviceStatus({ name, dir }).installed, false)
  } catch (e) {
    try { console.error(fs.readFileSync(path.join(dir, 'agent.log'), 'utf8')) } catch (_) {}
    try { uninstallService({ name, dir }) } catch (_) {}
    throw e
  } finally {
    if (prev === undefined) delete process.env.DOTRINO_AGENT_HOME; else process.env.DOTRINO_AGENT_HOME = prev
  }
})
