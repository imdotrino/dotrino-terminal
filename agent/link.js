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
  makeDeviceKey, signWithDevice, verifyDelegation, makePairingCode, pubkeyId
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

// Decodifica base64url a string UTF-8 (Node). El código copiable de la web
// (profile.dotrino.com/#myvault) viaja en base64url para no exponer iss/token/sn.
function b64urlDecode (s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Buffer.from(s, 'base64').toString('utf8')
}

export function parseQr (text) {
  let s = String(text ?? '').trim()
  const i = s.indexOf('#vault=')
  if (i >= 0) s = s.slice(i + 7).trim()        // profile.dotrino.com/#vault=…
  if (!s.startsWith('{')) {                     // no es JSON crudo → probar base64url
    const json = b64urlDecode(s)
    if (json && json.trim().startsWith('{')) s = json
    else throw new Error('código de emparejamiento inválido (se espera JSON o base64url)')
  }
  const qr = JSON.parse(s)
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
 * @param {(c:{deviceId:string,code:string})=>void} onChallenge  mostrar el CÓDIGO para que un humano lo TIPEE en la bóveda al aprobar (el código NO viaja de aquí)
 */
export async function enroll ({ qr, label = 'terminal-agent', dir = dataDir(), onChallenge, timeoutMs = 180000 } = {}) {
  const client = await freshClient(qr.proxy, dir)
  try {
    const device = await makeDeviceKey({ label })
    const deviceId = (await pubkeyId(device.publickey)).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2')
    // Código de emparejamiento ALEATORIO (un secreto, NO derivable de valores públicos):
    // lo mostramos y NO lo enviamos. La bóveda lo aprende solo cuando un humano lo tipea
    // y nos lo ECHA de vuelta → así aprobar exige TENER esta máquina (de aquí sale el código).
    const code = makePairingCode()
    const data = { op: 'enroll', dpub: device.publickey, token: qr.token, sn: qr.sn, label, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })

    const done = new Promise((resolve, reject) => {
      const off = client.on('message', (_from, p) => {
        if (!p || typeof p !== 'object') return
        if (p.type === MSG.ENROLL_CHALLENGE) onChallenge?.({ deviceId, code })
        // Aceptamos SOLO si el código echado coincide con el que generamos (anti
        // aprobación-a-ciegas / bóveda impostora). Un eco distinto se IGNORA y seguimos
        // esperando la aprobación correcta (o el timeout).
        else if (p.type === MSG.ENROLLED) { if (String(p.code || '').trim() === code) { cleanup(); resolve(p) } }
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
