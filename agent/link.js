/**
 * link.js — el enlace de esta máquina con la bóveda. Todo lo hace
 * `@dotrino/remote-agent/link` (que a su vez usa `enrollWithVault`, el único
 * enrolamiento headless del ecosistema), y DÓNDE vive lo decide el estándar
 * `@dotrino/remote-agent/instances`: `~/.dotrino/agent/terminal-agent/<nombre>/`.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { enroll as raEnroll, loadLink as raLoad, parseQr } from '@dotrino/remote-agent/link'
import { resolveInstance, instancesRoot, isValidName, DEFAULT_NAME } from '@dotrino/remote-agent/instances'
import { deviceInfo } from '@dotrino/vault/device-info'

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

function ask (q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a) }))
}

/**
 * Enlaza la carpeta `dir` con la bóveda, preguntando en la terminal: la invitación de
 * `dotrino-vault pair` y, mientras se espera, el código que hay que aprobar. Lo usan el
 * agente (`dotrino-terminal-agent enroll`) y las ventanas (`dotrino-terminal link`).
 */
export async function linkInteractive (dir) {
  if (!process.stdin.isTTY) {
    throw new Error('this machine is not linked, and linking needs an interactive terminal. Run it once in a terminal, then start it as a service.')
  }
  console.log('Enlazar esta máquina con tu bóveda.')
  console.log('En el PC de tu bóveda corre `dotrino-vault pair` y copia la invitación.\n')
  const qr = await parseQr(await ask('Pega la invitación y pulsa Enter:\n> '))
  console.log('\nConectando…')
  await enroll({
    qr,
    dir,
    onChallenge: ({ deviceId, code }) => {
      console.log('\n  Escribe ESTE código en tu bóveda para aprobar esta máquina:')
      console.log(`    código:  ${code}`)
      console.log(`    máquina: ${deviceId}`)
      console.log(`    (en el PC de la bóveda:  dotrino-vault approve ${code})\n`)
      console.log('  Esperando la aprobación…')
    }
  })
  console.log('\n  ✓ Máquina enlazada.\n')
}

/**
 * Los PERFILES de esta máquina: cada carpeta de agente de terminal, enlazada o no. Uno sin
 * enlazar atiende solo a las ventanas locales. Si no hay ninguno, sale `default` sin enlazar,
 * que es el que usa `dotrino-terminal` a secas.
 *
 * @returns {Promise<Array<{ name: string, dir: string, linked: boolean, id: string|null, vault: string|null, scope: string[] }>>}
 */
export async function listProfiles () {
  const root = instancesRoot(LABEL)
  let names = []
  try { names = fs.readdirSync(root).filter((n) => isValidName(n) && fs.statSync(path.join(root, n)).isDirectory()) } catch (_) {}
  if (!names.length) names = [DEFAULT_NAME]
  const out = []
  for (const name of names.sort()) {
    const dir = path.join(root, name)
    const link = raLoad(dir)
    const info = link ? await deviceInfo(link) : null
    out.push({ name, dir, linked: !!info, id: info?.id || null, vault: info?.vault || null, scope: info?.scope || [] })
  }
  return out
}
