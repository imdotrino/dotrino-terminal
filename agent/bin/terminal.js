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

Dentro de una consola: Ctrl+] y luego d la suelta sin cerrarla.
Cerrar la ventana cierra la consola que abrió.`, `usage:
  dotrino-terminal [--name <n>] [--cwd <dir>] open a new console in this window, in the current folder
  dotrino-terminal attach <id> [--name <n>]  attach to an open console
  dotrino-terminal ls [--name <n>] [--json]  list open consoles
  dotrino-terminal kill <id> [--name <n>]    close a console
  dotrino-terminal profiles [--json]         this machine's profiles
  dotrino-terminal link [--name <n>]         link a profile with your vault

Inside a console: Ctrl+] then d detaches without closing it.
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
  process.stderr.write(msg + '\n')
  if (process.env.DOTRINO_TERMINAL_HOLD !== '1' || !process.stdin.isTTY) process.exit(1)
  process.stderr.write(t('\nPulsa una tecla para cerrar.', '\nPress any key to close.'))
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.once('data', () => process.exit(1))
  throw HOLD                          // corta lo que venía detrás; el proceso sale con la tecla
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
function interactive (conn, first) {
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

  conn.on('message', (m) => {
    if (m.type === 'out' || m.type === 'replay') { out.write(filter(m.data)); return }
    if (m.type === 'attached') { consoleId = m.id; onInfo(m.console); return }
    if (m.type === 'meta') { onInfo(m.console); return }
    if (m.type === 'exit') { finish(m.code || 0); return }
    if (m.type === 'fail') { finish(1, `dotrino-terminal: ${m.message} (${m.code})`) }
  })
  conn.on('close', () => finish(1, t('dotrino-terminal: el agente se detuvo.', 'dotrino-terminal: the agent stopped.')))

  process.stdin.setRawMode(true)
  process.stdin.resume()
  const decoder = new StringDecoder('utf8')
  let prefixed = false
  process.stdin.on('data', (buf) => {
    // Ctrl+] abre el atajo: «d» suelta la consola, otro Ctrl+] manda uno literal, y cualquier
    // otra tecla pasa tal cual, con su Ctrl+] delante. Las dos teclas pueden llegar juntas.
    let send = ''
    for (const ch of decoder.write(buf)) {
      if (prefixed) {
        prefixed = false
        if (ch === 'd') {
          if (send) conn.send({ type: 'input', data: send })
          conn.send({ type: 'detach' })
          return finish(0, t(`Consola soltada. Para volver: dotrino-terminal attach ${consoleId}`, `Console detached. To return: dotrino-terminal attach ${consoleId}`))
        }
        send += ch === DETACH_PREFIX ? ch : DETACH_PREFIX + ch
      } else if (ch === DETACH_PREFIX) prefixed = true
      else send += ch
    }
    if (send) conn.send({ type: 'input', data: send })
  })
  out.on('resize', () => conn.send({ type: 'resize', ...size() }))
  // La ventana se cerró: el agente ve caer la conexión y mata la consola que abrimos.
  for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => { conn.close(); process.exit(0) })

  conn.send({ ...first, ...size() })
}

try {
  if (cmd === 'profiles') { await profiles(); process.exit(0) }
  if (cmd === 'link') { await link(); process.exit(0) }
  const dir = opt('--dir') || dataDir(opt('--name'))
  const conn = await agent(dir)
  if (cmd === 'ls' || cmd === 'list') { await list(conn); conn.close() } else if (cmd === 'kill') {
    if (!args[1]) die(t('falta el id: dotrino-terminal kill <id>', 'missing id: dotrino-terminal kill <id>'))
    conn.send({ type: 'kill', id: args[1] })
    const r = await Promise.race([request(conn, { type: 'list' }, 'consoles'), new Promise((resolve) => setTimeout(resolve, 1000))])
    if (r?.type === 'fail') die(`dotrino-terminal: ${r.message} (${r.code})`)
    conn.close()
  } else if (cmd === 'attach') {
    if (!args[1]) die(t('falta el id: dotrino-terminal attach <id>  (mira «dotrino-terminal ls»)', 'missing id: dotrino-terminal attach <id>  (see "dotrino-terminal ls")'))
    interactive(conn, { type: 'attach', id: args[1] })
  } else if (cmd === 'open') {
    // Como cualquier terminal: la consola abre en la carpeta donde estás (o en `--cwd`).
    interactive(conn, { type: 'open', cwd: path.resolve(opt('--cwd') || process.cwd()) })
  } else die(t(`orden desconocida: ${cmd} (mira --help)`, `unknown command: ${cmd} (see --help)`))
} catch (e) {
  if (e !== HOLD) { try { die(`dotrino-terminal: ${e.message}`) } catch (_) {} }
}
