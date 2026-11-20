/**
 * Una orden suelta, sin consola (run.js): la salida y los errores aparte, el código de salida, y
 * los mismos mostradores que una consola (la clave de la máquina). Sesiones de mentira, como en
 * pty.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveSession, makeHub, loadPty } from '../index.js'
import { shellArgs, startRun } from '../run.js'
import { makeGate, setAccessCode } from '../access.js'

const posix = { skip: process.platform === 'win32' && 'shell de Unix' }

function fakeSession () {
  const h = { message: [], close: [] }
  const sent = []
  return {
    sent,
    on (ev, cb) { h[ev].push(cb); return this },
    async send (p) { sent.push(p) },
    close () { for (const cb of h.close) cb() },
    deliver (msg) { for (const cb of h.message) cb(msg) },
    last () { return sent[sent.length - 1] },
    /** @param {'out' | 'err'} stream */
    text (stream) { return Buffer.concat(sent.filter((p) => p.type === 'run-out' && p.stream === stream).map((p) => Buffer.from(p.data, 'base64'))).toString() }
  }
}
const until = async (cond, ms = 5000) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
}
const hub = () => makeHub(loadPty(), { shell: '/bin/sh' })

test('shellArgs: cada shell recibe la orden a su manera', () => {
  assert.deepEqual(shellArgs('/bin/bash', 'ls -l'), ['-c', 'ls -l'])
  assert.deepEqual(shellArgs('/usr/bin/zsh', 'ls'), ['-c', 'ls'])
  assert.deepEqual(shellArgs('C:\\Windows\\System32\\cmd.exe', 'dir'), ['/d', '/s', '/c', 'dir'])
  const ps = shellArgs('powershell.exe', 'Get-Date')
  assert.deepEqual(ps.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
  assert.match(ps[4], /OutputEncoding.*UTF8.*Get-Date/s)
  assert.match(ps[4], /exit \$LASTEXITCODE/)
  assert.equal(shellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'x')[3], '-Command')
})

test('startRun: salida y errores aparte, y el código de salida', posix, async () => {
  const got = { out: '', err: '' }
  const r = await new Promise((resolve) => startRun({
    cmd: 'echo hola; echo mal >&2; exit 3', cwd: os.tmpdir(), shell: '/bin/sh',
    onOut: (s, d) => { got[s] += Buffer.from(d, 'base64').toString() },
    onExit: resolve
  }))
  assert.deepEqual(got, { out: 'hola\n', err: 'mal\n' })
  assert.equal(r.code, 3)
})

test('startRun: una shell que no existe lo dice, no se queda colgada', async () => {
  const r = await new Promise((resolve) => startRun({ cmd: 'x', cwd: os.tmpdir(), shell: '/no/such/shell', onOut: () => {}, onExit: resolve }))
  assert.equal(r.code, null)
  assert.ok(r.error)
})

test('run por la sesión: sale la salida, el código y la carpeta pedida', posix, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-run-')))
  const s = fakeSession(); serveSession(s, hub())
  s.deliver({ type: 'run', rid: 'r1', cmd: 'pwd; exit 7', cwd: dir })
  await until(() => s.sent.some((p) => p.type === 'run-exit'))
  assert.equal(s.text('out').trim(), dir)
  assert.equal(s.sent.find((p) => p.type === 'run-exit').code, 7)
})

test('run por la sesión: carpeta que no existe y orden vacía se rechazan con su rid', async () => {
  const s = fakeSession(); serveSession(s, hub())
  s.deliver({ type: 'run', rid: 'r2', cmd: 'true', cwd: '/no/such/dir' })
  assert.equal(s.last().code, 'bad-cwd'); assert.equal(s.last().rid, 'r2')
  s.deliver({ type: 'run', rid: 'r3', cmd: '  ' })
  assert.equal(s.last().code, 'bad-run'); assert.equal(s.last().rid, 'r3')
})

test('run-kill para la orden, y al irse la sesión también se para', posix, async () => {
  const s = fakeSession(); serveSession(s, hub())
  s.deliver({ type: 'run', rid: 'k1', cmd: 'sleep 30' })
  await new Promise((r) => setTimeout(r, 200))
  s.deliver({ type: 'run-kill', rid: 'k1' })
  await until(() => s.sent.some((p) => p.type === 'run-exit' && p.rid === 'k1'))
  assert.ok(s.sent.find((p) => p.type === 'run-exit').signal)
  const t = fakeSession(); serveSession(t, hub())
  t.deliver({ type: 'run', rid: 'k2', cmd: 'sleep 30' })
  await new Promise((r) => setTimeout(r, 200))
  t.close()
  await until(() => t.sent.some((p) => p.type === 'run-exit' && p.rid === 'k2'))
})

test('con clave puesta, una sesión remota no corre nada sin escribirla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-run-lock-'))
  setAccessCode(dir, '4821')
  const s = fakeSession(); serveSession(s, hub(), { origin: 'remote', gate: makeGate(dir) })
  s.deliver({ type: 'run', rid: 'l1', cmd: 'echo no' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(s.last().code, 'locked')
  assert.ok(!s.sent.some((p) => p.type === 'run-out' || p.type === 'run-exit'))
})
