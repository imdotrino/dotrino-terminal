/**
 * agentClient.js — una consola con una máquina, sobre `@dotrino/remote-agent`.
 *
 * El handshake contra el acta, el canal cifrado y el transporte los hace
 * `RemoteAgentClient`; aquí solo está la semántica de terminal (ver agent/index.js):
 *   cliente → agente: { type:'open'|'input'|'resize'|'close', ... }
 *   agente → cliente: { type:'out', data } · { type:'exit', code }
 */
import { RemoteAgentClient } from '@dotrino/remote-agent/client'

export class AgentClient {
  /**
   * @param {object} link  el enlace de este aparato (vault.js: getLink / getSelfLink).
   * @param {{ agentPubkey:string, proxyUrl?:string }} opts
   */
  constructor (link, { agentPubkey, proxyUrl }) {
    this.rc = new RemoteAgentClient(link, { agentPubkey, proxyUrl })
    /** @type {(data:string)=>void} */ this.onData = () => {}
    /** @type {(code:number)=>void} */ this.onExit = () => {}
    /** @type {(e:Error)=>void} */ this.onError = () => {}
  }

  async connect () {
    this.rc.on('message', (p) => {
      if (p?.type === 'out') this.onData(p.data)
      else if (p?.type === 'exit') this.onExit(p.code)
    })
    this.rc.on('error', (e) => this.onError(e))
    await this.rc.connect()
    return this
  }

  openShell (cols, rows) { return this.rc.send({ type: 'open', cols, rows }) }
  input (data) { return this.rc.send({ type: 'input', data }) }
  resize (cols, rows) { return this.rc.send({ type: 'resize', cols, rows }) }
  async close () {
    // Se avisa antes de cortar: así la shell muere ya, y no a los 30 min de inactividad.
    try { if (this.rc.key) await this.rc.send({ type: 'close' }) } catch (_) {}
    await this.rc.close()
  }
}
