#!/usr/bin/env node
/**
 * dotrino-terminal-agent — agente de Dotrino Terminal.
 *
 *   dotrino-terminal-agent            # enlaza (si falta) y CORRE el agente
 *   dotrino-terminal-agent enroll     # re-enlaza (sobrescribe) y corre el agente
 *
 * El agente es un dispositivo enrolado del vault: puede vivir en cualquier máquina.
 * Con un solo comando queda enlazado y sirviendo shells a tus dispositivos. Imprime
 * su "dirección de máquina" (pubkey), aunque aparece sola en terminal.dotrino.com.
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
  dotrino-terminal-agent            enlaza esta máquina (si falta) y corre el agente
  dotrino-terminal-agent enroll     re-enlaza (sobrescribe el enlace) y corre el agente
  opciones: [--label <nombre>] [--proxy <wss://…>] [--shell <bin>] [--dir <ruta>]

datos en ${dataDir()} (override DOTRINO_TERMINAL_DIR)`)
  process.exit(0)
}

async function doEnroll (dir) {
  console.log('Enlazar esta máquina con tu vault.')
  console.log('El código lo generas en tu bóveda. Hay dos formas:')
  console.log('  · Sin vault externo → abre https://profile.dotrino.com/#myvault,')
  console.log('    activa la bóveda y pulsa "Generar código de emparejamiento"; copia el código.')
  console.log('  · Con vault en un PC → ahí corre `dotrino-vault pair` y copia el QR/JSON.\n')
  const text = await ask('Pega el código y Enter:\n> ')
  const qr = parseQr(text)
  console.log('\nConectando…')
  await enroll({
    qr,
    dir,
    label: opt('--label') || 'terminal-agent',
    onChallenge: ({ deviceId, code }) => {
      console.log('\n  Escribe ESTE código en tu bóveda para aprobar esta máquina:')
      console.log(`    código: ${code}`)
      console.log(`    máquina: ${deviceId}`)
      console.log('    (en profile.dotrino.com/#myvault escríbelo en el campo y pulsa "Aprobar";')
      console.log(`     en el PC del vault:  dotrino-vault approve ${code})\n`)
      console.log('  Esperando aprobación…')
    }
  })
  console.log('\n  ✓ Máquina enlazada — levantando el agente…\n')
}

try {
  const dir = opt('--dir')
  // El comando por defecto enrola SOLO si aún no está enlazada; `enroll` fuerza
  // re-enrolar (sobrescribe) aunque ya lo esté. En ambos casos, al terminar sigue
  // y LEVANTA el servicio (antes moría tras enrolar y había que relanzarlo).
  if (cmd === 'enroll' || !loadLink(dir)) {
    if (cmd === 'enroll' && loadLink(dir)) console.log('Re-enlazando esta máquina (sobrescribe el enlace actual).\n')
    await doEnroll(dir)
  }

  const agent = await startAgent({
    dir, proxyUrl: opt('--proxy'), shell: opt('--shell'),
    onRevoked: () => { console.log('  Esta máquina fue revocada desde tu bóveda. Para reconectarla, vuelve a enrolarla.\n'); process.exit(0) }
  })
  console.log('\n  Dotrino Terminal — agente activo')
  console.log('  máquina:', agent.machineId)
  console.log('  dirección (pegar en la app):')
  console.log('   ', agent.machine, '\n')
  // Mantener vivo el servicio aunque stdin no sea una TTY (systemd/pm2/`nohup </dev/null`):
  // el socket del proxy está `unref`'d, así que sin este keep-alive el proceso saldría
  // justo después de arrancar. Vive hasta SIGINT/SIGTERM (o auto-borrado por revocación).
  const keepAlive = setInterval(() => {}, 1 << 30)
  const bye = () => { clearInterval(keepAlive); agent.close(); process.exit(0) }
  process.on('SIGINT', bye); process.on('SIGTERM', bye)
} catch (e) {
  console.error('error:', e.message)
  process.exit(1)
}
