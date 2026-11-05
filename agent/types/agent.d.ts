// Las formas de datos del agente. Solo tipos: el código es JS con JSDoc.

/** Quién mira una consola: una sesión (de una ventana de esta máquina o de otro aparato). */
export interface Viewer {
  onOut (data: string): void
  onExit (code: number, why?: { byOther: boolean }): void
  onMeta? (info: ConsoleInfo): void
  /** 'local' (una ventana de esta máquina) | 'remote' (otro aparato). Sin él, un mirón interno. */
  origin?: 'local' | 'remote'
  /** La pubkey del aparato, si es remoto. */
  device?: string | null
  /** La etiqueta con la que se presentó (la ventana de la app de escritorio). */
  tag?: string
  /** El tamaño de su pantalla. */
  size?: { cols: number, rows: number }
}

/** Lo que una consola cuenta de sí misma (`list`, `meta`, `attached`). */
export interface ConsoleInfo {
  id: string
  n: number
  activity: 'busy' | 'idle'
  doneAt: number | null
  sizeBy: { origin: string | null, device: string | null, tag: string | null } | null
  origin: string
  title: string
  shellTitle: string
  subject: string
  note: string
  task: string
  host: string | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  lastActive: number
  viewers: number
  watchers: { origin: string, device: string | null, tag: string | null }[]
}

/** Lo que se usa de un PTY (node-pty). */
export type Pty = import('node-pty').IPty

/**
 * Una sesión que atiende `serveSession`: la cifrada de otro aparato (`@dotrino/remote-agent`) o
 * la de una ventana de esta máquina (`local.js`, por el socket). Lo que llega por `message` viene
 * de fuera y se comprueba antes de usarlo, por eso va sin tipo.
 */
export interface SessionLike {
  device?: string | null
  send (payload: object): unknown
  on (ev: 'message', cb: (msg: any) => void): unknown
  on (ev: 'close', cb: () => void): unknown
  /** Solo en las remotas: ¿va ya por el canal directo? */
  direct? (): boolean
  /** Solo en las remotas: espera al canal directo, como mucho `ms`. */
  whenDirect? (ms?: number): Promise<boolean>
}
