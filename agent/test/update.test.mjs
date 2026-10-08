/**
 * LA AUTOACTUALIZACIÓN DEL AGENTE (`update.js`, CONVENCIONES §15): qué se le pasa al
 * instalador, qué se le dice a la bóveda, y que NO se reinicia con consolas abiertas.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { vaultUpdateHooks } from '@dotrino/vault/service'
import { startSelfUpdate, vaultHooks, PKG, REPO, releaseTag } from '../update.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta-update-'))
const link = { device: { publickey: 'PUB', privateJwk: {} }, cert: { seq: 3 }, iss: 'MASTER', proxy: 'wss://p.example' }
const agentWith = (n) => {
  const consoles = new Map(Array.from({ length: n }, (_, i) => [String(i), {}]))
  return { consoles: { consoles }, closed: 0, close () { this.closed++ } }
}

test('el vigilante arranca con el paquete, el repo, el tag de este repo y la carpeta de ESA instancia', () => {
  let got = null
  const dir = tmp()
  startSelfUpdate({ dir, version: '1.2.3', agent: agentWith(0), watch: (o) => { got = o; return () => {} }, hooks: { mayUpdate () {}, onUpdated () {}, onNeedsRoot () {} } })
  assert.equal(got.pkg, PKG)
  assert.equal(got.repo, REPO)
  assert.equal(got.current, '1.2.3')
  assert.equal(got.dir, dir)
  assert.equal(got.tag('0.30.0'), 'agent-v0.30.0')
  assert.equal(releaseTag('0.30.0'), 'agent-v0.30.0')
  for (const k of ['mayUpdate', 'onUpdated', 'onNeedsRoot', 'onInstalled']) assert.equal(typeof got[k], 'function', k)
})

test('instalada sin quien lo levante: no se va', () => {
  let got = null; const exits = []
  const agent = agentWith(0)
  startSelfUpdate({ dir: tmp(), version: '1.0.0', agent, exit: (c) => exits.push(c), log () {}, watch: (o) => { got = o; return () => {} }, hooks: {} })
  got.onInstalled({ version: '1.1.0', restart: false })
  assert.deepEqual(exits, [])
  assert.equal(agent.closed, 0)
})

test('instalada con supervisor y sin consolas: cierra y sale ya', () => {
  let got = null; const exits = []
  const agent = agentWith(0)
  startSelfUpdate({ dir: tmp(), version: '1.0.0', agent, exit: (c) => exits.push(c), log () {}, watch: (o) => { got = o; return () => {} }, hooks: {} })
  got.onInstalled({ version: '1.1.0', restart: true })
  assert.deepEqual(exits, [0])
  assert.equal(agent.closed, 1)
})

test('instalada con consolas abiertas: espera a que no quede ninguna', async () => {
  let got = null; const exits = []; const lines = []
  const agent = agentWith(2)
  const stop = startSelfUpdate({ dir: tmp(), version: '1.0.0', agent, exit: (c) => exits.push(c), log: (l) => lines.push(l), watch: (o) => { got = o; return () => {} }, hooks: {}, idleCheckMs: 10 })
  got.onInstalled({ version: '1.1.0', restart: true })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(exits, [], 'con consolas abiertas no se reinicia')
  assert.match(lines.join('\n'), /2 console\(s\) open/)
  agent.consoles.consoles.clear()
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(exits, [0], 'al cerrarse la última, sí')
  stop()
})

/** Los ganchos de verdad de `@dotrino/vault/service`, con la red cambiada por dobles. */
const withDoubles = (d) => (o) => vaultUpdateHooks({ ...o, _ask: d.ask, _done: d.done, _root: d.needsRoot })
const quiet = () => {}

test('a la bóveda se le habla con la conexión del enlace, leído cada vez', async () => {
  const calls = []
  let current = link
  const h = vaultHooks({
    dir: '/x', log: quiet, load: () => current,
    make: withDoubles({
      ask: async (o) => { calls.push(['ask', o]); return { ok: true, asked: true } },
      done: async (o) => { calls.push(['done', o]) },
      needsRoot: async (o) => { calls.push(['root', o]) }
    })
  })
  assert.equal(await h.mayUpdate({ version: '2.0.0', from: '1.0.0' }), true)
  await h.onUpdated({ version: '2.0.0', from: '1.0.0' })
  current = { ...link, cert: { seq: 4 } }   // el papel se renovó mientras corría
  await h.onNeedsRoot({ version: '2.0.0', from: '1.0.0' })
  assert.deepEqual(calls.map((c) => c[0]), ['ask', 'done', 'root'])
  for (const [, o] of calls) {
    assert.equal(o.product, PKG)
    assert.equal(o.version, '2.0.0')
    assert.equal(o.masterPubkey, 'MASTER')
    assert.equal(o.proxyUrl, 'wss://p.example')
  }
  assert.equal(calls[1][1].cert.seq, 3)
  assert.equal(calls[2][1].cert.seq, 4, 'usa el papel que hay AHORA en el disco')
})

test('un no es no; vencido es no; «no pude preguntar» se lanza', async () => {
  const mk = (ask) => vaultHooks({ dir: '/x', log: quiet, load: () => link, make: withDoubles({ ask }) })
  assert.equal(await mk(async () => ({ ok: false, asked: true })).mayUpdate({ version: '2.0.0' }), false)
  assert.equal(await mk(async () => { throw Object.assign(new Error('late'), { code: 'unanswered' }) }).mayUpdate({ version: '2.0.0' }), false)
  await assert.rejects(mk(async () => { throw Object.assign(new Error('down'), { code: 'vault-no-reply' }) }).mayUpdate({ version: '2.0.0' }), (e) => e.code === 'vault-no-reply')
})

test('sin enlace: no hay a quién preguntar (se lanza) ni a quién avisar (no falla)', async () => {
  const called = []
  const h = vaultHooks({ dir: '/x', log: quiet, load: () => null, make: () => { called.push('make'); return {} } })
  await assert.rejects(h.mayUpdate({ version: '2.0.0' }), (e) => e.code === 'not-linked')
  await h.onUpdated({ version: '2.0.0' })
  await h.onNeedsRoot({ version: '2.0.0' })
  assert.deepEqual(called, [])
})

test('`update` guarda los dos ajustes de esa instancia y los enseña', () => {
  const dir = tmp()
  const run = (...a) => execFileSync(process.execPath, [path.join(root, 'bin/cli.js'), 'update', '--dir', dir, ...a], { encoding: 'utf8' })
  assert.match(run(), /se actualiza solo[\s\S]*avisa cuando se actualiza/)
  assert.match(run('--approval', 'on'), /pide aprobación/)
  assert.match(run('--notify', 'off'), /no avisa/)
  const out = run()
  assert.match(out, /pide aprobación/)
  assert.match(out, /no avisa/)
  assert.throws(() => run('--approval', 'quizas'), (e) => e.status === 2)
})

test('la ayuda nombra `update` y sus dos banderas', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'bin/cli.js'), '--help'], { encoding: 'utf8' })
  assert.match(out, /update \[--name <n>\]/)
  assert.match(out, /--approval on\|off/)
  assert.match(out, /--notify on\|off/)
})
