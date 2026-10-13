/**
 * claude.js — que Claude Code mantenga al día la tarjeta «de qué va» de su consola.
 *
 * `dotrino-terminal claude` deja en la carpeta de Claude Code del usuario (`~/.claude`):
 *   · el skill `dotrino-terminal-note` (cómo se usa `dotrino-terminal note --task`);
 *   · tres hooks, y sus entradas en `settings.json`: uno recuerda la tarjeta en cada mensaje, otro
 *     apunta qué herramientas se usan, y el tercero no deja terminar un turno con la tarjeta vieja.
 * `--off` quita exactamente eso. Fuera de una consola de Dotrino Terminal los hooks no hacen nada.
 *
 * Es la misma idea que `editors.js` con VS Code: una orden que se puede repetir y deshacer, y que
 * no toca lo demás del archivo del usuario.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL = 'dotrino-terminal-note'
/** Cada hook: su archivo y el evento de Claude Code en que corre. */
export const HOOKS = [
  { file: 'terminal-note.sh', event: 'UserPromptSubmit' },
  { file: 'terminal-note-track.sh', event: 'PreToolUse' },
  { file: 'terminal-note-stop.sh', event: 'Stop' },
]

const fail = (code, message) => Object.assign(new Error(message), { code })
const source = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills')

/** ¿Es `command` el hook `file`? Por el archivo, lo llame como lo llame (con o sin comillas). */
const runs = (command, file) => typeof command === 'string' && new RegExp(`[/\\\\]hooks[/\\\\]${file.replace(/\./g, '\\.')}(["'\\s]|$)`).test(command)

function readSettings (file) {
  if (!fs.existsSync(file)) return {}
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw fail('bad-settings', `${file}: ${e.message}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('bad-settings', `${file}: not an object`)
  return value
}

/** `settings` sin las entradas de nuestros hooks (y sin los grupos o eventos que queden vacíos). */
function withoutHooks (settings) {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') return settings
  const out = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[event] = groups; continue }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !HOOKS.some((x) => runs(h?.command, x.file))) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length)
    if (kept.length) out[event] = kept
  }
  const next = { ...settings, hooks: out }
  if (!Object.keys(out).length) delete next.hooks
  return next
}

/** ¿Está puesto? `{ skill, hooks: [archivos presentes], wired: [archivos con entrada en settings] }`. */
export function claudeStatus ({ home = os.homedir() } = {}) {
  const dir = path.join(home, '.claude')
  let settings = {}
  try { settings = readSettings(path.join(dir, 'settings.json')) } catch (_) {}
  const commands = Object.values(settings.hooks || {}).flat().flatMap((g) => g?.hooks || []).map((h) => h?.command)
  return {
    skill: fs.existsSync(path.join(dir, 'skills', SKILL, 'SKILL.md')),
    hooks: HOOKS.filter((h) => fs.existsSync(path.join(dir, 'hooks', h.file))).map((h) => h.file),
    wired: HOOKS.filter((h) => commands.some((c) => runs(c, h.file))).map((h) => h.file),
  }
}

/**
 * Pone (o con `off`, quita) el skill y los hooks. Devuelve qué cambió.
 * Sin `~/.claude` no hay Claude Code en esta cuenta: se dice (`no-claude`) y no se crea nada.
 * Un `settings.json` que no se puede leer no se toca (`bad-settings`).
 */
export function configureClaude ({ off = false, home = os.homedir(), from = source() } = {}) {
  const dir = path.join(home, '.claude')
  if (!fs.existsSync(dir)) throw fail('no-claude', `${dir} does not exist`)
  const settingsFile = path.join(dir, 'settings.json')
  const before = readSettings(settingsFile)
  const skillDir = path.join(dir, 'skills', SKILL)
  const hooksDir = path.join(dir, 'hooks')

  // Lo que ya está enganchado (lo llame como lo llame) se deja como está: no se duplica ni se mueve.
  const wired = (file) => Object.values(before.hooks || {}).flat().flatMap((g) => g?.hooks || []).some((h) => runs(h?.command, file))
  let next = before
  if (off) next = withoutHooks(before)
  else {
    const hooks = { ...(before.hooks || {}) }
    for (const h of HOOKS.filter((x) => !wired(x.file))) {
      const file = path.join(hooksDir, h.file)
      const command = `bash ${/\s/.test(file) ? JSON.stringify(file) : file}`
      hooks[h.event] = [...(Array.isArray(hooks[h.event]) ? hooks[h.event] : []), { hooks: [{ type: 'command', command, timeout: 5 }] }]
    }
    next = { ...before, hooks }
  }
  const settingsChanged = JSON.stringify(before) !== JSON.stringify(next)

  let filesChanged = false
  if (off) {
    for (const h of HOOKS) { const f = path.join(hooksDir, h.file); if (fs.existsSync(f)) { fs.rmSync(f); filesChanged = true } }
    if (fs.existsSync(skillDir)) { fs.rmSync(skillDir, { recursive: true }); filesChanged = true }
  } else {
    const put = (src, dest, mode) => {
      const want = fs.readFileSync(src)
      if (fs.existsSync(dest) && fs.readFileSync(dest).equals(want)) return
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, want, { mode })
      fs.chmodSync(dest, mode)
      filesChanged = true
    }
    put(path.join(from, SKILL, 'SKILL.md'), path.join(skillDir, 'SKILL.md'), 0o644)
    for (const h of HOOKS) put(path.join(from, 'hooks', h.file), path.join(hooksDir, h.file), 0o755)
  }
  if (settingsChanged) {
    // De una vez (temporal + renombrar): Claude Code lee este archivo en cada sesión.
    const tmp = `${settingsFile}.dotrino-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
    fs.renameSync(tmp, settingsFile)
  }
  return { changed: settingsChanged || filesChanged, settings: settingsFile, skill: skillDir, hooks: HOOKS.map((h) => path.join(hooksDir, h.file)) }
}
