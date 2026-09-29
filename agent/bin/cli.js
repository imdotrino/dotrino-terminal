#!/usr/bin/env node
/**
 * dotrino-terminal-agent — agente de Dotrino Terminal.
 *
 *   dotrino-terminal-agent            # enlaza (si falta) y CORRE el agente
 *   dotrino-terminal-agent enroll     # re-enlaza (sobrescribe) y corre el agente
 *
 * El agente es un aparato más de tu cuenta: puede vivir en cualquier máquina. Con un
 * solo comando queda enlazado y aparece solo en terminal.dotrino.com.
 */
import readline from 'node:readline'
import { createRequire } from 'node:module'
import { watchForUpdate } from '@dotrino/update'
import { startAgent } from '../index.js'
import { enroll, parseQr, loadLink, dataDir } from '../link.js'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')
const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'run'
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

function ask (q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a) }))
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`uso:
  dotrino-terminal-agent            enlaza esta máquina (si falta) y corre el agente
  dotrino-terminal-agent enroll     re-enlaza (sobrescribe el enlace) y corre el agente
  opciones: [--proxy <wss://…>] [--shell <bin>] [--dir <ruta>]

datos en ${dataDir()} (override DOTRINO_TERMINAL_DIR)`)
  process.exit(0)
}

async function doEnroll (dir) {
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
  console.log('\n  ✓ Máquina enlazada. Levantando el agente…\n')
}

try {
  const dir = opt('--dir')
  // Sin `enroll`, enlaza solo si aún no lo está; `enroll` re-enlaza aunque ya lo esté.
  // En los dos casos sigue y LEVANTA el servicio.
  if (cmd === 'enroll' || !loadLink(dir)) {
    if (cmd === 'enroll' && loadLink(dir)) console.log('Re-enlazando esta máquina (sobrescribe el enlace actual).\n')
    await doEnroll(dir)
  }

  const agent = await startAgent({
    dir, proxyUrl: opt('--proxy'), shell: opt('--shell'),
    onRevoked: () => { console.log('  Esta máquina se quitó de tu bóveda. Para volver a usarla, enlázala otra vez.\n'); process.exit(0) }
  })
  console.log('\n  Dotrino Terminal — agente activo')
  console.log('  versión:', VERSION)
  console.log('  máquina:', agent.machineId, '\n')
  // §15: una vez al día mira si hay versión nueva y lo dice. Solo avisa: instalar lo decide una persona.
  watchForUpdate({
    current: VERSION, source: 'npm', pkg: '@dotrino/terminal-agent',
    onNewer: (r) => console.log(`[terminal-agent] version ${r.version} is available (running ${r.current}): npx @dotrino/terminal-agent@latest`)
  })
  // Mantener vivo el servicio aunque stdin no sea una TTY (systemd/pm2/`nohup </dev/null`):
  // el socket del proxio va `unref`'d, así que sin esto el proceso saldría al arrancar.
  const keepAlive = setInterval(() => {}, 1 << 30)
  const bye = () => { clearInterval(keepAlive); agent.close(); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
} catch (e) {
  console.error('error:', e.message)
  process.exit(1)
}
