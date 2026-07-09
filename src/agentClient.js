/**
 * agentClient.js — habla con el agente (la máquina destino) por el proxy del
 * ecosistema (`@dotrino/proxy-client`). El agente es otro dispositivo enrolado en
 * el MISMO vault: lo direccionamos por SU pubkey (`agentPubkey`) y verificamos que
 * su `cert` encadena a la maestra que este dispositivo vio al enlazar. Ambas
 * puntas son peers certificados por el vault; ninguna tiene la clave maestra.
 *
 * La firma de este lado la hace el PILAR de identidad (`id.signData`, dentro del
 * iframe id.dotrino.com): la clave del dispositivo es la identidad del navegador
 * y su cert (`P ← maestra`) viene del emparejamiento estándar del ecosistema
 * (profile.dotrino.com/#vault). Nada de claves privadas en la app.
 *
 * Handshake: firmamos la autorización → el agente responde un ack firmado con SU
 * `D` + su `cert` → verificamos la cadena a la maestra pineada (anti-MITM del
 * relay) → levantamos el canal cifrado (ECDH → AES-GCM).
 */
import { verifyChain } from '@dotrino/identity/capabilities'
import { makeEphemeral, deriveKey, seal, open } from '../shared/e2e.js'

const T = { HS: 'terminal.hs', ACK: 'terminal.hs.ack', CMD: 'terminal.cmd', OUT: 'terminal.out', ERROR: 'terminal.error' }

export class AgentClient {
  /** @param {{ id:object, cert:object, iss:string, proxy?:string }} link enlace de vault.js */
  constructor (link, { agentPubkey, proxyUrl } = {}) {
    this.link = link                                  // { id, cert, iss, proxy }
    this.agentPubkey = agentPubkey                    // pubkey de la máquina destino
    this.proxyUrl = proxyUrl || link.proxy || 'wss://proxy.dotrino.com'
    this.client = null
    this.key = null
    this.sid = null
    this.onData = () => {}
    this.onError = () => {}
  }

  async _identify () {
    if (!this.client.token) return
    // Patrón estándar del ecosistema (messenger): identify firmado por id.signData
    // + cert del vault → el proxy enruta también lo dirigido a la maestra.
    const { id, cert } = this.link
    const publickey = id.me?.publickey
    if (!publickey) return
    const data = { op: 'identify', publickey, token: this.client.token, ts: Date.now() }
    const { signature } = await id.signData(data)
    await this.client.identify({ data, signature, cert })
  }

  async connect () {
    if (!this.agentPubkey) throw new Error('falta la dirección de la máquina destino')
    const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
    this.client = new WebSocketProxyClient({ url: this.proxyUrl, enableWebRTC: false, autoReconnect: true })
    await this.client.connect()
    await this._identify()
    this.client.on('token', () => { this._identify().catch(() => {}) })

    this.client.on('message', async (_from, p) => {
      if (!p || typeof p !== 'object') return
      if (p.type === T.OUT && p.sid === this.sid) {
        try { const m = await open(this.key, p.env); if (m.type === 'out') this.onData(m.data) } catch {}
      } else if (p.type === T.ERROR) this.onError(new Error(p.error))
    })

    const eph = await makeEphemeral()
    // `publickey` va DENTRO del dato firmado: verifyChain verifica la firma
    // contra data.publickey y exige cert.sub === data.publickey.
    const data = { op: 'terminal.hs', eph: eph.pub, publickey: this.link.id.me?.publickey, ts: Date.now() }
    const { signature } = await this.link.id.signData(data)

    const acked = new Promise((resolve, reject) => {
      const off = this.client.on('message', (_from, p) => {
        if (!p || typeof p !== 'object') return
        if (p.type === T.ACK) { off(); resolve(p) }
        else if (p.type === T.ERROR) { off(); reject(new Error(p.error)) }
      })
      setTimeout(() => { off(); reject(new Error('la máquina no respondió (¿está corriendo el agente allí?)')) }, 20000)
    })
    this.client.sendByPubkey(this.agentPubkey, { type: T.HS, data, signature, cert: this.link.cert })
    const res = await acked

    // El ack debe: (1) encadenar a NUESTRA maestra, (2) estar firmado por la
    // máquina que apuntamos, (3) atar nuestra pub efímera y el sid.
    const chk = await verifyChain({ data: res.ack, signature: res.signature, cert: res.cert, trustedIssuer: this.link.iss })
    if (!chk.ok) throw new Error('la máquina no está certificada por tu vault: ' + chk.reason)
    if (res.ack.machine !== this.agentPubkey) throw new Error('el ack vino de otra máquina')
    if (res.ack.ceph !== eph.pub || res.ack.sid !== res.sid) throw new Error('ack no corresponde a este handshake')

    this.sid = res.sid
    this.key = await deriveKey(eph.privateKey, res.ack.seph, res.sid)
    return this
  }

  async _cmd (msg) {
    const env = await seal(this.key, msg)
    this.client.sendByPubkey(this.agentPubkey, { type: T.CMD, sid: this.sid, env })
  }

  openShell (cols, rows) { return this._cmd({ type: 'open', cols, rows }) }
  input (data) { return this._cmd({ type: 'input', data }) }
  resize (cols, rows) { return this._cmd({ type: 'resize', cols, rows }) }
  async close () { try { await this._cmd({ type: 'close' }) } catch {}; try { this.client?.close() } catch {} }
}
