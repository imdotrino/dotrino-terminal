/**
 * link.js — el enlace de esta máquina con la bóveda. Todo lo hace
 * `@dotrino/remote-agent/link` (que a su vez usa `enrollWithVault`, el único
 * enrolamiento headless del ecosistema); aquí solo se decide DÓNDE vive el enlace.
 */
import path from 'node:path'
import os from 'node:os'
import { enroll as raEnroll, loadLink as raLoad, parseQr } from '@dotrino/remote-agent/link'

export { parseQr }

/** Label con el que se enrola y con el que la app encuentra las máquinas. */
export const LABEL = 'terminal-agent'

/** `~/.local/share/dotrino-terminal-agent` (override `DOTRINO_TERMINAL_DIR`). */
export function dataDir () {
  if (process.env.DOTRINO_TERMINAL_DIR) return process.env.DOTRINO_TERMINAL_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'dotrino-terminal-agent')
}

export const loadLink = (dir = dataDir()) => raLoad(dir)

/**
 * Enrola esta máquina con la invitación de la bóveda (cualquiera de sus formas).
 * @param {{ qr:object|string, dir?:string, label?:string, onChallenge?:(c:{deviceId:string,code:string})=>void }} args
 */
export function enroll ({ qr, dir = dataDir(), label = LABEL, onChallenge }) {
  return raEnroll({ qr, dir, label, onChallenge })
}
