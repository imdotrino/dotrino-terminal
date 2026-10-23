// Checks the store listings against the length limits of Google Play and App Store Connect.
//   node store/check.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Límite por tipo de campo (caracteres), tal como lo cuentan las consolas.
const LIMITS = {
  'play.short': 80,
  'play.full': 4000,
  'appstore.subtitle': 30,
  'appstore.promo': 170,
  'appstore.keywords': 100,
  'appstore.description': 4000,
}

let failed = false
for (const name of ['listing.md']) {
  const text = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
  const parts = text.split(/^### (\S+)\s*$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i]
    const kind = key.replace(/\.(es|en)$/, '')
    const limit = LIMITS[kind]
    if (!limit) { console.error(`${name}: unknown field ${key}`); failed = true; continue }
    const body = parts[i + 1].split(/^## /m)[0].trim()
    const len = [...body].length
    const ok = len <= limit
    if (!ok) failed = true
    console.log(`${ok ? 'ok  ' : 'LONG'} ${name} ${key}: ${len}/${limit}`)
  }
}
process.exit(failed ? 1 : 0)
