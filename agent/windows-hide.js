/**
 * En Windows el agente corre SIN consola (lo lanza suelto una ventana o el supervisor). Todo
 * proceso de consola que lance sin `windowsHide` abre una ventana propia, y con Windows Terminal
 * como terminal por defecto esa ventana sale al frente aunque dure un instante. Pasaba al cerrar
 * cada consola: `node-pty` lanza `conpty_console_list_agent` con `fork()` sin `windowsHide`.
 *
 * Aquí `child_process` pone `windowsHide: true` por defecto en todo lo que lanza el agente
 * (lo suyo y lo de sus dependencias), salvo que la llamada diga otra cosa. Solo se carga en el
 * proceso del agente: el cliente corre en una TTY y sus hijos tienen que compartirla.
 */
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

/**
 * Los argumentos tras el primero (`[args?, opts?, cb?]`, o `[opts?, cb?]` en `exec`), con
 * `windowsHide: true` en las opciones si no lo traen.
 * @param {unknown[]} rest
 * @returns {unknown[]}
 */
export function withHide (rest) {
  const out = [...rest]
  const i = Array.isArray(out[0]) || (out[0] == null && out.length > 1) ? 1 : 0
  const o = out[i]
  if (o == null) out.splice(i, out.length > i ? 1 : 0, { windowsHide: true })
  else if (typeof o === 'function') out.splice(i, 0, { windowsHide: true })
  else if (typeof o === 'object' && !('windowsHide' in o)) out[i] = { ...o, windowsHide: true }
  return out
}

if (process.platform === 'win32') {
  const c = /** @type {Record<string, Function>} */ (/** @type {unknown} */ (cp))
  for (const name of ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    const orig = c[name]
    c[name] = function (/** @type {unknown} */ first, /** @type {unknown[]} */ ...rest) { return orig.call(this, first, ...withHide(rest)) }
  }
  // Los `import { spawn } from 'node:child_process'` ya hechos ven la versión nueva.
  syncBuiltinESMExports()
}
