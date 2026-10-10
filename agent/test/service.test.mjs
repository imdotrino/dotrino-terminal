/**
 * El agente como servicio: qué se escribe y qué se le pide al sistema. Sin tocar systemd ni
 * launchd de verdad: `run` va inyectado y la carpeta de inicio es una temporal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startService, installService, uninstallService, serviceStatus, unitText, plistText, unitPath, plistPath } from '../service.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'))
/** Un `run` que apunta lo que se le pide y falla en lo que se le diga. */
const recorder = (failing = () => false) => {
  const calls = []
  const run = (cmd, args) => { const line = [cmd, ...args].join(' '); calls.push(line); if (failing(line)) throw Object.assign(new Error('boom'), { stderr: 'not allowed' }) }
  return { calls, run }
}

test('la unidad corre ese perfil sin preguntar, con el PATH de quien instala, y se levanta sola', () => {
  const u = unitText({ name: 'work', node: '/home/u/.nvm/v22/bin/node', cli: '/home/u/lib/cli.js', pathEnv: '/home/u/.nvm/v22/bin:/usr/bin' })
  assert.match(u, /^ExecStart=\/home\/u\/\.nvm\/v22\/bin\/node \/home\/u\/lib\/cli\.js --name work --local$/m)
  assert.match(u, /^Environment=PATH=\/home\/u\/\.nvm\/v22\/bin:\/usr\/bin$/m)
  assert.match(u, /^Restart=always$/m)
  assert.match(u, /^WantedBy=default\.target$/m)
  // Una ruta con espacios va entre comillas: systemd parte por espacios.
  assert.match(unitText({ name: 'a', node: '/opt/my node/node', cli: '/c.js', pathEnv: '/usr/bin' }), /^ExecStart="\/opt\/my node\/node" \/c\.js/m)
})

test('el LaunchAgent arranca al iniciar sesión y dice que hay quien lo levante', () => {
  const p = plistText({ name: 'work', node: '/n', cli: '/c & d.js', pathEnv: '/usr/bin', log: '/l' })
  assert.match(p, /<string>com\.dotrino\.terminal-agent\.work<\/string>/)
  assert.match(p, /<string>\/c &amp; d\.js<\/string>/)
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(p, /<key>DOTRINO_SUPERVISED<\/key><string>1<\/string>/)
})

test('instalar en Linux: escribe, habilita, arranca y pide arrancar al encender', () => {
  const home = tmp(); const { calls, run } = recorder()
  const r = installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', pathEnv: '/usr/bin', platform: 'linux', home, user: 'u', run })
  assert.deepEqual([r.kind, r.started, r.boot, r.file], ['systemd', true, true, unitPath('work', home)])
  assert.ok(fs.existsSync(r.file))
  assert.deepEqual(calls, [
    'systemctl --user show-environment',
    'systemctl --user daemon-reload',
    'systemctl --user enable dotrino-terminal-agent-work.service',
    'systemctl --user restart dotrino-terminal-agent-work.service',
    'loginctl enable-linger u'
  ])
  fs.rmSync(home, { recursive: true, force: true })
})

test('con un agente que ya corre por su cuenta se habilita pero NO se arranca', () => {
  const home = tmp(); const { calls, run } = recorder()
  const r = installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', running: true, platform: 'linux', home, user: 'u', run })
  assert.equal(r.started, false)
  assert.equal(calls.some((c) => / (re)?start /.test(c)), false, 'arrancarlo sería un segundo agente con la misma llave')
  assert.ok(calls.includes('systemctl --user enable dotrino-terminal-agent-work.service'))
  fs.rmSync(home, { recursive: true, force: true })
})

test('si el sistema no deja arrancar al encender, se dice y el servicio queda puesto', () => {
  const home = tmp(); const { run } = recorder((l) => l.startsWith('loginctl'))
  const r = installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', platform: 'linux', home, user: 'u', run })
  assert.deepEqual([r.started, r.boot, r.lingerReason], [true, false, 'not allowed'])
  fs.rmSync(home, { recursive: true, force: true })
})

test('sin systemd de usuario no se escribe nada', () => {
  const home = tmp(); const { run } = recorder((l) => l.includes('show-environment'))
  assert.throws(() => installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', platform: 'linux', home, user: 'u', run }), { code: 'no-user-systemd' })
  assert.equal(fs.existsSync(unitPath('work', home)), false)
  assert.throws(() => installService({ name: 'work', cli: '/c.js', dir: '/d', platform: 'win32', home, user: 'u', run }), { code: 'unsupported-platform' })
  fs.rmSync(home, { recursive: true, force: true })
})

test('un fallo al habilitar no se calla', () => {
  const home = tmp(); const { run } = recorder((l) => l.includes(' enable '))
  assert.throws(() => installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', platform: 'linux', home, user: 'u', run }), { code: 'service-command-failed' })
  fs.rmSync(home, { recursive: true, force: true })
})

test('quitar: lo para, borra la unidad y recarga; sin servicio no hace nada', () => {
  const home = tmp(); const { calls, run } = recorder()
  assert.equal(uninstallService({ name: 'work', platform: 'linux', home, run }).removed, false)
  installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', platform: 'linux', home, user: 'u', run })
  assert.deepEqual(serviceStatus({ name: 'work', platform: 'linux', home, run }).installed, true)
  calls.length = 0
  const r = uninstallService({ name: 'work', platform: 'linux', home, run })
  assert.equal(r.removed, true)
  assert.equal(fs.existsSync(unitPath('work', home)), false)
  assert.deepEqual(calls, ['systemctl --user show-environment', 'systemctl --user disable --now dotrino-terminal-agent-work.service', 'systemctl --user daemon-reload'])
  fs.rmSync(home, { recursive: true, force: true })
})

test('macOS: carga el LaunchAgent de ese usuario, y lo descarga al quitar', () => {
  const home = tmp(); const { calls, run } = recorder()
  const r = installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', platform: 'darwin', home, uid: 501, run })
  assert.deepEqual([r.kind, r.started, r.file], ['launchd', true, plistPath('work', home)])
  assert.deepEqual(calls, ['launchctl bootout gui/501/com.dotrino.terminal-agent.work', `launchctl bootstrap gui/501 ${r.file}`])
  calls.length = 0
  assert.equal(uninstallService({ name: 'work', platform: 'darwin', home, uid: 501, run }).removed, true)
  assert.deepEqual(calls, ['launchctl bootout gui/501/com.dotrino.terminal-agent.work'])
  assert.equal(fs.existsSync(r.file), false)
  fs.rmSync(home, { recursive: true, force: true })
})

test('arrancar el servicio: solo si ese perfil lo tiene', () => {
  const home = tmp(); const { calls, run } = recorder()
  assert.equal(startService({ name: 'work', platform: 'linux', home, run }), false)
  assert.deepEqual(calls, [], 'sin servicio no se le pide nada al sistema')
  installService({ name: 'work', node: '/n', cli: '/c.js', dir: '/d', running: true, platform: 'linux', home, user: 'u', run })
  calls.length = 0
  assert.equal(startService({ name: 'work', platform: 'linux', home, run }), true)
  assert.deepEqual(calls, ['systemctl --user start dotrino-terminal-agent-work.service'])
  fs.rmSync(home, { recursive: true, force: true })
})
