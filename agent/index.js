/**
 * @dotrino/terminal-agent — abre una shell real (PTY) SOLO para dispositivos
 * enlazados al mismo vault. Puede correr en CUALQUIER máquina: se enrola con el
 * vault como un dispositivo más (ver link.js), así que NO necesita la maestra —
 * solo su propia sub-clave `D` + `cert` y la pública maestra pineada (`iss`).
 *
 * Autorización = el vault. Cada `terminal.hs` llega firmado por la `D` del cliente
 * con su `cert`; el agente verifica la cadena `D_cliente ← maestra` (misma maestra
 * que la suya) con `verifyChain`. Ambas puntas son peers certificados por el mismo
 * vault; ninguna tiene la clave maestra. El ack lo firma el agente con SU `D` y
 * adjunta su `cert`, para que el cliente compruebe que habla con una máquina que
 * el vault certificó (anti-MITM del relay).
 *
 * Transporte = el proxy (`@dotrino/proxy-client`): el agente se identifica bajo
 * SU pubkey y el cliente lo direcciona por ella. Revocación: refresca la lista del
 * vault (`vault.devices`) por el proxy; si el vault está offline, usa la última
 * cacheada + el TTL del cert acota el riesgo. I/O cifrado E2E (../shared/e2e.js).
 */
import os from 'node:os'
import { createRequire } from 'node:module'
import { verifyChain, signWithDevice, pubkeyId } from '@dotrino/identity/capabilities'
import { installNodeGlobals } from './node-globals.js'
import { makeEphemeral, deriveKey, seal, open } from './e2e.js'
import { loadLink, dataDir } from './link.js'

const require = createRequire(import.meta.url)

const T = {
  HS: 'terminal.hs', ACK: 'terminal.hs.ack', CMD: 'terminal.cmd', OUT: 'terminal.out', ERROR: 'terminal.error'
}
const VMSG = { DEVICES: 'vault.devices', DEVICES_RESULT: 'vault.devices.result' }
const SIGN_SCOPE = 'vault:sign'
const SESSION_TTL_MS = 30 * 60 * 1000
const REVOKE_REFRESH_MS = 5 * 60 * 1000

export async function startAgent (opts = {}) {
  const dir = opts.dir || dataDir()
  const link = opts.link || loadLink(dir)
  if (!link?.device?.privateJwk || !link?.cert || !link?.iss) {
    throw new Error('esta máquina no está enlazada. Corré primero: `dotrino-terminal-agent enroll`.')
  }
  const master = link.iss
  const myPub = link.device.publickey
  const myId = (await pubkeyId(myPub)).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2')

  installNodeGlobals(dir)

  let pty
  try { pty = require('node-pty') } catch {
    throw new Error('falta node-pty. En agent/: `npm install`.')
  }

  const { getWebSocketProxyClient } = await import('@dotrino/proxy-client')
  const proxyUrl = opts.proxyUrl || process.env.PROXY_URL || link.proxy || 'wss://proxy.dotrino.com'
  const client = getWebSocketProxyClient({
    url: proxyUrl, enableWebRTC: false, autoReconnect: true,
    maxReconnectAttempts: 100000, reconnectDelay: 4000
  })
  await client.connect()

  // Identificarse bajo la pubkey de ESTA máquina (firmado con su D).
  const identify = async () => {
    if (!client.token) return
    const data = { op: 'identify', publickey: myPub, token: client.token, ts: Date.now() }
    const { signature } = await signWithDevice({ privateJwk: link.device.privateJwk, data })
    await client.identify({ data, signature })
  }
  await identify()
  client.on('token', () => { identify().catch(() => {}) })

  const send = (to, obj) => { try { client.send(to, obj) } catch (e) { if (!opts.quiet) console.error('[terminal] send:', e.message) } }

  // --- Revocación: refrescar la lista del vault por el proxy (best-effort) ---
  let revokedSet = new Set()
  async function refreshRevocations () {
    try {
      const data = { op: 'devices', publickey: myPub, ts: Date.now() }
      const { signature } = await signWithDevice({ privateJwk: link.device.privateJwk, data })
      const res = await new Promise((resolve, reject) => {
        const off = client.on('message', (_f, p) => {
          if (p?.type === VMSG.DEVICES_RESULT) { off(); resolve(p) }
          else if (p?.type === 'vault.error') { off(); reject(new Error(p.error)) }
        })
        setTimeout(() => { off(); reject(new Error('timeout')) }, 15000)
        client.sendByPubkey(master, { type: VMSG.DEVICES, data, signature, cert: link.cert })
      })
      revokedSet = new Set((res.revoked || []).map((r) => r.nonce || r))
    } catch (e) {
      if (!opts.quiet) console.error('[terminal] no pude refrescar revocaciones (uso la cache):', e.message)
    }
  }
  refreshRevocations()
  const revTimer = setInterval(refreshRevocations, REVOKE_REFRESH_MS); revTimer.unref?.()

  // sid -> { key, term, from, exp }
  const sessions = new Map()
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [sid, s] of sessions) if (now > s.exp) { try { s.term?.kill() } catch {}; sessions.delete(sid) }
  }, 60 * 1000); sweeper.unref?.()

  async function pushOut (s, data) {
    if (!s.from) return
    const env = await seal(s.key, { type: 'out', data }).catch(() => null)
    if (env) send(s.from, { type: T.OUT, sid: s.sid, env })
  }

  async function handleHandshake (from, p) {
    const { data, signature, cert } = p
    if (!data || !signature || !cert) return send(from, { type: T.ERROR, error: 'handshake incompleto' })
    const chk = await verifyChain({ data, signature, cert, expectedScope: SIGN_SCOPE, trustedIssuer: master, revoked: revokedSet })
    if (!chk.ok) return send(from, { type: T.ERROR, error: 'no autorizado: ' + chk.reason })
    if (data.op !== 'terminal.hs' || typeof data.eph !== 'string') return send(from, { type: T.ERROR, error: 'handshake inválido' })

    const eph = await makeEphemeral()
    const sid = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')
    const key = await deriveKey(eph.privateKey, data.eph, sid)
    // Ack firmado con la D de ESTA máquina + su cert: el cliente verifica la
    // cadena a la maestra y que la pub efímera viene de una máquina certificada.
    const ack = { op: 'terminal.hs.ack', sid, seph: eph.pub, ceph: data.eph, machine: myPub, ts: Date.now() }
    const { signature: ackSig } = await signWithDevice({ privateJwk: link.device.privateJwk, data: ack })

    sessions.set(sid, { sid, key, term: null, from, exp: Date.now() + SESSION_TTL_MS })
    send(from, { type: T.ACK, sid, ack, signature: ackSig, cert: link.cert })
    if (!opts.quiet) console.log(`[terminal] sesión ${sid.slice(0, 8)} autorizada (device ${chk.device?.slice?.(0, 8) || '?'})`)
  }

  async function handleCmd (from, p) {
    const s = sessions.get(p.sid)
    if (!s) return send(from, { type: T.ERROR, error: 'sesión desconocida o expirada' })
    s.exp = Date.now() + SESSION_TTL_MS
    s.from = from
    let msg
    try { msg = await open(s.key, p.env) } catch { return send(from, { type: T.ERROR, error: 'sobre inválido' }) }

    if (msg.type === 'open') {
      if (s.term) return
      const shell = opts.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
      s.term = pty.spawn(shell, [], {
        name: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24,
        cwd: os.homedir(), env: { ...process.env, TERM: 'xterm-256color' }
      })
      s.term.onData((d) => pushOut(s, d))
      s.term.onExit(({ exitCode }) => { pushOut(s, `\r\n[proceso terminado (${exitCode})]\r\n`); s.term = null })
      return
    }
    if (msg.type === 'input') return void s.term?.write(msg.data)
    if (msg.type === 'resize') { try { s.term?.resize(msg.cols, msg.rows) } catch {}; return }
    if (msg.type === 'close') { try { s.term?.kill() } catch {}; sessions.delete(p.sid); return }
  }

  client.on('message', (from, payload) => {
    if (!payload || typeof payload !== 'object') return
    if (payload.type === T.HS) handleHandshake(from, payload).catch((e) => send(from, { type: T.ERROR, error: e.message }))
    else if (payload.type === T.CMD) handleCmd(from, payload).catch((e) => send(from, { type: T.ERROR, error: e.message }))
  })

  if (!opts.quiet) {
    console.log(`[terminal] agente activo · máquina ${myId} · vault ${(await pubkeyId(master)).slice(0, 16)} · proxy ${proxyUrl}`)
  }

  return {
    machine: myPub, machineId: myId, master,
    close () { clearInterval(revTimer); clearInterval(sweeper); for (const s of sessions.values()) { try { s.term?.kill() } catch {} } try { client.close() } catch {} }
  }
}

export default { startAgent }
