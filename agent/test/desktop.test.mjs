/**
 * Actualizar la app de escritorio: qué archivo le toca a cada forma de instalación, y que
 * nada se instala sin verificar. Sin red y sin tocar el sistema: todo va inyectado.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { installKind, assetFor, install, packageCommand, updateDesktop, BINARY } from '../desktop.js'

const ASSETS = ['dotrino-terminal-desktop-0.3.0-1.x86_64.rpm', 'dotrino-terminal-desktop-0.3.0-linux-x64.tar.gz', 'dotrino-terminal-desktop-0.3.0-macos-universal.zip', 'dotrino-terminal-desktop_0.3.0-1_amd64.deb', 'dotrino-terminal-desktop-0.3.0-windows-x64.zip'].map((name) => ({ name, url: `https://x/${name}` }))
const owner = (who) => (cmd) => { if (cmd !== who) throw new Error('not mine') }

test('la forma de instalación sale de a quién pertenece el binario', () => {
  const exe = '/usr/bin/dotrino-terminal-desktop'
  assert.equal(installKind({ exe, platform: 'linux', arch: 'x64', run: owner('dpkg') }).kind, 'deb')
  assert.equal(installKind({ exe, platform: 'linux', arch: 'x64', run: owner('rpm') }).kind, 'rpm')
  // Un tarball en una máquina con dpkg: el binario no es de ningún paquete.
  assert.equal(installKind({ exe: '/home/u/bin/x', platform: 'linux', arch: 'x64', run: owner('nobody'), writable: () => true }).kind, 'tar')
  assert.equal(installKind({ exe, platform: 'linux', arch: 'x64', run: owner('nobody'), writable: () => false }).code, 'not-writable')
  assert.equal(installKind({ exe, platform: 'linux', arch: 'arm64' }).code, 'unsupported-arch')
  const mac = installKind({ exe: '/Applications/Dotrino Terminal.app/Contents/MacOS/dotrino-terminal-desktop', platform: 'darwin', writable: () => true })
  assert.deepEqual([mac.kind, mac.app], ['mac', '/Applications/Dotrino Terminal.app'])
  assert.equal(installKind({ exe: '/tmp/dotrino-terminal-desktop', platform: 'darwin' }).code, 'not-a-bundle')
  assert.equal(installKind({ exe: null }).code, 'no-exe')
  assert.equal(installKind({ exe: 'C:\\Users\\u\\Dotrino\\dotrino-terminal-desktop.exe', platform: 'win32', arch: 'x64', writable: () => true }).kind, 'win')
  assert.equal(installKind({ exe: 'C:\\Program Files\\x.exe', platform: 'win32', arch: 'x64', writable: () => false }).code, 'not-writable')
})

test('cada forma baja su archivo', () => {
  assert.match(assetFor(ASSETS, 'deb').asset.name, /_amd64\.deb$/)
  assert.match(assetFor(ASSETS, 'rpm').asset.name, /\.x86_64\.rpm$/)
  assert.match(assetFor(ASSETS, 'tar').asset.name, /\.tar\.gz$/)
  assert.match(assetFor(ASSETS, 'mac').asset.name, /-macos-universal\.zip$/)
  assert.match(assetFor(ASSETS, 'win').asset.name, /-windows-x64\.zip$/)
  assert.equal(assetFor([], 'deb').ok, false)
})

test('un paquete se instala con el gestor que resuelve dependencias, con sudo salvo root', () => {
  // `tiene`: qué gestores hay en esa máquina.
  const maquina = (tiene) => {
    const calls = []
    const run = (c, a) => {
      if (c === 'sh') { if (!tiene.includes(a[1].replace('command -v ', ''))) throw new Error('no'); return }
      calls.push([c, ...a].join(' '))
    }
    return { calls, run }
  }
  const debian = maquina(['apt-get'])
  assert.equal(install('/t/a.deb', { kind: 'deb' }, { run: debian.run, uid: 1000 }).ok, true)
  assert.deepEqual(debian.calls, ['sudo apt-get install -y /t/a.deb'])
  const fedora = maquina(['dnf'])
  assert.equal(install('/t/a.rpm', { kind: 'rpm' }, { run: fedora.run, uid: 0 }).ok, true)
  assert.deepEqual(fedora.calls, ['dnf install -y /t/a.rpm'], 'como root, sin sudo')
  assert.deepEqual(packageCommand('rpm', '/t/a.rpm', { run: maquina(['zypper']).run }), ['zypper', ['--non-interactive', 'install', '--allow-unsigned-rpm', '/t/a.rpm']])
  // Sin ninguno de los que resuelven, el que desempaqueta.
  assert.deepEqual(packageCommand('rpm', '/t/a.rpm', { run: maquina([]).run }), ['rpm', ['-U', '/t/a.rpm']])
  assert.deepEqual(packageCommand('deb', '/t/a.deb', { run: maquina([]).run }), ['dpkg', ['-i', '/t/a.deb']])
  const bad = install('/t/a.deb', { kind: 'deb' }, { run: (c) => { if (c !== 'sh') throw new Error('exit 1') }, uid: 1000 })
  assert.deepEqual([bad.ok, bad.code, bad.file], [false, 'install-failed', '/t/a.deb'])
})

test('el tarball cambia el binario del usuario de una vez', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'))
  const exe = path.join(dir, 'bin', BINARY)
  fs.mkdirSync(path.dirname(exe)); fs.writeFileSync(exe, 'old')
  const pack = path.join(dir, 'pack', 'dotrino-terminal-desktop-0.3.0-linux-x64')
  fs.mkdirSync(pack, { recursive: true }); fs.writeFileSync(path.join(pack, BINARY), 'new')
  const work = path.join(dir, 'work'); fs.mkdirSync(work)
  const file = path.join(work, 'a.tar.gz')
  execFileSync('tar', ['czf', file, '-C', path.join(dir, 'pack'), '.'])
  assert.equal(install(file, { kind: 'tar' }, { exe }).ok, true)
  assert.equal(fs.readFileSync(exe, 'utf8'), 'new')
  assert.equal(fs.statSync(exe).mode & 0o111, 0o111)
  assert.deepEqual(fs.readdirSync(path.dirname(exe)), [BINARY], 'no queda el temporal')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('al día no baja nada, y «no se pudo mirar» no es «al día»', async () => {
  const never = async () => { throw new Error('should not download') }
  const same = await updateDesktop({ exe: '/x', current: '0.3.0', latest: async () => ({ ok: true, version: '0.3.0', assets: ASSETS }), fetchVerifiedImpl: never })
  assert.deepEqual([same.ok, same.updated], [true, false])
  const unknown = await updateDesktop({ exe: '/x', current: '0.3.0', latest: async () => ({ ok: false, reason: 'timed out' }), fetchVerifiedImpl: never })
  assert.deepEqual([unknown.ok, unknown.code], [false, 'could-not-check'])
  const check = await updateDesktop({ exe: '/x', current: '0.2.0', check: true, latest: async () => ({ ok: true, version: '0.3.0', assets: ASSETS }), fetchVerifiedImpl: never })
  assert.deepEqual([check.updated, check.newer], [false, true])
})

test('lo que no pasa la verificación no se instala ni se queda en el disco', async () => {
  let installed = false; let where
  const r = await updateDesktop({
    exe: '/usr/bin/x', current: '0.2.0',
    latest: async () => ({ ok: true, version: '0.3.0', assets: ASSETS }),
    kindOf: () => ({ ok: true, kind: 'deb' }),
    fetchVerifiedImpl: async (asset, { dir }) => { where = dir; fs.writeFileSync(path.join(dir, asset.name), 'x'); return { ok: false, code: 'BAD_SIGNATURE', reason: 'nope', file: path.join(dir, asset.name) } },
    installImpl: () => { installed = true; return { ok: true } }
  })
  assert.deepEqual([r.ok, r.code, r.file, installed], [false, 'BAD_SIGNATURE', undefined, false])
  assert.equal(fs.existsSync(where), false)
})

test('verificado: se instala el archivo de esa máquina', async () => {
  const steps = []; let got
  const r = await updateDesktop({
    exe: '/usr/bin/x', current: '0.2.0', say: (s) => steps.push(s),
    latest: async () => ({ ok: true, version: '0.3.0', assets: ASSETS }),
    kindOf: () => ({ ok: true, kind: 'rpm' }),
    fetchVerifiedImpl: async (asset, { repo, dir }) => { assert.equal(repo, 'imdotrino/dotrino-terminal'); return { ok: true, file: path.join(dir, asset.name) } },
    installImpl: (file, how) => { got = [path.basename(file), how.kind]; return { ok: true } }
  })
  assert.deepEqual([r.ok, r.updated, r.version], [true, true, '0.3.0'])
  assert.deepEqual(got, ['dotrino-terminal-desktop-0.3.0-1.x86_64.rpm', 'rpm'])
  assert.deepEqual(steps, ['latest', 'download', 'verified', 'install'])
})

test('Windows: el .exe que corre se aparta a .exe.old y el nuevo ocupa su sitio', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'win-app-'))
  const exe = path.join(app, `${BINARY}.exe`)
  fs.writeFileSync(exe, 'viejo')
  fs.writeFileSync(`${exe}.old`, 'de antes')
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'win-dl-'))
  const file = path.join(dl, 'x-windows-x64.zip')
  fs.writeFileSync(file, 'zip')
  // `tar` falso: deja el .exe nuevo dentro de su carpeta, como el .zip de la release.
  const run = (cmd, args) => {
    assert.deepEqual([cmd, args[0]], ['tar', '-xf'])
    fs.mkdirSync(path.join(dl, 'dotrino-terminal-desktop-0.3.0-windows-x64'))
    fs.writeFileSync(path.join(dl, 'dotrino-terminal-desktop-0.3.0-windows-x64', `${BINARY}.exe`), 'nuevo')
  }
  assert.deepEqual(install(file, { kind: 'win' }, { exe, run }), { ok: true })
  assert.equal(fs.readFileSync(exe, 'utf8'), 'nuevo')
  assert.equal(fs.readFileSync(`${exe}.old`, 'utf8'), 'viejo')
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'win-dl-'))
  fs.writeFileSync(path.join(empty, 'y.zip'), 'zip')
  assert.equal(install(path.join(empty, 'y.zip'), { kind: 'win' }, { exe, run: () => {} }).code, 'bad-zip')
  for (const d of [app, dl, empty]) fs.rmSync(d, { recursive: true, force: true })
})
