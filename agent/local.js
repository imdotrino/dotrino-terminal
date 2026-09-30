/**
 * local.js — las ventanas de ESTA máquina hablan con el agente por un socket local.
 *
 * Es el primer escalón del transporte del ecosistema: si la otra punta está en la misma
 * máquina, no se sale a la red. Por aquí no pasa ni el proxio ni el cifrado de sesión: el
 * socket vive en la carpeta del enlace (`~/.dotrino/agent/terminal-agent/<nombre>/`, 0700)
 * y solo lo abre el usuario dueño de esa carpeta — el mismo que ya puede leer el enlace.
 *
 * El protocolo es EL MISMO que el de las sesiones remotas (`serveSession`), en JSON por
 * líneas: una ventana local y el navegador de otro aparato son dos clientes de las mismas
 * consolas.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export const SOCKET_NAME = 'terminal.sock'
export const socketPath = (dir) => path.join(dir, SOCKET_NAME)
/** Lo más largo que admite la ruta de un socket Unix (macOS: 104 bytes con el nulo; Linux: 108). */
export const MAX_SOCKET_PATH = 103

function checkLength (file) {
  if (Buffer.byteLength(file) > MAX_SOCKET_PATH) {
    throw Object.assign(new Error(`socket path too long (${Buffer.byteLength(file)} bytes, max ${MAX_SOCKET_PATH}): ${file}. Use a shorter DOTRINO_AGENT_HOME`), { code: 'ESOCKPATH' })
  }
}

/** Mensajes JSON por líneas sobre un socket. */
function framed (sock, onMessage) {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      onMessage(msg)
    }
  })
  return (obj) => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n') }
}

/** ¿Contesta alguien en ese socket? */
function answers (file) {
  return new Promise((resolve) => {
    const s = net.connect(file)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

/**
 * Escucha las ventanas locales. Cada conexión es una sesión con la misma forma que las de
 * `@dotrino/remote-agent` (`send`, `on('message'|'close')`), así que `serve` es
 * `serveSession` tal cual.
 *
 * @param {{ dir: string, serve: (session: object) => void }} opts
 * @returns {Promise<{ path: string, close: () => void }>}
 */
export async function listenLocal ({ dir, serve }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const file = socketPath(dir)
  checkLength(file)
  if (fs.existsSync(file)) {
    if (await answers(file)) throw Object.assign(new Error(`another agent is already listening on ${file}`), { code: 'EALREADY' })
    fs.rmSync(file)                                   // lo dejó un agente que murió sin limpiar
  }
  const socks = new Set()
  const server = net.createServer((sock) => {
    socks.add(sock)
    sock.on('close', () => socks.delete(sock))
    const h = { message: [], close: [] }
    let closed = false
    const session = {
      device: null,
      send: async (payload) => write(payload),
      on (ev, cb) { h[ev]?.push(cb); return this }
    }
    const write = framed(sock, (msg) => { for (const cb of h.message) { try { cb(msg) } catch (_) {} } })
    const bye = () => { if (closed) return; closed = true; for (const cb of h.close) { try { cb() } catch (_) {} } }
    sock.on('close', bye)
    sock.on('error', bye)
    serve(session)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(file, () => { server.off('error', reject); resolve() })
  })
  fs.chmodSync(file, 0o600)
  return {
    path: file,
    // Parar el agente cierra también las ventanas: sin agente no queda shell que mirar.
    close: () => { server.close(); for (const s of socks) s.destroy(); try { fs.rmSync(file) } catch (_) {} }
  }
}

/**
 * Se conecta al agente de esta máquina. Rechaza con `code: 'ENOAGENT'` si no hay ninguno
 * escuchando en esa carpeta.
 *
 * @param {string} dir  la carpeta del enlace del agente.
 * @returns {Promise<{ send:(obj:object)=>void, on:(ev:'message'|'close', cb:Function)=>void, close:()=>void }>}
 */
export function connectLocal (dir) {
  const file = socketPath(dir)
  checkLength(file)
  return new Promise((resolve, reject) => {
    const sock = net.connect(file)
    const h = { message: [], close: [] }
    const send = framed(sock, (msg) => { for (const cb of h.message) cb(msg) })
    let connected = false
    sock.once('connect', () => {
      connected = true
      sock.on('close', () => { for (const cb of h.close) cb() })
      resolve({ send, on: (ev, cb) => { h[ev]?.push(cb) }, close: () => sock.end() })
    })
    // Tras conectar, un error acaba en 'close', que ya se avisa arriba.
    sock.on('error', (e) => {
      if (!connected) reject(Object.assign(new Error(`no terminal agent is listening on ${file}`), { code: 'ENOAGENT', cause: e }))
    })
  })
}
