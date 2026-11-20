/**
 * run.js — una orden suelta en esta máquina, sin consola: `dotrino-terminal run -- <orden>`.
 *
 * Una consola es un PTY: lo que sale va mezclado con el eco, los colores y el prompt, y no hay
 * código de salida. Para que un programa (o un asistente) ejecute algo en otra máquina de la
 * cuenta y lea el resultado, aquí la orden corre en la shell de la máquina SIN PTY: la salida
 * normal y la de errores llegan aparte, tal cual (bytes, en base64), y al final el código.
 *
 * Pasa por los mismos mostradores que abrir una consola (el permiso `terminal` del acta y la
 * clave de la máquina): quien puede abrir una shell aquí puede correr una orden, y nadie más.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

/** La shell de las consolas de esta máquina. */
export const defaultShell = () => process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')

/** Lo que cabe en un mensaje del canal directo (64 KiB) ya pasado a base64, con margen. */
const PIECE = 32 * 1024

/**
 * Cómo se le pasa una orden a cada shell.
 * @param {string} shell
 * @param {string} cmd
 * @returns {string[]}
 */
export function shellArgs (shell, cmd) {
  const name = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, '')
  if (name === 'powershell' || name === 'pwsh') {
    // Por una tubería PowerShell 5.1 escribe en la página de códigos de la consola (850, 437…):
    // las tildes llegaban rotas. Y su código de salida es 0 o 1: se devuelve el del programa.
    const wrapped = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${cmd}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapped]
  }
  if (name === 'cmd') return ['/d', '/s', '/c', cmd]
  return ['-c', cmd]
}

/**
 * Corre una orden. `onOut` recibe los trozos (ya en base64) y `onExit` el final: el código, o
 * la señal que la paró, o el error si ni siquiera arrancó.
 * @param {{ cmd: string, cwd: string, shell?: string,
 *   onOut: (stream: 'out' | 'err', data: string) => void,
 *   onExit: (r: { code: number | null, signal?: string | null, error?: string }) => void }} o
 * @returns {{ kill: () => void }}
 */
export function startRun ({ cmd, cwd, shell = defaultShell(), onOut, onExit }) {
  let done = false
  /** @param {{ code: number | null, signal?: string | null, error?: string }} r */
  const end = (r) => { if (!done) { done = true; onExit(r) } }
  const child = spawn(shell, shellArgs(shell, cmd), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  for (const stream of /** @type {const} */ (['out', 'err'])) {
    child[stream === 'out' ? 'stdout' : 'stderr'].on('data', (/** @type {Buffer} */ b) => {
      for (let i = 0; i < b.length; i += PIECE) onOut(stream, b.subarray(i, i + PIECE).toString('base64'))
    })
  }
  child.on('error', (e) => end({ code: null, error: e.message }))
  child.on('close', (code, signal) => end({ code, signal }))
  return { kill: () => { if (!done) child.kill() } }
}
