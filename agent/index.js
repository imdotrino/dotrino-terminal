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
 *   cliente → agente: { type:'list' } · { type:'open', cols, rows } ·
 *                     { type:'attach', id, cols, rows } · { type:'detach' } ·
 *                     { type:'input', data } · { type:'resize', cols, rows } ·
 *                     { type:'close' } (mata la consola enganchada) · { type:'kill', id }
 *   agente → cliente: { type:'consoles', list } · { type:'attached', id, fresh } ·
 *                     { type:'replay', id, data, last } · { type:'out', data } ·
 *                     { type:'exit', code } · { type:'fail', code, message }
 */
import os from 'node:os'
import { createRequire } from 'node:module'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { dataDir, LABEL } from './link.js'
import { ConsoleHub, REPLAY_CHUNK } from './consoles.js'

const require = createRequire(import.meta.url)

export { LABEL }

export function loadPty () {
  // Binarios PREBUILT (Linux/macOS/Windows, sin toolchain), API idéntica a node-pty.
  try { return require('@homebridge/node-pty-prebuilt-multiarch') } catch (e) {
    throw new Error('PTY module missing. Reinstall the agent: `npx @dotrino/terminal-agent` (' + e.message + ')')
  }
}

/** Las consolas de este agente, sobre el PTY. Exportada para las pruebas. */
export function makeHub (pty, opts = {}) {
  const shell = opts.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  return new ConsoleHub({
    spawn: ({ cols, rows }) => pty.spawn(shell, [], {
      name: 'xterm-256color', cols, rows,
      cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' }
    })
  })
}

/**
 * Atiende una sesión cifrada. Una sesión mira UNA consola a la vez (una pestaña). Si la
 * sesión se cierra (el navegador se fue, inactividad), la consola se SUELTA, no se mata.
 * Exportada para las pruebas.
 */
export function serveSession (session, hub) {
  let current = null
  const viewer = {
    onOut: (data) => { session.send({ type: 'out', data }) },
    onExit: (code) => { current = null; session.send({ type: 'exit', code }) }
  }
  const release = () => { if (current) { current.detach(viewer); current = null } }
  const fail = (code, message) => session.send({ type: 'fail', code, message })

  async function attachTo (c, { fresh }) {
    release()
    current = c
    const snapshot = await c.attach(viewer)
    // La pantalla va en trozos: el proxio corta los mensajes a 1 MB.
    for (let i = 0; i < snapshot.length || i === 0; i += REPLAY_CHUNK) {
      await session.send({ type: 'replay', id: c.id, data: snapshot.slice(i, i + REPLAY_CHUNK), last: i + REPLAY_CHUNK >= snapshot.length })
    }
    await session.send({ type: 'attached', id: c.id, fresh })
  }

  session.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'list') { session.send({ type: 'consoles', list: hub.list() }); return }
    if (msg.type === 'open') { attachTo(hub.create({ cols: msg.cols || 80, rows: msg.rows || 24 }), { fresh: true }); return }
    if (msg.type === 'attach') {
      const c = hub.get(msg.id)
      if (!c) return fail('no-console', 'that console no longer exists')
      c.resize(msg.cols, msg.rows)
      attachTo(c, { fresh: false })
      return
    }
    if (msg.type === 'detach') { release(); return }
    if (msg.type === 'input') { current?.write(String(msg.data ?? '')); return }
    if (msg.type === 'resize') { current?.resize(msg.cols, msg.rows); return }
    if (msg.type === 'close') { if (current) hub.kill(current.id); return }
    if (msg.type === 'kill') { if (!hub.kill(msg.id)) fail('no-console', 'that console no longer exists') }
  })
  session.on('close', release)
}

/**
 * Arranca el agente. Devuelve lo mismo que `startRemoteAgent`:
 * `{ machine, machineId, master, client, close }`.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]       dónde vive el enlace (default dataDir()).
 * @param {string} [opts.proxyUrl]  override del proxio del enlace.
 * @param {string} [opts.shell]     shell a lanzar (default $SHELL).
 * @param {boolean} [opts.quiet]
 * @param {()=>void} [opts.onRevoked]
 */
export async function startAgent (opts = {}) {
  const hub = makeHub(loadPty(), opts)
  const ra = await startRemoteAgent({
    label: LABEL,
    dir: opts.dir || dataDir(),
    proxyUrl: opts.proxyUrl,
    quiet: opts.quiet,
    onRevoked: () => { hub.killAll(); opts.onRevoked?.() },
    onSession: (session) => serveSession(session, hub)
  })
  // Parar el agente sí mata las consolas: sin agente no hay quién las atienda.
  return { ...ra, consoles: hub, close: () => { hub.killAll(); ra.close() } }
}

export default { startAgent, LABEL }
