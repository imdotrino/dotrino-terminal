/**
 * La terminal EMBEBIDA de VS Code (y sus variantes) como ventana de Dotrino Terminal.
 *
 * `dotrino-terminal vscode` escribe en el `settings.json` del usuario un perfil de terminal
 * «Dotrino» que corre este mismo cliente, y lo deja por defecto: cada pestaña del panel pasa a
 * ser una consola del agente, que se puede retomar desde los otros aparatos de la cuenta.
 *
 * El perfil apunta a Node y al script por su ruta, no al `dotrino-terminal` del PATH: un editor
 * lanzado desde el escritorio no hereda el PATH de la shell (nvm), y ahí el `#!/usr/bin/env node`
 * no encuentra con qué correr.
 *
 * `settings.json` es JSON con comentarios: se edita con `jsonc-parser` (el del propio VS Code),
 * que toca solo las claves que cambian y deja lo demás, comentarios incluidos, como estaba.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, modify, applyEdits, printParseErrorCode } from 'jsonc-parser'

export const PROFILE = 'Dotrino'

/** Las carpetas de configuración que se buscan, por nombre del editor. */
export const EDITORS = [
  { name: 'VS Code', dir: 'Code' },
  { name: 'VS Code Insiders', dir: 'Code - Insiders' },
  { name: 'VSCodium', dir: 'VSCodium' },
  { name: 'Cursor', dir: 'Cursor' },
]

/** Un error con `code`: quien lo recibe decide por el código, no por la frase. */
const fail = (code, message) => Object.assign(new Error(message), { code })

/** `linux` u `osx`: el sufijo de las claves de terminal de VS Code. Otro sistema no se atiende. */
export function platformKey (platform = process.platform) {
  if (platform === 'linux') return 'linux'
  if (platform === 'darwin') return 'osx'
  throw fail('unsupported-platform', `unsupported platform: ${platform}`)
}

/** Donde los editores guardan lo del usuario. */
export function configBase ({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support')
  return env.XDG_CONFIG_HOME || path.join(home, '.config')
}

/** Los editores instalados: los que tienen su carpeta `User`. */
export function findEditors (base = configBase()) {
  return EDITORS
    .map((e) => ({ ...e, settings: path.join(base, e.dir, 'User', 'settings.json') }))
    .filter((e) => fs.existsSync(path.dirname(e.settings)))
}

/** El perfil de terminal: Node, el script del cliente y, si se pidió, el perfil de Dotrino. */
export function terminalProfile ({ node, script, name }) {
  return { path: node, args: name ? [script, '--name', name] : [script] }
}

function check (text, file) {
  const errors = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || (text.trim() && (typeof value !== 'object' || value === null || Array.isArray(value)))) {
    const why = errors.length ? `${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}` : 'not an object'
    throw fail('bad-settings', `${file}: ${why}`)
  }
  return value || {}
}

const formatting = (text) => ({ formattingOptions: /\n\t/.test(text) ? { insertSpaces: false, tabSize: 1 } : { insertSpaces: true, tabSize: 2 } })

function set (text, keyPath, value) {
  return applyEdits(text, modify(text, keyPath, value, formatting(text)))
}

/**
 * El texto de `settings.json` con el perfil puesto (`profile`) o quitado (`profile: null`).
 * Al quitar, el perfil por defecto solo se toca si era el nuestro.
 */
export function applyToSettings (text, { profile, platform = platformKey(), file = 'settings.json' }) {
  const src = text.trim() ? text : '{}\n'
  const current = check(src, file)
  const profilesKey = `terminal.integrated.profiles.${platform}`
  const defaultKey = `terminal.integrated.defaultProfile.${platform}`
  if (profile) {
    return set(set(src, [profilesKey, PROFILE], profile), [defaultKey], PROFILE)
  }
  let out = src
  const profiles = current[profilesKey]
  if (profiles && typeof profiles === 'object' && PROFILE in profiles) {
    // Si era el único, se va la clave entera: no se deja un objeto vacío.
    out = Object.keys(profiles).length === 1 ? set(out, [profilesKey], undefined) : set(out, [profilesKey, PROFILE], undefined)
  }
  if (current[defaultKey] === PROFILE) out = set(out, [defaultKey], undefined)
  return out
}

/**
 * Lo aplica a cada editor instalado. Devuelve `[{ name, settings, changed }]`. Sin ninguno,
 * lanza `no-editor`; un `settings.json` que no se puede leer lanza `bad-settings` y no se toca.
 */
export function configureEditors ({ profile, base = configBase(), platform = platformKey() }) {
  const editors = findEditors(base)
  if (!editors.length) throw fail('no-editor', `no editor found under ${base}`)
  // Primero se calcula todo: si uno falla, no se deja a medias a los demás.
  const plan = editors.map((ed) => {
    const before = fs.existsSync(ed.settings) ? fs.readFileSync(ed.settings, 'utf8') : ''
    return { ...ed, before, after: applyToSettings(before, { profile, platform, file: ed.settings }) }
  })
  return plan.map(({ name, settings, before, after }) => {
    const changed = after !== before && !(profile === null && !before.trim())
    if (changed) fs.writeFileSync(settings, after)
    return { name, settings, changed }
  })
}
