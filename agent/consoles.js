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

// ¿ESTÁ TRABAJANDO? Lo que el panel enseña con un color por consola. UNA regla, sin leer lo que
// dice la pantalla ni el título (dueño, 2026-10-06): si el TÍTULO o el CONTENIDO cambian de
// seguido, trabaja; si llevan un rato sin cambiar, está quieta. Sirve igual para cualquier
// agente — medidos Claude Code y Codex (giran el título), y OpenCode (anima la pantalla): los
// tres cambian algo al menos una vez por segundo mientras trabajan y se callan al terminar.
// «Terminó» (`doneAt`) queda marcado hasta que alguien entra a la consola o teclea en ella: es
// lo que avisa de que un agente acabó mientras mirabas otra cosa. Una campana (BEL) lo marca igual.
const ECHO_MS = 400        // un cambio tan pegado a una tecla es su eco, no trabajo
const SUSTAIN_MS = 1500    // cambios seguidos durante este rato = está trabajando
const GAP_MS = 2000        // un hueco mayor que este corta la racha: eran cambios sueltos
// Sin cambios en este rato, la consola está quieta. `DOTRINO_TERMINAL_IDLE_SECONDS` lo cambia.
// Diez segundos: de sobra para un agente, y un comando que calle más se da por terminado pronto.
export const QUIET_MS = Math.max(1, Number(process.env.DOTRINO_TERMINAL_IDLE_SECONDS) || 10) * 1000
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
    this._changing = 0                // desde cuándo hay cambios seguidos
    this._lastChange = 0
    this._quiet = null
    this.screen.onTitleChange((t) => {
      this.title = String(t).slice(0, 200)
      if (!this._changed(Date.now())) this._meta()
    })
    this.screen.onBell(() => { this.doneAt = Date.now(); this._meta() })
  }

  /**
   * Algo cambió (el título o el contenido). Cambios seguidos encienden «trabajando»; un rato sin
   * ninguno lo apaga. Dos cambios sueltos (el prompt que se redibuja, un comando instantáneo) no
   * son un programa trabajando. Devuelve si avisó a quien mira.
   */
  _changed (now) {
    if (now - this.lastInput <= ECHO_MS) return false
    if (!this._changing || now - this._lastChange > GAP_MS) this._changing = now
    this._lastChange = now
    clearTimeout(this._quiet)
    this._quiet = setTimeout(() => { this._changing = 0; this._setBusy(false) }, this.quietMs)
    this._quiet.unref?.()
    return now - this._changing >= SUSTAIN_MS ? this._setBusy(true) : false
  }

  /** Cambia «trabajando». Al dejar de trabajar tras una tarea de verdad, queda como terminada. */
  _setBusy (v) {
    if (v === this.busy) return false
    this.busy = v
    // La tarea duró hasta el ÚLTIMO cambio, no hasta que se notó el silencio.
    if (v) { this.busySince = this._changing; this.doneAt = null } else if (this._lastChange - this.busySince >= MIN_TASK_MS) this.doneAt = Date.now()
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
    this._changed(now)
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

  /**
   * `viewer` tecleó: pasa a decidir el tamaño, también sobre una pantalla que lo tenía fijado
   * (deja de estarlo). Es la única forma de ganarlo que tiene quien no puede fijarlo, como la
   * terminal embebida de un editor.
   */
  typed (viewer) {
    if (!this.viewers.has(viewer) || this.decider() === viewer) return
    this.holder = viewer
    if (this.pinKey !== viewerKey(viewer)) this.pinKey = null
    if (viewer.size) this.resize(viewer.size.cols, viewer.size.rows)
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
// Lo que una terminal manda SOLA, sin que nadie teclee: avisos de foco, respuestas a lo que le
// pregunta el programa (posición del cursor, qué terminal es, modos, colores) y el ratón.
const REPORTS = new RegExp([
  '\\x1b\\[[IO]',                         // foco
  '\\x1b\\[\\??[\\d;]*[Rn]',                 // cursor y estado
  '\\x1b\\[[?>=][\\d;]*[cu]',               // qué terminal es; teclado
  '\\x1b\\[\\??[\\d;]*\\$y',                 // modos
  '\\x1b\\[[\\d;]*t',                       // tamaño de la ventana
  '\\x1b\\[<[\\d;]+[Mm]',                   // ratón
  '\\x1b\\[M[\\s\\S]{3}',
  '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',   // colores y demás (OSC)
  '\\x1bP[\\s\\S]*?\\x1b\\\\',               // DCS
].join('|'), 'g')

/** ¿Hay algo TECLEADO en `data`, o es solo lo que la terminal contesta por su cuenta? */
export function isTyped (data) { return String(data).replace(REPORTS, '') !== '' }

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
