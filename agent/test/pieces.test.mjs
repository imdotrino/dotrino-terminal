/**
 * Nada de lo que el agente manda a un aparato puede pasar de 64 KiB por el canal directo: werift
 * rechaza el mensaje («max-message-size exceeded») y el pilar lo manda por el proxio, que llega
 * DESPUÉS del siguiente mensaje pequeño que sí fue directo. Así llegaba desordenado el historial
 * en la tablet (2026-10-15). Se mide lo que de verdad viaja: el sobre sellado de remote-agent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pieces, PIECE_JSON_MAX } from '../consoles.js'
// `e2e.js` no está en el mapa de exports del paquete: se llega por su ruta, al lado de `index.js`.
const { seal } = await import(new URL('../node_modules/@dotrino/remote-agent/e2e.js', import.meta.url).href)

/** El tope de werift y libwebrtc cuando el otro lado no anuncia más (`DEFAULT_MAX_MESSAGE_SIZE`). */
const DIRECT_MAX = 65536

async function sealedSize (payload) {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt'])
  const env = await seal(key, payload)
  return Buffer.byteLength(JSON.stringify({ type: 'data', sid: 'x'.repeat(16), env }))
}

test('un trozo de pantalla sellado cabe en un mensaje del canal directo, también lleno de escapes', async () => {
  // Lo peor para el JSON: casi todo escapes (6 bytes cada ESC) y acentos (2-3 bytes).
  const screens = [
    '\x1b[32m● \x1b[0mBash(\x1b[1mcmd\x1b[0m) \x1b[2m… +5 líneas\x1b[0m\r\n'.repeat(3000),
    '\x1b[38;2;10;20;30m'.repeat(20000),
    'ñandú 😀 "comillas" \\barras\\ \t\n'.repeat(8000)
  ]
  for (const s of screens) {
    const parts = pieces(s)
    assert.equal(parts.join(''), s, 'se reconstruye entero')
    assert.ok(parts.length > 1, 'hay varios trozos')
    for (const data of parts) {
      assert.ok(Buffer.byteLength(JSON.stringify(data)) <= PIECE_JSON_MAX + 2)
      const n = await sealedSize({ type: 'replay', id: 'c'.repeat(16), data, last: false })
      assert.ok(n < DIRECT_MAX, `sellado mide ${n} ≥ ${DIRECT_MAX}`)
    }
  }
})

test('no parte un emoji por la mitad ni devuelve trozos vacíos', () => {
  const s = '😀'.repeat(30000)
  const parts = pieces(s)
  assert.equal(parts.join(''), s)
  for (const p of parts) {
    assert.ok(p.length > 0)
    assert.ok(!/[\ud800-\udbff]$/.test(p), 'ningún trozo acaba en media pareja')
  }
  assert.deepEqual(pieces(''), [''])
  assert.deepEqual(pieces('hola'), ['hola'])
})
