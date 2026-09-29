/**
 * @dotrino/terminal-agent — abre una shell real (PTY) SOLO para aparatos de tu cuenta.
 *
 * Lo común (enrolarse con la bóveda, handshake contra el ACTA, canal cifrado por sesión,
 * revocación, renovación del papel, auditoría) lo hace `@dotrino/remote-agent`: este
 * paquete solo sabe de PTY. Antes lo hacía todo a mano (su propio enrolamiento, su propio
 * cifrado) y por eso se quedó atrás: con la bóveda actual no podía ni emparejarse.
 *
 * Payloads de dominio (van cifrados dentro de la sesión, el proxio no los ve):
 *   cliente → agente: { type:'open', cols, rows } · { type:'input', data } ·
 *                     { type:'resize', cols, rows } · { type:'close' }
 *   agente → cliente: { type:'out', data } · { type:'exit', code }
 */
import os from 'node:os'
import { createRequire } from 'node:module'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { dataDir, LABEL } from './link.js'

const require = createRequire(import.meta.url)

export { LABEL }

export function loadPty () {
  // Binarios PREBUILT (Linux/macOS/Windows, sin toolchain), API idéntica a node-pty.
  try { return require('@homebridge/node-pty-prebuilt-multiarch') } catch (e) {
    throw new Error('PTY module missing. Reinstall the agent: `npx @dotrino/terminal-agent` (' + e.message + ')')
  }
}

/** Atiende una sesión cifrada: una shell por sesión. Exportada para las pruebas. */
export function servePty (session, pty, opts) {
  let term = null
  const kill = () => { try { term?.kill() } catch (_) {} term = null }

  session.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'open') {
      if (term) return
      const shell = opts.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
      term = pty.spawn(shell, [], {
        name: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24,
        cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' }
      })
      term.onData((data) => { session.send({ type: 'out', data }) })
      term.onExit(({ exitCode }) => { session.send({ type: 'exit', code: exitCode }); term = null })
      return
    }
    if (msg.type === 'input') { term?.write(String(msg.data ?? '')); return }
    if (msg.type === 'resize') { try { term?.resize(msg.cols, msg.rows) } catch (_) {} return }
    if (msg.type === 'close') { kill(); session.close() }
  })
  // La sesión se cierra por inactividad o al parar el agente: la shell muere con ella.
  session.on('close', kill)
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
  const pty = loadPty()
  return startRemoteAgent({
    label: LABEL,
    dir: opts.dir || dataDir(),
    proxyUrl: opts.proxyUrl,
    quiet: opts.quiet,
    onRevoked: opts.onRevoked,
    onSession: (session) => servePty(session, pty, opts)
  })
}

export default { startAgent, LABEL }
