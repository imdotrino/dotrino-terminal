/**
 * service.js — el agente como SERVICIO del usuario: arranca solo con la máquina.
 *
 * Sin esto el agente lo levanta la primera ventana que se abre (`dotrino-terminal`), así que
 * tras encender la máquina nadie puede abrir sus consolas desde otro aparato hasta que
 * alguien se siente delante. `dotrino-terminal service install` lo deja a cargo del sistema:
 *
 *   · Linux — una unidad de systemd DEL USUARIO (`~/.config/systemd/user`), sin `sudo`. Con
 *     «linger» arranca al encender, antes de que nadie inicie sesión; sin él, al iniciarla.
 *   · macOS — un LaunchAgent (`~/Library/LaunchAgents`): arranca al iniciar sesión.
 *   · Windows — una entrada en `HKCU\…\Run`: arranca al iniciar sesión, sin administrador.
 *     Lanza un SUPERVISOR (`dotrino-terminal-agent supervise`) que se vuelve a abrir sin
 *     ventana y levanta el agente cada vez que sale, como `Restart=always`. No es el
 *     Programador de tareas porque crear una tarea al iniciar sesión pide derechos que una
 *     cuenta normal no tiene, y no es un servicio de Windows porque ese pide administrador.
 *
 * Es de usuario a propósito (CONVENCIONES §15): así el agente se sigue actualizando solo, y
 * con alguien que lo levante ya puede reiniciarse para estrenar la versión nueva.
 *
 * Una unidad por PERFIL: cada perfil es un agente con su enlace.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn as childSpawn } from 'node:child_process'

const fail = (code, message) => Object.assign(new Error(message), { code })

export const unitName = (name) => `dotrino-terminal-agent-${name}.service`
export const plistLabel = (name) => `com.dotrino.terminal-agent.${name}`

export function unitPath (name, home = os.homedir()) {
  return path.join(home, '.config', 'systemd', 'user', unitName(name))
}

export function plistPath (name, home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${plistLabel(name)}.plist`)
}

/** Windows: la clave de lo que arranca al iniciar sesión, y el nombre del valor de cada perfil. */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const runValue = (name) => `DotrinoTerminalAgent-${name}`
/** Lo que se apunta en la clave: Node, el CLI y el supervisor del perfil. */
export const runCommand = ({ name, node, cli }) => `"${node}" "${cli}" supervise --name ${name}`
export const supervisorPidFile = (dir) => path.join(dir, 'supervisor.pid')
/** Cuánto espera el supervisor antes de volver a levantar el agente (como `RestartSec`). */
export const RESTART_MS = 3000

/** systemd parte `ExecStart` por espacios: lo que los lleve va entre comillas. */
const unitArg = (s) => (/[\s"'\\$%]/.test(s) ? `"${s.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"` : s)

/**
 * La unidad de systemd. `--local`: sin TTY el agente nunca pregunta; si el perfil no está
 * enlazado atiende solo a las ventanas de esta máquina, igual que cuando lo levanta una ventana.
 *
 * El PATH es el de quien instala: el de un servicio de usuario es mínimo y no trae el Node
 * de nvm ni las herramientas que las consolas esperan encontrar.
 */
export function unitText ({ name, node, cli, pathEnv }) {
  return `[Unit]
Description=Dotrino Terminal agent (${name})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${unitArg(node)} ${unitArg(cli)} --name ${name} --local
Environment=${unitArg(`PATH=${pathEnv}`)}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** El LaunchAgent de macOS. `DOTRINO_SUPERVISED`: launchd lo levanta si sale (§15). */
export function plistText ({ name, node, cli, pathEnv, log }) {
  const args = [node, cli, '--name', name, '--local'].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(plistLabel(name))}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>
    <key>DOTRINO_SUPERVISED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`
}

function quiet (run, cmd, args) {
  try { run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); return { ok: true } } catch (e) {
    return { ok: false, reason: String(e.stderr || e.message).trim().split('\n').pop() }
  }
}

function must (run, cmd, args) {
  const r = quiet(run, cmd, args)
  if (!r.ok) throw fail('service-command-failed', `${cmd} ${args.join(' ')}: ${r.reason}`)
}

/** ¿Ya arrancan los servicios de ese usuario al encender? systemd lo apunta con un archivo. */
const lingers = (user, root = LINGER_DIR) => fs.existsSync(path.join(root, user))
const LINGER_DIR = '/var/lib/systemd/linger'

/** ¿Deja este sistema instalar el servicio? Lanza con el motivo si no. */
function platformOf ({ platform, run }) {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'win32') return 'run-key'
  if (platform !== 'linux') throw fail('unsupported-platform', `there is no service support for ${platform}`)
  // Sin systemd de usuario (un contenedor, WSL sin systemd, otra init) no hay dónde ponerlo.
  if (!quiet(run, 'systemctl', ['--user', 'show-environment']).ok) throw fail('no-user-systemd', 'this session has no systemd user manager')
  return 'systemd'
}

const readPid = (file) => { try { return Number(fs.readFileSync(file, 'utf8')) || 0 } catch (e) { if (e.code === 'ENOENT') return 0; throw e } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const runKeyFile = (name) => `${RUN_KEY}\\${runValue(name)}`
const hasRunKey = (name, run) => quiet(run, 'reg', ['query', RUN_KEY, '/v', runValue(name)]).ok

/** PowerShell: una cadena entre comillas simples. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`

/**
 * Windows: lanza el supervisor del perfil, ya sin ventana.
 *
 * Desde una sesión SSH no vale un proceso aparte: sshd mete la sesión en un objeto de trabajo y
 * al cerrarla mata todo lo que lanzó, y Node no puede pedir salirse de él. Ahí lo crea WMI
 * (`Win32_Process.Create`), que lo lanza fuera de la sesión, y con la misma línea que queda en
 * `HKCU\…\Run`: así se prueba también la que correrá al iniciar sesión.
 *
 * Una cuenta sin administrador no puede pedirle eso a WMI desde SSH. Entonces no queda nada
 * corriendo ahora (lo que se lanzara moriría al cerrar la sesión) y se devuelve el motivo: la
 * entrada de `Run` ya está puesta y lo arranca al iniciar sesión.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function spawnSupervisor ({ name, node, cli, spawn, run, env }) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT) {
    const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(runCommand({ name, node, cli }))} }; if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }`
    const r = quiet(run, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  }
  const child = spawn(node, [cli, 'supervise', '--name', name], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...env, DOTRINO_SUPERVISOR: '1' } })
  child.unref()
  return { ok: true }
}

/**
 * El supervisor de Windows: levanta el agente del perfil y lo vuelve a levantar cada vez que
 * sale (también cuando se reinicia para estrenar una versión: §15, `DOTRINO_SUPERVISED`).
 * Uno por perfil: si ya hay otro vivo, lanza `already-supervised`.
 */
export function supervise ({ name, dir, node = process.execPath, cli, spawn = childSpawn }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pidFile = supervisorPidFile(dir)
  const other = readPid(pidFile)
  if (other && other !== process.pid && alive(other)) throw fail('already-supervised', `profile ${name} already has a supervisor (pid ${other})`)
  fs.writeFileSync(pidFile, String(process.pid))
  let stopped = false
  let child = null
  const start = () => {
    const fd = fs.openSync(path.join(dir, 'agent.log'), 'a', 0o600)
    child = spawn(node, [cli, '--name', name, '--local'], { windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, DOTRINO_SUPERVISED: '1' } })
    fs.closeSync(fd)
    child.on('exit', () => { child = null; if (!stopped) setTimeout(start, RESTART_MS) })
  }
  start()
  return {
    stop: () => {
      stopped = true
      try { child?.kill() } catch (_) {}
      try { if (readPid(pidFile) === process.pid) fs.rmSync(pidFile) } catch (_) {}
    }
  }
}

/** Windows: para el supervisor y después el agente (matar el supervisor no se lleva al hijo). */
function stopSupervised (dir) {
  for (const file of [supervisorPidFile(dir), path.join(dir, 'agent.pid')]) {
    const pid = readPid(file)
    if (pid && alive(pid)) process.kill(pid)
  }
  fs.rmSync(supervisorPidFile(dir), { force: true })
}

/**
 * Instala y enciende el servicio del perfil `name`.
 *
 * `running`: ya hay un agente de ese perfil corriendo por su cuenta (lo levantó una ventana).
 * Dos agentes con el mismo enlace son la misma llave, y parar ese cerraría sus consolas: el
 * servicio queda puesto y toma el relevo cuando ese agente termine o al próximo arranque.
 *
 * @returns {{ kind:'systemd'|'launchd'|'run-key', file:string, started:boolean, boot?:boolean, lingerReason?:string, startReason?:string }}
 */
export function installService ({ name, node = process.execPath, cli, dir, running = false, pathEnv = process.env.PATH || '', platform = process.platform, home = os.homedir(), user = os.userInfo().username, uid = process.getuid?.(), run = execFileSync, spawn = childSpawn, env = process.env }) {
  const kind = platformOf({ platform, run })
  if (kind === 'run-key') {
    must(run, 'reg', ['add', RUN_KEY, '/v', runValue(name), '/t', 'REG_SZ', '/d', runCommand({ name, node, cli }), '/f'])
    if (running) return { kind, file: runKeyFile(name), started: false }
    const s = spawnSupervisor({ name, node, cli, spawn, run, env })
    return { kind, file: runKeyFile(name), started: s.ok, ...(s.ok ? {} : { startReason: s.reason }) }
  }
  if (kind === 'launchd') {
    const file = plistPath(name, home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, plistText({ name, node, cli, pathEnv, log: path.join(dir, 'agent.log') }), { mode: 0o644 })
    if (running) return { kind, file, started: false }
    // Si ya estaba cargado (una instalación anterior), se recarga con el archivo nuevo.
    quiet(run, 'launchctl', ['bootout', `gui/${uid}/${plistLabel(name)}`])
    must(run, 'launchctl', ['bootstrap', `gui/${uid}`, file])
    return { kind, file, started: true }
  }
  const file = unitPath(name, home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, unitText({ name, node, cli, pathEnv }), { mode: 0o644 })
  must(run, 'systemctl', ['--user', 'daemon-reload'])
  must(run, 'systemctl', ['--user', 'enable', unitName(name)])
  if (!running) must(run, 'systemctl', ['--user', 'restart', unitName(name)])
  // Arrancar al ENCENDER, sin que nadie inicie sesión. Si el sistema no lo deja sin
  // administrador, el servicio arranca al iniciar sesión, y se dice.
  if (lingers(user)) return { kind, file, started: !running, boot: true }
  const linger = quiet(run, 'loginctl', ['enable-linger', user])
  return { kind, file, started: !running, boot: linger.ok, ...(linger.ok ? {} : { lingerReason: linger.reason }) }
}

/**
 * Arranca el servicio ya instalado de ese perfil. `false` si el perfil no tiene servicio (o
 * este sistema no los tiene): entonces el agente lo levanta la ventana, como siempre. Lo usa
 * `dotrino-terminal` cuando no encuentra agente, para no levantar uno propio al lado de un
 * servicio que el sistema arrancaría después con la misma llave.
 */
export function startService ({ name, dir, node = process.execPath, cli, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = execFileSync, spawn = childSpawn, env = process.env }) {
  if (platform === 'win32') {
    if (!hasRunKey(name, run)) return false
    const pid = readPid(supervisorPidFile(dir))
    if (pid && alive(pid)) return true
    // Sin poder dejarlo corriendo (cuenta normal por SSH), lo levanta la ventana, como sin servicio.
    return spawnSupervisor({ name, node, cli, spawn, run, env }).ok
  }
  if (platform === 'darwin') {
    const file = plistPath(name, home)
    if (!fs.existsSync(file)) return false
    // Cargado y parado no puede estar (KeepAlive): si no corre, es que no está cargado.
    quiet(run, 'launchctl', ['bootout', `gui/${uid}/${plistLabel(name)}`])
    must(run, 'launchctl', ['bootstrap', `gui/${uid}`, file])
    return true
  }
  if (platform !== 'linux' || !fs.existsSync(unitPath(name, home))) return false
  must(run, 'systemctl', ['--user', 'start', unitName(name)])
  return true
}

/** Para el servicio y lo quita. El enlace y los ajustes del perfil no se tocan. */
export function uninstallService ({ name, dir, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = execFileSync }) {
  const kind = platformOf({ platform, run })
  if (kind === 'run-key') {
    if (!hasRunKey(name, run)) return { kind, file: runKeyFile(name), removed: false }
    stopSupervised(dir)
    must(run, 'reg', ['delete', RUN_KEY, '/v', runValue(name), '/f'])
    return { kind, file: runKeyFile(name), removed: true }
  }
  const file = kind === 'launchd' ? plistPath(name, home) : unitPath(name, home)
  if (!fs.existsSync(file)) return { kind, file, removed: false }
  if (kind === 'launchd') quiet(run, 'launchctl', ['bootout', `gui/${uid}/${plistLabel(name)}`])
  else must(run, 'systemctl', ['--user', 'disable', '--now', unitName(name)])
  fs.rmSync(file)
  if (kind === 'systemd') must(run, 'systemctl', ['--user', 'daemon-reload'])
  return { kind, file, removed: true }
}

/** ¿Está puesto, y está corriendo ahora bajo el sistema? */
export function serviceStatus ({ name, dir, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = execFileSync }) {
  const kind = platformOf({ platform, run })
  if (kind === 'run-key') {
    const installed = hasRunKey(name, run)
    const pid = installed ? readPid(supervisorPidFile(dir)) : 0
    return { kind, file: runKeyFile(name), installed, active: !!pid && alive(pid) }
  }
  const file = kind === 'launchd' ? plistPath(name, home) : unitPath(name, home)
  const installed = fs.existsSync(file)
  const active = installed && (kind === 'launchd'
    ? quiet(run, 'launchctl', ['print', `gui/${uid}/${plistLabel(name)}`]).ok
    : quiet(run, 'systemctl', ['--user', 'is-active', '--quiet', unitName(name)]).ok)
  return { kind, file, installed, active }
}

export default { supervise, runCommand, runValue, RUN_KEY, startService, installService, uninstallService, serviceStatus, unitText, plistText, unitName, unitPath, plistLabel, plistPath }
