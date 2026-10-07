/**
 * `dotrino-terminal vscode`: el perfil de terminal «Dotrino» en el `settings.json` de los
 * editores. Lo que no puede pasar: perder los comentarios o las claves del usuario, tocar un
 * archivo que no se entiende, o llevarse al deshacer un perfil por defecto que no era el nuestro.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'jsonc-parser'
import { applyToSettings, configureEditors, findEditors, terminalProfile, configBase, platformKey, PROFILE } from '../editors.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '../bin/terminal.js')
const profile = terminalProfile({ node: '/usr/bin/node', script: '/opt/terminal.js', name: 'casa' })

const base = (...editors) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-'))
  for (const e of editors) fs.mkdirSync(path.join(dir, e, 'User'), { recursive: true })
  return dir
}

test('el perfil corre Node con el script, y el perfil de Dotrino solo si se pidió', () => {
  assert.deepEqual(profile, { path: '/usr/bin/node', args: ['/opt/terminal.js', '--name', 'casa'] })
  assert.deepEqual(terminalProfile({ node: '/n', script: '/s' }), { path: '/n', args: ['/s'] })
})

test('poner el perfil conserva los comentarios y las demás claves', () => {
  const before = `{
  // mi tema
  "workbench.colorTheme": "Solarized", /* fijo */
  "terminal.integrated.profiles.linux": {
    "zsh": { "path": "/bin/zsh" },
  },
}
`
  const after = applyToSettings(before, { profile, platform: 'linux' })
  assert.match(after, /\/\/ mi tema/)
  assert.match(after, /\/\* fijo \*\//)
  const v = parse(after, [], { allowTrailingComma: true })
  assert.equal(v['workbench.colorTheme'], 'Solarized')
  assert.deepEqual(v['terminal.integrated.profiles.linux'].zsh, { path: '/bin/zsh' })
  assert.deepEqual(v['terminal.integrated.profiles.linux'][PROFILE], profile)
  assert.equal(v['terminal.integrated.defaultProfile.linux'], PROFILE)
})

test('en macOS las claves son las de osx', () => {
  const v = parse(applyToSettings('', { profile, platform: 'osx' }))
  assert.deepEqual(v['terminal.integrated.profiles.osx'][PROFILE], profile)
  assert.equal(v['terminal.integrated.defaultProfile.osx'], PROFILE)
  assert.equal(platformKey('darwin'), 'osx')
  assert.throws(() => platformKey('win32'), (e) => e.code === 'unsupported-platform')
})

test('poner dos veces deja el mismo texto', () => {
  const once = applyToSettings('{}', { profile, platform: 'linux' })
  assert.equal(applyToSettings(once, { profile, platform: 'linux' }), once)
})

test('quitar deja el archivo como estaba', () => {
  const before = '{\n  // nota\n  "editor.fontSize": 14\n}\n'
  const off = applyToSettings(applyToSettings(before, { profile, platform: 'linux' }), { profile: null, platform: 'linux' })
  assert.deepEqual(parse(off), { 'editor.fontSize': 14 })
  assert.match(off, /\/\/ nota/)
})

test('quitar no se lleva los otros perfiles ni un perfil por defecto que no es el nuestro', () => {
  const before = JSON.stringify({
    'terminal.integrated.profiles.linux': { zsh: { path: '/bin/zsh' }, [PROFILE]: profile },
    'terminal.integrated.defaultProfile.linux': 'zsh',
  }, null, 2)
  const v = parse(applyToSettings(before, { profile: null, platform: 'linux' }))
  assert.deepEqual(v['terminal.integrated.profiles.linux'], { zsh: { path: '/bin/zsh' } })
  assert.equal(v['terminal.integrated.defaultProfile.linux'], 'zsh')
})

test('un settings.json que no se entiende no se toca', () => {
  const dir = base('Code', 'Cursor')
  const bad = path.join(dir, 'Cursor/User/settings.json')
  fs.writeFileSync(bad, '{ "a": ')
  assert.throws(() => configureEditors({ profile, base: dir, platform: 'linux' }), (e) => e.code === 'bad-settings')
  assert.equal(fs.readFileSync(bad, 'utf8'), '{ "a": ')
  // Y el que sí se entendía tampoco quedó a medias.
  assert.equal(fs.existsSync(path.join(dir, 'Code/User/settings.json')), false)
  assert.throws(() => applyToSettings('[1]', { profile, platform: 'linux' }), (e) => e.code === 'bad-settings')
})

test('configura cada editor instalado, y solo esos', () => {
  const dir = base('Code', 'VSCodium')
  assert.deepEqual(findEditors(dir).map((e) => e.name), ['VS Code', 'VSCodium'])
  const done = configureEditors({ profile, base: dir, platform: 'linux' })
  assert.deepEqual(done.map((d) => [d.name, d.changed]), [['VS Code', true], ['VSCodium', true]])
  for (const d of done) assert.equal(parse(fs.readFileSync(d.settings, 'utf8'))['terminal.integrated.defaultProfile.linux'], PROFILE)
  assert.deepEqual(configureEditors({ profile, base: dir, platform: 'linux' }).map((d) => d.changed), [false, false])
  assert.deepEqual(configureEditors({ profile: null, base: dir, platform: 'linux' }).map((d) => d.changed), [true, true])
})

test('sin ningún editor se dice, y quitar donde no había nada no crea el archivo', () => {
  assert.throws(() => configureEditors({ profile, base: base(), platform: 'linux' }), (e) => e.code === 'no-editor')
  const dir = base('Code')
  assert.deepEqual(configureEditors({ profile: null, base: dir, platform: 'linux' }).map((d) => d.changed), [false])
  assert.equal(fs.existsSync(path.join(dir, 'Code/User/settings.json')), false)
})

test('la carpeta de configuración: XDG en Linux, Application Support en macOS', () => {
  assert.equal(configBase({ platform: 'linux', home: '/h', env: {} }), '/h/.config')
  assert.equal(configBase({ platform: 'linux', home: '/h', env: { XDG_CONFIG_HOME: '/x' } }), '/x')
  assert.equal(configBase({ platform: 'darwin', home: '/h', env: {} }), '/h/Library/Application Support')
})

test('la orden: escribe el perfil con la ruta de este Node y de este script', { skip: process.platform !== 'linux' }, () => {
  const dir = base('Code')
  const env = { ...process.env, XDG_CONFIG_HOME: dir, DOTRINO_NO_UPDATE_NOTICE: '1', LANG: 'en_US.UTF-8', LC_ALL: '' }
  const run = (...a) => spawnSync(process.execPath, [CLIENT, 'vscode', ...a], { env, encoding: 'utf8' })
  const on = run('--name', 'casa')
  assert.equal(on.status, 0, on.stderr)
  assert.match(on.stdout, /VS Code\s+configured/)
  const v = parse(fs.readFileSync(path.join(dir, 'Code/User/settings.json'), 'utf8'))
  assert.deepEqual(v['terminal.integrated.profiles.linux'][PROFILE], { path: process.execPath, args: [fs.realpathSync(CLIENT), '--name', 'casa'] })
  assert.match(run('--off').stdout, /VS Code\s+removed/)
  assert.equal(run('--name', '../x').status, 1)
  const none = spawnSync(process.execPath, [CLIENT, 'vscode'], { env: { ...env, XDG_CONFIG_HOME: base() }, encoding: 'utf8' })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /could not find/)
})
