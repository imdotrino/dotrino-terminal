/**
 * El agente como servicio: qué se escribe y qué se le pide al sistema. Sin tocar systemd ni
 * launchd de verdad: `run` va inyectado y la carpeta de inicio es una temporal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { startService, installService, uninstallService, serviceStatus, unitText, plistText, unitPath, plistPath, supervise, runCommand, RUN_KEY, supervisorPidFile } from '../service.js'

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
  assert.throws(() => installService({ name: 'work', cli: '/c.js', dir: '/d', platform: 'freebsd', home, user: 'u', run }), { code: 'unsupported-platform' })
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

/** Un `spawn` que apunta lo lanzado y devuelve hijos falsos que se pueden «matar». */
const spawner = () => {
  const kids = []
  const spawn = (cmd, args, opts) => { const c = Object.assign(new EventEmitter(), { cmd, args, opts, unref () {}, kill () { this.emit('exit', 0) } }); kids.push(c); return c }
  return { kids, spawn }
}

test('Windows: la entrada de inicio de sesión corre el supervisor de ese perfil', () => {
  assert.equal(runCommand({ name: 'work', node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\a\\cli.js' }), '"C:\\Program Files\\nodejs\\node.exe" "C:\\a\\cli.js" supervise --name work')
})

test('Windows: instalar apunta la entrada y lanza el supervisor sin ventana; con agente propio, no', () => {
  const { calls, run } = recorder(); const { kids, spawn } = spawner()
  const r = installService({ name: 'work', node: 'n.exe', cli: 'c.js', dir: tmp(), platform: 'win32', run, spawn, env: {} })
  assert.equal(r.kind, 'run-key'); assert.equal(r.started, true)
  assert.deepEqual(calls, [`reg add ${RUN_KEY} /v DotrinoTerminalAgent-work /t REG_SZ /d "n.exe" "c.js" supervise --name work /f`])
  assert.deepEqual(kids[0].args, ['c.js', 'supervise', '--name', 'work'])
  assert.equal(kids[0].opts.windowsHide, true)
  assert.equal(kids[0].opts.env.DOTRINO_SUPERVISOR, '1', 'ya va sin ventana: no se vuelve a lanzar')
  const own = spawner()
  assert.equal(installService({ name: 'work', node: 'n.exe', cli: 'c.js', dir: tmp(), running: true, platform: 'win32', run, spawn: own.spawn, env: {} }).started, false)
  assert.equal(own.kids.length, 0)
})

test('Windows: desde una sesión SSH el supervisor lo crea WMI, con la línea de la entrada de Run', () => {
  const calls = []
  const run = (cmd, args) => { calls.push([cmd, ...args]) }
  const { kids, spawn } = spawner()
  installService({ name: 'work', node: "C:\\it's\\node.exe", cli: 'c.js', dir: tmp(), platform: 'win32', run, spawn, env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' } })
  assert.equal(kids.length, 0, 'un proceso hijo moriría al cerrar la sesión')
  const ps = calls.find((c) => c[0] === 'powershell.exe')
  assert.ok(ps)
  assert.match(ps.at(-1), /Win32_Process -MethodName Create/)
  assert.ok(ps.at(-1).includes(`CommandLine = '"C:\\it''s\\node.exe" "c.js" supervise --name work'`), ps.at(-1))
})

test('Windows: una cuenta normal por SSH (WMI dice que no) deja la entrada puesta y lo dice', () => {
  const calls = []
  const run = (cmd, args) => { calls.push(cmd); if (cmd === 'powershell.exe') throw Object.assign(new Error('x'), { stderr: 'Access denied' }) }
  const r = installService({ name: 'work', node: 'n.exe', cli: 'c.js', dir: tmp(), platform: 'win32', run, spawn: spawner().spawn, env: { SSH_CLIENT: 'x' } })
  assert.deepEqual([r.started, r.startReason], [false, 'Access denied'])
  assert.equal(calls[0], 'reg', 'la entrada de Run se puso')
  assert.equal(startService({ name: 'work', dir: tmp(), cli: 'c.js', platform: 'win32', run, spawn: spawner().spawn, env: { SSH_CLIENT: 'x' } }), false, 'la ventana levanta el suyo')
})

test('Windows: arrancar solo si hay entrada, y sin duplicar un supervisor vivo', () => {
  const dir = tmp()
  const none = recorder(() => true); const a = spawner()
  assert.equal(startService({ name: 'work', dir, cli: 'c.js', platform: 'win32', run: none.run, spawn: a.spawn, env: {} }), false)
  assert.equal(a.kids.length, 0)
  const { run } = recorder(); const b = spawner()
  assert.equal(startService({ name: 'work', dir, cli: 'c.js', platform: 'win32', run, spawn: b.spawn, env: {} }), true)
  assert.equal(b.kids.length, 1)
  fs.writeFileSync(supervisorPidFile(dir), String(process.pid))
  const c = spawner()
  assert.equal(startService({ name: 'work', dir, cli: 'c.js', platform: 'win32', run, spawn: c.spawn, env: {} }), true)
  assert.equal(c.kids.length, 0, 'ya hay uno vivo')
  assert.equal(serviceStatus({ name: 'work', dir, platform: 'win32', run }).active, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('Windows: quitar borra la entrada; sin entrada no hace nada', () => {
  const dir = tmp()
  const none = recorder((l) => l.startsWith('reg query'))
  assert.equal(uninstallService({ name: 'work', dir, platform: 'win32', run: none.run }).removed, false)
  const { calls, run } = recorder()
  assert.equal(uninstallService({ name: 'work', dir, platform: 'win32', run }).removed, true)
  assert.deepEqual(calls.at(-1), `reg delete ${RUN_KEY} /v DotrinoTerminalAgent-work /f`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('el supervisor vuelve a levantar el agente cuando sale, y no cuando se le para', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tmp(); const { kids, spawn } = spawner()
  const s = supervise({ name: 'work', dir, node: 'n', cli: 'c.js', spawn })
  assert.deepEqual(kids[0].args, ['c.js', '--name', 'work', '--local'])
  assert.equal(kids[0].opts.env.DOTRINO_SUPERVISED, '1', '§15: hay quien lo levante')
  assert.equal(fs.readFileSync(supervisorPidFile(dir), 'utf8'), String(process.pid))
  kids[0].emit('exit', 1)
  t.mock.timers.tick(3000)
  assert.equal(kids.length, 2)
  s.stop()
  t.mock.timers.tick(3000)
  assert.equal(kids.length, 2)
  assert.equal(fs.existsSync(supervisorPidFile(dir)), false)
  // Otro proceso vivo ya supervisa ese perfil: no se pone un segundo.
  fs.writeFileSync(supervisorPidFile(dir), String(process.ppid))
  assert.throws(() => supervise({ name: 'work', dir, node: 'n', cli: 'c.js', spawn }), (e) => e.code === 'already-supervised')
  fs.rmSync(dir, { recursive: true, force: true })
})
