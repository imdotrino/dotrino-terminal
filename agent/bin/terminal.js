#!/usr/bin/env node
/**
 * dotrino-terminal — una ventana de Dotrino Terminal en ESTA terminal (TTY).
 *
 *   dotrino-terminal [--name <n>] [--cwd <dir>] abre una consola nueva aquí (en la carpeta actual)
 *   dotrino-terminal attach <id> [--name <n>]  se engancha a una consola que ya existe
 *   dotrino-terminal ls [--name <n>] [--json]  las consolas abiertas en el agente
 *   dotrino-terminal kill <id> [--name <n>]    cierra una consola
 *   dotrino-terminal profiles [--json]         los perfiles de esta máquina (enlazados o no)
 *   dotrino-terminal link [--name <n>]         enlaza un perfil con tu bóveda
 *   dotrino-terminal rename <perfil> [nuevo]   renombra un perfil (para su agente si corre)
 *   dotrino-terminal lock [--name <n>]         pone o cambia la clave que piden los otros aparatos
 *   dotrino-terminal lock --off [--name <n>]   la quita
 *   dotrino-terminal vscode [--name <n>]       la terminal embebida de VS Code abre consolas de aquí
 *   dotrino-terminal vscode --off              lo deshace
 *
 * Un PERFIL es un agente con nombre (`~/.dotrino/agent/terminal-agent/<nombre>/`), enlazado a
 * una bóveda o solo local. Cada consola vive en el agente de un perfil.
 *
 * La shell no vive aquí: vive en el agente (`dotrino-terminal-agent`), y esta ventana es un
 * cliente más, igual que el navegador de otro aparato. Por eso lo que se abre aquí se puede
 * abrir desde terminal.dotrino.com. Si el agente no está corriendo, se levanta solo.
 *
 * Cerrar la ventana mata la consola que abrió, como en cualquier terminal. Para dejarla viva
 * y retomarla después: Ctrl+] y luego d.
 */
import fs from 'node:fs'
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

Dentro de una consola: Ctrl+] y luego d la suelta sin cerrarla; Ctrl+] n abre otra
(y suelta la actual); Ctrl+] a <id> Enter pasa a esa consola; Ctrl+] p fija el tamaño de la
consola a esta ventana y Ctrl+] u lo suelta.
Cerrar la ventana cierra la consola que abrió.`, `usage:
  dotrino-terminal [--name <n>] [--cwd <dir>] open a new console in this window, in the current folder
  dotrino-terminal attach <id> [--name <n>]  attach to an open console
  dotrino-terminal ls [--name <n>] [--json]  list open consoles
  dotrino-terminal kill <id> [--name <n>]    close a console
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

Inside a console: Ctrl+] then d detaches without closing it; Ctrl+] n opens another
(detaching the current one); Ctrl+] a <id> Enter switches to that console; Ctrl+] p pins the
console's size to this window and Ctrl+] u unpins it.
Closing the window closes the console it opened.`))
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
  if (pid && alive(pid)) {
    throw new Error(t(`hay un agente corriendo (pid ${pid}) que no acepta ventanas: es anterior a la 0.6.0. Reinícialo con la versión nueva.`,
      `an agent is running (pid ${pid}) that does not accept windows: it predates 0.6.0. Restart it with the new version.`))
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const log = path.join(dir, 'agent.log')
  const fd = fs.openSync(log, 'a', 0o600)
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  const extra = opt('--name') ? ['--name', opt('--name')] : []
  // Sin TTY: si la máquina no está enlazada, el agente atiende solo a las ventanas locales.
  const child = spawn(process.execPath, [cli, ...extra], { detached: true, stdio: ['ignore', fd, fd], env: process.env })
  child.unref()
  fs.closeSync(fd)
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

/** La ventana: la TTY enganchada a una consola del agente. */
function interactive (conn, first, dir) {
  // Hasta que el agente diga `attached` no hay consola a la que escribir: se guarda.
  let ready = false
  let queued = ''
  const input = (data) => { if (ready) conn.send({ type: 'input', data }); else queued += data }
  if (!process.stdin.isTTY || !process.stdout.isTTY) die(t('dotrino-terminal necesita una terminal (TTY).', 'dotrino-terminal needs a terminal (TTY).'))
  const out = process.stdout
  let consoleId = null
  let shellTitle = ''
  let remote = new Set()
  let ending = false

  const showTitle = () => {
    const base = shellTitle || 'Dotrino Terminal'
    const mark = remote.size ? `  ● ${t('abierta desde otro aparato', 'open on another device')}${remote.size > 1 ? ` ×${remote.size}` : ''}` : ''
    out.write(`\x1b]2;${base}${mark}\x07`)
  }
  const onInfo = (info) => {
    if (!info) return
    shellTitle = info.title || ''
    const now = new Set(info.watchers.filter((w) => w.origin === 'remote').map((w) => w.device || '?'))
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
      // LA CERRÓ OTRA PANTALLA (el teléfono, la web, el panel de otra ventana): esta ventana no
      // se va — nadie aquí pidió cerrarla, y cerrarla dejaba al usuario sin ventana y sin forma
      // de abrir otra consola. Se abre una nueva y se dice. Si la shell terminó sola (`exit`) o
      // la cerró esta misma ventana, la ventana se cierra, como cualquier terminal.
      if (m.closedBy === 'other') {
        consoleId = null
        switchTo({ type: 'open', cwd: first.cwd || path.resolve(process.cwd()) })
        out.write(`\x1b[2m${t('Otra pantalla cerró esta consola. Esta es una nueva.', 'Another screen closed this console. This is a new one.')}\x1b[0m\r\n`)
        return
      }
      finish(m.code || 0)
      return
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
          return finish(0, t(`Consola soltada. Para volver: dotrino-terminal attach ${consoleId}`, `Console detached. To return: dotrino-terminal attach ${consoleId}`))
        }
        if (ch === 'a') { collecting = ''; continue }
        // «r»: esta ventana manda en el tamaño de la consola (la app la usa al ganar el foco: con
        // varias ventanas de tamaños distintos en la misma consola, se ajusta a la que miras).
        if (ch === 'r') { conn.send({ type: 'resize', ...size() }); continue }
        // «p» / «u»: esta ventana fija (⤢) o suelta el tamaño de la consola.
        if (ch === 'p' || ch === 'u') { conn.send({ type: 'pin', on: ch === 'p' }); if (ch === 'p') conn.send({ type: 'resize', ...size() }); continue }
        if (ch === 'n') {
          if (send) { input(send); send = '' }
          switchTo({ type: 'open', cwd: first.cwd || path.resolve(process.cwd()) })
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
  // La ventana se cerró: el agente ve caer la conexión y mata la consola que abrimos.
  for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => { conn.close(); process.exit(0) })

  conn.send({ ...first, ...size() })
}

try {
  if (cmd === 'profiles') { await profiles(); process.exit(0) }
  if (cmd === 'link') { await link(); process.exit(0) }
  if (cmd === 'rename') { await rename(); process.exit(0) }
  if (cmd === 'lock') { await lock(); process.exit(0) }
  if (cmd === 'vscode') { vscode(); process.exit(0) }
  const dir = opt('--dir') || dataDir(opt('--name'))
  if (cmd === 'open' || cmd === 'attach') captureEarly()
  const conn = await agent(dir)
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
    interactive(conn, { type: 'open', cwd: path.resolve(opt('--cwd') || process.cwd()), ...tag() }, dir)
  } else die(t(`orden desconocida: ${cmd} (mira --help)`, `unknown command: ${cmd} (see --help)`))
} catch (e) {
  if (e !== HOLD) { try { die(`dotrino-terminal: ${e.message}`) } catch (_) {} }
}
