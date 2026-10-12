/**
 * uploads.js — una imagen que manda un aparato de la cuenta se guarda en ESTA máquina.
 *
 * Para qué: desde el teléfono no hay otra forma de enseñarle una foto o una captura a lo que
 * corre en la consola. El aparato la manda por la sesión (cifrada, como todo lo demás), aquí
 * se guarda en un archivo y se le contesta la RUTA, que es lo que se escribe en la consola.
 *
 * Solo imágenes, y qué es lo decide el contenido (sus primeros bytes), no lo que diga quien la
 * manda: el nombre y la extensión los pone el agente. Quien llega hasta aquí ya tiene una shell
 * en la máquina, así que esto no le da nada que no tuviera; aun así no elige ni el nombre ni la
 * carpeta.
 *
 * Llega en trozos (`file`), en orden y con acuse por trozo (`filed`): el proxio corta los
 * mensajes a 1 MB y el acuse hace que el que manda no vaya más rápido de lo que se recibe.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Lo más que pesa una imagen. El aparato la reduce antes de mandarla; esto es el tope. */
export const UPLOAD_MAX = 12 * 1024 * 1024
/** Lo más que pesa un trozo, ya en base64. */
export const UPLOAD_CHUNK_MAX = 256 * 1024
/** Lo que se guarda una imagen: después se borra sola. */
export const UPLOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000

const fail = (code, message) => Object.assign(new Error(message), { code })

/** La extensión de una imagen por sus primeros bytes, o null si no es una de las admitidas. */
export function imageExt (buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

/** Borra las imágenes que ya cumplieron su tiempo. Un fallo aquí se dice y no para nada más. */
export function pruneUploads (dir, now = Date.now()) {
  let names
  try { names = fs.readdirSync(dir) } catch (e) { if (e.code === 'ENOENT') return; throw e }
  for (const name of names) {
    if (!/^img-.*\.(png|jpg|gif|webp)$/.test(name)) continue
    const file = path.join(dir, name)
    try { if (now - fs.statSync(file).mtimeMs > UPLOAD_KEEP_MS) fs.rmSync(file) } catch (e) {
      console.error('[terminal-agent] could not remove an old image', file, '-', e.message)
    }
  }
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Lo que recibe UNA sesión. Una imagen a la vez: empezar otra descarta la que iba a medias.
 *
 * @param {string} dir  la carpeta donde se guardan (se crea, solo para el usuario).
 * @returns {{ take: (msg: { up: string, seq: number, data: string, last?: boolean }) => { up: string, seq: number, path?: string }, drop: () => void }}
 */
export function makeUploads (dir) {
  /** @type {{ up: string, next: number, size: number, parts: Buffer[] } | null} */
  let cur = null
  return {
    take (msg) {
      const up = typeof msg.up === 'string' ? msg.up.slice(0, 64) : ''
      const seq = msg.seq
      if (!up || !Number.isInteger(seq) || seq < 0 || typeof msg.data !== 'string') throw fail('bad-file', 'file: needs `up`, `seq` and `data`')
      if (msg.data.length > UPLOAD_CHUNK_MAX) { cur = null; throw fail('too-big', 'file: that piece is too big') }
      if (seq === 0) cur = { up, next: 0, size: 0, parts: [] }
      if (!cur || cur.up !== up || cur.next !== seq) { cur = null; throw fail('bad-file', 'file: a piece came out of order') }
      const part = Buffer.from(msg.data, 'base64')
      cur.size += part.length
      if (cur.size > UPLOAD_MAX) { cur = null; throw fail('too-big', `file: the image is over ${UPLOAD_MAX / 1024 / 1024} MB`) }
      cur.parts.push(part)
      cur.next++
      if (!msg.last) return { up, seq }
      const whole = Buffer.concat(cur.parts)
      cur = null
      const ext = imageExt(whole)
      if (!ext) throw fail('not-image', 'file: that is not a PNG, JPEG, GIF or WebP image')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      pruneUploads(dir)
      const file = path.join(dir, `img-${stamp(new Date())}-${crypto.randomBytes(3).toString('hex')}.${ext}`)
      fs.writeFileSync(file, whole, { mode: 0o600, flag: 'wx' })
      return { up, seq, path: file }
    },
    drop () { cur = null }
  }
}
