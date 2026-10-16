/**
 * desktop.js — actualizar la APP DE ESCRITORIO (la ventana, `dotrino-terminal-desktop`).
 *
 * La app es un binario de Rust sin red: no baja nada ella. Su menú corre
 * `dotrino-terminal desktop update` en la ventana, a la vista, y esto hace el trabajo con la
 * misma pieza que el resto del ecosistema (`@dotrino/update`, CONVENCIONES §15): mira la
 * release, baja el archivo que le toca a esta máquina, lo VERIFICA contra su atestación y solo
 * entonces lo instala. Sin con qué verificar, se para y se dice.
 *
 * Cómo se instala depende de cómo llegó la app:
 *
 *   · `.deb` / `.rpm` — el binario es de root: `sudo dpkg -i` / `sudo rpm -U`, que pide la
 *     contraseña en esa misma ventana.
 *   · tarball — el binario es del usuario: se cambia por el nuevo, de forma atómica.
 *   · macOS — se cambia el `.app` entero.
 *   · Windows — el `.exe` es del usuario (sale de un `.zip`). Un `.exe` que está corriendo no se
 *     puede sobrescribir, pero sí renombrar: el viejo pasa a `.exe.old` y el nuevo ocupa su sitio.
 *
 * La ventana que ya corre sigue con la versión anterior hasta que se cierre y se vuelva a abrir.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { latestVersion, isNewer } from '@dotrino/update'
import { pickAsset, fetchVerified } from '@dotrino/update/fetch'
import { REPO } from './update.js'

/** Este repo también lleva el agente y la PWA: las releases del escritorio van con prefijo. */
export const DESKTOP_TAG = 'desktop-v'
export const BINARY = 'dotrino-terminal-desktop'
const PRODUCT = 'dotrino-terminal-desktop'

/** @returns {any} */
const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra })

/** La última release del escritorio. `{ ok:false }` si no se pudo mirar, que NO es «al día». */
export const latestDesktop = (opts = {}) =>
  latestVersion({ source: 'github', repo: REPO, tagPrefix: DESKTOP_TAG, product: PRODUCT, ...opts })

/**
 * Cómo está instalada la app que corre desde `exe`, que es lo que decide qué archivo se baja
 * y cómo se pone. Se le pregunta al gestor de paquetes por ESE archivo: mirar solo qué
 * gestor hay se equivoca con un tarball en una máquina con `dpkg`.
 *
 * @param {any} [o]
 * @returns {any} `{ ok:true, kind:'deb'|'rpm'|'tar'|'mac'|'win', app? }` o `{ ok:false, code, reason }`
 */
export function installKind ({ exe, platform = process.platform, arch = process.arch, run = execFileSync, writable = canWrite } = {}) {
  if (!exe) return fail('no-exe', 'the desktop app was not found')
  if (platform === 'darwin') {
    const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)
    if (!m) return fail('not-a-bundle', `${exe} is not inside an .app bundle`)
    if (!writable(path.dirname(m[1]))) return fail('not-writable', `cannot write in ${path.dirname(m[1])}`)
    return { ok: true, kind: 'mac', app: m[1] }
  }
  if (platform === 'win32') {
    if (arch !== 'x64') return fail('unsupported-arch', `there is no desktop app for ${arch}`)
    if (!writable(path.dirname(exe))) return fail('not-writable', `cannot write in ${path.dirname(exe)}`)
    return { ok: true, kind: 'win' }
  }
  if (platform !== 'linux') return fail('unsupported-platform', `there is no desktop app for ${platform}`)
  if (arch !== 'x64') return fail('unsupported-arch', `there is no desktop app for ${arch}`)
  const owns = (cmd, args) => { try { run(cmd, args, { stdio: 'ignore' }); return true } catch (_) { return false } }
  if (owns('dpkg', ['-S', exe])) return { ok: true, kind: 'deb' }
  if (owns('rpm', ['-qf', exe])) return { ok: true, kind: 'rpm' }
  if (!writable(path.dirname(exe))) return fail('not-writable', `${exe} does not belong to a package and its folder is not writable`)
  return { ok: true, kind: 'tar' }
}

function canWrite (dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true } catch (_) { return false }
}

const MATCH = {
  deb: { kind: 'deb', re: /_amd64\.deb$/ },
  rpm: { kind: 'rpm', re: /\.x86_64\.rpm$/ },
  tar: { kind: 'tar', re: /-linux-x64\.tar\.gz$/ },
  mac: { kind: 'mac', re: /-macos-universal\.zip$/ },
  win: { kind: 'win', re: /-windows-x64\.zip$/ }
}

/** El archivo de la release que le toca a esa forma de instalación. */
export const assetFor = (assets, kind) => pickAsset(assets, [MATCH[kind]])

/** Como root no hace falta `sudo`; si no, se pide en la ventana. */
function asRoot (cmd, args, { run, uid }) {
  const [c, a] = uid === 0 ? [cmd, args] : ['sudo', [cmd, ...args]]
  run(c, a, { stdio: 'inherit' })
}

const has = (cmd, run) => { try { run('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true } catch (_) { return false } }

/**
 * Con qué se instala el paquete ya bajado. Se prefiere el gestor que RESUELVE dependencias
 * (`apt-get`, `dnf`, `zypper`) al que solo desempaqueta (`dpkg`, `rpm`): una versión nueva
 * puede pedir una librería que la anterior no pedía, y `rpm -U` se para ahí sin traerla.
 *
 * @returns {[string, string[]]}
 */
export function packageCommand (kind, file, { run = execFileSync } = {}) {
  if (kind === 'deb') return has('apt-get', run) ? ['apt-get', ['install', '-y', file]] : ['dpkg', ['-i', file]]
  if (has('dnf', run)) return ['dnf', ['install', '-y', file]]
  // El paquete no va firmado con una llave de rpm: lo que se comprobó es su atestación.
  if (has('zypper', run)) return ['zypper', ['--non-interactive', 'install', '--allow-unsigned-rpm', file]]
  return ['rpm', ['-U', file]]
}

/**
 * Pone el archivo ya verificado. Devuelve `{ ok:true }` o por qué no se pudo; si el archivo
 * quedó bajado y sirve para instalarlo a mano, va en `file`.
 *
 * @param {string} file
 * @param {any} how
 * @param {any} [o]
 * @returns {any}
 */
export function install (file, how, { exe, run = execFileSync, uid = process.getuid?.() } = {}) {
  if (how.kind === 'deb' || how.kind === 'rpm') {
    try { asRoot(...packageCommand(how.kind, file, { run }), { run, uid }); return { ok: true } } catch (e) {
      return fail('install-failed', `the package manager did not install it: ${e.message}`, { file })
    }
  }
  if (how.kind === 'tar') {
    const work = path.dirname(file)
    try { run('tar', ['xzf', file, '-C', work], { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (e) {
      return fail('unpack-failed', `could not unpack the release: ${String(e.stderr || e.message).trim()}`, { file })
    }
    const src = fs.readdirSync(work).map((d) => path.join(work, d, BINARY)).find((f) => fs.existsSync(f))
    if (!src) return fail('bad-tarball', `the tarball has no ${BINARY} inside`, { file })
    // Al lado y renombrado encima: nunca queda un binario a medias, y la ventana que corre
    // sigue con el suyo (el archivo viejo vive mientras alguien lo tenga abierto).
    const tmp = path.join(path.dirname(exe), `.${path.basename(exe)}.new`)
    fs.copyFileSync(src, tmp)
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, exe)
    return { ok: true }
  }
  if (how.kind === 'mac') {
    // Se desempaqueta AL LADO del .app (mismo volumen) para poder cambiarlo renombrando.
    const parent = path.dirname(how.app)
    const work = fs.mkdtempSync(path.join(parent, '.dotrino-terminal-update-'))
    try {
      run('ditto', ['-x', '-k', file, work], { stdio: ['ignore', 'ignore', 'pipe'] })
      const fresh = fs.readdirSync(work).map((d) => path.join(work, d)).find((d) => d.endsWith('.app') && fs.existsSync(path.join(d, 'Contents', 'MacOS', BINARY)))
      if (!fresh) return fail('bad-zip', `the zip has no .app with ${BINARY} inside`, { file })
      const old = path.join(work, 'old.app')
      fs.renameSync(how.app, old)
      try { fs.renameSync(fresh, how.app) } catch (e) { fs.renameSync(old, how.app); throw e }
      return { ok: true }
    } catch (e) {
      return fail('install-failed', `could not replace the app: ${String(e.stderr || e.message).trim()}`, { file })
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  }
  if (how.kind === 'win') {
    const work = path.dirname(file)
    // `tar` de Windows (bsdtar, desde Windows 10) desempaqueta un .zip.
    try { run('tar', ['-xf', file, '-C', work], { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (e) {
      return fail('unpack-failed', `could not unpack the release: ${String(e.stderr || e.message).trim()}`, { file })
    }
    const name = `${BINARY}.exe`
    const src = [path.join(work, name), ...fs.readdirSync(work).map((d) => path.join(work, d, name))].find((f) => fs.existsSync(f))
    if (!src) return fail('bad-zip', `the zip has no ${name} inside`, { file })
    // El .exe que corre no se puede pisar, pero sí apartar: la ventana abierta sigue con él. El
    // `.old` de la vez anterior se borra si ya nadie lo usa.
    const old = `${exe}.old`
    try { fs.rmSync(old, { force: true }) } catch (_) { /* aún lo usa una ventana: se queda */ }
    try {
      fs.renameSync(exe, old)
      try { fs.copyFileSync(src, exe) } catch (e) { fs.renameSync(old, exe); throw e }
    } catch (e) {
      return fail('install-failed', `could not replace the app: ${e.message}`, { file })
    }
    return { ok: true }
  }
  return fail('unknown-kind', `unknown install kind: ${how.kind}`)
}

/**
 * Todo el camino: mirar, bajar, verificar, instalar. `say(step, data)` va contando por dónde
 * va, para que quien lo enseñe lo diga en su idioma.
 *
 * @param {any} [o]
 * @returns {Promise<any>} `{ ok:true, version, updated, newer?, kind? }` o `{ ok:false, code, reason, file? }`
 */
export async function updateDesktop ({ exe, current, check = false, say = () => {}, latest = latestDesktop, fetchVerifiedImpl = fetchVerified, kindOf = installKind, installImpl = install } = {}) {
  const r = await latest({ version: current })
  if (!r.ok) return fail('could-not-check', r.reason)
  say('latest', { version: r.version, current })
  if (current && !isNewer(r.version, current)) return { ok: true, version: r.version, updated: false }
  if (check) return { ok: true, version: r.version, updated: false, newer: true }
  const how = kindOf({ exe })
  if (!how.ok) return how
  const pick = assetFor(r.assets, how.kind)
  if (!pick.ok) return fail('no-asset', pick.reason)
  say('download', { name: pick.asset.name })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotrino-terminal-update-'))
  let keep = false
  try {
    let got
    try { got = await fetchVerifiedImpl(pick.asset, { repo: REPO, product: PRODUCT, version: current, dir }) } catch (e) {
      return fail(e.code || 'download-failed', e.message)
    }
    // Lo que no pasa la verificación no se deja en el disco: nadie debe instalarlo a mano.
    if (!got.ok) return fail(got.code || 'not-verified', got.reason)
    say('verified', { name: pick.asset.name, repo: REPO })
    say('install', { kind: how.kind })
    const done = installImpl(got.file, how, { exe })
    if (!done.ok) { keep = !!done.file; return done }
    return { ok: true, version: r.version, updated: true, kind: how.kind }
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true })
  }
}

export default { packageCommand, updateDesktop, latestDesktop, installKind, assetFor, install, DESKTOP_TAG, BINARY }
