/**
 * access.js — la CLAVE de esta máquina (un PIN o una contraseña), opcional.
 *
 * Sin clave puesta no cambia nada: abre una consola cualquier aparato de la cuenta con `sign`,
 * como siempre. Con clave, además de ser de la cuenta hay que escribirla en cada conexión
 * remota. Las ventanas de ESTA máquina (el socket local) no la piden: son del mismo usuario
 * que ya puede leer este archivo.
 *
 * En el disco queda la sal y el resumen (scrypt), nunca la clave. La clave viaja dentro de la
 * sesión cifrada entre el aparato y el agente, así que el proxio no la ve.
 *
 * Los fallos se frenan POR AGENTE y no por sesión: quien prueba claves puede abrir otra
 * conexión, y eso no le da intentos nuevos. A los TRES seguidos (dueño, 2026-10-07) empieza
 * la espera, que se dobla con cada fallo más: es un bloqueo LOCAL de este servicio, nada más.
 *
 * Y a los tres fallos seguidos de UN MISMO aparato se avisa (`onIncident`): la bóveda se lo
 * pone en la mesa a quien aprueba, que bloquea o ignora desde el teléfono. Avisar no decide
 * nada aquí; el freno de arriba sigue igual.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ACCESS_FILE = 'access.json'
export const MIN_LENGTH = 4
/** Fallos seguidos que se dejan pasar sin esperar: al tercero empieza la espera. */
export const FREE_TRIES = 3
/** Fallos seguidos de un mismo aparato que disparan el aviso a la bóveda. */
export const INCIDENT_AFTER = 3
const BASE_WAIT_MS = 30_000
const MAX_WAIT_MS = 60 * 60_000
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })
const file = (dir) => path.join(dir, ACCESS_FILE)
const digest = (secret, salt, params) => crypto.scryptSync(String(secret).normalize('NFKC'), salt, 32, params)

/** Si esta máquina tiene clave. Un archivo que existe y no se puede leer NO es «sin clave»: se lanza. */
export function hasAccessCode (dir) {
  return readRecord(dir) !== null
}

function readRecord (dir) {
  let raw
  try { raw = fs.readFileSync(file(dir), 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return null
    throw fail('access-unreadable', `cannot read ${ACCESS_FILE}: ${e.message}`)
  }
  let r
  try { r = JSON.parse(raw) } catch (_) { throw fail('access-unreadable', `${ACCESS_FILE} is not valid JSON`) }
  if (r?.v !== 1 || typeof r.salt !== 'string' || typeof r.hash !== 'string' || !r.params) {
    throw fail('access-unreadable', `${ACCESS_FILE} has an unknown shape`)
  }
  return r
}

/** Pone o cambia la clave. */
export function setAccessCode (dir, secret) {
  if (typeof secret !== 'string' || secret.length < MIN_LENGTH) throw fail('too-short', `the code needs at least ${MIN_LENGTH} characters`)
  const salt = crypto.randomBytes(16)
  const record = { v: 1, salt: salt.toString('base64'), hash: digest(secret, salt, SCRYPT).toString('base64'), params: SCRYPT }
  const tmp = file(dir) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
  fs.renameSync(tmp, file(dir))
}

/** Quita la clave. */
export function clearAccessCode (dir) {
  fs.rmSync(file(dir), { force: true })
}

/** Si `secret` es la clave de esta máquina. Sin frenos: para la orden local que la cambia. */
export function checkAccessCode (dir, secret) {
  const r = readRecord(dir)
  if (!r) throw fail('no-access-code', 'this machine has no code')
  const want = Buffer.from(r.hash, 'base64')
  const got = digest(secret ?? '', Buffer.from(r.salt, 'base64'), r.params)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

/**
 * La puerta de un agente: comprueba la clave y frena los fallos seguidos. Una por agente,
 * compartida por todas sus sesiones.
 * @param {string} dir
 * @param {{ now?: () => number, onIncident?: (i: { device: string, tries: number }) => void }} [opts]
 *   `onIncident`: un mismo aparato (`device`, su pubkey) falló `INCIDENT_AFTER` veces seguidas.
 *   Se llama UNA vez por racha; la racha se corta al acertar.
 */
export function makeGate (dir, { now = Date.now, onIncident = null } = {}) {
  let fails = 0
  let until = 0
  /** Fallos seguidos por aparato: el aviso es sobre QUIÉN, y el freno sobre el agente. */
  const byDevice = new Map()
  return {
    /** Si hay que escribir la clave para entrar. Lanza `access-unreadable` si no se puede saber. */
    required: () => hasAccessCode(dir),
    /**
     * Lanza `wait` (con `retryMs`) o `bad-code`; si no lanza, la clave era la buena.
     * `device` es quién la escribió (pubkey), para contar sus fallos y avisar.
     */
    check (secret, device = null) {
      const left = until - now()
      if (left > 0) throw fail('wait', 'too many wrong codes', { retryMs: left })
      if (checkAccessCode(dir, secret)) { fails = 0; until = 0; if (device) byDevice.delete(device); return }
      fails++
      if (fails >= FREE_TRIES) until = now() + Math.min(BASE_WAIT_MS * 2 ** (fails - FREE_TRIES), MAX_WAIT_MS)
      if (device) {
        const n = (byDevice.get(device) || 0) + 1
        byDevice.set(device, n)
        if (n === INCIDENT_AFTER && onIncident) { try { onIncident({ device, tries: n }) } catch (_) {} }
      }
      throw fail('bad-code', 'wrong code', until ? { retryMs: until - now() } : {})
    }
  }
}
