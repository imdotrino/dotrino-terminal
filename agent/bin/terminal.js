#!/usr/bin/env node
/**
 * dotrino-terminal — una ventana de Dotrino Terminal en ESTA terminal (TTY).
 *
 *   dotrino-terminal [--name <n>] [--cwd <dir>] abre una consola nueva aquí (en la carpeta actual)
 *   dotrino-terminal attach <id> [--name <n>]  se engancha a una consola que ya existe
 *   dotrino-terminal ls [--name <n>] [--json]  las consolas abiertas en el agente
 *   dotrino-terminal kill <id> [--name <n>]    cierra una consola
 *   dotrino-terminal machines [--json]         tus OTRAS máquinas encendidas y sus consolas
 *   dotrino-terminal … --machine <id|nombre>   lo mismo (abrir, attach, ls, kill) en otra máquina
 *   dotrino-terminal note [texto]              la nota de esta consola (de qué va): la lee o la cambia
 *   dotrino-terminal profiles [--json]         los perfiles de esta máquina (enlazados o no)
 *   dotrino-terminal link [--name <n>]         enlaza un perfil con tu bóveda
 *   dotrino-terminal rename <perfil> [nuevo]   renombra un perfil (para su agente si corre)
 *   dotrino-terminal lock [--name <n>]         pone o cambia la clave que piden los otros aparatos
 *   dotrino-terminal lock --off [--name <n>]   la quita
 *   dotrino-terminal vscode [--name <n>]       la terminal embebida de VS Code abre consolas de aquí
 *   dotrino-terminal vscode --off              lo deshace
 *   dotrino-terminal desktop update [--check]  actualiza la app de escritorio (la ventana)
 *   dotrino-terminal updates [--json] [--desktop <versión>]
 *                                              qué versiones nuevas hay (del cliente y de la app)
 *   dotrino-terminal agents [--json]           qué agente corre en cada perfil y con qué versión
 *   dotrino-terminal network [--name <n>] [--json]  el uso de red del agente: por dónde va cada conexión
 *   dotrino-terminal restart [--name <n>] [--stale] [--yes]
 *                                              para el agente (cierra sus consolas) para que arranque
 *                                              con la versión instalada
 *   dotrino-terminal service install|uninstall|status [--name <n>]
 *                                              el agente como servicio: arranca solo con la máquina
 *
 * Un PERFIL es un agente con nombre (`~/.dotrino/agent/terminal-agent/<nombre>/`), enlazado a
 * una bóveda o solo local. Cada consola vive en el agente de un perfil.
 *
 * La shell no vive aquí: vive en el agente (`dotrino-terminal-agent`), y esta ventana es un
 * cliente más, igual que el navegador de otro aparato. Por eso lo que se abre aquí se puede
 * abrir desde terminal.dotrino.com. Si el agente no está corriendo, se levanta solo.
 *
 * Cerrar la ventana NO cierra la consola: sigue viva en el agente y se retoma después. Se
 * cierra saliendo de su shell (`exit`) o desde el panel.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'
import { printUpdateNotice } from '@dotrino/update/notice'
import { dataDir, loadLink, listProfiles, linkInteractive, LABEL } from '../link.js'
import { resolveInstance, isValidName } from '@dotrino/remote-agent/instances'
import readline from 'node:readline'
import { connectLocal } from '../local.js'
import { titleFilter } from '../title.js'
import { hasAccessCode, setAccessCode, clearAccessCode, MIN_LENGTH } from '../access.js'
import { configureEditors, terminalProfile } from '../editors.js'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'open'
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const es = /^es/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')
const t = (esText, enText) => (es ? esText : enText)

const DETACH_PREFIX = '\x1d'   // Ctrl+]

if (args.includes('-h') || args.includes('--help')) {
  console.log(t(`uso:
  dotrino-terminal [--name <n>] [--cwd <dir>] abre una consola nueva en esta ventana, en la carpeta actual
  dotrino-terminal attach <id> [--name <n>]  se engancha a una consola abierta
  dotrino-terminal ls [--name <n>] [--json]  las consolas abiertas
  dotrino-terminal kill <id> [--name <n>]    cierra una consola
  dotrino-terminal machines [--json]         tus otras máquinas encendidas y sus consolas
  dotrino-terminal … --machine <id|nombre>   abrir, attach, ls y kill, pero en otra máquina tuya
                                             (su id o su nombre salen en «machines»)
  dotrino-terminal note                      enseña la nota de esta consola (de qué va)
  dotrino-terminal note <texto>              la reemplaza («-» la lee de la entrada estándar)
  dotrino-terminal note --add <texto>        le añade una línea
  dotrino-terminal note --clear              la borra
  dotrino-terminal note --task <texto>       pone la TAREA en curso, que va aparte de la nota: es
                                             lo que usa un programa; --task '' la quita
  dotrino-terminal note --title <texto>      pone el TÍTULO de la consola en vez del de la shell
                                             (solo o junto a --task); --title '' devuelve el de la shell
                                             (--id <id> para otra consola; --json para leerla una máquina)
  dotrino-terminal profiles [--json]         los perfiles de esta máquina
  dotrino-terminal link [--name <n>]         enlaza un perfil con tu bóveda
  dotrino-terminal rename <perfil> [nuevo]   renombra un perfil (para su agente: cierra sus consolas)
  dotrino-terminal lock [--name <n>]         pone o cambia la clave (PIN o contraseña) que tus otros
                                             aparatos tienen que escribir para abrir consolas aquí
  dotrino-terminal lock --off [--name <n>]   quita la clave
  dotrino-terminal lock --status [--name <n>] dice si hay clave
  dotrino-terminal vscode [--name <n>]       hace que la terminal embebida de VS Code (y de
                                             VS Code Insiders, VSCodium y Cursor) abra consolas de aquí
  dotrino-terminal vscode --off              lo deshace
  dotrino-terminal desktop update            actualiza la app de escritorio (la ventana): baja la
                                             versión nueva, comprueba su firma y la instala
                                             (--check solo mira si hay una)
  dotrino-terminal updates [--json]          dice si hay versión nueva de dotrino-terminal y de la app
                                             (--desktop <versión> es la app que tienes; no instala nada)
  dotrino-terminal agents [--json]           qué agente corre en cada perfil, con qué versión y si va
                                             por detrás de la instalada
  dotrino-terminal network [--name <n>]      el uso de red del agente: por dónde va cada conexión con
                                             tus otros aparatos (directo, TURN o el proxy) y cuánto pasó
  dotrino-terminal restart [--name <n>]      para el agente para que arranque con la versión instalada
                                             (cierra TODAS sus consolas; --stale: solo los que van por
                                             detrás, en todos los perfiles; --yes no pregunta)
  dotrino-terminal service install [--name <n>]   deja el agente como servicio de tu usuario: arranca
                                             solo al encender la máquina, sin abrir ninguna ventana
  dotrino-terminal service uninstall [--name <n>] lo quita (para el agente: cierra sus consolas)
  dotrino-terminal service status [--name <n>]    dice si está puesto y si está corriendo

Dentro de una consola: Ctrl+] y luego d la suelta sin cerrarla; Ctrl+] n abre otra
(y suelta la actual); Ctrl+] a <id> Enter pasa a esa consola; Ctrl+] p fija el tamaño de la
consola a esta ventana y Ctrl+] u lo suelta.
Cerrar la ventana no cierra la consola: sigue abierta y se retoma después.`, `usage:
  dotrino-terminal [--name <n>] [--cwd <dir>] open a new console in this window, in the current folder
  dotrino-terminal attach <id> [--name <n>]  attach to an open console
  dotrino-terminal ls [--name <n>] [--json]  list open consoles
  dotrino-terminal kill <id> [--name <n>]    close a console
  dotrino-terminal machines [--json]         your other machines that are on, and their consoles
  dotrino-terminal … --machine <id|name>     open, attach, ls and kill, but on another machine of yours
                                             (its id or name show up in "machines")
  dotrino-terminal note                      show this console's note (what it is about)
  dotrino-terminal note <text>               replace it ("-" reads it from standard input)
  dotrino-terminal note --add <text>         append a line
  dotrino-terminal note --clear              clear it
  dotrino-terminal note --task <text>        set the TASK in progress, kept apart from the note: what
                                             a program uses; --task '' removes it
  dotrino-terminal note --title <text>       set the console's TITLE instead of the shell's (alone
                                             or with --task); --title '' gives the shell's back
                                             (--id <id> for another console; --json for a machine to read)
  dotrino-terminal profiles [--json]         this machine's profiles
  dotrino-terminal link [--name <n>]         link a profile with your vault
  dotrino-terminal rename <profile> [new]    rename a profile (stops its agent: closes its consoles)
  dotrino-terminal lock [--name <n>]         set or change the code (PIN or password) your other
                                             devices must type to open consoles here
  dotrino-terminal lock --off [--name <n>]   remove the code
  dotrino-terminal lock --status [--name <n>] say whether there is a code
  dotrino-terminal vscode [--name <n>]       make the integrated terminal of VS Code (and VS Code
                                             Insiders, VSCodium and Cursor) open consoles from here
  dotrino-terminal vscode --off              undo it
  dotrino-terminal claude                    make Claude Code keep the card of the console it runs
                                             in up to date (installs a skill and three hooks in ~/.claude)
  dotrino-terminal claude --off              undo it (--status says whether it is set)
  dotrino-terminal desktop update            update the desktop app (the window): downloads the
                                             new version, checks its signature and installs it
                                             (--check only looks for one)
  dotrino-terminal updates [--json]          say whether there is a new version of dotrino-terminal and of
                                             the app (--desktop <version> is the app you have; installs nothing)
  dotrino-terminal agents [--json]           which agent runs in each profile, its version and whether
                                             it is behind the installed one
  dotrino-terminal network [--name <n>]      the agent's network use: which path each connection with
                                             your other devices takes (direct, TURN or the proxy) and how much
  dotrino-terminal restart [--name <n>]      stop the agent so it starts with the installed version
                                             (closes ALL its consoles; --stale: only the ones behind,
                                             in every profile; --yes does not ask)
  dotrino-terminal service install [--name <n>]   run the agent as a service of your user: it starts
                                             by itself when the machine boots, with no window open
  dotrino-terminal service uninstall [--name <n>] remove it (stops the agent: closes its consoles)
  dotrino-terminal service status [--name <n>]    say whether it is installed and running

Inside a console: Ctrl+] then d detaches without closing it; Ctrl+] n opens another
(detaching the current one); Ctrl+] a <id> Enter switches to that console; Ctrl+] p pins the
console's size to this window and Ctrl+] u unpins it.
Closing the window does not close the console: it stays open and can be picked up later.`))
  process.exit(0)
}

/**
 * Un error que termina el cliente. Dentro de la app de escritorio (`DOTRINO_TERMINAL_HOLD=1`)
 * la ventana se cierra cuando el cliente sale, así que antes se espera una tecla: si no, el
 * error desaparecería con la ventana sin que nadie lo leyera.
 */
const HOLD = Symbol('hold')
function die (msg) {
  // Si la TTY ya estaba en crudo (ver `captureEarly`), se devuelve a normal para que el
  // mensaje salga con sus saltos de línea.
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch (_) {}
  process.stderr.write(msg + '\n')
  if (process.env.DOTRINO_TERMINAL_HOLD !== '1' || !process.stdin.isTTY) process.exit(1)
  process.stderr.write(t('\nPulsa una tecla para cerrar.', '\nPress any key to close.'))
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.once('data', () => process.exit(1))
  throw HOLD                          // corta lo que venía detrás; el proceso sale con la tecla
}

/**
 * Lo que se teclea MIENTRAS el cliente arranca (Node, y a veces levantar el agente). Con la TTY
 * en modo normal, eso se repetía en pantalla a destiempo y luego la pantalla de la consola lo
 * pisaba (un retorno de carro y a sobrescribir), y el agente lo descartaba porque aún no había
 * consola. Ahora la TTY pasa a crudo nada más empezar, y lo tecleado se guarda y se manda
 * entero cuando la consola está lista.
 */
const early = []
const earlyTap = (b) => early.push(b)
function captureEarly () {
  if (!process.stdin.isTTY) return
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', earlyTap)
}

/** El agente de esta máquina; si no hay ninguno escuchando, lo levanta y espera a que conteste. */
async function agent (dir) {
  try { return await connectLocal(dir) } catch (e) { if (e.code !== 'ENOAGENT') throw e }
  // Un agente vivo sin socket es uno anterior a las ventanas (< 0.6.0): no se levanta otro
  // encima (tendrían la misma llave), se dice.
  const pid = Number((() => { try { return fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8') } catch (_) { return '' } })())
  // Un agente que se está yendo (`dotrino-terminal restart`) cierra su socket un instante antes
  // de terminar: se le da ese instante antes de decir que es uno viejo.
  for (const t0 = Date.now(); pid && alive(pid) && Date.now() - t0 < 3000;) await new Promise((r) => setTimeout(r, 100))
  if (pid && alive(pid)) {
    throw new Error(t(`hay un agente corriendo (pid ${pid}) que no acepta ventanas: es anterior a la 0.6.0. Reinícialo con la versión nueva.`,
      `an agent is running (pid ${pid}) that does not accept windows: it predates 0.6.0. Restart it with the new version.`))
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = path.join(dir, 'agent.log')
  // Si este perfil tiene servicio (`dotrino-terminal service install`), el agente es el del
  // sistema: se arranca ese, no uno propio al lado. `--dir` fuerza una carpeta sin perfil.
  const { startService } = await import('../service.js')
  if (!(!opt('--dir') && !process.env.DOTRINO_TERMINAL_DIR && startService({ name: path.basename(dir) }))) {
    const fd = fs.openSync(log, 'a', 0o600)
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
    const extra = opt('--name') ? ['--name', opt('--name')] : []
    // Sin TTY: si la máquina no está enlazada, el agente atiende solo a las ventanas locales.
    const child = spawn(process.execPath, [cli, ...extra], { detached: true, stdio: ['ignore', fd, fd], env: process.env })
    child.unref()
    fs.closeSync(fd)
  }
  const t0 = Date.now()
  while (Date.now() - t0 < 10000) {
    await new Promise((r) => setTimeout(r, 100))
    try { return await connectLocal(dir) } catch (e) { if (e.code !== 'ENOAGENT') throw e }
  }
  throw new Error(t(`el agente no arrancó; mira ${log}`, `the agent did not start; see ${log}`))
}

/** `--tag <t>`: cómo se presenta esta ventana en la lista de quién mira (la app de escritorio). */
const tag = () => (opt('--tag') ? { tag: opt('--tag') } : {})

function alive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

async function profiles () {
  const list = await listProfiles()
  if (args.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return }
  for (const p of list) {
    const what = p.linked ? `${t('aparato', 'device')} ${p.id} · ${t('bóveda', 'vault')} ${p.vault}` : t('sin enlazar (solo esta máquina)', 'not linked (this machine only)')
    console.log(`  ${p.name.padEnd(16)} ${what}`)
  }
}

/** Pone (o quita, con `--off`) el perfil de terminal «Dotrino» en los editores instalados. */
function vscode () {
  const off = args.includes('--off')
  const name = opt('--name')
  if (name !== undefined && !isValidName(name)) die(t(`nombre de perfil no válido: ${name}`, `invalid profile name: ${name}`))
  const profile = off ? null : terminalProfile({ node: process.execPath, script: fs.realpathSync(fileURLToPath(import.meta.url)), name })
  let done
  try { done = configureEditors({ profile }) } catch (e) {
    if (e.code === 'no-editor') die(t('no encontré VS Code, VS Code Insiders, VSCodium ni Cursor en esta cuenta.', 'could not find VS Code, VS Code Insiders, VSCodium or Cursor in this account.'))
    if (e.code === 'bad-settings') die(t(`no se pudo leer la configuración y no se tocó nada: ${e.message}`, `could not read the settings and nothing was changed: ${e.message}`))
    if (e.code === 'unsupported-platform') die(t('esto solo está para Linux y macOS.', 'this is only available on Linux and macOS.'))
    throw e
  }
  for (const d of done) {
    const what = off
      ? (d.changed ? t('quitado', 'removed') : t('no estaba', 'was not set'))
      : (d.changed ? t('configurado', 'configured') : t('ya estaba', 'already set'))
    console.log(`  ${d.name.padEnd(18)} ${what}  ${d.settings}`)
  }
  if (!off) console.log(t('\nLas terminales nuevas del editor ya abren aquí. Si actualizas o cambias de Node, vuelve a correr esta orden.', '\nNew terminals in the editor now open here. If you update or switch Node, run this command again.'))
}

/**
 * `dotrino-terminal claude`: que Claude Code mantenga la tarjeta «de qué va» de su consola (el
 * skill y los hooks, `claude.js`). `--off` lo quita; `--status` dice si está puesto.
 */
async function claude () {
  const { configureClaude, claudeStatus, HOOKS } = await import('../claude.js')
  if (args.includes('--status')) {
    const s = claudeStatus()
    const all = s.skill && s.hooks.length === HOOKS.length && s.wired.length === HOOKS.length
    const none = !s.skill && !s.hooks.length && !s.wired.length
    if (args.includes('--json')) { console.log(JSON.stringify({ installed: all, ...s })); return }
    console.log(all ? t('Instalado: Claude Code mantiene la tarjeta de sus consolas.', 'Installed: Claude Code keeps the card of its consoles.')
      : none ? t('No está instalado. Se pone con: dotrino-terminal claude', 'Not installed. Set it with: dotrino-terminal claude')
        : t('A medias: vuelve a correr «dotrino-terminal claude» para dejarlo entero.', 'Half set: run "dotrino-terminal claude" again to complete it.'))
    return
  }
  const off = args.includes('--off')
  let done
  try { done = configureClaude({ off }) } catch (e) {
    if (e.code === 'no-claude') die(t('no encontré Claude Code en esta cuenta (no existe ~/.claude). Ábrelo una vez y repite.', 'could not find Claude Code in this account (~/.claude does not exist). Open it once and try again.'))
    if (e.code === 'bad-settings') die(t(`no se pudo leer la configuración de Claude Code y no se tocó nada: ${e.message}`, `could not read Claude Code's settings and nothing was changed: ${e.message}`))
    throw e
  }
  const what = off
    ? (done.changed ? t('quitado', 'removed') : t('no estaba', 'was not set'))
    : (done.changed ? t('instalado', 'installed') : t('ya estaba', 'already set'))
  console.log(`  Claude Code  ${what}`)
  if (!off) {
    console.log(`    ${done.skill}`)
    for (const h of done.hooks) console.log(`    ${h}`)
    console.log(`    ${done.settings}`)
    console.log(t('\nLas sesiones NUEVAS de Claude Code dentro de una consola de Dotrino Terminal ya mantienen su tarjeta. Fuera de una consola no hace nada.', '\nNEW Claude Code sessions inside a Dotrino Terminal console now keep its card. Outside a console it does nothing.'))
  }
}

/**
 * Qué versiones nuevas hay, sin instalar nada: del cliente (npm) y, con `--desktop <versión>`,
 * de la app de escritorio. La app lo pregunta al arrancar (ella no tiene red). Cada una dice
 * `newer` o por qué no se pudo mirar: «no se pudo mirar» no es «al día».
 */
async function updates () {
  const { latestVersion, isNewer } = await import('@dotrino/update')
  const one = async (current, ask) => {
    const r = await ask()
    return r.ok ? { current, latest: r.version, newer: isNewer(r.version, current) } : { current, error: r.reason }
  }
  const out = { agent: await one(VERSION, () => latestVersion({ source: 'npm', pkg: '@dotrino/terminal-agent', product: 'dotrino-terminal', version: VERSION })) }
  const app = opt('--desktop')
  if (app) {
    const { latestDesktop } = await import('../desktop.js')
    out.desktop = await one(app, () => latestDesktop({ version: app }))
  }
  if (args.includes('--json')) { console.log(JSON.stringify(out)); return }
  const say = (name, x) => console.log(x.error
    ? t(`${name}: no se pudo mirar (${x.error}).`, `${name}: could not check (${x.error}).`)
    : x.newer ? t(`${name}: hay ${x.latest} y tienes ${x.current}.`, `${name}: ${x.latest} is out and you have ${x.current}.`)
      : t(`${name}: al día (${x.current}).`, `${name}: up to date (${x.current}).`))
  say('dotrino-terminal', out.agent)
  if (out.desktop) say(t('La app', 'The app'), out.desktop)
}

/** Dónde está la app de escritorio, si no lo dijo quien llama: la del PATH. */
function findDesktop (name) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    const f = path.join(d, name)
    try { fs.accessSync(f, fs.constants.X_OK); return fs.realpathSync(f) } catch (_) {}
  }
  return null
}

/**
 * Actualiza la app de escritorio. La app lo corre desde su menú con `--current` (su versión)
 * y `--exe` (su binario); a mano basta `dotrino-terminal desktop update`.
 */
async function desktop () {
  if (args[1] !== 'update') die(t('uso: dotrino-terminal desktop update [--check]', 'usage: dotrino-terminal desktop update [--check]'))
  const { updateDesktop, BINARY } = await import('../desktop.js')
  const current = opt('--current')
  const exe = opt('--exe') || findDesktop(BINARY)
  const check = args.includes('--check')
  if (!exe && !check) die(t(`no encontré ${BINARY} en esta máquina. Bájala de https://terminal.dotrino.com/`, `could not find ${BINARY} on this machine. Get it from https://terminal.dotrino.com/`))
  const say = (step, d) => {
    if (step === 'latest') console.log(d.current ? t(`Publicada: ${d.version} · esta: ${d.current}`, `Published: ${d.version} · this one: ${d.current}`) : t(`Publicada: ${d.version}`, `Published: ${d.version}`))
    if (step === 'download') console.log(t(`Bajando ${d.name} y comprobando su firma…`, `Downloading ${d.name} and checking its signature…`))
    if (step === 'verified') console.log(t(`Firmado por la release de ${d.repo} ✓`, `Signed by the release of ${d.repo} ✓`))
    if (step === 'install' && (d.kind === 'deb' || d.kind === 'rpm') && process.getuid?.() !== 0) console.log(t('Instalar un paquete del sistema pide tu contraseña:', 'Installing a system package asks for your password:'))
  }
  console.log(t('Mirando qué hay publicado…', 'Checking what is published…'))
  const r = await updateDesktop({ exe, current, check, say })
  if (!r.ok) {
    const why = {
      'could-not-check': t(`No se pudo mirar (${r.reason}). No es que estés al día: es que no se sabe.`, `Could not check (${r.reason}). That does not mean you are up to date: it is unknown.`),
      NO_VERIFIER: t('NO se instala nada: a este programa le falta la pieza que comprueba la firma. Reinstálalo con: npm install -g @dotrino/terminal-agent', 'Nothing is installed: this program is missing the piece that checks the signature. Reinstall it with: npm install -g @dotrino/terminal-agent'),
      'not-writable': t(`NO se instala nada: no puedo escribir donde está la app (${r.reason}). Bájala de https://terminal.dotrino.com/`, `Nothing is installed: I cannot write where the app is (${r.reason}). Get it from https://terminal.dotrino.com/`)
    }[r.code] || t(`NO se instala nada: ${r.reason}`, `Nothing is installed: ${r.reason}`)
    die(r.file ? `${why}\n${t('El archivo, ya comprobado, quedó en', 'The file, already checked, is at')} ${r.file}` : why)
  }
  if (r.updated) console.log(t(`\nInstalada la ${r.version}. Las ventanas abiertas siguen con la anterior: cierra Dotrino Terminal y vuelve a abrirla. Tus consolas no se cierran.`, `\nInstalled ${r.version}. Open windows keep the old one: quit Dotrino Terminal and open it again. Your consoles stay open.`))
  else if (r.newer) console.log(t('Hay versión nueva. Tráela con: dotrino-terminal desktop update', 'There is a new version. Get it with: dotrino-terminal desktop update'))
  else console.log(t(`La app está al día (${current}).`, `The app is up to date (${current}).`))
}

/** Cuántas consolas tiene abiertas el agente de esa carpeta (0 si no hay agente). */
async function openConsoles (dir) {
  let conn
  try { conn = await connectLocal(dir) } catch (e) { if (e.code === 'ENOAGENT') return 0; throw e }
  const r = await request(conn, { type: 'list' }, 'consoles')
  conn.close()
  if (r.type === 'fail') throw new Error(`${r.message} (${r.code})`)
  return r.list.length
}

/** Lo que se espera a que un agente diga su versión: uno anterior a la 0.45.0 no contesta. */
const VERSION_WAIT_MS = 1500

/**
 * Los agentes de esta máquina, uno por perfil: si corre, con qué versión y cuántas consolas.
 * `stale`: corre con una versión que no es la instalada (el paquete se actualizó y él sigue con
 * la anterior hasta que se reinicie). `version: null`: no la dijo, así que es anterior a la 0.45.0.
 */
async function agentStates () {
  const out = []
  for (const p of await listProfiles()) {
    let conn
    try { conn = await connectLocal(p.dir) } catch (e) {
      if (e.code !== 'ENOAGENT') throw e
      out.push({ name: p.name, running: false, version: null, consoles: 0, stale: false })
      continue
    }
    const v = await Promise.race([request(conn, { type: 'version' }, 'version'), new Promise((resolve) => setTimeout(() => resolve(null), VERSION_WAIT_MS))])
    const l = await request(conn, { type: 'list' }, 'consoles')
    conn.close()
    if (l.type === 'fail') throw new Error(`${l.message} (${l.code})`)
    const version = v && v.type === 'version' ? v.version : null
    out.push({ name: p.name, running: true, version, consoles: l.list.length, stale: version !== VERSION })
  }
  return out
}

/** `dotrino-terminal agents`: qué agente corre en cada perfil y si va por detrás de lo instalado. */
async function agents () {
  const list = await agentStates()
  if (args.includes('--json')) { console.log(JSON.stringify({ installed: VERSION, agents: list })); return }
  for (const a of list) {
    const what = !a.running ? t('parado', 'stopped')
      : `${a.version || t('anterior a la 0.45.0', 'older than 0.45.0')} · ${a.consoles} ${t('consola(s)', 'console(s)')}${a.stale ? t(` · instalada la ${VERSION}: reinícialo con «dotrino-terminal restart --name ${a.name}»`, ` · ${VERSION} is installed: restart it with "dotrino-terminal restart --name ${a.name}"`) : ''}`
    console.log(`  ${a.name.padEnd(16)} ${what}`)
  }
}

/**
 * `dotrino-terminal restart`: para el agente para que arranque con la versión instalada. Cierra
 * TODAS sus consolas (las de las ventanas, las de un editor y las que miran otros aparatos), así
 * que pregunta antes. `--stale`: solo los que van por detrás de lo instalado, en todos los perfiles.
 */
async function restart () {
  const stale = args.includes('--stale')
  const asked = opt('--name')
  if (asked !== undefined && !isValidName(asked)) die(t(`nombre de perfil no válido: ${asked}`, `invalid profile name: ${asked}`))
  const only = stale && asked === undefined ? null : path.basename(resolveInstance(LABEL, asked).dir)
  const targets = (await agentStates()).filter((a) => a.running && (only === null || a.name === only) && (!stale || a.stale))
  if (!targets.length) { console.log(stale ? t('Ningún agente va por detrás de lo instalado.', 'No agent is behind what is installed.') : t('Ese perfil no tiene un agente corriendo.', 'That profile has no agent running.')); return }
  const dirOf = (name) => resolveInstance(LABEL, name).dir
  // ¿Corre esta orden DENTRO de una consola de uno de esos agentes? Pararlo la cerraría a mitad
  // de camino: el trabajo lo hace un proceso aparte.
  const inside = targets.some((a) => !!process.env.DOTRINO_TERMINAL_PROFILE_DIR && samePath(process.env.DOTRINO_TERMINAL_PROFILE_DIR, dirOf(a.name)))
  const open = targets.reduce((n, a) => n + a.consoles, 0)
  if (open && !args.includes('--yes')) {
    const ok = await ask(t(`Se van a cerrar ${open} consola(s)${inside ? ', esta incluida' : ''}. ¿Seguir? [s/N] `, `${open} console(s) will be closed${inside ? ', this one included' : ''}. Continue? [y/N] `))
    if (!/^[sy]/i.test(ok)) die(t('No se reinició nada.', 'Nothing was restarted.'))
  }
  if (inside && !args.includes('--detached-step')) {
    const self = fileURLToPath(import.meta.url)
    spawn(process.execPath, [self, ...args.filter((a) => a !== '--yes'), '--yes', '--detached-step'], { detached: true, stdio: 'ignore', env: process.env }).unref()
    console.log(t('Reiniciando. Esta consola se va a cerrar.', 'Restarting. This console is about to close.'))
    return
  }
  const { serviceStatus } = await import('../service.js')
  for (const a of targets) {
    const dir = dirOf(a.name)
    const pid = Number((() => { try { return fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8') } catch (_) { return '' } })())
    if (!pid || !alive(pid)) die(t(`el agente de «${a.name}» contesta pero no dejó su pid: páralo a mano.`, `the agent of "${a.name}" answers but left no pid: stop it by hand.`))
    process.kill(pid, 'SIGTERM')
    for (const t0 = Date.now(); alive(pid);) {
      if (Date.now() - t0 > 5000) die(t(`el agente de «${a.name}» (pid ${pid}) no se detuvo: páralo a mano.`, `the agent of "${a.name}" (pid ${pid}) did not stop: stop it by hand.`))
      await new Promise((r) => setTimeout(r, 100))
    }
    let service = false
    try { service = serviceStatus({ name: a.name }).installed } catch (e) { if (e.code !== 'no-user-systemd' && e.code !== 'unsupported-platform') throw e }
    console.log(service
      ? t(`«${a.name}»: agente detenido (${a.consoles} consola(s) cerradas). Su servicio lo vuelve a levantar con la ${VERSION}.`, `"${a.name}": agent stopped (${a.consoles} console(s) closed). Its service starts it again with ${VERSION}.`)
      : t(`«${a.name}»: agente detenido (${a.consoles} consola(s) cerradas). Arranca con la ${VERSION} al abrir una ventana.`, `"${a.name}": agent stopped (${a.consoles} console(s) closed). It starts with ${VERSION} when you open a window.`))
  }
}

/**
 * `dotrino-terminal network`: el uso de red del agente de este perfil. Por dónde va cada conexión
 * con tus otros aparatos (directo, TURN o el proxio) y cuánto pasó por cada camino.
 */
async function network () {
  const asked = opt('--name')
  if (asked !== undefined && !isValidName(asked)) die(t(`nombre de perfil no válido: ${asked}`, `invalid profile name: ${asked}`))
  const { dir } = resolveInstance(LABEL, asked)
  let conn
  try { conn = await connectLocal(dir) } catch (e) {
    if (e.code !== 'ENOAGENT') throw e
    console.log(t('Este perfil no tiene un agente corriendo: no hay conexiones.', 'This profile has no agent running: there are no connections.'))
    return
  }
  const r = await Promise.race([request(conn, { type: 'net' }, 'net'), new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
  conn.close()
  if (!r) die(t('el agente que corre es anterior a la 0.46.0 y no da su uso de red. Reinícialo con la versión nueva: dotrino-terminal restart', 'the running agent predates 0.46.0 and does not report its network use. Restart it with the new version: dotrino-terminal restart'))
  if (r.type === 'fail') die(`${r.message} (${r.code})`)
  if (args.includes('--json')) { console.log(JSON.stringify(r.transports)); return }
  console.log(t('Esta ventana ↔ el agente de esta máquina: socket local (no toca la red).', 'This window ↔ this machine\'s agent: local socket (never touches the network).'))
  console.log(t('El agente ↔ tus otros aparatos (route: direct = WebRTC directo, turn = WebRTC por TURN, proxy = por el proxy):\n', 'The agent ↔ your other devices (route: direct = direct WebRTC, turn = WebRTC via TURN, proxy = through the proxy):\n'))
  process.stdout.write(r.report)
  console.log(t('\nBytes del contenido, sin las cabeceras de la red. Acumulados desde que arrancó el agente.', '\nContent bytes, without network headers. Accumulated since the agent started.'))
}

/** El agente como servicio del usuario (systemd en Linux, launchd en macOS). */
async function service () {
  const action = args[1]
  if (!['install', 'uninstall', 'status'].includes(action)) die(t('uso: dotrino-terminal service install|uninstall|status [--name <perfil>]', 'usage: dotrino-terminal service install|uninstall|status [--name <profile>]'))
  const asked = opt('--name')
  if (asked !== undefined && !isValidName(asked)) die(t(`nombre de perfil no válido: ${asked}`, `invalid profile name: ${asked}`))
  const { dir } = resolveInstance(LABEL, asked)
  const name = path.basename(dir)
  const { installService, uninstallService, serviceStatus } = await import('../service.js')
  const explain = (e) => {
    if (e.code === 'no-user-systemd') die(t('esta sesión no tiene systemd de usuario, que es donde se pone el servicio. No se instaló nada.', 'this session has no systemd user manager, which is where the service goes. Nothing was installed.'))
    if (e.code === 'unsupported-platform') die(t('esto solo está para Linux y macOS.', 'this is only available on Linux and macOS.'))
    throw e
  }
  let st
  try { st = serviceStatus({ name }) } catch (e) { explain(e) }
  const pid = Number((() => { try { return fs.readFileSync(path.join(dir, 'agent.pid'), 'utf8') } catch (_) { return '' } })())
  const running = !!pid && alive(pid)

  if (action === 'status') {
    if (!st.installed) console.log(t(`El perfil «${name}» no tiene servicio: su agente arranca cuando abres una ventana. Para ponerlo: dotrino-terminal service install --name ${name}`, `Profile "${name}" has no service: its agent starts when you open a window. To add it: dotrino-terminal service install --name ${name}`))
    else if (st.active) console.log(t(`Servicio puesto y corriendo (${st.file}).`, `Service installed and running (${st.file}).`))
    else if (running) console.log(t(`Servicio puesto (${st.file}). Ahora corre un agente que levantó una ventana; el servicio toma el relevo cuando ese termine o al próximo arranque.`, `Service installed (${st.file}). Right now an agent started by a window is running; the service takes over when it ends or at the next start.`))
    else console.log(t(`Servicio puesto pero parado (${st.file}). Arranca al abrir una ventana; si falló, mira por qué: journalctl --user -u dotrino-terminal-agent-${name}`, `Service installed but stopped (${st.file}). It starts when you open a window; if it failed, see why: journalctl --user -u dotrino-terminal-agent-${name}`))
    return
  }

  if (action === 'install') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const cli = fs.realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)))
    // Un agente que corre por su cuenta no se para: cerraría sus consolas.
    const own = running && !st.active
    let r
    try { r = installService({ name, cli, dir, running: own }) } catch (e) { explain(e) }
    console.log(t(`Servicio del perfil «${name}» puesto: ${r.file}`, `Service for profile "${name}" installed: ${r.file}`))
    if (r.started) console.log(t('El agente ya corre como servicio.', 'The agent now runs as a service.'))
    else console.log(t('Ahora mismo corre un agente que levantó una ventana, y no se toca para no cerrar sus consolas. El servicio toma el relevo cuando ese termine o al próximo arranque.', 'Right now an agent started by a window is running, and it is left alone so its consoles stay open. The service takes over when it ends or at the next start.'))
    if (r.kind === 'launchd') console.log(t('Arranca solo cuando inicias sesión en esta Mac.', 'It starts by itself when you log in to this Mac.'))
    else if (r.boot) console.log(t('Arranca solo al encender la máquina, sin que nadie inicie sesión.', 'It starts by itself when the machine boots, with nobody logged in.'))
    else console.log(t(`Arranca solo cuando inicias sesión. Para que arranque al encender, sin iniciar sesión: sudo loginctl enable-linger ${os.userInfo().username}`, `It starts by itself when you log in. To start at boot, with nobody logged in: sudo loginctl enable-linger ${os.userInfo().username}`))
    if (!loadLink(dir)) console.log(t(`Este perfil no está enlazado: el servicio atiende solo a las ventanas de esta máquina. Para abrir sus consolas desde otros aparatos: dotrino-terminal link --name ${name}`, `This profile is not linked: the service only serves this machine's windows. To open its consoles from other devices: dotrino-terminal link --name ${name}`))
    console.log(t('Si cambias de versión de Node, vuelve a correr esta orden.', 'If you switch Node versions, run this command again.'))
    return
  }

  if (!st.installed) { console.log(t(`El perfil «${name}» no tiene servicio.`, `Profile "${name}" has no service.`)); return }
  // Quitarlo para el agente que corre bajo el servicio, y con él sus consolas.
  if (st.active && !args.includes('--yes')) {
    const inside = !!process.env.DOTRINO_TERMINAL_PROFILE_DIR && samePath(process.env.DOTRINO_TERMINAL_PROFILE_DIR, dir)
    if (inside) die(t('esta consola es de ese mismo servicio: quitarlo la cerraría a mitad de la orden. Hazlo desde una terminal normal, o con --yes si eso es lo que quieres.', 'this console belongs to that very service: removing it would close it mid-command. Do it from a plain terminal, or with --yes if that is what you want.'))
    const open = await openConsoles(dir)
    if (open > 0) {
      const ok = await ask(t(`El perfil «${name}» tiene ${open} consola(s) abierta(s); quitar el servicio las cierra. ¿Seguir? [s/N] `, `Profile "${name}" has ${open} open console(s); removing the service closes them. Continue? [y/N] `))
      if (!/^[sy]/i.test(ok)) die(t('No se quitó.', 'Not removed.'))
    }
  }
  let r
  try { r = uninstallService({ name }) } catch (e) { explain(e) }
  console.log(t(`Servicio del perfil «${name}» quitado (${r.file}). El perfil y su enlace siguen igual: el agente vuelve a arrancar cuando abras una ventana.`, `Service for profile "${name}" removed (${r.file}). The profile and its link are untouched: the agent starts again when you open a window.`))
}

/** Enlaza un perfil. Sin `--name`, lo pregunta. Uno ya enlazado no se pisa: eso es `enroll`. */
async function link () {
  let name = opt('--name')
  if (!name) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const taken = (await listProfiles()).filter((p) => p.linked).map((p) => p.name)
    const suggestion = taken.includes('default') ? '' : 'default'
    name = await new Promise((resolve) => rl.question(t(`Nombre del perfil (a-z, 0-9, -)${suggestion ? ` [${suggestion}]` : ''}: `, `Profile name (a-z, 0-9, -)${suggestion ? ` [${suggestion}]` : ''}: `), (a) => { rl.close(); resolve(a.trim() || suggestion) }))
  }
  if (!isValidName(name)) die(t(`nombre no válido: «${name}» (usa a-z, 0-9 y -, hasta 32)`, `invalid name: "${name}" (use a-z, 0-9 and -, up to 32)`))
  const { dir } = resolveInstance(LABEL, name)
  if (loadLink(dir)) die(t(`el perfil «${name}» ya está enlazado. Para re-enlazarlo: dotrino-terminal-agent enroll --name ${name}`, `profile "${name}" is already linked. To re-link it: dotrino-terminal-agent enroll --name ${name}`))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  await linkInteractive(dir)
  console.log(t(`Perfil «${name}» enlazado.`, `Profile "${name}" linked.`))
}

function ask (q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()) }))
}

/** Pregunta algo que no debe verse al teclearlo. Solo en una TTY: una clave no se pasa por una tubería. */
function askHidden (q) {
  if (!process.stdin.isTTY) die(t('la clave se teclea: hace falta una terminal', 'the code is typed: a terminal is needed'))
  process.stdout.write(q)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve) => {
    let typed = ''
    const onData = (b) => {
      // Una tecla que no es texto (flechas, Fin, el teclado numérico SIN Bloq Num) llega como una
      // secuencia de escape: se descarta entera. Antes solo se saltaba el ESC y el resto («[F»)
      // entraba en la clave sin que se viera, así que la clave guardada no era la tecleada.
      const typedText = b.toString('utf8').replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '')
      for (const ch of typedText) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause()
          process.stdout.write('\n'); resolve(typed); return
        }
        if (ch === '\x03') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130) }
        if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1)
        else if (ch >= ' ') typed += ch
      }
    }
    process.stdin.on('data', onData)
  })
}

/**
 * La clave de esta máquina (access.js). Se pone AQUÍ, en la máquina, y la piden solo los otros
 * aparatos: quien está sentado delante ya es el usuario que puede leer y borrar el archivo, así
 * que ni cambiarla ni quitarla piden la anterior. Vale al momento, sin reiniciar el agente.
 */
async function lock () {
  const dir = opt('--dir') || dataDir(opt('--name'))
  if (args.includes('--status')) {
    console.log(hasAccessCode(dir)
      ? t('Hay clave: tus otros aparatos la escriben para abrir consolas en esta máquina.', 'There is a code: your other devices type it to open consoles on this machine.')
      : t('Sin clave: cualquier aparato de tu cuenta abre consolas en esta máquina.', 'No code: any device of your account opens consoles on this machine.'))
    return
  }
  if (args.includes('--off')) {
    if (!hasAccessCode(dir)) { console.log(t('Esta máquina no tenía clave.', 'This machine had no code.')); return }
    clearAccessCode(dir)
    console.log(t('Clave quitada. Cualquier aparato de tu cuenta vuelve a abrir consolas aquí.', 'Code removed. Any device of your account opens consoles here again.'))
    return
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const changing = hasAccessCode(dir)
  const first = await askHidden(t(`Clave nueva (PIN o contraseña, mínimo ${MIN_LENGTH}): `, `New code (PIN or password, at least ${MIN_LENGTH}): `))
  if (first.length < MIN_LENGTH) die(t(`demasiado corta: mínimo ${MIN_LENGTH} caracteres`, `too short: at least ${MIN_LENGTH} characters`))
  const again = await askHidden(t('Otra vez: ', 'Again: '))
  if (again !== first) die(t('no coinciden. No se cambió nada.', 'they do not match. Nothing was changed.'))
  setAccessCode(dir, first)
  console.log(changing
    ? t('Clave cambiada. Los aparatos que ya estaban dentro siguen hasta que se desconecten.', 'Code changed. Devices already in stay until they disconnect.')
    : t('Clave puesta. Tus otros aparatos la escriben para abrir consolas en esta máquina; las ventanas de esta máquina no la piden.', 'Code set. Your other devices type it to open consoles on this machine; this machine\'s own windows do not ask for it.'))
}

/**
 * Renombra un perfil: su carpeta, nada más. Es el mismo aparato con la misma llave, así que el
 * acta no se entera ni hace falta volver a enrolar. El nombre es solo tuyo, de esta máquina.
 *
 * Si su agente está corriendo hay que pararlo (las ventanas lo encuentran por el socket de esa
 * carpeta), y eso cierra sus consolas: si quedan abiertas, se dice cuántas y se pregunta.
 */
async function rename () {
  const from = args[1]
  if (!from) die(t('falta el perfil: dotrino-terminal rename <perfil> [nuevo]', 'missing profile: dotrino-terminal rename <profile> [new]'))
  if (!isValidName(from)) die(t(`nombre no válido: «${from}»`, `invalid name: "${from}"`))
  const { dir } = resolveInstance(LABEL, from)
  if (!fs.existsSync(dir)) die(t(`no existe el perfil «${from}»`, `there is no profile "${from}"`))
  let to = args[2] && !args[2].startsWith('-') ? args[2] : await ask(t(`Nuevo nombre para «${from}» (a-z, 0-9, -): `, `New name for "${from}" (a-z, 0-9, -): `))
  if (!isValidName(to)) die(t(`nombre no válido: «${to}» (usa a-z, 0-9 y -, hasta 32)`, `invalid name: "${to}" (use a-z, 0-9 and -, up to 32)`))
  if (to === from) die(t('es el mismo nombre', 'that is the same name'))
  const target = resolveInstance(LABEL, to).dir
  if (fs.existsSync(target)) die(t(`ya hay un perfil «${to}»`, `there is already a profile "${to}"`))

  const pidFile = path.join(dir, 'agent.pid')
  const pid = Number((() => { try { return fs.readFileSync(pidFile, 'utf8') } catch (_) { return '' } })())
  const running = pid && alive(pid)
  // ¿Corre esta orden DENTRO de una consola del perfil que se renombra? Entonces parar su
  // agente cerraría esta misma consola a mitad de camino: el trabajo lo hace un proceso aparte.
  const inside = !!process.env.DOTRINO_TERMINAL_PROFILE_DIR && samePath(process.env.DOTRINO_TERMINAL_PROFILE_DIR, dir)
  if (running && !args.includes('--yes')) {
    let open = 0
    try {
      const conn = await connectLocal(dir)
      open = ((await request(conn, { type: 'list' }, 'consoles')).list || []).length
      conn.close()
    } catch (_) { /* agente viejo sin socket: igual hay que pararlo */ }
    const others = open - (inside ? 1 : 0)
    if (others > 0) {
      const ok = await ask(t(`El perfil «${from}» tiene ${others} consola(s) abierta(s) más; renombrarlo las cierra. ¿Seguir? [s/N] `, `Profile "${from}" has ${others} more open console(s); renaming it closes them. Continue? [y/N] `))
      if (!/^[sy]/i.test(ok)) die(t('No se renombró.', 'Not renamed.'))
    }
  }
  if (running && inside && !args.includes('--detached-step')) {
    const self = fileURLToPath(import.meta.url)
    spawn(process.execPath, [self, 'rename', from, to, '--yes', '--detached-step'], { detached: true, stdio: 'ignore', env: process.env }).unref()
    console.log(t(`Renombrando «${from}» → «${to}». Esta consola es de ese perfil y se va a cerrar; la ventana sigue en «${to}».`,
      `Renaming "${from}" → "${to}". This console belongs to that profile and is about to close; the window continues in "${to}".`))
    return
  }
  // PRIMERO se mueve la carpeta y DESPUÉS se para el agente: así quien estaba mirando ve que el
  // perfil ya cambió de nombre cuando se le cae la conexión (y no lo confunde con un fallo).
  // Mover la carpeta con el agente vivo no rompe nada: el socket y el pid se van con ella.
  fs.renameSync(dir, target)
  if (running) {
    process.kill(pid, 'SIGTERM')
    const t0 = Date.now()
    while (alive(pid)) {
      if (Date.now() - t0 > 5000) die(t(`renombrado, pero el agente (pid ${pid}) no se detuvo: páralo a mano`, `renamed, but the agent (pid ${pid}) did not stop: stop it by hand`))
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  // Lo que dejó el agente viejo (su pid y su socket ya no atienden): el próximo arranca limpio.
  fs.rmSync(path.join(target, 'agent.pid'), { force: true })
  fs.rmSync(path.join(target, 'terminal.sock'), { force: true })
  // La app de escritorio recuerda el último perfil elegido: si era este, pasa al nombre nuevo.
  const last = lastProfileFile()
  try { if (fs.readFileSync(last, 'utf8').trim() === from) fs.writeFileSync(last, to) } catch (_) { /* sin preferencia guardada */ }
  console.log(t(`Perfil «${from}» → «${to}». Es el mismo aparato: no hace falta volver a enrolar.`, `Profile "${from}" → "${to}". Same device: no need to enroll again.`))
}

function samePath (a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch (_) { return path.resolve(a) === path.resolve(b) }
}

/** La preferencia de la app de escritorio: el último perfil elegido en su menú. */
function lastProfileFile () {
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')
  return path.join(base, 'dotrino-terminal', 'last-profile')
}

/** Una pregunta y su respuesta, para `ls` y `kill`. */
function request (conn, msg, type) {
  return new Promise((resolve) => {
    conn.on('message', (m) => { if (m.type === type || m.type === 'fail') resolve(m) })
    conn.send(msg)
  })
}

/** Lo que se espera a que el agente conteste por otra máquina (descubrirla y saludarla). */
const FAR_WAIT_MS = 40_000
/** Una pregunta sobre las otras máquinas. Un agente anterior a la 0.38 no la entiende y calla: se dice. */
async function farRequest (conn, msg, type) {
  const r = await Promise.race([request(conn, msg, type), new Promise((resolve) => setTimeout(() => resolve(null), FAR_WAIT_MS))])
  if (!r) die(t('el agente de esta máquina no contestó. Si es anterior a la 0.38 no sabe de otras máquinas: actualízalo y reinícialo.', 'this machine\'s agent did not answer. If it predates 0.38 it knows nothing about other machines: update and restart it.'))
  return r
}
const farMessage = (r) => ({
  'not-linked': t('esta máquina no está enlazada con tu bóveda, así que no ve tus otras máquinas. Enlázala con: dotrino-terminal link', 'this machine is not linked to your vault, so it cannot see your other machines. Link it with: dotrino-terminal link'),
  'no-acta': t('no se pudo preguntar a tu bóveda qué máquinas tienes. Comprueba que esté encendida y que esta máquina tenga conexión.', 'could not ask your vault which machines you have. Check that it is on and that this machine is online.'),
  'no-machine': t('no hay ninguna máquina encendida con ese id o nombre (mira «dotrino-terminal machines»).', 'no machine with that id or name is on (see "dotrino-terminal machines").'),
  'ambiguous-machine': t('hay más de una máquina con ese nombre: usa su id (mira «dotrino-terminal machines»).', 'more than one machine has that name: use its id (see "dotrino-terminal machines").')
}[r.code] || `${r.message} (${r.code})`)

/** `dotrino-terminal machines`: las otras máquinas de la cuenta que están encendidas, y sus consolas. */
async function machines (conn) {
  const r = await farRequest(conn, { type: 'machines' }, 'machines')
  if (r.type === 'fail') die(`dotrino-terminal: ${farMessage(r)}`)
  if (args.includes('--json')) { console.log(JSON.stringify(r.list, null, 2)); return }
  if (!r.list.length) { console.log(t('No hay otras máquinas encendidas con Dotrino Terminal.', 'No other machines are on with Dotrino Terminal.')); return }
  for (const m of r.list) {
    const state = m.locked ? t('pide su clave', 'asks for its code') : m.error ? t('no contesta', 'not answering') : `${m.consoles.length} ${t('consolas', 'consoles')}`
    console.log(`${m.id}  ${m.name || ''}  ·  ${state}`)
    for (const c of m.consoles || []) console.log(`  ${c.id}  ${age(Date.now() - c.createdAt).padStart(4)}  ${c.viewers} ${t('mirando', 'watching')}  ${c.title || ''}`)
  }
}

/**
 * `--machine <id|nombre>`: esta conexión pasa a hablar con OTRA máquina de la cuenta (el agente
 * de aquí hace de puente, `far.js`). A partir de ahí todo es igual que en local. Si la otra
 * máquina tiene clave, se pide aquí, antes de seguir.
 */
async function goVia (conn, ref) {
  const r = await farRequest(conn, { type: 'via', machine: ref }, 'via')
  if (r.type === 'fail') die(`dotrino-terminal: ${farMessage(r)}`)
  let probe = await farRequest(conn, { type: 'list' }, 'consoles')
  const name = r.machine.name || r.machine.id
  while (probe.type === 'fail' && ['locked', 'bad-code', 'wait'].includes(probe.code)) {
    if (probe.code === 'bad-code') console.error(t('Clave incorrecta.', 'Wrong code.'))
    if (probe.code === 'wait') console.error(t(`Demasiados intentos: espera ${Math.ceil((probe.retryMs || 0) / 1000)} s.`, `Too many tries: wait ${Math.ceil((probe.retryMs || 0) / 1000)} s.`))
    // Lo tecleado aquí es la clave, no entrada para la consola.
    process.stdin.off('data', earlyTap)
    early.length = 0
    const code = await askHidden(t(`Clave de ${name}: `, `Code for ${name}: `))
    if (!code) die(t('sin clave no se entra.', 'no code, no entry.'))
    probe = await farRequest(conn, { type: 'unlock', code }, 'unlocked')
    if (probe.type === 'unlocked') break
  }
  if (probe.type === 'fail') die(`dotrino-terminal: ${probe.message} (${probe.code})`)
}

const age = (ms) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

async function list (conn) {
  const { list } = await request(conn, { type: 'list' }, 'consoles')
  if (args.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return }
  if (!list.length) { console.log(t('No hay consolas abiertas.', 'No open consoles.')); return }
  for (const c of list) {
    const remote = c.watchers.filter((w) => w.origin === 'remote').length
    const who = `${c.viewers} ${t('mirando', 'watching')}${remote ? ` (${remote} ${t('desde otro aparato', 'from another device')})` : ''}`
    console.log(`  ${c.id}  ${c.origin.padEnd(6)}  ${age(Date.now() - c.createdAt).padStart(4)}  ${who}  ${c.title || ''}`)
  }
}

/**
 * La nota de una consola: de qué va. Sin `--id` es la consola en la que corre esta orden (el
 * agente pone su id en `DOTRINO_TERMINAL_CONSOLE`), que es como la cambia un programa desde dentro.
 * No levanta ningún agente: sin agente no hay consola a la que ponerle nota.
 */
/** Cómo se enseñan, al leer la nota, las líneas de la tarea (la que pone un programa con `note --task`). */
const TASK_MARK = '▸ '

async function note () {
  const id = opt('--id') || process.env.DOTRINO_TERMINAL_CONSOLE
  if (!id) die(t('no sé de qué consola: esta shell no corre dentro de Dotrino Terminal. Usa --id <id> (mira «dotrino-terminal ls»).', 'no console to act on: this shell is not running inside Dotrino Terminal. Use --id <id> (see "dotrino-terminal ls").'))
  // Dentro de una consola, el perfil es el de esa consola, no el `default`.
  const dir = opt('--dir') || (opt('--name') ? dataDir(opt('--name')) : process.env.DOTRINO_TERMINAL_PROFILE_DIR || dataDir())
  const valued = new Set(['--id', '--dir', '--name', '--add', '--task', '--title'])
  const flags = new Set([...valued, '--clear', '--json'])
  const words = []
  for (let i = 1; i < args.length; i++) {
    if (valued.has(args[i])) { i++; continue }
    // Una bandera que no se conoce PARA, no se salta: saltarla dejaba su valor como texto suelto, y
    // el texto suelto reemplaza la nota de la persona (un cliente viejo con `--title` lo hizo).
    if (args[i].startsWith('--') && !flags.has(args[i])) die(t(`no conozco ${args[i]}: no se cambió nada. Mira «dotrino-terminal --help».`, `unknown option ${args[i]}: nothing was changed. See "dotrino-terminal --help".`))
    if (args[i] === '-' || !args[i].startsWith('-')) words.push(args[i])
  }
  const stdin = () => fs.readFileSync(0, 'utf8').replace(/\n+$/, '')
  const given = words.length ? (words.length === 1 && words[0] === '-' ? stdin() : words.join(' ')) : null
  const add = opt('--add') === '-' ? stdin() : opt('--add')
  const task = opt('--task') === '-' ? stdin() : opt('--task')
  const title = opt('--title')
  let conn
  try { conn = await connectLocal(dir) } catch (e) {
    if (e.code !== 'ENOAGENT') throw e
    die(t('el agente de este perfil no está corriendo.', 'this profile\'s agent is not running.'))
  }
  const ask = async (msg) => {
    const r = await Promise.race([request(conn, msg, 'noted'), new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
    // Un agente anterior a la 0.36 no conoce la orden y no contesta: se dice, no se da por hecho.
    if (!r) die(t('el agente no contestó: es anterior a la 0.36.0 y no tiene notas. Actualízalo y reinícialo.', 'the agent did not answer: it predates 0.36.0 and has no notes. Update and restart it.'))
    if (r.type === 'fail') die(`dotrino-terminal: ${r.message} (${r.code})`)
    return r.console
  }
  let c
  if (task !== undefined) {
    // LA TAREA ES DEL PROGRAMA, LA NOTA ES DE LA PERSONA: dos campos. Esta orden solo escribe el
    // primero, así un agente de IA no puede pisar una nota personal ni por descuido.
    c = await ask({ type: 'note', id, task: task.split('\n').map((l) => l.trim()).filter(Boolean).join('\n'), ...(title === undefined ? {} : { title }) })
    // Un agente anterior a la 0.37 contesta, pero no guarda tareas: se dice, no se da por hecha.
    if (c.task === undefined) die(t('el agente que corre es anterior a la 0.37.0 y no guarda tareas. Reinícialo con la versión nueva (cierra sus consolas).', 'the running agent predates 0.37.0 and keeps no tasks. Restart it with the new version (closes its consoles).'))
    // Y uno anterior a la 0.41 no guarda el título: lo mismo.
    if (title !== undefined && c.subject === undefined) die(t('el agente que corre es anterior a la 0.41.0 y no guarda el título. Reinícialo con la versión nueva (cierra sus consolas).', 'the running agent predates 0.41.0 and keeps no title. Restart it with the new version (closes its consoles).'))
  } else if (title !== undefined) {
    c = await ask({ type: 'note', id, title })
    if (c.subject === undefined) die(t('el agente que corre es anterior a la 0.41.0 y no guarda el título. Reinícialo con la versión nueva (cierra sus consolas).', 'the running agent predates 0.41.0 and keeps no title. Restart it with the new version (closes its consoles).'))
  }
  else if (args.includes('--clear')) c = await ask({ type: 'note', id, text: '' })
  else if (add !== undefined) {
    const before = (await ask({ type: 'note', id })).note || ''
    c = await ask({ type: 'note', id, text: before ? `${before}\n${add}` : add })
  } else if (given !== null) c = await ask({ type: 'note', id, text: given })
  else c = await ask({ type: 'note', id })
  conn.close()
  if (args.includes('--json')) console.log(JSON.stringify({ id: c.id, n: c.n, title: c.title, task: c.task || '', note: c.note }, null, 2))
  else {
    // La tarea, marcada; debajo, la nota de la persona.
    const lines = [...(c.task ? c.task.split('\n').map((l) => TASK_MARK + l) : []), ...(c.note ? [c.note] : [])]
    if (lines.length) console.log(lines.join('\n'))
  }
}

/** La ventana: la TTY enganchada a una consola del agente. */
function interactive (conn, first, dir) {
  // Hasta que el agente diga `attached` no hay consola a la que escribir: se guarda.
  let ready = false
  let queued = ''
  // SIN CONSOLA (`empty`): otra pantalla cerró la última de la máquina. La ventana sigue, vacía,
  // hasta que se abra una (Ctrl+] n, el «+» de la app) o se pase a una (Ctrl+] a<id>). Lo que se
  // teclee ahí no va a ningún sitio: se descarta, no se guarda para una consola que aún no existe.
  let empty = false
  const input = (data) => { if (ready) conn.send({ type: 'input', data }); else if (!empty) queued += data }
  if (!process.stdin.isTTY || !process.stdout.isTTY) die(t('dotrino-terminal necesita una terminal (TTY).', 'dotrino-terminal needs a terminal (TTY).'))
  const out = process.stdout
  let consoleId = null
  let shellTitle = ''
  let subject = ''
  let remote = new Set()
  let ending = false

  const showTitle = () => {
    const base = subject || shellTitle || 'Dotrino Terminal'
    const mark = remote.size ? `  ● ${t('abierta desde otro aparato', 'open on another device')}${remote.size > 1 ? ` ×${remote.size}` : ''}` : ''
    out.write(`\x1b]2;${base}${mark}\x07`)
  }
  const onInfo = (info) => {
    if (!info) return
    // El título que puso el programa (`note --title`) manda sobre el de la shell.
    subject = info.subject || ''
    shellTitle = info.shellTitle ?? info.title ?? ''
    // En otra máquina (`--machine`) esta ventana es, para aquella, «otro aparato»: no se cuenta
    // a sí misma (se reconoce por su etiqueta; sin etiqueta, es una de las que salen).
    let far = info.watchers.filter((w) => w.origin === 'remote')
    if (opt('--machine')) {
      const mine = opt('--tag') ? far.findIndex((w) => w.tag === opt('--tag')) : 0
      if (mine >= 0) far = far.filter((_, i) => i !== mine)
    }
    const now = new Set(far.map((w, i) => (opt('--machine') ? `${w.device || '?'}#${w.tag || i}` : w.device || '?')))
    const arrived = [...now].some((d) => !remote.has(d))
    remote = now
    if (arrived) out.write('\x07')                 // la campana: alguien entró desde fuera
    showTitle()
  }
  const filter = titleFilter((title) => { shellTitle = title; showTitle() })
  const size = () => ({ cols: out.columns || 80, rows: out.rows || 24 })

  const finish = (code, note) => {
    if (ending) return
    ending = true
    try { process.stdin.setRawMode(false) } catch (_) {}
    out.write('\x1b]2;\x07')
    if (note) process.stderr.write(`\r\n${note}\r\n`)
    conn.close()
    printUpdateNotice({ current: VERSION, source: 'npm', pkg: '@dotrino/terminal-agent', how: 'npx @dotrino/terminal-agent@latest' })
      .finally(() => process.exit(code))
  }

  // La pantalla de la consola (`replay`) está hecha para pintarse sobre una pantalla LIMPIA con
  // el cursor en el origen. Al arrancar, la TTY puede haber repetido algo de lo tecleado en los
  // primeros milisegundos (antes de pasar a crudo), y entonces todo se pintaba corrido: el cursor
  // acababa en la columna 0 o encima del prompt. Por eso, antes de la primera, en limpio.
  let clean = false
  let switching = false                // se pidió pasar a otra consola y aún no contestó
  let recovering = false               // falló el cambio: se está repintando la que había
  conn.on('message', (m) => {
    if (m.type === 'replay' && !clean) { clean = true; out.write('\x1b[H\x1b[2J') }
    if (m.type === 'out' || m.type === 'replay') { out.write(filter(m.data)); return }
    if (m.type === 'attached') {
      switching = false; recovering = false
      consoleId = m.id
      onInfo(m.console)
      // Ya hay consola: va lo que se tecleó mientras tanto, en orden y de una vez.
      ready = true
      if (queued) { conn.send({ type: 'input', data: queued }); queued = '' }
      return
    }
    if (m.type === 'meta') { onInfo(m.console); return }
    if (m.type === 'exit') {
      // LA CONSOLA SE CERRÓ, la cierre quien la cierre (otra pantalla, el panel, o `exit` tecleado
      // aquí): cerrar una consola nunca cierra la ventana (dueño, 2026-10-08). Pasa a una consola
      // que YA existe: primero una que no mire nadie; si todas se miran, la primera igual.
      // NUNCA crea una nueva (para no llenarse de consolas que nadie mira): si la máquina se quedó
      // sin ninguna, la ventana se queda SIN consola (`empty`) y lo dice.
      {
        const closed = consoleId
        consoleId = null
        ready = false                  // lo que se teclee mientras tanto espera a la consola que venga
        request(conn, { type: 'list' }, 'consoles').then((r) => {
          if (r.type !== 'consoles') return            // un `fail`: ya lo atendió el manejador de abajo
          const rest = r.list.filter((c) => c.id !== closed)
          // Desatendida EN ESTA MÁQUINA: que la mire otro aparato no la hace atendida aquí.
          const other = rest.find((c) => !c.watchers.length) || rest.find((c) => !c.watchers.some((w) => w.origin === 'local')) || rest[0]
          if (other) return switchTo({ type: 'attach', id: other.id })
          empty = true
          shellTitle = ''; subject = ''; remote = new Set(); showTitle()
          out.write(`\x1bc\x1b[2m${t('No hay consolas abiertas. Ctrl+] y luego n abre una.', 'No open consoles. Ctrl+] then n opens one.')}\x1b[0m\r\n`)
        })
        return
      }
    }
    if (m.type === 'fail') {
      // FALLÓ UN CAMBIO DE CONSOLA (la que se pidió ya no existe: el panel de la app iba un
      // instante por detrás). El agente rechaza ANTES de soltar la actual, así que esta ventana
      // sigue en la suya: se vuelve a pintar y se sigue. Terminar aquí cerraba la ventana entera
      // por elegir una entrada caducada. Solo es fatal si falla al arrancar, o al repintar.
      if (switching && consoleId && !recovering) {
        switching = false; recovering = true
        conn.send({ type: 'attach', id: consoleId, ...size(), ...tag() })
        return
      }
      finish(1, `dotrino-terminal: ${m.message} (${m.code})`)
    }
  })
  conn.on('close', () => {
    // Si se fue porque el perfil cambió de nombre (`rename`), no es un error: se dice y se sale.
    if (!fs.existsSync(dir)) return finish(0, t('Este perfil cambió de nombre.', 'This profile was renamed.'))
    finish(1, t('dotrino-terminal: el agente se detuvo.', 'dotrino-terminal: the agent stopped.'))
  })

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.off('data', earlyTap)
  const decoder = new StringDecoder('utf8')
  let prefixed = false
  let collecting = null                // tras Ctrl+] a: el id de la consola, hasta Enter
  // Cambiar de consola SIN salir: por la misma conexión, y con la pantalla en limpio para que la
  // repetición de la otra consola no se pinte encima. Lo tecleado mientras tanto se guarda.
  const switchTo = (msg) => {
    empty = false
    ready = false
    switching = true
    out.write('\x1bc')                 // RIS: pantalla, historial y modos, de cero
    conn.send({ ...msg, ...size(), ...tag() })
  }
  const onKeys = (buf) => {
    // Ctrl+] abre el atajo: «d» suelta la consola, «n» abre otra nueva, «a<id>⏎» pasa a esa
    // consola (lo usa el panel de la app de escritorio), otro Ctrl+] manda uno literal, y
    // cualquier otra tecla pasa tal cual, con su Ctrl+] delante. Pueden llegar todas juntas.
    let send = ''
    for (const ch of decoder.write(buf)) {
      if (collecting !== null) {
        if (ch === '\r' || ch === '\n') {
          const id = collecting
          collecting = null
          if (send) { input(send); send = '' }
          if (id) switchTo({ type: 'attach', id })
        } else if (/[0-9a-f]/i.test(ch) && collecting.length < 64) collecting += ch
        else collecting = null             // no era un id: se descarta el atajo
        continue
      }
      if (prefixed) {
        prefixed = false
        if (ch === 'd') {
          if (send) input(send)
          conn.send({ type: 'detach' })
          if (!consoleId) return finish(0)
          return finish(0, t(`Consola soltada. Para volver: dotrino-terminal attach ${consoleId}`, `Console detached. To return: dotrino-terminal attach ${consoleId}`))
        }
        if (ch === 'a') { collecting = ''; continue }
        // «r»: esta ventana manda en el tamaño de la consola (la app la usa al ganar el foco: con
        // varias ventanas de tamaños distintos en la misma consola, se ajusta a la que miras).
        if (ch === 'r') { conn.send({ type: 'resize', ...size() }); continue }
        // «p»: ⤢, la consola toma ahora el tamaño de esta ventana.
        if (ch === 'p') { conn.send({ type: 'resize', ...size() }); conn.send({ type: 'take' }); continue }
        if (ch === 'n') {
          if (send) { input(send); send = '' }
          // En otra máquina (`--machine`) la carpeta de aquí no existe: sin `--cwd`, la consola
          // nueva abre en su carpeta de inicio. Mandar la de aquí hacía que la rechazara
          // (`bad-cwd`) y la ventana acababa en otra consola en vez de en una nueva.
          const where = opt('--machine') ? (first.cwd ? { cwd: first.cwd } : {}) : { cwd: first.cwd || path.resolve(process.cwd()) }
          switchTo({ type: 'open', ...where })
          continue
        }
        send += ch === DETACH_PREFIX ? ch : DETACH_PREFIX + ch
      } else if (ch === DETACH_PREFIX) prefixed = true
      else send += ch
    }
    if (send) input(send)
  }
  process.stdin.on('data', onKeys)
  // Lo tecleado antes de llegar aquí pasa por el mismo camino (el atajo de soltar incluido).
  for (const b of early.splice(0)) onKeys(b)
  out.on('resize', () => conn.send({ type: 'resize', ...size() }))
  // La ventana se cerró: el agente ve caer la conexión y suelta la consola (sigue viva).
  // SALVO en la terminal integrada de VS Code (y Cursor, VSCodium: `TERM_PROGRAM=vscode`): allí
  // no hay panel de consolas con el que volver a ella ni cerrarla, así que cada terminal cerrada
  // dejaba una consola que nadie mira (dueño, 2026-10-13). Cerrar la terminal CIERRA su consola.
  // Una ventana de la app (`--tag`) nunca: aunque la app se lanzara desde una terminal de VS Code.
  const ownsConsole = process.env.TERM_PROGRAM === 'vscode' && !opt('--tag')
  for (const sig of ['SIGHUP', 'SIGTERM']) {
    process.on(sig, () => {
      if (!ownsConsole || !consoleId) { conn.close(); process.exit(0) }
      conn.send({ type: 'close' })
      // Que la orden salga antes de soltar la conexión.
      setTimeout(() => { conn.close(); process.exit(0) }, 150)
    })
  }

  conn.send({ ...first, ...size() })
}

try {
  if (cmd === 'profiles') { await profiles(); process.exit(0) }
  if (cmd === 'link') { await link(); process.exit(0) }
  if (cmd === 'rename') { await rename(); process.exit(0) }
  if (cmd === 'lock') { await lock(); process.exit(0) }
  if (cmd === 'vscode') { vscode(); process.exit(0) }
  if (cmd === 'claude') { await claude(); process.exit(0) }
  if (cmd === 'desktop') { await desktop(); process.exit(0) }
  if (cmd === 'updates') { await updates(); process.exit(0) }
  if (cmd === 'agents') { await agents(); process.exit(0) }
  if (cmd === 'network') { await network(); process.exit(0) }
  if (cmd === 'restart') { await restart(); process.exit(0) }
  if (cmd === 'service') { await service(); process.exit(0) }
  if (cmd === 'note') { await note(); process.exit(0) }
  const dir = opt('--dir') || dataDir(opt('--name'))
  if (cmd === 'open' || cmd === 'attach') captureEarly()
  const conn = await agent(dir)
  const machine = opt('--machine')
  if (cmd === 'machines') { await machines(conn); conn.close(); process.exit(0) }
  if (machine) await goVia(conn, machine)
  if (cmd === 'ls' || cmd === 'list') { await list(conn); conn.close() } else if (cmd === 'kill') {
    if (!args[1]) die(t('falta el id: dotrino-terminal kill <id>', 'missing id: dotrino-terminal kill <id>'))
    conn.send({ type: 'kill', id: args[1] })
    const r = await Promise.race([request(conn, { type: 'list' }, 'consoles'), new Promise((resolve) => setTimeout(resolve, 1000))])
    if (r?.type === 'fail') die(`dotrino-terminal: ${r.message} (${r.code})`)
    conn.close()
  } else if (cmd === 'attach') {
    if (!args[1]) die(t('falta el id: dotrino-terminal attach <id>  (mira «dotrino-terminal ls»)', 'missing id: dotrino-terminal attach <id>  (see "dotrino-terminal ls")'))
    interactive(conn, { type: 'attach', id: args[1], ...tag() }, dir)
  } else if (cmd === 'open') {
    // Como cualquier terminal: la consola abre en la carpeta donde estás (o en `--cwd`).
    // En otra máquina, la carpeta de aquí no existe: abre en su carpeta de inicio, salvo `--cwd`.
    const cwd = machine ? (opt('--cwd') ? { cwd: opt('--cwd') } : {}) : { cwd: path.resolve(opt('--cwd') || process.cwd()) }
    interactive(conn, { type: 'open', ...cwd, ...tag() }, dir)
  } else die(t(`orden desconocida: ${cmd} (mira --help)`, `unknown command: ${cmd} (see --help)`))
} catch (e) {
  if (e !== HOLD) { try { die(`dotrino-terminal: ${e.message}`) } catch (_) {} }
}
