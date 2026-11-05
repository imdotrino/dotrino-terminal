/**
 * demoAgent.js — un agente de MUESTRA en el navegador (`/consoles?demo`), sin red ni perfil: el
 * mismo papel que `DemoConsolesActivity` (Android) y `DemoAgent` (iOS). Sirve para mirar y probar
 * la pantalla de consolas (panel, split, tamaño) con Playwright. Habla lo mismo que `AgentClient`.
 *
 * La máquina tiene tres consolas: 1 libre, 2 mirada por una ventana de la máquina que ELIGIÓ su
 * tamaño (120×40), 3 con una ruta larga de título. Cada cliente es un «viewer» más.
 */

/** @typedef {import('./types').ConsoleInfo} ConsoleInfo */
/** @typedef {import('./types').Agent} Agent */
/** @type {(code: string, message: string) => Error & { code: string }} */
const codeError = (code, message) => Object.assign(new Error(message), { code })
/**
 * Una consola de la máquina de muestra.
 * @typedef {{ id: string, n: number, title: string, cwd: string, cols: number, rows: number, window: boolean,
 *   task: string, note: string, holder: string | null, lines: string[] }} DemoConsole
 */

/** @type {{ next: number, consoles: DemoConsole[], clients: Set<DemoAgentClient> }} */
const machine = {
  next: 4,
  consoles: [
    mk('c1', 1, '✳ Sefjr improvement', '/mnt/sda1/Dotrino/dotrino-terminal/android/app/src/main', 80, 24),
    mk('c2', 2, 'seyacat@loca: ~/proyectos/dotrino', '~/proyectos/dotrino', 120, 40, { window: true }),
    mk('c3', 3, 'seyacat@loca: /mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor', '/mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor', 80, 24),
  ],
  clients: new Set(),
}

// La tercera «terminó» hace un rato: siempre el mismo momento, o cada lista sería una noticia.
const DEMO_DONE_AT = Date.now()

/**
 * @param {string} id
 * @param {number} n
 * @param {string} title
 * @param {string} cwd
 * @param {number} cols
 * @param {number} rows
 * @param {{ window?: boolean }} [opts]
 * @returns {DemoConsole}
 */
function mk (id, n, title, cwd, cols, rows, { window = false } = {}) {
  return { id, n, title, cwd, cols, rows, window, task: n === 1 ? 'Mejorando el panel de consolas\nFalta: probar en el teléfono' : '', note: n === 1 ? 'Llamar a Ana antes de desplegar.' : '', holder: window ? 'window' : null, lines: [] }
}

/**
 * @param {DemoConsole} c
 * @returns {ConsoleInfo}
 */
function info (c) {
  /** @type {import('./types').Watcher[]} */
  const watchers = []
  if (c.window) watchers.push({ origin: 'local', tag: 'desktop-1' })
  for (const k of machine.clients) if (k.consoleId === c.id) watchers.push({ origin: 'remote', device: 'demo-phone', tag: `pane-${k.n}` })
  const sizeBy = c.holder === 'window' ? { origin: 'local', device: null, tag: 'desktop-1' }
    : c.holder ? { origin: 'remote', device: 'demo-phone', tag: c.holder } : null
  return { id: c.id, n: c.n, title: c.title, note: c.note, task: c.task, cwd: c.cwd, host: 'seyacat@loca', origin: 'local', cols: c.cols, rows: c.rows, activity: c.n === 2 ? 'busy' : 'idle', doneAt: c.n === 3 ? DEMO_DONE_AT : null, sizeBy, viewers: watchers.length, watchers, lastActive: Date.now() }
}

const list = () => machine.consoles.map(info)
const broadcast = () => { for (const k of machine.clients) { k._list(); if (k.consoleId) { const c = machine.consoles.find((x) => x.id === k.consoleId); if (c) k.onMeta(info(c)) } } }

let nextClient = 0

/** @implements {Agent} */
export class DemoAgentClient {
  constructor () {
    this.n = ++nextClient
    /** @type {string | null} */
    this.consoleId = null
    /** @type {Agent['onData']} */ this.onData = () => {}
    /** @type {Agent['onExit']} */ this.onExit = () => {}
    /** @type {Agent['onError']} */ this.onError = () => {}
    /** @type {Agent['onResumed']} */ this.onResumed = () => {}
    /** @type {Agent['onMeta']} */ this.onMeta = () => {}
    /** @type {Agent['askCode']} */ this.askCode = async () => null
    this.rc = { key: 'demo' }
    /** @type {{ cols: number, rows: number } | undefined} */
    this.size = undefined
  }

  async connect () { machine.clients.add(this) }
  _list () {}
  async list () { return list() }

  /** @param {DemoConsole} c */
  _screen (c) {
    this.onData(`\x1b[2J\x1b[H\x1b[32mseyacat@loca\x1b[0m:\x1b[34m${c.cwd}\x1b[0m$ ls\r\n\x1b[34msrc  docs\x1b[0m  run.sh  README.md\r\nConsola ${c.n} · ${c.cols}×${c.rows}\r\n$ `)
  }

  // Como el agente: abrir, cambiarse, ⤢ o teclear toman el tamaño; cambiar la pantalla solo lo
  // sigue quien lo puso.
  /**
   * @param {DemoConsole} c
   * @param {number | undefined} cols
   * @param {number | undefined} rows
   */
  _take (c, cols, rows) {
    c.holder = `pane-${this.n}`
    if (cols && rows) { c.cols = cols; c.rows = rows; this.size = { cols, rows } }
  }

  /**
   * @param {number} cols
   * @param {number} rows
   */
  async open (cols, rows) {
    const c = mk(`c${machine.next}`, machine.next++, 'seyacat@loca: ~', '~', cols, rows)
    machine.consoles.push(c)
    return this.attach(c.id, cols, rows)
  }

  /**
   * @param {string} id
   * @param {number} cols
   * @param {number} rows
   * @param {{ keep?: boolean }} [opts]
   */
  async attach (id, cols, rows, { keep = false } = {}) {
    const c = machine.consoles.find((x) => x.id === id)
    if (!c) throw codeError('no-console', 'that console no longer exists')
    this.consoleId = c.id
    this.size = { cols, rows }
    if (!keep) this._take(c, cols, rows)
    setTimeout(() => { this._screen(c); broadcast() }, 30)
    return { id: c.id, console: info(c) }
  }

  /** @param {string} data */
  input (data) {
    const c = machine.consoles.find((x) => x.id === this.consoleId); if (!c) return
    if (c.holder !== `pane-${this.n}`) { this._take(c, this.size?.cols, this.size?.rows); broadcast() }
    for (const k of machine.clients) if (k.consoleId === c.id) k.onData(data.replace(/\r/g, '\r\n$ '))
  }

  /**
   * @param {number} cols
   * @param {number} rows
   */
  resize (cols, rows) {
    const c = machine.consoles.find((x) => x.id === this.consoleId); if (!c) return
    this.size = { cols, rows }
    if (c.holder === `pane-${this.n}`) { c.cols = cols; c.rows = rows }
    broadcast()
  }

  take () {
    const c = machine.consoles.find((x) => x.id === this.consoleId); if (!c) return
    this._take(c, this.size?.cols, this.size?.rows); broadcast()
  }

  /** @param {string} id */
  kill (id) {
    const i = machine.consoles.findIndex((x) => x.id === id); if (i < 0) return
    machine.consoles.splice(i, 1)
    for (const k of machine.clients) if (k.consoleId === id) { k.consoleId = null; k.onExit(0, { closedBy: k === this ? null : 'other', id }) }
    broadcast()
  }

  /**
   * @param {string} id
   * @param {{ text?: string, task?: string }} [patch]
   */
  async note (id, { text, task } = {}) {
    const c = machine.consoles.find((x) => x.id === id)
    if (!c) throw codeError('no-console', 'that console no longer exists')
    if (typeof text === 'string') c.note = text.slice(0, 4000)
    if (typeof task === 'string') c.task = task.slice(0, 4000)
    broadcast()
    return info(c)
  }

  /**
   * @param {string} id
   * @param {string | null} [before]
   */
  async move (id, before = null) {
    const i = machine.consoles.findIndex((x) => x.id === id); if (i < 0) return list()
    const [c] = machine.consoles.splice(i, 1)
    const j = before ? machine.consoles.findIndex((x) => x.id === before) : -1
    if (j < 0) machine.consoles.push(c); else machine.consoles.splice(j, 0, c)
    broadcast()
    return list()
  }

  // La máquina de muestra «guarda» la imagen: contesta una ruta como la del agente.
  /**
   * @param {Uint8Array} bytes
   * @param {{ onProgress?: (sent: number, total: number) => void }} [opts]
   */
  async sendImage (bytes, { onProgress } = {}) {
    if (!bytes?.length) throw codeError('not-image', 'the image is empty')
    onProgress?.(bytes.length, bytes.length)
    return `/home/seyacat/.dotrino/agent/terminal-agent/default/uploads/img-demo-${bytes.length}.${bytes[0] === 0xff ? 'jpg' : 'png'}`
  }

  /** En la demo no hay máquina: cualquier ruta trae un texto que lo dice. */
  /**
   * @param {string} path
   * @param {{ onProgress?: (got: number, total: number) => void }} [opts]
   */
  async fetchFile (path, { onProgress } = {}) {
    const bytes = new TextEncoder().encode(`Demo: ${path}\n`)
    onProgress?.(bytes.length, bytes.length)
    return { name: (path.split('/').pop() || 'demo') + '.txt', path, bytes }
  }

  async disconnect () { this.consoleId = null; machine.clients.delete(this); broadcast() }
  async close () { if (this.consoleId) this.kill(this.consoleId); await this.disconnect() }
}

export const DEMO_MACHINE = { sub: 'demo-machine', label: 'TerminalLocal' }
