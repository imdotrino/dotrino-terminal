/**
 * vaultLink.js — enlaza ESTE navegador como un dispositivo del vault (flujo de
 * emparejamiento ENDURECIDO de `@dotrino/identity` / dotrino-vault). Reusa el
 * pilar de identidad y el transporte del ecosistema; NO reimplementa cripto.
 *
 * Es la contraparte en navegador de `dotrino-vault/src/client.js#enroll`: el
 * dispositivo genera su sub-clave `D`, firma el ENROLL (prueba de posesión),
 * muestra un SAS que el dueño compara y aprueba en el PC, y valida el cert que
 * recibe (firmado por la maestra que vio en el QR, para SU clave). El resultado
 * —`{ device, cert, iss }`— es la credencial de "dispositivo enlazado" que
 * autoriza a abrir la terminal.
 *
 * La clave privada del dispositivo es material de identidad: se guarda cifrada
 * dependería del store; para v1 va en localStorage (solo en este dispositivo,
 * nunca viaja al servidor). Revocable desde el vault (`dotrino-vault revoke`).
 */
import {
  makeDeviceKey, signWithDevice, verifyDelegation, deriveSAS, pubkeyId
} from '@dotrino/identity/capabilities'

const MSG = {
  ENROLL: 'vault.enroll',
  ENROLL_CHALLENGE: 'vault.enroll.challenge',
  ENROLLED: 'vault.enrolled',
  ERROR: 'vault.error'
}
const LS_KEY = 'dotrino-terminal:link'

export function loadLink () {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null } catch { return null }
}
export function clearLink () { localStorage.removeItem(LS_KEY) }
function saveLink (link) { localStorage.setItem(LS_KEY, JSON.stringify(link)) }

/** Parsea el QR/texto de emparejamiento del vault (`dotrino-vault pair`). */
export function parseQr (text) {
  const qr = JSON.parse(text.trim())
  if (!qr?.iss || !qr?.proxy || !qr?.token || !qr?.sn) throw new Error('QR inválido: faltan iss/proxy/token/sn')
  return qr
}

async function connect (proxyUrl) {
  const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
  const client = new WebSocketProxyClient({ url: proxyUrl, enableWebRTC: false, autoReconnect: false })
  await client.connect()
  return client
}

/**
 * Enrola este navegador contra el vault descrito por el QR.
 * @param {object} qr  resultado de parseQr()
 * @param {(c:{deviceId:string,sas:string})=>void} onChallenge  mostrar el SAS a comparar
 */
export async function enroll (qr, { label = 'terminal-web', onChallenge, timeoutMs = 180000 } = {}) {
  const client = await connect(qr.proxy)
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
    saveLink(link)
    return link
  } finally { client.close() }
}
