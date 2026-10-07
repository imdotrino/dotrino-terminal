/**
 * @dotrino/terminal-agent — abre una shell real (PTY) SOLO para aparatos de tu cuenta.
 *
 * Lo común (enrolarse con la bóveda, handshake contra el ACTA, canal cifrado por sesión,
 * revocación, renovación del papel, auditoría) lo hace `@dotrino/remote-agent`: este
 * paquete solo sabe de PTY. Antes lo hacía todo a mano (su propio enrolamiento, su propio
 * cifrado) y por eso se quedó atrás: con la bóveda actual no podía ni emparejarse.
 *
 * Las shells son CONSOLAS que viven aparte de las sesiones (consoles.js): cerrar o recargar
 * el navegador solo las suelta, y cualquier aparato de la cuenta puede volver a ellas.
 *
 * Payloads de dominio (van cifrados dentro de la sesión, el proxio no los ve):
 *   cliente → agente: { type:'list' } · { type:'open', cols, rows, cwd?, tag? } ·
 *                     { type:'attach', id, cols, rows } · { type:'detach' } ·
 *                     { type:'input', data } · { type:'resize', cols, rows } · { type:'pin', on } ·
 *                     { type:'close' } (mata la consola enganchada) · { type:'kill', id } ·
 *                     { type:'move', id, before? } (el orden del panel; contesta con `consoles`) ·
 *                     { type:'unlock', code } (la clave de la máquina, si tiene: access.js)
 *   agente → cliente: { type:'consoles', list } · { type:'attached', id, fresh } ·
 *                     { type:'replay', id, data, last } · { type:'out', data } ·
 *                     { type:'exit', code, closedBy? } · { type:'fail', code, message, retryMs? } ·
 *                     { type:'unlocked' }
 *
 * Con clave puesta, una sesión remota que no la ha escrito recibe `fail` con `code:'locked'`
 * a todo lo que pida; tras `unlock` vale para esa conexión. `bad-code` y `wait` traen
 * `retryMs` cuando toca esperar.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { dataDir, loadLink, LABEL } from './link.js'
import { ConsoleHub, REPLAY_CHUNK, isTyped } from './consoles.js'
import { listenLocal } from './local.js'
import { makeGate } from './access.js'

const require = createRequire(import.meta.url)

export { LABEL }

/** Cada cuánto mira un agente sin enlazar si ya lo enlazaron. */
export const LINK_POLL_MS = 2000

export function loadPty () {
  // node-pty (Microsoft, el de VS Code) ≥ 1.2 trae los binarios DENTRO del paquete para Linux,
  // macOS y Windows: no compila ni descarga nada al instalarse (funciona con ignore-scripts).
  // Antes: @homebridge/node-pty-prebuilt-multiarch, que los bajaba al instalar con
  // prebuild-install, abandonado (npm avisaba «deprecated»).
  try { return require('node-pty') } catch (e) {
    throw new Error('PTY module missing. Reinstall the agent: `npx @dotrino/terminal-agent` (' + e.message + ')')
  }
}

const isDir = (p) => {
  try { return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory() } catch (_) { return false }
}

/** Las consolas de este agente, sobre el PTY. Exportada para las pruebas. */
export function makeHub (pty, opts = {}) {
  const shell = opts.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  return new ConsoleHub({
    ...(opts.quietMs ? { quietMs: opts.quietMs } : {}),
    spawn: ({ cols, rows, cwd }) => pty.spawn(shell, [], {
      name: 'xterm-256color', cols, rows,
      cwd: cwd || os.homedir(),
      // La carpeta del perfil viaja a la shell: `dotrino-terminal rename` sabe así si corre
      // dentro del mismo perfil que renombra (y que parar su agente cerraría su consola).
      env: { ...process.env, TERM: 'xterm-256color', ...(opts.dir ? { DOTRINO_TERMINAL_PROFILE_DIR: opts.dir } : {}) }
    })
  })
}

/**
 * Atiende una sesión: la cifrada de un aparato remoto, o la de una ventana de esta máquina
 * (`local.js`, por el socket). Una sesión mira UNA consola a la vez.
 *
 * Al irse la sesión, la consola se SUELTA — salvo que sea una ventana local que la abrió
 * ella: cerrar la ventana mata su shell, como en cualquier terminal. Una ventana que solo
 * se enganchó a una consola ajena, o que la soltó a propósito (`detach`), no mata nada.
 *
 * Tamaño con varios mirando: lo decide quien lo FIJÓ (`pin`, el ⤢ de la app o el teléfono) y, si
 * nadie, el último que se enganchó. Solo esa pantalla lo cambia (sus `resize` se siguen: girar el
 * teléfono, redimensionar la ventana). Escribir o dar foco no cambia nada.
 * Exportada para las pruebas.
 *
 * @param {object} session
 * @param {ConsoleHub} hub
 * @param {{ origin?: 'local'|'remote', gate?: ReturnType<typeof makeGate> }} [opts]  `gate`: la
 *   clave de la máquina (access.js). Solo se le pide a las sesiones remotas.
 */
export function serveSession (session, hub, { origin = 'remote', gate = null } = {}) {
  let current = null
  let owned = null                       // la consola que esta ventana local abrió
  let size = { cols: 80, rows: 24 }
  const viewer = {
    origin,
    device: session.device || null,
    onOut: (data) => { session.send({ type: 'out', data }) },
    // `closedBy: 'other'`: la cerró otra pantalla (no esta, ni la shell por su cuenta).
    onExit: (code, why) => { current = null; owned = null; session.send({ type: 'exit', code, ...(why?.byOther ? { closedBy: 'other' } : {}) }) },
    onMeta: (info) => { session.send({ type: 'meta', console: info }) }
  }
  const release = () => { if (current) { current.detach(viewer); current = null } }
  const fail = (code, message, extra = {}) => session.send({ type: 'fail', code, message, ...extra })
  // La clave de la máquina: una vez escrita vale para ESTA conexión.
  let unlocked = false
  /** True si esta sesión puede seguir; si no, ya contestó por qué. No saber si hay clave = no pasa. */
  const mayPass = () => {
    if (origin !== 'remote' || !gate || unlocked) return true
    try {
      if (!gate.required()) return true
    } catch (e) { fail(e.code || 'access-unreadable', e.message); return false }
    fail('locked', 'this machine asks for its code')
    return false
  }
  const takeSize = (msg) => { if (msg.cols && msg.rows) { size = { cols: msg.cols, rows: msg.rows }; viewer.size = size } }
  // La etiqueta con la que se presenta quien mira (una ventana de la app de escritorio).
  const takeTag = (msg) => { if (typeof msg.tag === 'string') viewer.tag = msg.tag.slice(0, 64) }

  async function attachTo (c, { fresh }) {
    release()
    current = c
    const snapshot = await c.attach(viewer)
    c.sizeFrom(viewer, { attaching: true })
    // La pantalla va en trozos: el proxio corta los mensajes a 1 MB.
    for (let i = 0; i < snapshot.length || i === 0; i += REPLAY_CHUNK) {
      await session.send({ type: 'replay', id: c.id, data: snapshot.slice(i, i + REPLAY_CHUNK), last: i + REPLAY_CHUNK >= snapshot.length })
    }
    await session.send({ type: 'attached', id: c.id, fresh, console: c.info() })
  }

  session.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'unlock') {
      if (origin !== 'remote' || !gate) { session.send({ type: 'unlocked' }); return }
      try {
        if (gate.required()) gate.check(msg.code, viewer.device)
        unlocked = true
        session.send({ type: 'unlocked' })
      } catch (e) { fail(e.code || 'access-unreadable', e.message, e.retryMs ? { retryMs: e.retryMs } : {}) }
      return
    }
    if (!mayPass()) return
    if (msg.type === 'list') { session.send({ type: 'consoles', list: hub.list() }); return }
    if (msg.type === 'open') {
      takeSize(msg)
      takeTag(msg)
      // `cwd`: dónde abre la shell (la carpeta de la ventana que la pide). Si no existe, se
      // dice: abrir en otra carpeta sin avisar haría que un comando corra donde no toca.
      if (msg.cwd != null && !isDir(msg.cwd)) return fail('bad-cwd', `not a directory: ${msg.cwd}`)
      const c = hub.create({ ...size, origin, cwd: msg.cwd || null })
      if (origin === 'local') owned = c
      attachTo(c, { fresh: true })
      return
    }
    if (msg.type === 'attach') {
      const c = hub.get(msg.id)
      if (!c) return fail('no-console', 'that console no longer exists')
      takeSize(msg)
      takeTag(msg)
      attachTo(c, { fresh: false })
      return
    }
    if (msg.type === 'detach') { owned = null; release(); return }
    if (msg.type === 'input') {
      if (!current) return
      const data = String(msg.data ?? '')
      // Quien teclea gana el tamaño. Lo que la terminal contesta sola no cuenta.
      if (isTyped(data)) current.typed(viewer)
      current.write(data)
      return
    }
    if (msg.type === 'resize') { takeSize(msg); current?.sizeFrom(viewer); return }
    // ⤢ «Esta pantalla manda en el tamaño» (on) o soltarlo (off).
    if (msg.type === 'pin') { current?.pin(viewer, !!msg.on); return }
    if (msg.type === 'close') { if (current) hub.kill(current.id, viewer); return }
    if (msg.type === 'kill') { if (!hub.kill(msg.id, viewer)) fail('no-console', 'that console no longer exists'); return }
    // El orden del panel: es de la máquina, así que lo ve igual cualquier pantalla.
    if (msg.type === 'move') {
      if (!hub.move(String(msg.id), msg.before == null ? null : String(msg.before))) return fail('no-console', 'that console no longer exists')
      session.send({ type: 'consoles', list: hub.list() })
    }
  })
  session.on('close', () => {
    const mine = owned && owned === current ? owned : null
    release()
    if (mine) hub.kill(mine.id, viewer)
  })
}

/**
 * Arranca el agente: las consolas, el socket de las ventanas de esta máquina y, si la
 * máquina está enlazada con la bóveda, la parte remota (`startRemoteAgent`).
 *
 * Sin enlace el agente atiende SOLO a las ventanas locales: una terminal tiene que abrir
 * aunque no haya bóveda (ninguna app puede exigirla). Lo que no hay es acceso desde otros
 * aparatos, y se dice en `remote: null`.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]       dónde vive el enlace (default dataDir()).
 * @param {string} [opts.proxyUrl]  override del proxio del enlace.
 * @param {string} [opts.shell]     shell a lanzar (default $SHELL).
 * @param {boolean} [opts.quiet]
 * @param {()=>void} [opts.onRevoked]
 * @param {(remote:object)=>void} [opts.onLinked]   se enlazó mientras corría y ya atiende a otros aparatos.
 * @param {(e:Error)=>void} [opts.onLinkError]     se enlazó, pero la parte remota no arrancó.
 * @returns {Promise<{ consoles: ConsoleHub, socket: string, remote: object|null, machineId: string|null, close: ()=>void }>}
 */
export async function startAgent (opts = {}) {
  const dir = opts.dir || dataDir()
  const hub = makeHub(loadPty(), { ...opts, dir })
  let remote = null
  // TRES CLAVES MAL SEGUIDAS DE UN MISMO APARATO: se reporta a la bóveda, que se lo pone en
  // la mesa a quien aprueba (bloquear o ignorar). El freno local ya está puesto; esto es el
  // aviso. Si no se puede reportar se dice: un aviso que no sale es un teléfono que no suena.
  const gate = makeGate(dir, {
    onIncident: ({ device, tries }) => {
      if (!remote?.reportIncident) return
      remote.reportIncident({ kind: 'bad-code', about: device, tries })
        .then((r) => { if (!opts.quiet) console.log(`[terminal-agent] incident reported: ${r.id ? `request ${r.id} to ${r.approvers} approver(s)` : r.blocked ? 'that device is already blocked' : 'nobody can approve, nothing asked'}`) })
        .catch((e) => console.error(`[terminal-agent] could not report the incident: ${e.message}`))
    }
  })
  const local = await listenLocal({ dir, serve: (session) => serveSession(session, hub, { origin: 'local' }) })
  let stopped = false
  const startRemote = () => startRemoteAgent({
    label: LABEL,
    dir,
    proxyUrl: opts.proxyUrl,
    quiet: opts.quiet,
    onRevoked: () => { hub.killAll(); opts.onRevoked?.() },
    onSession: (session) => serveSession(session, hub, { origin: 'remote', gate })
  })
  let watcher = null
  if (loadLink(dir)) {
    try { remote = await startRemote() } catch (e) { local.close(); throw e }
  } else {
    // Sin enlace: se mira cada poco si aparece (`dotrino-terminal link` desde una ventana).
    // Al aparecer se enciende la parte remota SIN reiniciar, así las consolas abiertas siguen.
    watcher = setInterval(() => {
      if (!loadLink(dir)) return
      clearInterval(watcher); watcher = null
      startRemote().then((r) => {
        if (stopped) { r.close(); return }
        remote = r
        opts.onLinked?.(r)
      }).catch((e) => opts.onLinkError?.(e))
    }, LINK_POLL_MS)
    watcher.unref()
  }
  // Parar el agente sí mata las consolas: sin agente no hay quién las atienda.
  return {
    consoles: hub,
    socket: local.path,
    get remote () { return remote },
    get machineId () { return remote?.machineId || null },
    close: () => { stopped = true; if (watcher) clearInterval(watcher); hub.killAll(); local.close(); remote?.close() }
  }
}

export default { startAgent, LABEL }
