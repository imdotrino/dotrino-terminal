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
 * conexión, y eso no le da intentos nuevos.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ACCESS_FILE = 'access.json'
export const MIN_LENGTH = 4
/** Fallos seguidos que se dejan pasar sin esperar. */
export const FREE_TRIES = 5
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
 * @param {{ now?: () => number }} [opts]
 */
export function makeGate (dir, { now = Date.now } = {}) {
  let fails = 0
  let until = 0
  return {
    /** Si hay que escribir la clave para entrar. Lanza `access-unreadable` si no se puede saber. */
    required: () => hasAccessCode(dir),
    /** Lanza `wait` (con `retryMs`) o `bad-code`; si no lanza, la clave era la buena. */
    check (secret) {
      const left = until - now()
      if (left > 0) throw fail('wait', 'too many wrong codes', { retryMs: left })
      if (checkAccessCode(dir, secret)) { fails = 0; until = 0; return }
      fails++
      if (fails >= FREE_TRIES) until = now() + Math.min(BASE_WAIT_MS * 2 ** (fails - FREE_TRIES), MAX_WAIT_MS)
      throw fail('bad-code', 'wrong code', until ? { retryMs: until - now() } : {})
    }
  }
}
