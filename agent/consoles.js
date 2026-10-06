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

// ¿ESTÁ TRABAJANDO? Lo que el panel enseña con un color por consola.
//  · Si el programa lo dice en el TÍTULO, manda eso. Claude Code lo hace (medido el 2026-10-06
//    con la 2.1.291): «✳ tema» esperando, «◐ tema» / «◑ tema» alternando mientras trabaja.
//  · Si no lo dice (otro agente, un comando): salida SOSTENIDA que no es eco de lo tecleado es
//    trabajo, y el silencio es que terminó.
// «Terminó» (`doneAt`) queda marcado hasta que alguien entra a la consola o teclea en ella: es
// lo que avisa de que un agente acabó mientras mirabas otra cosa. Una campana (BEL) lo marca igual.
const BUSY_GLYPHS = /^[\u25d0-\u25d3\u25f4-\u25f7\u2800-\u28ff]/      // ◐◑◒◓ ◴◵◶◷ y los girasoles braille
const IDLE_GLYPHS = /^\u2733/                                           // ✳
/** Lo que dice el título: true (trabajando), false (esperando) o null (el programa no lo dice). */
export function titleSignal (title) {
  const t = String(title || '')
  if (BUSY_GLYPHS.test(t)) return true
  if (IDLE_GLYPHS.test(t)) return false
  return null
}
const ECHO_MS = 400        // salida tan pegada a una tecla es su eco, no trabajo
const SUSTAIN_MS = 1500    // salida propia durante este rato = está trabajando
const GAP_MS = 1000        // un hueco mayor que este corta la racha: no era salida seguida
// EL RESPALDO, para quien no lo dice en el título (OpenCode, un comando cualquiera): si la
// pantalla no cambia en este rato, la consola está quieta. Un minuto por defecto (dueño,
// 2026-10-06): un programa que piensa en silencio unos segundos no debe darse por terminado.
// `DOTRINO_TERMINAL_IDLE_SECONDS` lo cambia; quien lo dice en el título no espera a esto.
export const QUIET_MS = Math.max(1, Number(process.env.DOTRINO_TERMINAL_IDLE_SECONDS) || 60) * 1000
const MIN_TASK_MS = 3000   // menos que esto no fue «una tarea»: no se marca como terminada

const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('')

class Console {
  constructor ({ id, n, pty, cols, rows, origin, quietMs = QUIET_MS }) {
    this.quietMs = quietMs
    this.id = id
    this.n = n                        // su número, fijo mientras viva (ver ConsoleHub.create)
    this.pty = pty
    this.origin = origin              // 'local' (una ventana de esta máquina) | 'remote' (otro aparato)
    this.title = ''                   // el que pone la shell (OSC 0/2), para reconocerla en la lista
    this.cols = cols
    this.rows = rows
    this.createdAt = Date.now()
    this.lastActive = Date.now()
    this.viewers = new Set()          // sesiones mirando: { onOut(data), onExit(code), onMeta?(info), origin, device?, tag?, size? }
    // QUIÉN MANDA EN EL TAMAÑO. `pinKey`: la pantalla que lo eligió a propósito (⤢ en la app o el teléfono);
    // si nadie, `holder`: el último que se enganchó. Solo ese lo cambia, y se sigue su pantalla
    // (redimensionar la ventana, girar el teléfono). Escribir o dar foco no cambia nada.
    // `pinKey` recuerda QUÉ PANTALLA lo eligió (ventana o aparato), no su conexión: si esa pantalla
    // pasa a otra consola y vuelve, lo recupera. Mientras no está, manda el último que llegó.
    this.pinKey = null
    this.holder = null
    this.exited = false
    this.screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    this.busy = false                 // ¿trabajando ahora?
    this.busySince = 0
    this.doneAt = null                // terminó (o pidió atención) y nadie lo ha atendido
    this.lastInput = 0
    this._titleSays = null            // lo último que dijo el título (true/false), o null si no lo dice
    this._outSince = 0                // desde cuándo hay salida propia seguida
    this._lastOwnOut = 0
    this._quiet = null
    this.screen.onTitleChange((t) => {
      this.title = String(t).slice(0, 200)
      const says = titleSignal(this.title)
      const before = this._titleSays
      this._titleSays = says
      // Cuando el programa lo dice, manda él; si DEJA de decirlo (salió), ya no está trabajando.
      // Un título que nunca dijo nada (el de la shell) no toca lo que se dedujo de la salida.
      let changed = false
      if (says !== null) changed = this._setBusy(says)
      else if (before !== null) changed = this._setBusy(false)
      if (!changed) this._meta()
    })
    this.screen.onBell(() => { this.doneAt = Date.now(); this._meta() })
  }

  /** Cambia «trabajando». Al dejar de trabajar tras una tarea de verdad, queda como terminada. */
  _setBusy (v) {
    if (v === this.busy) return false
    const now = Date.now()
    this.busy = v
    if (v) { this.busySince = now; this.doneAt = null } else if (now - this.busySince >= MIN_TASK_MS) this.doneAt = now
    this._meta()
    return true
  }

  /** Alguien atendió la consola (entró o tecleó): ya no está «terminada sin atender». */
  _attended () {
    if (this.doneAt == null) return
    this.doneAt = null
    this._meta()
  }

  /** Avisa a todos los que miran de que cambió quién mira o el título. */
  _meta () {
    const info = this.info()
    for (const v of this.viewers) v.onMeta?.(info)
  }

  /** Lo que sale de la shell: a la pantalla sin pantalla y a quien esté mirando. */
  _out (data) {
    const now = Date.now()
    this.lastActive = now
    // Sin señal en el título: salida propia y sostenida = trabajando; el silencio lo apaga.
    if (this._titleSays === null) {
      if (now - this.lastInput > ECHO_MS) {
        // SOSTENIDA = seguida: dos ráfagas sueltas (el prompt que se redibuja al cambiar el
        // tamaño, y otra cosa segundos después) no son un programa trabajando.
        if (!this._outSince || now - this._lastOwnOut > GAP_MS) this._outSince = now
        this._lastOwnOut = now
        if (now - this._outSince >= SUSTAIN_MS) this._setBusy(true)
      }
      clearTimeout(this._quiet)
      this._quiet = setTimeout(() => { this._outSince = 0; if (this._titleSays === null) this._setBusy(false) }, this.quietMs)
      this._quiet.unref?.()
    }
    this.screen.write(data)
    for (const v of this.viewers) v.onOut(data)
  }

  write (data) { this.lastActive = this.lastInput = Date.now(); this._attended(); this.pty.write(data) }

  resize (cols, rows) {
    if (!cols || !rows) return
    const changed = cols !== this.cols || rows !== this.rows
    this.cols = cols; this.rows = rows
    try { this.pty.resize(cols, rows) } catch (_) {}
    try { this.screen.resize(cols, rows) } catch (_) {}
    // Quien mira desde otro aparato se entera del tamaño nuevo y adapta su vista (la PWA no
    // encoge la consola: la muestra a su tamaño, con desplazamiento).
    if (changed) this._meta()
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
        this.doneAt = null                // quien entra, la atiende (el `_meta` de abajo lo cuenta)
        resolve(snapshot + pending.join(''))
        this._meta()
      })
    })
  }

  detach (viewer) {
    if (!this.viewers.has(viewer)) return
    // Quién decidía, ANTES de quitarlo: si era él, hay que pasar el tamaño a otro.
    const before = this.decider()
    this.viewers.delete(viewer)
    // Si se fue el último que llegó, lo es el último de los que quedan.
    if (this.holder === viewer) this.holder = [...this.viewers].filter((v) => v.size).pop() || null
    // Si cambió quién decide (se fue el que lo tenía, fijado o no), manda su tamaño.
    const d = this.decider()
    if (d !== before && d?.size) this.resize(d.size.cols, d.size.rows)
    this._meta()
  }

  /** Quién decide el tamaño ahora. */
  decider () { return this.pinnedViewer() || this.holder }

  /** La pantalla que eligió el tamaño, si está mirando ahora. */
  pinnedViewer () {
    if (!this.pinKey) return null
    return [...this.viewers].filter((v) => viewerKey(v) === this.pinKey).pop() || null
  }

  /**
   * `viewer` dice su tamaño (al engancharse, `attaching`, o porque cambió su pantalla). Se aplica
   * solo si es quien decide; engancharse lo hace decidir si nadie lo tiene fijado.
   */
  sizeFrom (viewer, { attaching = false } = {}) {
    if (attaching) this.holder = viewer
    if (this.decider() === viewer && viewer.size) this.resize(viewer.size.cols, viewer.size.rows)
    else this._meta()
  }

  /** ⤢: `viewer` fija (o suelta) el tamaño a su pantalla. */
  pin (viewer, on) {
    if (on) this.pinKey = viewerKey(viewer)
    else if (this.pinKey === viewerKey(viewer)) this.pinKey = null
    const d = this.decider()
    if (d?.size) this.resize(d.size.cols, d.size.rows)
    this._meta()
  }

  /**
   * `watchers` dice QUIÉN mira: una ventana de esta máquina o un aparato de la cuenta (con
   * su pubkey), y la etiqueta con la que se presentó (`tag`): así una ventana de la app de
   * escritorio reconoce, en la lista, cuál es la consola que está mostrando ella. Es lo que deja a la ventana local avisar de que alguien entró desde fuera.
   */
  info () {
    const watchers = [...this.viewers].filter((v) => v.origin).map((v) => ({ origin: v.origin, device: v.device || null, tag: v.tag || null }))
    const d = this.decider()
    const sizeBy = d ? { origin: d.origin || null, device: d.device || null, tag: d.tag || null, pinned: !!d && d === this.pinnedViewer() } : null
    return { id: this.id, n: this.n, activity: this.busy ? 'busy' : 'idle', doneAt: this.doneAt, sizeBy, origin: this.origin, title: this.title, cols: this.cols, rows: this.rows, createdAt: this.createdAt, lastActive: this.lastActive, viewers: this.viewers.size, watchers }
  }
}

/** Qué pantalla es un `viewer`: su ventana (`tag`) o su aparato, sin importar la conexión. */
function viewerKey (v) { return `${v.origin || ''}|${v.device || ''}|${v.tag || ''}` }

/** Las consolas de este agente. */
export class ConsoleHub {
  /**
   * @param {{ spawn:(opts:{cols:number,rows:number,cwd:string|null})=>any }} opts
   *   `spawn` lanza la shell (un PTY con `onData`, `onExit`, `write`, `resize`, `kill`).
   */
  constructor ({ spawn, quietMs = QUIET_MS }) {
    this._spawn = spawn
    this._quietMs = quietMs
    this.consoles = new Map()
  }

  create ({ cols = 80, rows = 24, origin = 'remote', cwd = null } = {}) {
    const id = randomId()
    // Su NÚMERO: el libre más bajo, y no cambia mientras viva. Si se cierra la 1, la 2 sigue
    // siendo la 2 y la próxima nueva será la 1. Lo da el agente para que sea el mismo en todas
    // las ventanas y aparatos.
    const used = new Set([...this.consoles.values()].map((c) => c.n))
    let n = 1
    while (used.has(n)) n++
    const pty = this._spawn({ cols, rows, cwd })
    const c = new Console({ id, n, pty, cols, rows, origin, quietMs: this._quietMs })
    pty.onData((d) => c._out(d))
    pty.onExit(({ exitCode }) => {
      c.exited = true
      clearTimeout(c._quiet)
      this.consoles.delete(id)
      // A cada pantalla se le dice si la consola la cerró OTRA (`byOther`): la shell que termina
      // sola, o la que cierra la propia pantalla, no lo es. Quien mira decide con eso si se va
      // (una ventana cuya shell hizo `exit`) o si sigue (se la cerraron desde otro aparato).
      for (const v of c.viewers) v.onExit(exitCode, { byOther: c.killed === true && c.killedBy !== v })
      c.viewers.clear()
      try { c.screen.dispose() } catch (_) {}
    })
    this.consoles.set(id, c)
    return c
  }

  get (id) { return this.consoles.get(id) || null }

  list () { return [...this.consoles.values()].map((c) => c.info()).sort((a, b) => a.n - b.n) }

  /** Cierra una consola. `by`: la pantalla (viewer) que lo pide, para decirle a las DEMÁS que no fueron ellas. */
  kill (id, by = null) {
    const c = this.consoles.get(id)
    if (!c) return false
    c.killed = true
    c.killedBy = by
    try { c.pty.kill() } catch (_) {}
    return true
  }

  killAll () { for (const id of [...this.consoles.keys()]) this.kill(id) }
}
