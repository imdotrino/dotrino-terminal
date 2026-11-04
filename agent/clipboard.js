/**
 * clipboard.js — la imagen del portapapeles de ESTA máquina, para mandarla a otra.
 *
 * Para qué: Ctrl+V con una imagen copiada hace que el programa de la consola (Claude Code) la
 * busque en el portapapeles de la máquina donde corre. Si la consola es de OTRA máquina
 * (`--machine`), allí no hay nada: la imagen está aquí. El cliente la lee con esto, la sube
 * (uploads.js, la misma subida que usa el teléfono) y pega la ruta donde quedó.
 *
 * Cada sistema la da con su herramienta: `wl-paste` (Wayland), `xclip` (X11), `osascript`
 * (macOS) y PowerShell (Windows). Devuelve `null` si en el portapapeles no hay imagen, que es
 * lo normal (entonces Ctrl+V sigue su camino), y lanza con `code` si no se pudo mirar.
 */
import { execFile } from 'node:child_process'

/** Los tipos que admite la subida (uploads.js), en orden de preferencia. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

const fail = (code, message) => Object.assign(new Error(message), { code })

/** Corre una herramienta y devuelve su salida en bytes. */
function runTool (cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(fail('no-clipboard-tool', `${cmd} is not installed`))
        // Sin imagen, varias herramientas salen con error (xclip: «target … not available»).
        return reject(Object.assign(err, { code: 'clipboard-empty' }))
      }
      resolve(stdout)
    })
  })
}

/** De la lista de tipos que ofrece el portapapeles, el de imagen que se manda, o null. */
export function pickImageType (targets) {
  const offered = new Set(String(targets).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  return IMAGE_TYPES.find((t) => offered.has(t)) || null
}

/** Lo que contesta `osascript` (`«data PNGf89504E…»`), en bytes; null si no es eso. */
export function parseAppleData (text) {
  const m = /«data PNGf([0-9A-Fa-f]+)»/.exec(String(text))
  return m ? Buffer.from(m[1], 'hex') : null
}

const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$i = [Windows.Forms.Clipboard]::GetImage()',
  'if ($i) { $m = New-Object IO.MemoryStream; $i.Save($m, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()) }',
].join('; ')

/**
 * La imagen del portapapeles, o null si no hay.
 * @param {{ platform?: string, env?: object, run?: (cmd:string, args:string[]) => Promise<Buffer> }} [opts]
 * @returns {Promise<Buffer|null>}
 */
export async function clipboardImage ({ platform = process.platform, env = process.env, run = runTool } = {}) {
  const quiet = async (cmd, args) => {
    try { return await run(cmd, args) } catch (e) { if (e.code === 'clipboard-empty') return null; throw e }
  }
  if (platform === 'darwin') {
    const out = await quiet('osascript', ['-e', 'the clipboard as «class PNGf»'])
    return out ? parseAppleData(out.toString('utf8')) : null
  }
  if (platform === 'win32') {
    const out = await quiet('powershell.exe', ['-NoProfile', '-STA', '-Command', WINDOWS_SCRIPT])
    const b64 = out ? out.toString('utf8').trim() : ''
    return b64 ? Buffer.from(b64, 'base64') : null
  }
  if (env.WAYLAND_DISPLAY) {
    const type = pickImageType((await quiet('wl-paste', ['--list-types'])) || '')
    if (!type) return null
    return (await quiet('wl-paste', ['--no-newline', '--type', type])) || null
  }
  if (env.DISPLAY) {
    const type = pickImageType((await quiet('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])) || '')
    if (!type) return null
    return (await quiet('xclip', ['-selection', 'clipboard', '-t', type, '-o'])) || null
  }
  throw fail('no-display', 'no graphical session here (neither WAYLAND_DISPLAY nor DISPLAY)')
}

/** Una ruta como se teclea en una shell: entre comillas solo si hace falta. */
export function typedPath (file) {
  return /^[\w@%+=:,./-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`
}

/** Lo que va en cada trozo, antes de pasarlo a base64 (≤ 256 KB ya en base64: uploads.js). */
export const UPLOAD_PIECE = 96 * 1024

/**
 * Sube una imagen a la máquina de la consola y devuelve la ruta donde quedó. Va en trozos y
 * cada uno espera su acuse (`filed`). `ask(msg)` manda un mensaje y resuelve con la respuesta
 * (`filed` o `fail`); un `fail` se lanza con su `code`.
 * @param {(msg: object) => Promise<object>} ask
 * @param {Buffer} bytes
 * @param {{ id?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function uploadImage (ask, bytes, { id = Math.random().toString(16).slice(2, 18) } = {}) {
  if (!bytes?.length) throw fail('not-image', 'the image is empty')
  for (let at = 0, seq = 0; ; seq++) {
    const end = Math.min(bytes.length, at + UPLOAD_PIECE)
    const last = end >= bytes.length
    const r = await ask({ type: 'file', up: id, seq, data: bytes.subarray(at, end).toString('base64'), ...(last ? { last: true } : {}) })
    if (r.type === 'fail') throw fail(r.code || 'file-failed', r.message || 'the machine did not keep the image')
    if (r.up !== id || r.seq !== seq) throw fail('bad-file', 'the machine answered about another image')
    at = end
    if (last) {
      if (typeof r.path !== 'string' || !r.path) throw fail('bad-file', 'the machine did not say where it kept the image')
      return r.path
    }
  }
}
