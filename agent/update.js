/**
 * update.js — este agente SE ACTUALIZA SOLO (CONVENCIONES §15, dueño 2026-10-08).
 *
 * Lo que mira, verifica e instala es `@dotrino/update/npm`; a quién se pregunta y a quién se
 * avisa es `@dotrino/vault/service`. Aquí solo se juntan las dos piezas con lo que es propio
 * de este agente: dónde vive su enlace y cuándo puede reiniciarse.
 *
 * Los dos ajustes son de CADA agente (`dotrino-terminal-agent update --approval|--notify`),
 * no de la bóveda: por defecto se actualiza sin preguntar y avisa de que lo hizo.
 *
 * REINICIAR MATA LAS CONSOLAS (viven en este proceso, `consoles.js`), así que la versión
 * nueva se instala en cuanto sale pero el agente solo se va cuando no queda ninguna consola
 * abierta. Tumbarle a alguien la shell en la que está trabajando para estrenar una versión
 * es justo lo contrario de lo que se quiere.
 */
import { watchSelfUpdateNpm } from '@dotrino/update/npm'
import { vaultUpdateHooks } from '@dotrino/vault/service'
import { loadLink } from './link.js'

export const PKG = '@dotrino/terminal-agent'
export const REPO = 'imdotrino/dotrino-terminal'
/** Este repo también lleva la PWA y el escritorio: las releases del agente van con prefijo. */
export const releaseTag = (version) => `agent-v${version}`

/** Cada cuánto se mira si ya no quedan consolas para reiniciar con la versión instalada. */
export const IDLE_CHECK_MS = 60_000

const fail = (code, message) => Object.assign(new Error(message), { code })

/**
 * Lo que este agente le dice a SU bóveda sobre actualizarse: los tres ganchos de
 * `vaultUpdateHooks` (`@dotrino/vault/service`), armados EN CADA LLAMADA con el enlace leído
 * del disco. El papel se renueva mientras el agente corre, y el agente puede arrancar sin
 * enlace y enlazarse después: una conexión fijada al arrancar se quedaría vieja.
 *
 * @param {{ dir: string, product?: string, log?: (m: string) => void, load?: (dir: string) => any, make?: (o: any) => any }} o
 * @returns {{ mayUpdate: Function, onUpdated: Function, onNeedsRoot: Function }}
 */
export function vaultHooks ({ dir, product = PKG, log = console.log, load = loadLink, make = vaultUpdateHooks }) {
  const now = () => {
    const link = load(dir)
    if (!link?.device || !link.cert || !link.iss) return null
    return make({ product, log, proxyUrl: link.proxy || 'wss://proxy.dotrino.com', masterPubkey: link.iss, device: link.device, cert: link.cert })
  }
  return {
    // true = sí · false = no, o pasó el día sin respuesta · lanza = no se pudo preguntar.
    async mayUpdate (u) {
      const h = now()
      // Sin enlace no hay a quién preguntar. No es un «no»: se dice y se reintenta.
      if (!h) throw fail('not-linked', 'this agent is not linked to a vault, so there is nobody to ask')
      return h.mayUpdate(u)
    },
    // Sin enlace no hay bóveda a la que contárselo: no es un fallo que reintentar.
    async onUpdated (u) { await now()?.onUpdated(u) },
    async onNeedsRoot (u) { await now()?.onNeedsRoot(u) }
  }
}

/**
 * Enciende la autoactualización del agente que ya corre.
 *
 * `dir` es la carpeta de datos de ESTA instancia (su enlace y sus ajustes) y `version` la
 * que está en marcha. Lo demás es para las pruebas.
 *
 * @param { dir: string, version: string, agent: { consoles: { consoles: Map<string, unknown> }, close: () => void }, exit?: (code: number) => void,
 *   log?: (m: string) => void, watch?: (o: any) => (() => void), hooks?: object, idleCheckMs?: number } o
 * @returns {() => void} para dejar de mirar
 */
export function startSelfUpdate ({ dir, version, agent, exit = (code) => process.exit(code), log = console.log, watch = watchSelfUpdateNpm, hooks = vaultHooks({ dir, log }), idleCheckMs = IDLE_CHECK_MS }) {
  let waiting = null
  const open = () => agent.consoles.consoles.size
  const restart = (v) => {
    log(`[terminal-agent] restarting to run ${v}`)
    agent.close()
    exit(0)
  }
  const stop = watch({
    pkg: PKG,
    current: version,
    repo: REPO,
    tag: releaseTag,
    dir,
    ...hooks,
    onInstalled: ({ version: v, restart: supervised }) => {
      // Sin quien lo levante no se va: irse sería apagarle el servicio al usuario.
      if (!supervised) return
      if (!open()) return restart(v)
      if (waiting) return
      log(`[terminal-agent] ${v} is installed · ${open()} console(s) open, so it restarts when none is left`)
      waiting = setInterval(() => { if (!open()) { clearInterval(waiting); waiting = null; restart(v) } }, idleCheckMs)
      waiting.unref?.()
    },
    log
  })
  return () => { if (waiting) { clearInterval(waiting); waiting = null } stop?.() }
}

export default { startSelfUpdate, vaultHooks, PKG, REPO, releaseTag }
