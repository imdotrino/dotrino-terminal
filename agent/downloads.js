/**
 * downloads.js — un archivo de ESTA máquina, para abrirlo en el aparato que mira la consola.
 *
 * Para qué: la consola enseña rutas (`/tmp/informe.pdf`, `~/fotos/a.png`) y desde el teléfono o
 * el navegador no hay otra forma de ver ese archivo. El aparato la pide por la sesión (cifrada,
 * como todo lo demás) y se le manda en trozos.
 *
 * Quien llega hasta aquí ya tiene una shell en la máquina, así que leer un archivo no le da nada
 * que no tuviera con `cat`. Lo que se cuida es otra cosa: solo archivos normales (ni carpetas ni
 * dispositivos) y con tope de tamaño, para que una ruta mal leída no se ponga a mandar gigas.
 *
 * Sin estado: cada trozo se pide con la ruta y su número (`seq`), y cada respuesta lleva el
 * tamaño y la fecha del archivo; si cambian a mitad, quien pide lo ve y para.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Lo más que pesa un archivo que se manda. */
export const FETCH_MAX = 50 * 1024 * 1024
/** Lo que lleva cada trozo, antes del base64 (el mismo tamaño que las subidas del cliente). */
export const FETCH_CHUNK = 96 * 1024

const fail = (code, message) => Object.assign(new Error(message), { code })

/**
 * La ruta absoluta de lo que se pide. `~` es la carpeta personal; una ruta relativa cuelga de
 * `cwd` (la carpeta de la shell de la consola), y sin ella no se adivina: se dice.
 */
export function resolvePath (p, cwd = null) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) throw fail('bad-fetch', 'fetch: needs a `path`')
  const home = os.homedir()
  const expand = (s) => s === '~' ? home : s.startsWith('~/') ? path.join(home, s.slice(2)) : s
  const full = expand(p)
  if (path.isAbsolute(full)) return path.normalize(full)
  if (!cwd) throw fail('no-cwd', `fetch: ${p} is relative and the folder of the console is unknown`)
  return path.resolve(expand(cwd), full)
}

/**
 * Un trozo del archivo.
 * @param {{ id: string, path: string, seq: number }} msg
 * @param {string|null} cwd  la carpeta de la consola enganchada, para las rutas relativas.
 * @returns {{ id: string, seq: number, path: string, name: string, size: number, mtime: number, data: string, last?: true }}
 */
export function readPiece (msg, cwd = null) {
  const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : ''
  const seq = msg.seq
  if (!id || !Number.isInteger(seq) || seq < 0) throw fail('bad-fetch', 'fetch: needs `id`, `path` and `seq`')
  const file = resolvePath(msg.path, cwd)
  let st
  try { st = fs.statSync(file) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw fail('no-file', `no such file: ${file}`)
    if (e.code === 'EACCES' || e.code === 'EPERM') throw fail('no-read', `not allowed to read: ${file}`)
    throw e
  }
  if (st.isDirectory()) throw fail('is-dir', `that is a folder: ${file}`)
  if (!st.isFile()) throw fail('not-file', `that is not a regular file: ${file}`)
  if (st.size > FETCH_MAX) throw fail('too-big', `the file is over ${FETCH_MAX / 1024 / 1024} MB`)
  const at = seq * FETCH_CHUNK
  if (at > st.size || (at === st.size && st.size > 0)) throw fail('bad-fetch', 'fetch: that piece is past the end of the file')
  const len = Math.min(FETCH_CHUNK, st.size - at)
  const buf = Buffer.alloc(len)
  let fd
  try { fd = fs.openSync(file, 'r') } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw fail('no-read', `not allowed to read: ${file}`)
    throw e
  }
  try {
    let got = 0
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, at + got)
      if (n === 0) break
      got += n
    }
    if (got < len) throw fail('changed', 'the file got shorter while it was being sent')
  } finally { fs.closeSync(fd) }
  const last = at + len >= st.size
  return { id, seq, path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, data: buf.toString('base64'), ...(last ? { last: true } : {}) }
}
