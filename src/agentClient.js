/**
 * agentClient.js — una pestaña conectada a una máquina, sobre `@dotrino/remote-agent`.
 *
 * El handshake contra el acta, el canal cifrado y el transporte los hace
 * `RemoteAgentClient`; aquí está la semántica de consolas (ver agent/index.js). Las
 * consolas viven en el agente: esta pestaña se ENGANCHA a una (nueva o existente) y al
 * irse la suelta. Solo `close()` la mata.
 */
import { RemoteAgentClient } from '@dotrino/remote-agent/client'

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
    /** @type {(code:number)=>void} */ this.onExit = () => {}
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
      if (p.type === 'out' || p.type === 'replay') { this.onData(p.data); return }
      if (p.type === 'exit') { this.consoleId = null; this.onExit(p.code); return }
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

  /** Abre una consola nueva y se engancha. Devuelve `{ id, console }`. */
  async open (cols, rows) {
    const p = await this._ask({ type: 'open', cols, rows }, 'attached')
    this.consoleId = p.id
    return p
  }

  /**
   * Se engancha a una consola existente (también para CAMBIAR de consola en la misma conexión:
   * el agente suelta la anterior). Su pantalla llega por `onData`. Lanza `no-console`.
   */
  async attach (id, cols, rows) {
    const p = await this._ask({ type: 'attach', id, cols, rows }, 'attached')
    this.consoleId = p.id
    return p
  }

  input (data) { return this.rc.send({ type: 'input', data }) }
  resize (cols, rows) { return this.rc.send({ type: 'resize', cols, rows }) }
  /** ⤢ Usar (o soltar) el tamaño de esta pantalla en la consola (agente ≥ 0.14). */
  pin (on) { return this.rc.send({ type: 'pin', on: !!on }) }
  kill (id) { return this.rc.send({ type: 'kill', id }) }

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
