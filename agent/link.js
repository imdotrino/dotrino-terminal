/**
 * link.js — enrola ESTA máquina como un dispositivo del vault (mismo flujo
 * endurecido que usa el navegador / `dotrino-vault/src/client.js#enroll`). Es lo
 * que vuelve al agente INDEPENDIENTE de la máquina del vault: guarda su propia
 * sub-clave `D` + `cert` (cadena `D ← maestra`); la maestra NUNCA vive aquí, solo
 * su pública pineada (`iss`).
 *
 * Persistencia en un directorio propio (por defecto
 * `~/.local/share/dotrino-terminal-agent`, override `DOTRINO_TERMINAL_DIR`): NO
 * comparte carpeta con el vault, así el agente puede correr en otro host.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  makeDeviceKey, signWithDevice, verifyDelegation, deriveSAS, pubkeyId
} from '@dotrino/identity/capabilities'
import { installNodeGlobals } from './node-globals.js'

const MSG = {
  ENROLL: 'vault.enroll',
  ENROLL_CHALLENGE: 'vault.enroll.challenge',
  ENROLLED: 'vault.enrolled',
  ERROR: 'vault.error'
}

export function dataDir () {
  if (process.env.DOTRINO_TERMINAL_DIR) return process.env.DOTRINO_TERMINAL_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'dotrino-terminal-agent')
}

const linkPath = (dir) => path.join(dir, 'link.json')

export function loadLink (dir = dataDir()) {
  try { return JSON.parse(fs.readFileSync(linkPath(dir), 'utf8')) } catch { return null }
}

function saveLink (dir, link) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(linkPath(dir), JSON.stringify(link, null, 2), { mode: 0o600 })
}

export function parseQr (text) {
  const qr = JSON.parse(String(text).trim())
  if (!qr?.iss || !qr?.proxy || !qr?.token || !qr?.sn) throw new Error('QR inválido (v2): faltan iss/proxy/token/sn')
  return qr
}

async function freshClient (proxyUrl, dir) {
  installNodeGlobals(dir)
  const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
  const client = new WebSocketProxyClient({ url: proxyUrl, enableWebRTC: false, autoReconnect: false })
  await client.connect()
  return client
}

/**
 * Enrola esta máquina contra el vault del QR. Devuelve y persiste
 * `{ device, cert, iss, proxy, label }`.
 * @param {(c:{deviceId:string,sas:string})=>void} onChallenge  mostrar el SAS a comparar/aprobar en el vault
 */
export async function enroll ({ qr, label = 'terminal-agent', dir = dataDir(), onChallenge, timeoutMs = 180000 } = {}) {
  const client = await freshClient(qr.proxy, dir)
  try {
    const device = await makeDeviceKey({ label })
    const deviceId = (await pubkeyId(device.publickey)).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2')
    const sas = await deriveSAS(qr.iss, device.publickey, qr.sn)
    const data = { op: 'enroll', dpub: device.publickey, token: qr.token, sn: qr.sn, label, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })

    const done = new Promise((resolve, reject) => {
      const off = client.on('message', (_from, p) => {
        if (!p || typeof p !== 'object') return
        if (p.type === MSG.ENROLL_CHALLENGE) onChallenge?.({ deviceId, sas })
        else if (p.type === MSG.ENROLLED) { cleanup(); resolve(p) }
        else if (p.type === MSG.ERROR) { cleanup(); reject(new Error(p.error)) }
      })
      const t = setTimeout(() => { cleanup(); reject(new Error('timeout esperando la aprobación en el vault')) }, timeoutMs)
      const cleanup = () => { off(); clearTimeout(t) }
    })
    client.sendByPubkey(qr.iss, { type: MSG.ENROLL, data, signature })
    const res = await done

    const v = await verifyDelegation({ cert: res.cert, expectedSub: device.publickey })
    if (!v.ok) throw new Error('cert inválido: ' + v.reason)
    if (res.cert.iss !== qr.iss) throw new Error('cert firmado por otra maestra (posible proxy malicioso)')

    const link = { device, cert: res.cert, iss: qr.iss, proxy: qr.proxy, label, at: Date.now() }
    saveLink(dir, link)
    return link
  } finally { client.close() }
}
