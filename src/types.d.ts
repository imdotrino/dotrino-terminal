// Las formas de datos de la PWA. Solo tipos: el código es JS con JSDoc.
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

/** Quién mira una consola (agent/index.js). */
export interface Watcher { origin: 'local' | 'remote' | (string & {}), device?: string | null, tag?: string }

/** Una consola, como la cuenta el agente (`list`, `meta`, `attached`). */
export interface ConsoleInfo {
  id: string
  /** Número fijo (agente ≥ 0.12). */
  n?: number
  title: string
  cwd?: string | null
  /** `usuario@máquina` (agente ≥ 0.24). */
  host?: string | null
  note?: string
  task?: string
  origin?: string
  cols: number
  rows: number
  activity?: 'busy' | 'idle' | (string & {})
  doneAt?: number | null
  /** Quién puso el tamaño. */
  sizeBy?: { origin: string, device: string | null, tag: string } | null
  viewers?: number
  watchers?: Watcher[]
  lastActive?: number
}

/** Lo que contesta `open`/`attach`. */
export interface Attached { id: string, console: ConsoleInfo }

/** Un error del agente: se decide por el código. */
export interface AgentError extends Error { code?: string, retryMs?: number, reason?: string }

/** Una pestaña conectada a una máquina: `AgentClient`, o `DemoAgentClient` en `/consoles?demo`. */
export interface Agent {
  consoleId: string | null
  rc: { key?: unknown }
  onData: (data: string) => void
  onExit: (code: number, why: { closedBy: string | null, id: string | null }) => void
  onError: (e: AgentError) => void
  onResumed: () => void
  onMeta: (info: ConsoleInfo) => void
  askCode: (info: { wrong: AgentError | null }) => Promise<string | null>
  connect (): Promise<unknown>
  list (): Promise<ConsoleInfo[]>
  open (cols: number, rows: number): Promise<Attached>
  attach (id: string, cols: number, rows: number, opts?: { keep?: boolean }): Promise<Attached>
  input (data: string): unknown
  resize (cols: number, rows: number): unknown
  take (): unknown
  kill (id: string): unknown
  note (id: string, patch?: { text?: string, task?: string }): Promise<ConsoleInfo>
  move (id: string, before?: string | null): Promise<ConsoleInfo[]>
  sendImage (bytes: Uint8Array, opts?: { onProgress?: (sent: number, total: number) => void }): Promise<string>
  fetchFile (path: string, opts?: { onProgress?: (got: number, total: number) => void }): Promise<{ name: string, path: string, bytes: Uint8Array<ArrayBuffer> }>
  disconnect (): Promise<void>
  close (): Promise<void>
}

/** Un enlace o una ruta de una línea de la consola (links.js). */
export interface FoundLink { start: number, end: number, text: string, kind: 'url' | 'path', target: string }

/** El reparto de una pestaña en paneles (layout.js). */
export type Layout<P> = { pane: P } | { dir: 'row' | 'col', ratio: number, a: Layout<P>, b: Layout<P> }
/** Lo mismo, guardado: los `consoleId` en las hojas. */
export type SavedLayout = string | null | { dir: 'row' | 'col', ratio: number, a: SavedLayout, b: SavedLayout }

/** Un panel de una pestaña: su xterm, su conexión y su panel de consolas. */
export interface Pane {
  id: number
  s: Session
  collapsed: boolean
  el: HTMLElement
  view: HTMLElement
  about: HTMLElement
  side: HTMLElement
  arrow: HTMLElement
  /** Desde `connectPane`. */
  agent?: Agent
  /** Desde `mountTerm`. */
  term?: Terminal
  fit?: FitAddon
  meta?: ConsoleInfo
  /** La consola cuya nota se está editando. */
  editing?: string | null
  hoverLink?: FoundLink | null
  sending?: boolean
  resizeObs?: ResizeObserver
  onResize?: () => void
  drag?: { id: string, y: number, pointer: number, on: boolean, over: string | null } | null
  dragged?: boolean
}

/** Una pestaña: una máquina con uno o varios paneles. */
export interface Session {
  id: number
  pub: string
  alias: string
  status: string
  list: ConsoleInfo[]
  panes: Pane[]
  focus: Pane | null
  layout: Layout<Pane>
  box: HTMLElement
  panesEl: HTMLElement
  tab: HTMLElement
  poll?: ReturnType<typeof setInterval>
  /** Los del panel con el foco. */
  readonly agent?: Agent
  readonly term?: Terminal
  readonly fit?: FitAddon
  readonly view?: HTMLElement
}

/** Una pestaña recordada en sessionStorage. */
export interface SavedTab { sub: string, alias: string, consoleId: string, layout: SavedLayout }

/** El enlace de este aparato con su bóveda: externa, la propia (self) o la de muestra. */
export type TerminalLink =
  | import('@dotrino/remote-agent/browser-link').BrowserLink & { mode?: undefined }
  /** No se pudo preguntar al pilar de identidad: se trata como no enlazado. */
  | { mode?: undefined, paired: false, id?: undefined }
  | { mode: 'self', id: import('@dotrino/identity').Identity, paired?: boolean, iss?: string, proxy?: string, cert?: object | null, getSelfCert?: () => Promise<object> }
  | { mode: 'demo', paired: true, id?: undefined, proxy?: undefined, deviceId?: undefined }
