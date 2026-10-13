/**
 * `dotrino-terminal claude`: el skill y los hooks que hacen que Claude Code mantenga la tarjeta de
 * su consola. Se pone y se quita sin tocar lo demás de `~/.claude/settings.json`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { configureClaude, claudeStatus, HOOKS, SKILL } from '../claude.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '../bin/terminal.js')
const home = (settings) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-claude-'))
  fs.mkdirSync(path.join(h, '.claude'))
  if (settings !== undefined) fs.writeFileSync(path.join(h, '.claude/settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2))
  return h
}
const read = (h) => JSON.parse(fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8'))

test('pone el skill, los tres hooks y sus entradas; repetirlo no cambia nada', () => {
  const h = home()
  const first = configureClaude({ home: h })
  assert.equal(first.changed, true)
  assert.ok(fs.existsSync(path.join(h, '.claude/skills', SKILL, 'SKILL.md')))
  for (const k of HOOKS) assert.ok(fs.statSync(path.join(h, '.claude/hooks', k.file)).mode & 0o100, `${k.file} se puede ejecutar`)
  const s = read(h)
  for (const k of HOOKS) assert.equal(s.hooks[k.event].length, 1, k.event)
  assert.match(s.hooks.Stop[0].hooks[0].command, /^bash .*\/\.claude\/hooks\/terminal-note-stop\.sh$/)
  assert.deepEqual(claudeStatus({ home: h }), { skill: true, hooks: HOOKS.map((k) => k.file), wired: HOOKS.map((k) => k.file) })
  const before = fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8')
  assert.equal(configureClaude({ home: h }).changed, false)
  assert.equal(fs.readFileSync(path.join(h, '.claude/settings.json'), 'utf8'), before)
})

test('conserva lo del usuario, no duplica un hook que ya estaba puesto a mano, y quitarlo deja solo lo suyo', () => {
  const mine = { type: 'command', command: 'ffplay /home/x/alert.mp3' }
  const byHand = { type: 'command', command: 'bash /home/x/.claude/hooks/terminal-note-stop.sh', timeout: 5 }
  const h = home({ model: 'opus', hooks: { Stop: [{ hooks: [byHand] }, { hooks: [mine] }], Notification: [{ hooks: [mine] }] } })
  configureClaude({ home: h })
  let s = read(h)
  assert.equal(s.model, 'opus')
  assert.deepEqual(s.hooks.Stop, [{ hooks: [byHand] }, { hooks: [mine] }], 'el que ya estaba no se duplica ni se mueve')
  assert.equal(s.hooks.UserPromptSubmit.length, 1)
  assert.deepEqual(s.hooks.Notification, [{ hooks: [mine] }])

  assert.equal(configureClaude({ home: h, off: true }).changed, true)
  s = read(h)
  assert.deepEqual(s, { model: 'opus', hooks: { Stop: [{ hooks: [mine] }], Notification: [{ hooks: [mine] }] } })
  assert.equal(fs.existsSync(path.join(h, '.claude/skills', SKILL)), false)
  for (const k of HOOKS) assert.equal(fs.existsSync(path.join(h, '.claude/hooks', k.file)), false)
  assert.equal(configureClaude({ home: h, off: true }).changed, false, 'quitarlo dos veces no cambia nada')
})

test('sin Claude Code en la cuenta se dice; un settings.json ilegible no se toca', () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-claude-'))
  assert.throws(() => configureClaude({ home: none }), (e) => e.code === 'no-claude')
  assert.equal(fs.existsSync(path.join(none, '.claude')), false, 'y no se crea nada')
  const bad = home('{ not json')
  assert.throws(() => configureClaude({ home: bad }), (e) => e.code === 'bad-settings')
  assert.equal(fs.readFileSync(path.join(bad, '.claude/settings.json'), 'utf8'), '{ not json')
  assert.equal(fs.existsSync(path.join(bad, '.claude/hooks')), false)
})

test('los hooks: callan fuera de una consola; dentro, recuerdan la tarjeta y no dejan terminar con ella vieja', () => {
  const h = home()
  configureClaude({ home: h })
  // Un `dotrino-terminal` cualquiera en el PATH: los hooks solo miran que exista.
  const bin = path.join(h, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'dotrino-terminal'), '#!/bin/sh\n', { mode: 0o755 })
  const run = (file, input, console_ = 'c1') => spawnSync('bash', [path.join(h, '.claude/hooks', file)], {
    input, encoding: 'utf8',
    env: { HOME: h, PATH: `${bin}:${process.env.PATH}`, ...(console_ ? { DOTRINO_TERMINAL_CONSOLE: console_ } : {}) }
  })
  const tool = (name, command = '') => JSON.stringify({ tool_name: name, tool_input: { command } })
  assert.equal(run('terminal-note.sh', '{}', null).stdout, '', 'fuera de una consola no dice nada')
  assert.equal(run('terminal-note-stop.sh', '{}', null).status, 0)

  assert.match(run('terminal-note.sh', '{}').stdout, /dotrino-terminal note --task/)
  assert.equal(run('terminal-note-stop.sh', '{}').status, 0, 'un turno sin herramientas: la tarjeta sigue valiendo')
  run('terminal-note-track.sh', tool('Edit'))
  const stale = run('terminal-note-stop.sh', '{}')
  assert.equal(stale.status, 2, 'se usó una herramienta y la tarea no se puso después')
  assert.match(stale.stderr, /quedó vieja/)
  assert.equal(run('terminal-note-stop.sh', '{"stop_hook_active":true}').status, 0, 'una sola vez por parada')
  run('terminal-note-track.sh', tool('Bash', "dotrino-terminal note --task 'hecho'"))
  assert.equal(run('terminal-note-stop.sh', '{}').status, 0, 'puesta la tarea después de la última herramienta')
  run('terminal-note-track.sh', tool('Bash', 'ls'))
  assert.equal(run('terminal-note-stop.sh', '{}').status, 2, 'y otra herramienta después la vuelve vieja')
})

test('la orden: `dotrino-terminal claude` y `claude --off`', () => {
  const h = home()
  const run = (...a) => spawnSync(process.execPath, [CLIENT, 'claude', ...a], { env: { ...process.env, HOME: h, DOTRINO_NO_UPDATE_NOTICE: '1' }, encoding: 'utf8' })
  const on = run()
  assert.equal(on.status, 0, on.stderr)
  assert.equal(claudeStatus({ home: h }).wired.length, 3)
  assert.equal(run('--off').status, 0)
  assert.deepEqual(claudeStatus({ home: h }), { skill: false, hooks: [], wired: [] })
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-claude-'))
  assert.equal(spawnSync(process.execPath, [CLIENT, 'claude'], { env: { ...process.env, HOME: none, DOTRINO_NO_UPDATE_NOTICE: '1' }, encoding: 'utf8' }).status, 1)
})
