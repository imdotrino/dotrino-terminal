#!/usr/bin/env node
/**
 * dotrino-terminal-agent — agente de Dotrino Terminal.
 *
 *   dotrino-terminal-agent enroll     # enlaza ESTA máquina con tu vault (una vez)
 *   dotrino-terminal-agent            # corre el agente (abre shells para tus dispositivos)
 *
 * El agente es un dispositivo enrolado del vault: puede vivir en cualquier
 * máquina. Imprime la "dirección de máquina" (su pubkey) que pegás en el cliente
 * terminal.dotrino.com para conectarte a ESTA máquina.
 */
import readline from 'node:readline'
import { startAgent } from '../index.js'
import { enroll, parseQr, loadLink, dataDir } from '../link.js'

const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'run'
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

function ask (q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a) }))
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`uso:
  dotrino-terminal-agent enroll [--label <nombre>]   enlaza esta máquina con el vault
  dotrino-terminal-agent [--proxy <wss://…>] [--shell <bin>] [--dir <ruta>]   corre el agente

datos en ${dataDir()} (override DOTRINO_TERMINAL_DIR)`)
  process.exit(0)
}

try {
  if (cmd === 'enroll') {
    console.log('Enlazar esta máquina con tu vault.')
    console.log('En la máquina del vault: `dotrino-vault pair` y copiá el QR/JSON.\n')
    const text = await ask('Pegá el QR/JSON del vault y Enter:\n> ')
    const qr = parseQr(text)
    console.log('\nConectando al vault…')
    const link = await enroll({
      qr,
      dir: opt('--dir'),
      label: opt('--label') || 'terminal-agent',
      onChallenge: ({ deviceId, sas }) => {
        console.log('\n  Compará que este código coincida y aprobalo EN EL VAULT:')
        console.log(`    código: ${sas}`)
        console.log(`    máquina ${deviceId}`)
        console.log(`    en el PC del vault:  dotrino-vault approve ${sas}\n`)
        console.log('  Esperando aprobación…')
      }
    })
    console.log('\n  ✓ Máquina enlazada. Dirección de máquina (pegala en la app):\n')
    console.log('   ', link.device.publickey, '\n')
    console.log('  Ahora corré:  dotrino-terminal-agent\n')
    process.exit(0)
  }

  if (!loadLink(opt('--dir'))) {
    console.error('esta máquina no está enlazada. Corré primero: dotrino-terminal-agent enroll')
    process.exit(1)
  }
  const agent = await startAgent({
    dir: opt('--dir'), proxyUrl: opt('--proxy'), shell: opt('--shell')
  })
  console.log('\n  Dotrino Terminal — agente activo')
  console.log('  máquina:', agent.machineId)
  console.log('  dirección (pegar en la app):')
  console.log('   ', agent.machine, '\n')
  const bye = () => { agent.close(); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
} catch (e) {
  console.error('error:', e.message)
  process.exit(1)
}
