import test from 'node:test'
import assert from 'node:assert/strict'
import { clipboardImage, pickImageType, parseAppleData, uploadImage, typedPath, UPLOAD_PIECE } from '../clipboard.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

test('de los tipos del portapapeles se elige el de imagen, png primero', () => {
  assert.equal(pickImageType('TARGETS\ntext/plain\nimage/jpeg\nimage/png\n'), 'image/png')
  assert.equal(pickImageType('UTF8_STRING\ntext/plain'), null)
})

test('X11: pide los tipos y después la imagen con xclip', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    return args.includes('TARGETS') ? Buffer.from('TARGETS\nimage/png\n') : PNG
  }
  const img = await clipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, run })
  assert.deepEqual(img, PNG)
  assert.deepEqual(calls, ['xclip -selection clipboard -t TARGETS -o', 'xclip -selection clipboard -t image/png -o'])
})

test('sin imagen en el portapapeles es null, no un error', async () => {
  const run = async () => Buffer.from('UTF8_STRING\ntext/plain\n')
  assert.equal(await clipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, run }), null)
  const empty = async () => { throw Object.assign(new Error('target not available'), { code: 'clipboard-empty' }) }
  assert.equal(await clipboardImage({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, run: empty }), null)
})

test('sin herramienta o sin sesión gráfica se lanza con su código', async () => {
  const missing = async () => { throw Object.assign(new Error('xclip is not installed'), { code: 'no-clipboard-tool' }) }
  await assert.rejects(clipboardImage({ platform: 'linux', env: { DISPLAY: ':0' }, run: missing }), { code: 'no-clipboard-tool' })
  await assert.rejects(clipboardImage({ platform: 'linux', env: {}, run: missing }), { code: 'no-display' })
})

test('macOS: lo que contesta osascript se pasa a bytes', () => {
  assert.deepEqual(parseAppleData('«data PNGf89504E470D0A1A0A»'), PNG.subarray(0, 8))
  assert.equal(parseAppleData(''), null)
})

test('la subida va en trozos en orden y devuelve la ruta del último', async () => {
  const bytes = Buffer.concat([PNG, Buffer.alloc(UPLOAD_PIECE * 2)])
  const seen = []
  const ask = async (m) => {
    seen.push([m.seq, !!m.last, Buffer.from(m.data, 'base64').length])
    return { type: 'filed', up: m.up, seq: m.seq, ...(m.last ? { path: '/home/x/uploads/img-1.png' } : {}) }
  }
  assert.equal(await uploadImage(ask, bytes, { id: 'u1' }), '/home/x/uploads/img-1.png')
  assert.deepEqual(seen.map((s) => s.slice(0, 2)), [[0, false], [1, false], [2, true]])
  assert.equal(seen.reduce((n, s) => n + s[2], 0), bytes.length)
})

test('un fallo de la máquina se lanza con su código', async () => {
  const ask = async () => ({ type: 'fail', code: 'too-big', message: 'too big' })
  await assert.rejects(uploadImage(ask, PNG), { code: 'too-big' })
})

test('una ruta con espacios va entre comillas', () => {
  assert.equal(typedPath('/a/b.png'), '/a/b.png')
  assert.equal(typedPath("/a b/it's.png"), "'/a b/it'\\''s.png'")
})
