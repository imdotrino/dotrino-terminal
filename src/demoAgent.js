/**
 * demoAgent.js — un agente de MUESTRA en el navegador (`/consoles?demo`), sin red ni perfil: el
 * mismo papel que `DemoConsolesActivity` (Android) y `DemoAgent` (iOS). Sirve para mirar y probar
 * la pantalla de consolas (panel, split, tamaño) con Playwright. Habla lo mismo que `AgentClient`.
 *
 * La máquina tiene tres consolas: 1 libre, 2 mirada por una ventana de la máquina que ELIGIÓ su
 * tamaño (120×40), 3 con una ruta larga de título. Cada cliente es un «viewer» más.
 */

const machine = {
  next: 4,
  consoles: [
    mk('c1', 1, '✳ Sefjr improvement', '/mnt/sda1/Dotrino/dotrino-terminal/android/app/src/main', 80, 24),
    mk('c2', 2, 'seyacat@loca: ~/proyectos/dotrino', '~/proyectos/dotrino', 120, 40, { window: true }),
    mk('c3', 3, 'seyacat@loca: /mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor', '/mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor', 80, 24),
  ],
  clients: new Set(),
}

function mk (id, n, title, cwd, cols, rows, { window = false } = {}) {
  return { id, n, title, cwd, cols, rows, window, pinnedBy: window ? 'window' : null, lines: [] }
}

function info (c) {
  const watchers = []
  if (c.window) watchers.push({ origin: 'local', tag: 'desktop-1' })
  for (const k of machine.clients) if (k.consoleId === c.id) watchers.push({ origin: 'remote', device: 'demo-phone', tag: `pane-${k.n}` })
  const sizeBy = c.pinnedBy === 'window' ? { origin: 'local', device: null, tag: 'desktop-1', pinned: true }
    : c.holder ? { origin: 'remote', device: 'demo-phone', tag: c.holder, pinned: c.pinnedBy === c.holder } : null
  return { id: c.id, n: c.n, title: c.title, cwd: c.cwd, host: 'seyacat@loca', origin: 'local', cols: c.cols, rows: c.rows, activity: c.n === 2 ? 'busy' : 'idle', doneAt: c.n === 3 ? Date.now() : null, sizeBy, viewers: watchers.length, watchers, lastActive: Date.now() }
}

const list = () => machine.consoles.map(info)
const broadcast = () => { for (const k of machine.clients) { k._list(); if (k.consoleId) { const c = machine.consoles.find((x) => x.id === k.consoleId); if (c) k.onMeta(info(c)) } } }

let nextClient = 0

export class DemoAgentClient {
  constructor () {
    this.n = ++nextClient
    this.consoleId = null
    this.onData = () => {}; this.onExit = () => {}; this.onError = () => {}; this.onResumed = () => {}; this.onMeta = () => {}
    this.askCode = async () => null
    this.rc = { key: 'demo' }
  }

  async connect () { machine.clients.add(this) }
  _list () {}
  async list () { return list() }

  _screen (c) {
    this.onData(`\x1b[2J\x1b[H\x1b[32mseyacat@loca\x1b[0m:\x1b[34m${c.cwd}\x1b[0m$ ls\r\n\x1b[34msrc  docs\x1b[0m  run.sh  README.md\r\nConsola ${c.n} · ${c.cols}×${c.rows}\r\n$ `)
  }

  _size (c, cols, rows) {
    if (c.pinnedBy === 'window') return
    c.holder = `pane-${this.n}`
    if (c.cols !== cols || c.rows !== rows) { c.cols = cols; c.rows = rows }
  }

  async open (cols, rows) {
    const c = mk(`c${machine.next}`, machine.next++, 'seyacat@loca: ~', '~', cols, rows)
    machine.consoles.push(c)
    return this.attach(c.id, cols, rows)
  }

  async attach (id, cols, rows) {
    const c = machine.consoles.find((x) => x.id === id)
    if (!c) { const e = new Error('that console no longer exists'); e.code = 'no-console'; throw e }
    this.consoleId = c.id
    this._size(c, cols, rows)
    setTimeout(() => { this._screen(c); broadcast() }, 30)
    return { id: c.id, console: info(c) }
  }

  input (data) {
    const c = machine.consoles.find((x) => x.id === this.consoleId); if (!c) return
    for (const k of machine.clients) if (k.consoleId === c.id) k.onData(data.replace(/\r/g, '\r\n$ '))
  }

  resize (cols, rows) {
    const c = machine.consoles.find((x) => x.id === this.consoleId); if (!c) return
    this._size(c, cols, rows); broadcast()
  }

  pin (on) {
    const c = machine.consoles.find((x) => x.id === this.consoleId); if (!c || c.pinnedBy === 'window') return
    c.pinnedBy = on ? `pane-${this.n}` : null; c.holder = `pane-${this.n}`; broadcast()
  }

  kill (id) {
    const i = machine.consoles.findIndex((x) => x.id === id); if (i < 0) return
    machine.consoles.splice(i, 1)
    for (const k of machine.clients) if (k.consoleId === id) { k.consoleId = null; k.onExit(0, { closedBy: k === this ? null : 'other', id }) }
    broadcast()
  }

  async move (id, before = null) {
    const i = machine.consoles.findIndex((x) => x.id === id); if (i < 0) return list()
    const [c] = machine.consoles.splice(i, 1)
    const j = before ? machine.consoles.findIndex((x) => x.id === before) : -1
    if (j < 0) machine.consoles.push(c); else machine.consoles.splice(j, 0, c)
    broadcast()
    return list()
  }

  async disconnect () { this.consoleId = null; machine.clients.delete(this); broadcast() }
  async close () { if (this.consoleId) this.kill(this.consoleId); await this.disconnect() }
}

export const DEMO_MACHINE = { sub: 'demo-machine', label: 'TerminalLocal' }
