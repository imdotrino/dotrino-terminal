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
 *
 * En Windows no hay sockets Unix: es una TUBERÍA CON NOMBRE (`\\.\pipe\…`). Esas viven en un
 * espacio de nombres de toda la máquina, no en la carpeta, así que el permiso de la carpeta no
 * las protege. Dos cosas lo suplen, y las dos salen de un archivo que solo lee el usuario
 * (`terminal.pipe`, en la carpeta del enlace):
 *
 *   · el NOMBRE de la tubería es aleatorio: nadie puede crearla antes que el agente para
 *     hacerse pasar por él, porque no sabe cómo se va a llamar;
 *   · una LLAVE que la ventana manda en su primera línea. La lista de tuberías la ve cualquiera,
 *     y sin la llave el agente corta la conexión sin atender nada.
 *
 * Por eso la tubería se abre para todos (`readableAll`/`writableAll`): lo que protege es la llave.
 * Con el permiso por defecto, un agente lanzado con el token de administrador entero (desde SSH)
 * dejaba fuera a las ventanas del mismo usuario, que corren sin elevar.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

export const SOCKET_NAME = 'terminal.sock'
export const socketPath = (dir) => path.join(dir, SOCKET_NAME)
/** Windows: el archivo que dice cómo se llama la tubería del agente y con qué llave se entra. */
export const PIPE_FILE = 'terminal.pipe'
export const pipeFile = (dir) => path.join(dir, PIPE_FILE)
const isWindows = (platform) => platform === 'win32'
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

/** Windows: lo apuntado por el agente que escucha (o escuchó) en esa carpeta. `null` si no hay. */
function readPipe (dir) {
  let text
  try { text = fs.readFileSync(pipeFile(dir), 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  const rec = JSON.parse(text)
  if (typeof rec?.pipe !== 'string' || typeof rec?.key !== 'string') throw Object.assign(new Error(`${pipeFile(dir)} is malformed`), { code: 'EBADPIPE' })
  return rec
}

/** La sesión de una conexión: misma forma que las de `@dotrino/remote-agent`. */
function sessionOf (sock, serve, key) {
  const h = { message: [], close: [] }
  let closed = false
  let allowed = !key
  const session = {
    device: null,
    send: async (payload) => { if (allowed) write(payload) },
    on (ev, cb) { h[ev]?.push(cb); return this }
  }
  const write = framed(sock, (msg) => {
    // Windows: la primera línea es la llave. Cualquier otra cosa corta, sin contestar.
    if (!allowed) {
      const got = Buffer.from(String(msg?.type === 'local-auth' ? msg.key : ''))
      const want = Buffer.from(key)
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) { sock.destroy(); return }
      allowed = true
      serve(session)
      return
    }
    for (const cb of h.message) { try { cb(msg) } catch (_) {} }
  })
  const bye = () => { if (closed) return; closed = true; if (allowed) for (const cb of h.close) { try { cb() } catch (_) {} } }
  sock.on('close', bye)
  sock.on('error', bye)
  if (allowed) serve(session)
}

/**
 * Escucha las ventanas locales. Cada conexión es una sesión con la misma forma que las de
 * `@dotrino/remote-agent` (`send`, `on('message'|'close')`), así que `serve` es
 * `serveSession` tal cual.
 *
 * @param {{ dir: string, serve: (session: object) => void, platform?: string }} opts
 * @returns {Promise<{ path: string, close: () => void }>}
 */
export async function listenLocal ({ dir, serve, platform = process.platform }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  let file, key = null
  if (isWindows(platform)) {
    const old = readPipe(dir)
    if (old && await answers(old.pipe)) throw Object.assign(new Error(`another agent is already listening on ${old.pipe}`), { code: 'EALREADY' })
    file = `\\\\.\\pipe\\dotrino-terminal-${crypto.randomBytes(16).toString('hex')}`
    key = crypto.randomBytes(32).toString('hex')
  } else {
    file = socketPath(dir)
    checkLength(file)
    if (fs.existsSync(file)) {
      if (await answers(file)) throw Object.assign(new Error(`another agent is already listening on ${file}`), { code: 'EALREADY' })
      fs.rmSync(file)                                   // lo dejó un agente que murió sin limpiar
    }
  }
  const socks = new Set()
  const server = net.createServer((sock) => {
    socks.add(sock)
    sock.on('close', () => socks.delete(sock))
    sessionOf(sock, serve, key)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path: file, ...(key ? { readableAll: true, writableAll: true } : {}) }, () => { server.off('error', reject); resolve() })
  })
  if (key) {
    // Se apunta DESPUÉS de escuchar: quien lo lea encuentra la tubería ya abierta.
    const tmp = pipeFile(dir) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ pipe: file, key }), { mode: 0o600 })
    fs.renameSync(tmp, pipeFile(dir))
  } else {
    fs.chmodSync(file, 0o600)
  }
  const forget = () => {
    if (!key) { try { fs.rmSync(file) } catch (_) {} return }
    // Solo si sigue siendo el nuestro: otro agente pudo tomar la carpeta después.
    try { if (readPipe(dir)?.pipe === file) fs.rmSync(pipeFile(dir)) } catch (_) {}
  }
  return {
    path: file,
    // Parar el agente cierra también las ventanas: sin agente no queda shell que mirar.
    close: () => { server.close(); for (const s of socks) s.destroy(); forget() }
  }
}

/**
 * Se conecta al agente de esta máquina. Rechaza con `code: 'ENOAGENT'` si no hay ninguno
 * escuchando en esa carpeta.
 *
 * @param {string} dir  la carpeta del enlace del agente.
 * @param {{ platform?: string }} [opts]
 * @returns {Promise<{ send:(obj:object)=>void, on:(ev:'message'|'close', cb:Function)=>void, close:()=>void }>}
 */
export function connectLocal (dir, { platform = process.platform } = {}) {
  let file, key = null
  if (isWindows(platform)) {
    const rec = readPipe(dir)
    if (!rec) return Promise.reject(Object.assign(new Error(`no terminal agent is listening in ${dir}`), { code: 'ENOAGENT' }))
    file = rec.pipe; key = rec.key
  } else {
    file = socketPath(dir)
    checkLength(file)
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect(file)
    const h = { message: [], close: [] }
    const send = framed(sock, (msg) => { for (const cb of h.message) cb(msg) })
    let connected = false
    sock.once('connect', () => {
      connected = true
      if (key) send({ type: 'local-auth', key })
      sock.on('close', () => { for (const cb of h.close) cb() })
      resolve({ send, on: (ev, cb) => { h[ev]?.push(cb) }, close: () => sock.end() })
    })
    // Tras conectar, un error acaba en 'close', que ya se avisa arriba.
    sock.on('error', (e) => {
      if (connected) return
      // Hay agente pero no deja entrar: no es lo mismo que no haber ninguno.
      if (e.code === 'EPERM' || e.code === 'EACCES') reject(Object.assign(new Error(`the terminal agent on ${file} refused this window (${e.code})`), { code: 'EAGENTACCESS', cause: e }))
      else reject(Object.assign(new Error(`no terminal agent is listening on ${file}`), { code: 'ENOAGENT', cause: e }))
    })
  })
}
