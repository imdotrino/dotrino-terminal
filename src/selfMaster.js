/**
 * selfMaster.js — ESTE dispositivo (el navegador) actúa como su PROPIO vault.
 *
 * La identidad del navegador (`@dotrino/identity`, iframe id.dotrino.com) tiene su
 * propia clave maestra `P`. Sin emparejarla con un vault externo, `P` puede firmar
 * certificados de delegación (`id.signDelegation`) → autoriza máquinas como un vault
 * más. Así el terminal funciona SIN un vault en un PC: el dispositivo ES el vault.
 *
 * Qué hace este módulo:
 *   - Levanta un listener en el proxy (identificado como `P`) que atiende el MISMO
 *     protocolo de enrolamiento endurecido que usa el vault (`vault.enroll` →
 *     `vault.enroll.challenge` → `vault.enrolled`). El agente (`@dotrino/terminal-agent`)
 *     no cambia: se enrola contra la pubkey `P` exactamente igual que contra un vault.
 *   - Firma certificados `D ← P` (scope `vault:sign`, 30 días) al aprobar una máquina.
 *   - Lista/revoca máquinas vía `id.listDelegations` / `id.revokeDelegation`.
 *   - Responde `vault.devices` (revocaciones) para que el agente refresque su lista.
 *
 * Cripto 100% de `@dotrino/identity`: nada se reimplementa. El self-cert `P ← P`
 * (que el navegador presenta al agente en el handshake) se valida con el MISMO
 * `verifyChain` que ya usa el agente: cert.sub === P === data.publickey,
 * cert.iss === P === trustedIssuer.
 */
import { deriveSAS, verifyDeviceSig, verifyChain, pubkeyId } from '@dotrino/identity/capabilities'

const SIGN_SCOPE = 'vault:sign'
const PAIRING_TTL_MS = 5 * 60 * 1000          // un QR de emparejamiento vale 5 min
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // vida de un cert de máquina (30 días)
const SELFCERT_TTL_MS = 24 * 60 * 60 * 1000    // el self-cert se regenera cada 24 h
const FRESH_WINDOW_MS = 5 * 60 * 1000

const MSG = {
  ENROLL: 'vault.enroll',
  ENROLL_CHALLENGE: 'vault.enroll.challenge',
  ENROLLED: 'vault.enrolled',
  DEVICES: 'vault.devices',
  DEVICES_RESULT: 'vault.devices.result',
  ERROR: 'vault.error'
}

const LS_MODE = 'dotrino-terminal:mode'

/** ¿El usuario eligió modo standalone (este dispositivo = vault)? */
export function selfModeEnabled () {
  try { return localStorage.getItem(LS_MODE) === 'self' } catch { return false }
}
export function setSelfMode (on) {
  try { on ? localStorage.setItem(LS_MODE, 'self') : localStorage.removeItem(LS_MODE) } catch {}
}

// ----- self-cert P ← P (para presentar al agente en el handshake) -----
// Lo firma la propia identidad de este navegador. verifyChain lo acepta: cert.sub
// === P === data.publickey y cert.iss === P === trustedIssuer. Cacheado en memoria
// y regenerado al acercarse a su vencimiento (barato: una firma ECDSA).
let _selfCert = null
async function getSelfCert (id, iss) {
  const now = Date.now()
  if (_selfCert && _selfCert.exp > now + 60_000) return _selfCert
  const { cert } = await id.signDelegation(iss, SIGN_SCOPE, { ttlMs: SELFCERT_TTL_MS })
  _selfCert = cert
  return cert
}

function randToken () {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function deviceIdOf (pub) {
  return pubkeyId(pub).then((id) => id.slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2'))
}

/**
 * Levanta el "vault del navegador": conexión al proxy identificada como `P` que
 * atiende enrolamientos y consultas de revocación de los agentes.
 * @param {object} id instancia de Identity (@dotrino/identity)
 * @returns {Promise<object>} { iss, proxy, client, startPairing, approve, reject,
 *   listPending, listMachines, revoke, getSelfCert, onPendingChange, close }
 */
export async function startSelfMaster (id, { proxyUrl } = {}) {
  const iss = id.me?.publickey
  if (!iss) throw new Error('sin identidad: abre la app de perfil para crear tu identidad')
  const proxy = proxyUrl || 'wss://proxy.dotrino.com'

  const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
  const client = new WebSocketProxyClient({
    url: proxy, enableWebRTC: false, autoReconnect: true,
    maxReconnectAttempts: 100000, reconnectDelay: 4000
  })
  await client.connect()

  const selfCert = await getSelfCert(id, iss)
  const identify = async () => {
    if (!client.token) return
    const data = { op: 'identify', publickey: iss, token: client.token, ts: Date.now() }
    const { signature } = await id.signData(data)
    await client.identify({ data, signature, cert: selfCert })
  }
  await identify()
  client.on('token', () => identify().catch(() => {}))

  const send = (to, obj) => { try { client.send(to, obj) } catch (_) {} }

  // token -> { exp, sn, scope, ttlMs, label, state, dpub?, deviceId?, from? }
  const pending = new Map()
  let _onPendingChange = () => {}

  async function handleEnroll (from, p) {
    const d = p?.data
    if (!d || typeof d.dpub !== 'string' || typeof p.signature !== 'string') {
      return send(from, { type: MSG.ERROR, error: 'enroll inválido' })
    }
    const pend = pending.get(d.token)
    if (!pend || Date.now() > pend.exp) {
      return send(from, { type: MSG.ERROR, error: 'token de emparejamiento inválido o expirado' })
    }
    if (d.sn !== pend.sn) return send(from, { type: MSG.ERROR, error: 'sesión inválida' })
    if (typeof d.ts !== 'number' || Math.abs(Date.now() - d.ts) > FRESH_WINDOW_MS) {
      return send(from, { type: MSG.ERROR, error: 'enroll vencido (posible replay, o el reloj desfasado)' })
    }
    // PRUEBA DE POSESIÓN: la firma de `data` debe verificar contra `dpub`.
    const ok = await verifyDeviceSig({ publickey: d.dpub, data: d, signature: p.signature })
    if (!ok) return send(from, { type: MSG.ERROR, error: 'firma de dispositivo inválida' })
    if (pend.state === 'PENDING_CONFIRM' && pend.dpub && pend.dpub !== d.dpub) {
      return send(from, { type: MSG.ERROR, error: 'ya hay un dispositivo usando este emparejamiento' })
    }
    const deviceId = await deviceIdOf(d.dpub)
    pend.state = 'PENDING_CONFIRM'
    pend.dpub = d.dpub
    pend.deviceId = deviceId
    pend.from = from
    if (d.label) pend.label = String(d.label).slice(0, 60)
    pend.sas = await deriveSAS(iss, d.dpub, pend.sn)
    _onPendingChange()
    send(from, { type: MSG.ENROLL_CHALLENGE, deviceId })
  }

  // Consulta de revocaciones del agente (igual que vault.devices del vault):
  // responde la lista de dispositivos enrolados + revocados para que el agente
  // refresque su set de revocación.
  async function handleDevices (from, p) {
    const d = p?.data
    if (!d || !p.signature || !p.cert) return send(from, { type: MSG.ERROR, error: 'petición inválida' })
    if (typeof d.ts !== 'number' || Math.abs(Date.now() - d.ts) > FRESH_WINDOW_MS) return
    const chk = await verifyChain({ data: d, signature: p.signature, cert: p.cert, trustedIssuer: iss })
    if (!chk.ok) return send(from, { type: MSG.ERROR, error: 'no autorizado: ' + chk.reason })
    const { issued, revoked } = await id.listDelegations()
    const devices = await Promise.all((issued || []).map(async (x) => ({
      deviceId: x.sub ? await deviceIdOf(x.sub) : null, sub: x.sub || null,
      label: x.label || '', scope: x.scope, exp: x.exp, nonce: x.nonce
    })))
    send(from, { type: MSG.DEVICES_RESULT, devices, revoked: (revoked || []).map((r) => r.nonce || r) })
  }

  client.on('message', (_from, p) => {
    if (!p || typeof p !== 'object') return
    if (p.type === MSG.ENROLL) handleEnroll(_from, p).catch(() => {})
    else if (p.type === MSG.DEVICES) handleDevices(_from, p).catch(() => {})
  })

  function startPairing ({ label = 'terminal-agent' } = {}) {
    pending.clear()
    const token = randToken()
    const sn = randToken()
    pending.set(token, { token, exp: Date.now() + PAIRING_TTL_MS, sn, scope: [SIGN_SCOPE], ttlMs: DEVICE_TTL_MS, label, state: 'AWAITING_ENROLL' })
    return { qr: { v: 2, iss, proxy, token, sn }, expiresInMs: PAIRING_TTL_MS }
  }

  function listPending () {
    return [...pending.values()]
      .filter((p) => p.state === 'PENDING_CONFIRM')
      .map((p) => ({ deviceId: p.deviceId, sas: p.sas, label: p.label }))
  }
  function findPending (deviceId) {
    for (const [, p] of pending) if (p.state === 'PENDING_CONFIRM' && p.deviceId === deviceId) return p
    return null
  }

  async function approve (deviceId) {
    const pend = findPending(deviceId)
    if (!pend || !pend.dpub) throw new Error('no hay ninguna máquina esperando aprobación')
    const { cert } = await id.signDelegation(pend.dpub, pend.scope, { ttlMs: pend.ttlMs, label: pend.label })
    send(pend.from, { type: MSG.ENROLLED, cert, iss })
    pending.delete(pend.token)
    _onPendingChange()
    return { ok: true, deviceId }
  }

  function reject (deviceId) {
    const pend = findPending(deviceId)
    if (!pend) return
    send(pend.from, { type: MSG.ERROR, error: 'emparejamiento rechazado' })
    pending.delete(pend.token)
    _onPendingChange()
  }

  /** Máquinas enroladas bajo esta identidad (P), vigentes y con agente. */
  async function listMachines () {
    const { issued } = await id.listDelegations()
    const now = Date.now()
    const bySub = new Map()
    for (const x of (issued || [])) {
      if (!x.sub || (x.exp && x.exp <= now)) continue
      if (!Array.isArray(x.scope) || !x.scope.includes(SIGN_SCOPE)) continue
      if (!x.label || x.label === 'cli') continue // los navegadores enrolados no atienden consolas
      if (!bySub.has(x.sub) || (x.exp || 0) > (bySub.get(x.sub).exp || 0)) bySub.set(x.sub, x)
    }
    // Adjuntar el deviceId legible (C440-AC0E) — sin él la UI cae al JWK crudo.
    return Promise.all([...bySub.values()].map(async (x) => ({ ...x, deviceId: await deviceIdOf(x.sub) })))
  }

  async function revoke (nonce) {
    return id.revokeDelegation(nonce)
  }

  return {
    iss, proxy, client,
    startPairing, approve, reject, listPending, listMachines, revoke,
    getSelfCert: () => getSelfCert(id, iss),
    onPendingChange (fn) { _onPendingChange = fn || (() => {}) },
    close () { try { client.close() } catch (_) {} }
  }
}
