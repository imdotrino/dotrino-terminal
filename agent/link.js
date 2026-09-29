/**
 * link.js — el enlace de esta máquina con la bóveda. Todo lo hace
 * `@dotrino/remote-agent/link` (que a su vez usa `enrollWithVault`, el único
 * enrolamiento headless del ecosistema), y DÓNDE vive lo decide el estándar
 * `@dotrino/remote-agent/instances`: `~/.dotrino/agent/terminal-agent/<nombre>/`.
 */
import { enroll as raEnroll, loadLink as raLoad, parseQr } from '@dotrino/remote-agent/link'
import { resolveInstance } from '@dotrino/remote-agent/instances'

export { parseQr }

/** El tipo de este agente: lo contesta al ping y da nombre a la carpeta de sus enlaces. */
export const LABEL = 'terminal-agent'

/**
 * La carpeta del enlace. `DOTRINO_TERMINAL_DIR` fuerza una concreta (un contenedor); si no,
 * la de la instancia `name` (sin nombre se busca y solo se exige con empate).
 */
export function dataDir (name) {
  if (process.env.DOTRINO_TERMINAL_DIR) return process.env.DOTRINO_TERMINAL_DIR
  return resolveInstance(LABEL, name).dir
}

export const loadLink = (dir = dataDir()) => raLoad(dir)

/**
 * Enrola esta máquina con la invitación de la bóveda (cualquiera de sus formas).
 * @param {{ qr:object|string, dir?:string, label?:string, onChallenge?:(c:{deviceId:string,code:string})=>void }} args
 */
export function enroll ({ qr, dir = dataDir(), label = LABEL, onChallenge }) {
  return raEnroll({ qr, dir, label, onChallenge })
}
