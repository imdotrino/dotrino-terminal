/**
 * far.js — las consolas de las OTRAS máquinas de la cuenta, para las ventanas de esta.
 *
 * El navegador y el teléfono ya abren consolas de cualquier máquina; las ventanas de esta
 * (la app de escritorio, `dotrino-terminal`) solo veían las suyas. Aquí el agente de esta
 * máquina hace de CLIENTE de los otros agentes, con su propio enlace (`clientLink`): es un
 * aparato del acta y entra como cualquier otro, con lo que el acta le reconozca (`sign`) y
 * con la clave de la otra máquina si la tiene.
 *
 * Tres cosas, las tres por el socket local (ver `serveLocal` en index.js):
 *
 *   · `machines()` — qué máquinas hay encendidas y qué consolas tiene cada una. Se guarda y se
 *     refresca por detrás: quien pregunta no espera a la red más que la primera vez.
 *   · `via(session, machine)` — la ventana pasa a hablar con la OTRA máquina. Es un tubo: el
 *     protocolo es el mismo que el local (`serveSession`), así que el cliente no cambia.
 *   · `send(machine, msg)` — una orden suelta (cerrar, ordenar, la nota) sin abrir ventana.
 *
 * La clave de una máquina que la pide se recuerda SOLO en memoria, cuando una ventana la
 * escribió bien: así el panel puede seguir listando sus consolas sin volver a preguntarla.
 */
import { RemoteAgentClient } from '@dotrino/remote-agent/client'
import { clientLink } from '@dotrino/remote-agent/link'
import { listAgentsByLabel, probeAgents } from '@dotrino/remote-agent/discover'
import { keyLabel } from '@dotrino/identity/capabilities'

/** Lo más seguido que se vuelve a preguntar a las máquinas por sus consolas. */
export const REFRESH_MS = 3000
/** Cada cuánto se vuelve a mirar QUÉ máquinas hay (el acta y quién contesta). */
export const DISCOVER_MS = 30_000
/**
 * Cada cuánto se le pide el acta a la BÓVEDA. Entre medias vale la guardada, que el agente ya
 * refresca solo (`REVOKE_REFRESH_MS`, también 5 min). Pedirla en cada vuelta (30 s) era un
 * `vault.devices` a la cuenta cada 30 s mientras hubiera una ventana abierta, y eso no dejaba
 * dormirse a la bóveda de Lambda (2026-10-25).
 */
export const MEMBERS_MS = 5 * 60_000
/** Sin que nadie pregunte durante este rato, se sueltan las conexiones. */
export const IDLE_MS = 60_000
/** Lo que se espera la respuesta de una máquina antes de darla por apagada. */
export const ANSWER_MS = 8000

/** @type {(code: string, message: string) => Error & { code: string }} */
const fail = (code, message) => Object.assign(new Error(message), { code })

/** @typedef {import('./types/agent.js').SessionLike} SessionLike */
/** @typedef {import('./types/agent.js').ConsoleInfo} ConsoleInfo */
/** Una máquina de la cuenta con agente de terminal encendido. */
/** @typedef {{ sub: string, id: string, name: string }} Found */
/**
 * Lo que se sabe de una máquina: su conexión de control (si está abierta), sus consolas, si
 * pide clave y el último fallo.
 * @typedef {Found & { rc: RemoteAgentClient | null, consoles: ConsoleInfo[] | null, locked: boolean, error: { code: string, message: string } | null }} Machine
 */
/** @typedef {{ probe: import('@dotrino/proxy-client').WebSocketProxyClient | null, askedVaultAt?: number }} DiscoverState */

/** `AB12-CD34`, como sale en `dotrino-vault members`. */
export const shortId = keyLabel

/**
 * Las máquinas con agente de terminal encendido, con el transporte de verdad.
 * @param {{ link: DotrinoDeviceLink, dir: string, kind: string, state: DiscoverState }} o
 * @returns {Promise<Found[]>}
 */
async function discoverReal ({ link, dir, kind, state }) {
  const cl = clientLink(link, { dir })
  const fresh = !state.askedVaultAt || Date.now() - state.askedVaultAt >= MEMBERS_MS
  const members = await listAgentsByLabel(cl.id, undefined, { fresh })
  if (fresh) state.askedVaultAt = Date.now()
  if (!members.length) return []
  if (!state.probe) {
    const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
    state.probe = new WebSocketProxyClient({ url: cl.proxy, enableWebRTC: false, autoReconnect: true })
    await state.probe.connect()
  }
  const found = await probeAgents(state.probe, members.map((m) => m.sub))
  /** @type {Found[]} */
  const out = []
  for (const m of members) {
    if (found.get(m.sub)?.kind !== kind) continue
    out.push({ sub: m.sub, id: await shortId(m.sub), name: m.label || '' })
  }
  return out
}

/**
 * Una sesión con el agente de otra máquina.
 * @param {{ link: DotrinoDeviceLink, dir: string, sub: string, loadLink?: () => DotrinoDeviceLink | null }} o
 * @returns {Promise<RemoteAgentClient>}
 */
async function connectReal ({ link, dir, sub, loadLink }) {
  // EL ACTA DE CONFIANZA DE ESTE AGENTE, leída del disco en cada saludo: la mantiene al día su
  // lado de agente (cada 5 min y con los avisos de la bóveda). Sin ella el cliente le pedía el
  // acta a la bóveda en cada conexión, y la ventana esperaba 4-17 s a pedir la clave de otra
  // máquina (2026-11-04). Si con ella no pasa, el cliente sí pregunta a la bóveda.
  const trustedActa = () => {
    const l = loadLink?.() || link
    return l?.actaTrusted === true && l.acta ? /** @type {object} */ (l.acta) : null
  }
  const rc = new RemoteAgentClient(clientLink(link, { dir }), { agentPubkey: sub, trustedActa })
  await rc.connect()
  return rc
}

/**
 * @param {object} opts
 * @param {string} opts.dir                 la carpeta del enlace de este agente.
 * @param {() => DotrinoDeviceLink|null} opts.loadLink el enlace, leído cada vez (puede aparecer después).
 * @param {string} opts.kind                el tipo de agente que se busca (`terminal-agent`).
 * @param {typeof discoverReal} [opts.discover]  para las pruebas.
 * @param {typeof connectReal} [opts.connect]    para las pruebas.
 * @param {number} [opts.refreshMs]
 * @param {number} [opts.discoverMs]
 * @param {number} [opts.idleMs]
 * @param {number} [opts.answerMs]
 * @param {(line: string) => void} [opts.log]
 */
export function makeFar ({ dir, loadLink, kind, discover = discoverReal, connect = connectReal, refreshMs = REFRESH_MS, discoverMs = DISCOVER_MS, idleMs = IDLE_MS, answerMs = ANSWER_MS, log = (line) => console.error(line) }) {
  /** sub → { sub, id, name, rc, consoles, locked, error } */
  /** @type {Map<string, Machine>} */
  const machines = new Map()
  /** sub → la clave que una ventana escribió bien (solo en memoria). */
  /** @type {Map<string, string>} */
  const codes = new Map()
  /** @type {DiscoverState} */
  const state = { probe: null }
  let discoveredAt = 0
  let refreshedAt = 0
  /** @type {Promise<void> | null} */
  let refreshing = null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idle
  let closed = false

  /**
   * LO QUE FALLA QUEDA ESCRITO, CON SU HORA. Sin esto, «no se pudo preguntar a tu bóveda» salía
   * en la ventana y en `agent.log` no quedaba nada: ni cuándo, ni cuánto tardó, ni por qué
   * (2026-11-04, dos minutos de Terminal sin conectar que no se pudieron explicar). Se escribe
   * solo al CAMBIAR (falla, cambia de motivo o se recupera): el refresco va cada pocos segundos
   * y una línea por vuelta ahogaría el log.
   */
  /** @type {Map<string, string>} */
  const lastError = new Map()
  /**
   * @param {string} what
   * @param {{ code?: string, message?: string } | null | unknown} failure
   * @param {number} [ms]
   */
  function report (what, failure, ms) {
    const err = /** @type {{ code?: string, message?: string } | null} */ (failure)
    const code = err ? (err.code || 'error') : null
    if ((lastError.get(what) ?? null) === code) return
    const took = typeof ms === 'number' ? ` after ${ms} ms` : ''
    if (code) log(`[far] ${new Date().toISOString()} ${what}: ${code}${took} · ${err?.message || ''}`)
    else log(`[far] ${new Date().toISOString()} ${what}: ok again${took}`)
    if (code) lastError.set(what, code); else lastError.delete(what)
  }

  const link = () => {
    const l = loadLink()
    if (!l) throw fail('not-linked', 'this machine is not linked to a vault, so it cannot see your other machines')
    return l
  }

  /**
   * Una pregunta por la conexión de control de una máquina, y su respuesta (o `fail`).
   * @param {RemoteAgentClient} rc
   * @param {object} msg
   * @param {string} type
   * @returns {Promise<any>} la respuesta de la máquina (`type` o `fail`)
   */
  function ask (rc, msg, type) {
    return new Promise((resolve, reject) => {
      const off = rc.on('message', (m) => { if (m?.type === type || m?.type === 'fail') { done(); resolve(m) } })
      const offErr = rc.on('error', (e) => { done(); reject(e) })
      const timer = setTimeout(() => { done(); reject(fail('no-answer', 'that machine did not answer')) }, answerMs)
      const done = () => { off(); offErr(); clearTimeout(timer) }
      rc.send(msg).catch((e) => { done(); reject(e) })
    })
  }

  /** @param {Machine} m */
  function drop (m) {
    try { m.rc?.close() } catch (_) {}
    m.rc = null
  }

  /**
   * Las consolas de una máquina, abriendo su conexión de control si hace falta.
   * @param {Machine} m
   */
  async function readOne (m) {
    const t0 = Date.now()
    try {
      if (!m.rc) m.rc = await connect({ link: link(), dir, sub: m.sub, loadLink })
      let r = await ask(m.rc, { type: 'list' }, 'consoles')
      if (r.type === 'fail' && r.code === 'locked' && codes.has(m.sub)) {
        const u = await ask(m.rc, { type: 'unlock', code: codes.get(m.sub) }, 'unlocked')
        // La clave cambió: la guardada ya no vale, se olvida y vuelve a pedirse en una ventana.
        if (u.type === 'fail') codes.delete(m.sub)
        else r = await ask(m.rc, { type: 'list' }, 'consoles')
      }
      if (r.type === 'fail') {
        m.locked = r.code === 'locked'
        m.consoles = null
        m.error = m.locked ? null : { code: r.code, message: r.message }
        report(`machine ${m.id}`, m.error, Date.now() - t0)
        return
      }
      m.locked = false; m.error = null; m.consoles = r.list
      report(`machine ${m.id}`, null, Date.now() - t0)
    } catch (e) {
      // No contestó o la sesión cayó: la conexión se suelta y la próxima pasada abre otra.
      drop(m)
      m.consoles = null; m.locked = false
      m.error = { code: /** @type {Thrown} */ (e).code || 'unreachable', message: /** @type {Thrown} */ (e).message }
      report(`machine ${m.id}`, m.error, Date.now() - t0)
    }
  }

  async function refresh () {
    const now = Date.now()
    if (now - discoveredAt >= discoverMs || !discoveredAt) {
      const t0 = Date.now()
      let found
      try { found = await discover({ link: link(), dir, kind, state }) } catch (e) {
        report('vault (list of machines)', e, Date.now() - t0)
        throw e
      }
      report('vault (list of machines)', null, Date.now() - t0)
      discoveredAt = Date.now()
      const alive = new Set(found.map((f) => f.sub))
      for (const [sub, m] of machines) if (!alive.has(sub)) { drop(m); machines.delete(sub) }
      for (const f of found) {
        const m = machines.get(f.sub)
        if (m) { m.id = f.id; m.name = f.name } else machines.set(f.sub, { ...f, rc: null, consoles: null, locked: false, error: null })
      }
    }
    await Promise.all([...machines.values()].map(readOne))
    refreshedAt = Date.now()
  }

  function touch () {
    clearTimeout(idle)
    idle = setTimeout(release, idleMs)
    idle.unref?.()
  }

  /**
   * Nadie pregunta: se sueltan las conexiones. La lista se olvida para no enseñar algo viejo, y
   * las claves también: desconectado es desconectado, y la próxima vez se vuelven a escribir.
   */
  function release () {
    for (const m of machines.values()) drop(m)
    machines.clear()
    codes.clear()
    try { state.probe?.close() } catch (_) {}
    state.probe = null
    discoveredAt = 0; refreshedAt = 0
  }

  const snapshot = () => [...machines.values()].map((m) => ({
    sub: m.sub, id: m.id, name: m.name, locked: m.locked, ...(m.error ? { error: m.error } : {}), consoles: m.consoles
  }))

  function startRefresh () {
    if (!refreshing) refreshing = refresh().finally(() => { refreshing = null })
    return refreshing
  }

  /**
   * Las otras máquinas y sus consolas. La primera vez espera a la red; después contesta con
   * lo guardado y refresca por detrás (un fallo ahí se ve en la siguiente respuesta).
   */
  async function list () {
    if (closed) throw fail('closed', 'the agent is stopping')
    link()
    touch()
    if (!refreshedAt) await startRefresh()
    else if (Date.now() - refreshedAt >= refreshMs) startRefresh().catch(() => {})
    return snapshot()
  }

  /**
   * La máquina que se nombró: por su llave, por su id (`AB12-CD34`) o por su nombre.
   * @param {unknown} ref
   * @returns {Promise<Machine>}
   */
  async function resolve (ref) {
    const want = String(ref || '').trim()
    if (!want) throw fail('no-machine', 'which machine?')
    const find = () => {
      const all = [...machines.values()]
      const low = want.toLowerCase()
      const hits = all.filter((m) => m.sub === want || m.id.toLowerCase() === low || m.id.replace('-', '').toLowerCase() === low.replace('-', '') || (m.name && m.name.toLowerCase() === low))
      if (hits.length > 1) throw fail('ambiguous-machine', `more than one machine is called "${want}": use its id`)
      return hits[0] || null
    }
    let m = find()
    if (!m) { touch(); discoveredAt = 0; await startRefresh(); m = find() }
    if (!m) throw fail('no-machine', `no machine "${want}" is on with a terminal agent`)
    return m
  }

  /**
   * La ventana pasa a hablar con otra máquina: todo lo que mande va allí y todo lo que venga
   * de allí vuelve, tal cual. Contesta `{ type:'via', machine }` cuando el tubo está puesto.
   * @param {SessionLike} session
   * @param {unknown} ref
   */
  async function via (session, ref) {
    /** @type {object[]} */
    const queue = []
    /** @type {RemoteAgentClient | null} */
    let rc = null
    let gone = false
    /** @type {string | null} */
    let typed = null                   // la clave que se acaba de mandar, hasta saber si valió
    // La ventana se cerró. Antes de cortar se SUELTA la consola: la otra máquina no ve caer
    // esta conexión hasta que se le agota la espera, y mientras tanto la consola seguía
    // saliendo «abierta desde otro aparato» sin nadie mirándola.
    const bye = () => {
      gone = true
      const conn = rc
      if (!conn) return
      const end = () => { try { conn.close() } catch (_) {} }
      conn.send({ type: 'detach' }).then(end, end)
    }
    session.on('close', bye)
    /** @param {any} msg  lo que manda la ventana, tal cual */
    const forward = (msg) => {
      if (msg?.type === 'unlock') typed = String(msg.code ?? '')
      // Solo se reenvía con la conexión abierta: antes, los mensajes esperan en `queue`.
      if (!rc) throw new Error('far: forwarding before the connection is up')
      rc.send(msg).catch((/** @type {Thrown} */ e) => session.send({ type: 'fail', code: e.code || 'far-send', message: e.message }))
    }
    session.on('message', (msg) => { if (rc) forward(msg); else queue.push(msg) })
    /** @type {Machine} */
    let m
    /** @type {RemoteAgentClient} */
    let conn
    try {
      m = await resolve(ref)
      rc = conn = await connect({ link: link(), dir, sub: m.sub, loadLink })
    } catch (e) {
      session.send({ type: 'fail', code: /** @type {Thrown} */ (e).code || 'unreachable', message: /** @type {Thrown} */ (e).message })
      return
    }
    if (gone) { try { conn.close() } catch (_) {} return }
    /** @type {string | null} */
    let attached = null                // la consola que mira la ventana allí
    conn.on('message', (p) => {
      if (p?.type === 'attached') attached = p.id
      if (p?.type === 'unlocked' && typed != null) { codes.set(m.sub, typed); typed = null }
      if (p?.type === 'fail' && (p.code === 'bad-code' || p.code === 'wait')) typed = null
      session.send(p)
    })
    conn.on('error', (e) => session.send({ type: 'fail', code: e.code || 'far-error', message: e.message }))
    // LA SESIÓN CON LA OTRA MÁQUINA SE PERDIÓ y se abrió otra: o la máquina se reinició, o la
    // sesión venció (una hora sin mensajes, SESSION_IDLE_MS: una consola quieta; la otra máquina
    // lo avisa en el momento, remote-agent ≥ 0.27). Se pregunta a la sesión nueva:
    // - pide la clave: DESCONECTADA. La clave guardada se olvida y el panel suelta su conexión,
    //   así deja de enseñar sus consolas y vuelve a salir «Escribir la clave» (dueño,
    //   2026-10-27). Antes el panel la reenviaba solo y las consolas seguían a la vista.
    // - la consola de la ventana sigue allí: solo venció la sesión, la ventana se vuelve a enganchar.
    // - no está: la máquina se reinició y sus consolas ya no existen. Se dice; no se inventa otra.
    conn.on('resumed', () => {
      ask(conn, { type: 'list' }, 'consoles').then((r) => {
        if (r.type === 'fail' && r.code === 'locked') {
          codes.delete(m.sub)
          const panel = machines.get(m.sub)
          if (panel) { drop(panel); panel.consoles = null; panel.locked = true; panel.error = null }
          session.send({ type: 'fail', code: 'locked-again', message: 'that machine asks for its code again' })
        } else if (r.type === 'consoles' && attached && r.list.some((/** @type {ConsoleInfo} */ c) => c.id === attached)) {
          session.send({ type: 'fail', code: 'session-resumed', message: 'the session with that machine was renewed' })
        } else {
          session.send({ type: 'fail', code: 'machine-restarted', message: 'that machine restarted: its consoles are gone' })
        }
      }, (/** @type {Thrown} */ e) => session.send({ type: 'fail', code: e.code || 'unreachable', message: e.message }))
    })
    session.send({ type: 'via', machine: { sub: m.sub, id: m.id, name: m.name } })
    for (const msg of queue.splice(0)) forward(msg)
  }

  /**
   * Una orden suelta a otra máquina (cerrar una consola, moverla, su nota), sin ventana.
   * @param {unknown} ref
   * @param {object} msg
   */
  async function send (ref, msg) {
    const m = await resolve(ref)
    if (!m.rc) await readOne(m)
    if (!m.rc) throw fail(m.error?.code || 'unreachable', m.error?.message || 'that machine did not answer')
    await m.rc.send(msg)
    // Lo que cambió se ve en la próxima lectura, sin esperar al refresco normal.
    refreshedAt = 1
  }

  /** Las máquinas que ya se conocen, sin preguntar a la red (para nombrarlas en un informe). */
  const known = () => [...machines.values()].map((m) => ({ sub: m.sub, id: m.id, name: m.name }))

  return {
    list, via, send, known,
    close: () => { closed = true; clearTimeout(idle); release() }
  }
}

export default { makeFar }
