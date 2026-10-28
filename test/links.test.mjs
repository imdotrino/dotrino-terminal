/**
 * La regla de enlaces y rutas (src/links.js). Los casos están en `links.vectors.json` y son los
 * mismos que prueban el escritorio, Android e iOS.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { findLinks, linkAt, mimeOf } from '../src/links.js'

const vectors = JSON.parse(fs.readFileSync(new URL('./links.vectors.json', import.meta.url), 'utf8'))

for (const v of vectors) {
  test(`enlaces en: ${v.line}`, () => {
    const got = findLinks(v.line).map(({ text, kind, target, start }) => ({ text, kind, target, start }))
    assert.deepEqual(got, v.links)
  })
}

test('linkAt da el que pasa por la columna', () => {
  assert.equal(linkAt('ver /tmp/a.pdf ya', 6).target, '/tmp/a.pdf')
  assert.equal(linkAt('ver /tmp/a.pdf ya', 1), null)
})

test('el tipo sale de la extensión', () => {
  assert.equal(mimeOf('a.PDF'), 'application/pdf')
  assert.equal(mimeOf('a'), 'application/octet-stream')
})
