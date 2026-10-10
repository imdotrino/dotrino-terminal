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
 *
 * Es de usuario a propósito (CONVENCIONES §15): así el agente se sigue actualizando solo, y
 * con alguien que lo levante ya puede reiniciarse para estrenar la versión nueva.
 *
 * Una unidad por PERFIL: cada perfil es un agente con su enlace.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const fail = (code, message) => Object.assign(new Error(message), { code })

export const unitName = (name) => `dotrino-terminal-agent-${name}.service`
export const plistLabel = (name) => `com.dotrino.terminal-agent.${name}`

export function unitPath (name, home = os.homedir()) {
  return path.join(home, '.config', 'systemd', 'user', unitName(name))
}

export function plistPath (name, home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', `${plistLabel(name)}.plist`)
}

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
  if (platform !== 'linux') throw fail('unsupported-platform', `there is no service support for ${platform}`)
  // Sin systemd de usuario (un contenedor, WSL sin systemd, otra init) no hay dónde ponerlo.
  if (!quiet(run, 'systemctl', ['--user', 'show-environment']).ok) throw fail('no-user-systemd', 'this session has no systemd user manager')
  return 'systemd'
}

/**
 * Instala y enciende el servicio del perfil `name`.
 *
 * `running`: ya hay un agente de ese perfil corriendo por su cuenta (lo levantó una ventana).
 * Dos agentes con el mismo enlace son la misma llave, y parar ese cerraría sus consolas: el
 * servicio queda puesto y toma el relevo cuando ese agente termine o al próximo arranque.
 *
 * @returns {{ kind:'systemd'|'launchd', file:string, started:boolean, boot?:boolean, lingerReason?:string }}
 */
export function installService ({ name, node = process.execPath, cli, dir, running = false, pathEnv = process.env.PATH || '', platform = process.platform, home = os.homedir(), user = os.userInfo().username, uid = process.getuid?.(), run = execFileSync }) {
  const kind = platformOf({ platform, run })
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
export function startService ({ name, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = execFileSync }) {
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
export function uninstallService ({ name, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = execFileSync }) {
  const kind = platformOf({ platform, run })
  const file = kind === 'launchd' ? plistPath(name, home) : unitPath(name, home)
  if (!fs.existsSync(file)) return { kind, file, removed: false }
  if (kind === 'launchd') quiet(run, 'launchctl', ['bootout', `gui/${uid}/${plistLabel(name)}`])
  else must(run, 'systemctl', ['--user', 'disable', '--now', unitName(name)])
  fs.rmSync(file)
  if (kind === 'systemd') must(run, 'systemctl', ['--user', 'daemon-reload'])
  return { kind, file, removed: true }
}

/** ¿Está puesto, y está corriendo ahora bajo el sistema? */
export function serviceStatus ({ name, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), run = execFileSync }) {
  const kind = platformOf({ platform, run })
  const file = kind === 'launchd' ? plistPath(name, home) : unitPath(name, home)
  const installed = fs.existsSync(file)
  const active = installed && (kind === 'launchd'
    ? quiet(run, 'launchctl', ['print', `gui/${uid}/${plistLabel(name)}`]).ok
    : quiet(run, 'systemctl', ['--user', 'is-active', '--quiet', unitName(name)]).ok)
  return { kind, file, installed, active }
}

export default { startService, installService, uninstallService, serviceStatus, unitText, plistText, unitName, unitPath, plistLabel, plistPath }
