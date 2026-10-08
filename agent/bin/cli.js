#!/usr/bin/env node
/**
 * dotrino-terminal-agent — agente de Dotrino Terminal.
 *
 *   dotrino-terminal-agent [--name <n>]          # enlaza (si falta) y CORRE el agente
 *   dotrino-terminal-agent enroll [--name <n>]   # re-enlaza (sobrescribe) y corre el agente
 *   dotrino-terminal-agent list                  # los agentes enlazados en esta máquina
 *   dotrino-terminal-agent info [--name <n>]     # qué aparato es: su ID, su bóveda, sus permisos
 *   dotrino-terminal-agent update [--name <n>] [--approval on|off] [--notify on|off]
 *                                                # cómo se actualiza este agente (CONVENCIONES §15)
 *
 * Las ventanas de esta máquina se abren con `dotrino-terminal` (bin/terminal.js), que habla
 * con este agente por un socket local y lo levanta si no está corriendo.
 *
 * Cada agente tiene su NOMBRE y su enlace (`@dotrino/remote-agent/instances`), como `dotrino-env`.
 *
 * El agente es un aparato más de tu cuenta: puede vivir en cualquier máquina. Con un
 * solo comando queda enlazado y aparece solo en terminal.dotrino.com.
 */
import { createRequire } from 'node:module'
import { updatePrefsCommand, updateStatusText } from '@dotrino/update/npm'
import { startAgent } from '../index.js'
import { linkInteractive, loadLink, dataDir, LABEL } from '../link.js'
import { listInstances, lockInstance, instancesRoot } from '@dotrino/remote-agent/instances'
import { deviceInfo, formatDeviceInfo } from '@dotrino/vault/device-info'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'run'
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

if (args.includes('-h') || args.includes('--help')) {
  console.log(`uso:
  dotrino-terminal-agent [--name <n>]          enlaza este agente (si falta) y lo corre
  dotrino-terminal-agent enroll [--name <n>]   re-enlaza (sobrescribe el enlace) y lo corre
  dotrino-terminal-agent list                  los agentes enlazados en esta máquina
  dotrino-terminal-agent info [--name <n>]     qué aparato es: su ID (el de «dotrino-vault members»),
                                               su bóveda y sus permisos. Sin red. [--json]
  dotrino-terminal-agent update [--name <n>]   cómo se actualiza este agente. Por defecto lo hace
                                               solo y avisa de que lo hizo:
                                                 --approval on|off  pedir antes aprobación a tu bóveda
                                                 --notify on|off    avisar cuando se actualiza
  opciones: [--name <n>] [--proxy <wss://…>] [--shell <bin>] [--dir <ruta>]
           [--local]  no enlazar ahora: atender solo a las ventanas de esta máquina

enlaces en ${instancesRoot(LABEL)}/<nombre> (override DOTRINO_AGENT_HOME;
--dir o DOTRINO_TERMINAL_DIR fuerzan una carpeta concreta)`)
  process.exit(0)
}

if (cmd === 'list') {
  const names = listInstances(LABEL)
  if (!names.length) console.log('No hay ningún agente de terminal enlazado en esta máquina.')
  for (const n of names) console.log(`  ${n}   ${instancesRoot(LABEL)}/${n}`)
  process.exit(0)
}

// `update`: los dos ajustes de ESTE agente (`@dotrino/update/npm`). Sin banderas, los enseña.
if (cmd === 'update') {
  let r
  try {
    const dir = opt('--dir') || dataDir(opt('--name'))
    // Solo las banderas de este comando: `--name`/`--dir` ya eligieron la carpeta.
    const own = args.slice(1).filter((a, i, all) => !['--name', '--dir'].includes(a) && !['--name', '--dir'].includes(all[i - 1]))
    r = updatePrefsCommand(own, { dir, lang: 'es' })
  } catch (e) { console.error('error:', e.message); process.exit(1) }
  if (!r.handled) { console.error('uso: dotrino-terminal-agent update [--name <n>] [--approval on|off] [--notify on|off]'); process.exit(2) }
  ;(r.ok ? console.log : console.error)(r.text)
  process.exit(r.ok ? 0 : 2)
}

// `info`: la pieza común del ecosistema (`@dotrino/vault/device-info`). Lo que se viene a
// mirar es el ID, para buscarlo en el acta.
if (cmd === 'info') {
  try {
    const dir = opt('--dir') || dataDir(opt('--name'))
    const link = loadLink(dir)
    if (!link) { console.error(`Este agente no está enlazado (${dir}). Enlázalo con: dotrino-terminal-agent`); process.exit(1) }
    const info = await deviceInfo(link, { kind: LABEL, name: opt('--dir') ? null : dir.split(/[\\/]/).pop(), version: VERSION, dir })
    // Lo pendiente de su actualización (se pidió y no se aprobó, o necesita permisos de
    // administrador), si hay algo que decir. Sin red: sale de lo apuntado en su carpeta.
    const pending = updateStatusText({ dir, current: VERSION, lang: 'es' })
    if (args.includes('--json')) console.log(JSON.stringify(pending ? { ...info, update: pending } : info, null, 2))
    else console.log(formatDeviceInfo(info) + (pending ? '\n' + pending : ''))
  } catch (e) { console.error('error:', e.message); process.exit(1) }
  process.exit(0)
}

try {
  const dir = opt('--dir') || dataDir(opt('--name'))
  // Antes de nada, también de enlazar: dos procesos con el mismo enlace son la misma llave.
  process.on('exit', lockInstance(dir))
  // Sin `enroll`, enlaza solo si aún no lo está Y hay alguien delante (una TTY) que no pidió
  // `--local`; `enroll` re-enlaza aunque ya lo esté. Sin enlace el agente atiende solo a las
  // ventanas de esta máquina: así lo levanta `dotrino-terminal` cuando no hay ninguno.
  const wantsLink = cmd === 'enroll' || (!loadLink(dir) && process.stdin.isTTY && !args.includes('--local'))
  if (wantsLink) {
    if (cmd === 'enroll' && loadLink(dir)) console.log('Re-enlazando esta máquina (sobrescribe el enlace actual).\n')
    await linkInteractive(dir)
    console.log('  Levantando el agente…\n')
  }

  const agent = await startAgent({
    dir, proxyUrl: opt('--proxy'), shell: opt('--shell'),
    onRevoked: () => { console.log('  Esta máquina se quitó de tu bóveda. Para volver a usarla, enlázala otra vez.\n'); process.exit(0) },
    onLinked: (r) => console.log(`  enlazada: máquina ${r.machineId}. Tus otros aparatos ya pueden abrir estas consolas.\n`),
    onLinkError: (e) => console.error('[terminal-agent] linked, but the remote side did not start:', e.message)
  })
  console.log('\n  Dotrino Terminal — agente activo')
  console.log('  versión:', VERSION)
  console.log('  ventanas de esta máquina:', agent.socket)
  if (agent.remote) console.log('  máquina:', agent.machineId, '(tus otros aparatos pueden abrir estas consolas)\n')
  else console.log('  sin enlazar: solo ventanas de esta máquina. Para abrirlas desde otros aparatos: dotrino-terminal-agent enroll\n')
  // §15: se actualiza solo. Mira al arrancar y una vez al día; pedir aprobación y avisar son
  // ajustes de este agente (`dotrino-terminal-agent update`). Solo se reinicia sin consolas.
  const { startSelfUpdate } = await import('../update.js')
  const stopUpdates = startSelfUpdate({ dir, version: VERSION, agent })
  // Mantener vivo el servicio aunque stdin no sea una TTY (systemd/pm2/`nohup </dev/null`):
  // el socket del proxio va `unref`'d, así que sin esto el proceso saldría al arrancar.
  const keepAlive = setInterval(() => {}, 1 << 30)
  const bye = () => { clearInterval(keepAlive); stopUpdates(); agent.close(); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
} catch (e) {
  console.error('error:', e.message)
  process.exit(1)
}
