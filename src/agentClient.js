/**
 * agentClient.js — una pestaña conectada a una máquina, sobre `@dotrino/remote-agent`.
 *
 * El handshake contra el acta, el canal cifrado y el transporte los hace
 * `RemoteAgentClient`; aquí está la semántica de consolas (ver agent/index.js). Las
 * consolas viven en el agente: esta pestaña se ENGANCHA a una (nueva o existente) y al
 * irse la suelta. Solo `close()` la mata.
 */
import { RemoteAgentClient } from '@dotrino/remote-agent/client'

/** Lo que pesa cada trozo de una imagen antes de pasarlo a base64 (el proxio corta a 1 MB). */
export const FILE_CHUNK = 96 * 1024

/** base64 de unos bytes, sin pasar por una cadena gigante de una vez. */
export function toBase64 (bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Error con `code` del agente (`no-console`…): se comprueba por el código, no por la frase. */
const agentError = (p) => Object.assign(new Error(p.message || p.code), { code: p.code, ...(p.retryMs ? { retryMs: p.retryMs } : {}) })

/**
 * La clave de cada máquina que la pide (agente ≥ 0.19, `dotrino-terminal lock`), por la llave
 * de la máquina. SOLO en memoria: vale para las pestañas de esta página y se va al recargar.
 */
const CODES = new Map()

export class AgentClient {
  /**
   * @param {object} link  el enlace de este aparato (vault.js: getLink / getSelfLink).
   * @param {{ agentPubkey:string, proxyUrl?:string }} opts
   */
  constructor (link, { agentPubkey, proxyUrl }) {
    this.rc = new RemoteAgentClient(link, { agentPubkey, proxyUrl })
    this.consoleId = null
    /** @type {(data:string)=>void} */ this.onData = () => {}
    /** @type {(code:number, why:{ closedBy:string|null, id:string|null })=>void} */ this.onExit = () => {}
    /** @type {(e:Error)=>void} */ this.onError = () => {}
    /** La máquina se reinició y la sesión se volvió a abrir sola: hay que volver a engancharse. */
    /** @type {()=>void} */ this.onResumed = () => {}
    /** La consola enganchada cambió (quién mira, título, TAMAÑO): `info` como en `list`. */
    /** @type {(info:object)=>void} */ this.onMeta = () => {}
    /**
     * La máquina pide su clave. Devuelve lo tecleado, o null si la persona lo deja. `wrong` trae
     * el fallo del intento anterior (`bad-code`, o `wait` con `retryMs`).
     * @type {(info:{ wrong: (Error & { code?:string, retryMs?:number })|null }) => Promise<string|null>}
     */
    this.askCode = async () => null
    this._pub = agentPubkey
    this._unlocking = null
    this._waiting = null   // { type, resolve, reject }: la respuesta que se espera
    this._queue = Promise.resolve()   // las preguntas van de una en una (ver `_ask`)
  }

  async connect () {
    this.rc.on('message', (p) => {
      if (!p || typeof p !== 'object') return
      if (p.type === 'out' || p.type === 'replay') { if (this._wanted(p.id)) this.onData(p.data); return }
      if (p.type === 'exit') {
        // `closedBy: 'other'`: la cerró otra pantalla (no esta, ni la shell por su cuenta).
        const closed = this.consoleId
        this.consoleId = null
        this.onExit(p.code, { closedBy: p.closedBy || null, id: closed })
        return
      }
      if (p.type === 'meta') { if (p.console) this.onMeta(p.console); return }
      const w = this._waiting
      if (p.type === 'fail') {
        if (w) { this._waiting = null; w.reject(agentError(p)); return }
        // Le pusieron clave a la máquina con esta pestaña ya dentro: se pide, sin dar error.
        if (p.code === 'locked') { this._queue = this._queue.then(() => this._unlock()).catch((e) => this.onError(e)); return }
        this.onError(agentError(p))
        return
      }
      if (w && p.type === w.type) { this._waiting = null; w.resolve(p) }
    })
    this.rc.on('error', (e) => this.onError(e))
    // Lo que se esperaba de la sesión vieja ya no va a llegar: se suelta, y la app se vuelve a
    // enganchar (a su consola si sigue viva; si la máquina se reinició, ya no existe).
    this.rc.on('resumed', () => {
      const w = this._waiting
      if (w) { this._waiting = null; w.reject(Object.assign(new Error('the machine restarted'), { code: 'resumed' })) }
      this.onResumed()
    })
    await this.rc.connect()
    return this
  }

  /**
   * Manda `msg` y espera la respuesta de tipo `type`. EN COLA: el panel pregunta la lista cada
   * poco, y si eso pisara un `attach` en curso, el `attach` no recibiría nunca su respuesta.
   */
  _ask (msg, type, timeoutMs = 20000) {
    const run = async () => {
      try { return await this._askNow(msg, type, timeoutMs) } catch (e) {
        if (e.code !== 'locked') throw e
        await this._unlock()                       // la máquina pide su clave: se escribe y se repite
        return this._askNow(msg, type, timeoutMs)
      }
    }
    const p = this._queue.then(run, run)
    this._queue = p.catch(() => {})
    return p
  }

  _askNow (msg, type, timeoutMs) {
    return new Promise((resolve, reject) => {
      this._waiting = { type, resolve, reject }
      setTimeout(() => {
        if (this._waiting?.resolve !== resolve) return
        this._waiting = null
        reject(Object.assign(new Error('the machine did not answer'), { code: 'timeout' }))
      }, timeoutMs)
      this.rc.send(msg).catch(reject)
    })
  }

  /**
   * Escribe la clave de la máquina: la que ya se tecleó en esta página o, si no hay o ya no
   * vale, la que diga `askCode`. Insiste mientras la persona siga probando; si lo deja, lanza
   * `locked`. Una sola a la vez por pestaña.
   */
  _unlock () {
    if (this._unlocking) return this._unlocking
    this._unlocking = (async () => {
      let wrong = null
      for (;;) {
        let code = wrong ? null : CODES.get(this._pub)
        if (code == null) code = await this.askCode({ wrong })
        if (code == null) throw Object.assign(new Error('this machine asks for its code'), { code: 'locked' })
        try {
          await this._askNow({ type: 'unlock', code }, 'unlocked', 20000)
          CODES.set(this._pub, code)
          return
        } catch (e) {
          CODES.delete(this._pub)
          if (e.code !== 'bad-code' && e.code !== 'wait') throw e
          wrong = e
        }
      }
    })().finally(() => { this._unlocking = null })
    return this._unlocking
  }

  /** Las consolas vivas en la máquina: `[{ id, n, title, origin, cols, rows, viewers, watchers… }]`. */
  async list () { return (await this._ask({ type: 'list' }, 'consoles')).list }

  /** Abre una consola nueva y se engancha: toma el tamaño de esta pantalla. Devuelve `{ id, console }`. */
  async open (cols, rows) {
    this._left = this.consoleId; this._want = null
    const p = await this._ask({ type: 'open', cols, rows }, 'attached')
    this.consoleId = p.id; this._want = p.id; this._left = null
    return p
  }

  /**
   * ¿Es de la consola que se mira (o se pidió) lo que llega? Lo de la que se acaba de dejar
   * llega tarde a veces (su historial va en trozos) y, pintado, tapa la pantalla de la nueva.
   * Un agente viejo no pone `id`: eso pasa.
   */
  _wanted (id) {
    if (id == null) return true
    if (this._want != null) return id === this._want
    return id !== this._left
  }

  /**
   * Se engancha a una consola existente (también para CAMBIAR de consola en la misma conexión:
   * el agente suelta la anterior). Su pantalla llega por `onData`. Lanza `no-console`.
   * La consola toma el tamaño de esta pantalla, salvo con `keep`: volver a engancharse tras una
   * reconexión no es abrirla ni cambiarse a ella, y no toca el tamaño.
   */
  async attach (id, cols, rows, { keep = false } = {}) {
    this._left = this.consoleId !== id ? this.consoleId : null; this._want = id
    const p = await this._ask({ type: 'attach', id, cols, rows, ...(keep ? { keep: true } : {}) }, 'attached')
    this.consoleId = p.id; this._want = p.id; this._left = null
    return p
  }

  input (data) { return this.rc.send({ type: 'input', data }) }
  resize (cols, rows) { return this.rc.send({ type: 'resize', cols, rows }) }
  /** ⤢ La consola toma AHORA el tamaño de esta pantalla. No queda fijado (agente ≥ 0.35). */
  take () { return this.rc.send({ type: 'take' }) }
  kill (id) { return this.rc.send({ type: 'kill', id }) }
  /**
   * El orden del panel: `id` pasa justo antes de `before` (o al final, sin él). Es de la máquina:
   * lo ven igual las demás pantallas. Devuelve la lista ya ordenada (agente ≥ 0.26).
   */
  async move (id, before = null) { return (await this._ask({ type: 'move', id, before }, 'consoles', 5000)).list }

  /**
   * De qué va la consola `id`: `text` cambia la nota de la persona y `task` la tarea que puso el
   * programa (aquí solo se quita, con ''); sin ninguno, solo lee. Devuelve la consola, como en
   * `list` (agente ≥ 0.37; uno anterior a la 0.36 no contesta y esto lanza `timeout`).
   * @param {string} id
   * @param {{ text?: string, task?: string }} [patch]
   */
  async note (id, { text, task } = {}) {
    return (await this._ask({ type: 'note', id, ...(typeof text === 'string' ? { text } : {}), ...(typeof task === 'string' ? { task } : {}) }, 'noted', 5000)).console
  }

  /**
   * Manda una imagen a la máquina, que la guarda y dice DÓNDE quedó: esa ruta es lo que se
   * escribe en la consola. Va en trozos y cada uno espera su acuse (agente ≥ 0.43; uno anterior
   * no contesta y esto lanza `timeout`). Lanza también `not-image` y `too-big`.
   * @param {Uint8Array} bytes
   * @param {{ onProgress?: (sent:number, total:number)=>void }} [opts]
   * @returns {Promise<string>} la ruta en la máquina
   */
  async sendImage (bytes, { onProgress } = {}) {
    if (!bytes?.length) throw Object.assign(new Error('the image is empty'), { code: 'not-image' })
    const up = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('')
    for (let at = 0, seq = 0; ; seq++) {
      const end = Math.min(bytes.length, at + FILE_CHUNK)
      const last = end >= bytes.length
      // Cada trozo espera SU acuse: `filed` de otra subida o de otro trozo no cuenta.
      const p = await this._ask({ type: 'file', up, seq, data: toBase64(bytes.subarray(at, end)), ...(last ? { last: true } : {}) }, 'filed', 20000)
      if (p.up !== up || p.seq !== seq) throw Object.assign(new Error('the machine answered about another image'), { code: 'bad-file' })
      at = end
      onProgress?.(at, bytes.length)
      if (last) {
        if (typeof p.path !== 'string' || !p.path) throw Object.assign(new Error('the machine did not say where it kept the image'), { code: 'bad-file' })
        return p.path
      }
    }
  }

  /** Suelta la consola (sigue viva en la máquina) y corta la conexión. */
  async disconnect () {
    try { if (this.rc.key && this.consoleId) await this.rc.send({ type: 'detach' }) } catch (_) {}
    await this.rc.close()
  }

  /** Mata la consola enganchada y corta la conexión: es la × de la pestaña. */
  async close () {
    try { if (this.rc.key && this.consoleId) await this.rc.send({ type: 'close' }) } catch (_) {}
    await this.rc.close()
  }
}
