/**
 * consoles.js — las shells del agente, SEPARADAS de las conexiones.
 *
 * Antes una shell vivía lo que su sesión cifrada: cerrar o recargar el navegador la
 * dejaba huérfana y a los 30 min moría. Ahora cada shell es una CONSOLA con id, que sigue
 * viva aunque no haya nadie mirando, y a la que cualquier aparato de la cuenta puede
 * volver (`attach`) y ver la pantalla tal como estaba.
 *
 * La pantalla se reconstruye con una terminal SIN PANTALLA (`@xterm/headless`) que recibe
 * lo mismo que el navegador: al volver se manda su estado serializado (pantalla + historial),
 * no los últimos bytes sueltos, que cortarían secuencias de escape a la mitad.
 *
 * Todo en MEMORIA: nada de lo que sale por una shell se escribe al disco. Si el agente se
 * reinicia, las consolas se pierden (y se dice: la app ve que ya no están).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')

/** Líneas de historial que se guardan y se devuelven al volver. */
export const SCROLLBACK = 1000
/** Tamaño máximo de cada trozo de la repetición: el proxio corta los mensajes a 1 MB. */
export const REPLAY_CHUNK = 64 * 1024

const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('')

class Console {
  constructor ({ id, pty, cols, rows, origin }) {
    this.id = id
    this.pty = pty
    this.origin = origin              // 'local' (una ventana de esta máquina) | 'remote' (otro aparato)
    this.title = ''                   // el que pone la shell (OSC 0/2), para reconocerla en la lista
    this.cols = cols
    this.rows = rows
    this.createdAt = Date.now()
    this.lastActive = Date.now()
    this.viewers = new Set()          // sesiones mirando: { onOut(data), onExit(code), onMeta?(info), origin, device? }
    this.exited = false
    this.screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    this.screen.onTitleChange((t) => { this.title = String(t).slice(0, 200); this._meta() })
  }

  /** Avisa a todos los que miran de que cambió quién mira o el título. */
  _meta () {
    const info = this.info()
    for (const v of this.viewers) v.onMeta?.(info)
  }

  /** Lo que sale de la shell: a la pantalla sin pantalla y a quien esté mirando. */
  _out (data) {
    this.lastActive = Date.now()
    this.screen.write(data)
    for (const v of this.viewers) v.onOut(data)
  }

  write (data) { this.lastActive = Date.now(); this.pty.write(data) }

  resize (cols, rows) {
    if (!cols || !rows) return
    this.cols = cols; this.rows = rows
    try { this.pty.resize(cols, rows) } catch (_) {}
    try { this.screen.resize(cols, rows) } catch (_) {}
  }

  /**
   * Engancha a `viewer` y le devuelve la pantalla actual. EXACTO, sin huecos ni repetidos:
   * lo que ya se escribió va en la foto, y lo que llega mientras se hace la foto se guarda
   * aparte y se le da después. El `write('', cb)` hace de marca: xterm procesa en orden y
   * llama al callback justo tras esa marca, así que la foto tiene todo lo anterior y nada
   * de lo posterior.
   * @returns {Promise<string>} la pantalla serializada
   */
  attach (viewer) {
    const pending = []
    const buffering = { onOut: (d) => pending.push(d), onExit: viewer.onExit }
    this.viewers.add(buffering)
    return new Promise((resolve) => {
      this.screen.write('', () => {
        const snapshot = this.serializer.serialize()
        this.viewers.delete(buffering)
        this.viewers.add(viewer)
        resolve(snapshot + pending.join(''))
        this._meta()
      })
    })
  }

  detach (viewer) { if (this.viewers.delete(viewer)) this._meta() }

  /**
   * `watchers` dice QUIÉN mira: una ventana de esta máquina o un aparato de la cuenta (con
   * su pubkey), y la etiqueta con la que se presentó (`tag`): así una ventana de la app de
   * escritorio reconoce, en la lista, cuál es la consola que está mostrando ella. Es lo que deja a la ventana local avisar de que alguien entró desde fuera.
   */
  info () {
    const watchers = [...this.viewers].filter((v) => v.origin).map((v) => ({ origin: v.origin, device: v.device || null, tag: v.tag || null }))
    return { id: this.id, origin: this.origin, title: this.title, cols: this.cols, rows: this.rows, createdAt: this.createdAt, lastActive: this.lastActive, viewers: this.viewers.size, watchers }
  }
}

/** Las consolas de este agente. */
export class ConsoleHub {
  /**
   * @param {{ spawn:(opts:{cols:number,rows:number,cwd:string|null})=>any }} opts
   *   `spawn` lanza la shell (un PTY con `onData`, `onExit`, `write`, `resize`, `kill`).
   */
  constructor ({ spawn }) {
    this._spawn = spawn
    this.consoles = new Map()
  }

  create ({ cols = 80, rows = 24, origin = 'remote', cwd = null } = {}) {
    const id = randomId()
    const pty = this._spawn({ cols, rows, cwd })
    const c = new Console({ id, pty, cols, rows, origin })
    pty.onData((d) => c._out(d))
    pty.onExit(({ exitCode }) => {
      c.exited = true
      this.consoles.delete(id)
      for (const v of c.viewers) v.onExit(exitCode)
      c.viewers.clear()
      try { c.screen.dispose() } catch (_) {}
    })
    this.consoles.set(id, c)
    return c
  }

  get (id) { return this.consoles.get(id) || null }

  list () { return [...this.consoles.values()].map((c) => c.info()) }

  kill (id) {
    const c = this.consoles.get(id)
    if (!c) return false
    try { c.pty.kill() } catch (_) {}
    return true
  }

  killAll () { for (const id of [...this.consoles.keys()]) this.kill(id) }
}
