/** «Copiar sin saltos» (src/unwrap.js) contra los casos que comparten las cuatro versiones. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { unwrap } from '../src/unwrap.js'

const vectors = JSON.parse(fs.readFileSync(new URL('./unwrap.vectors.json', import.meta.url), 'utf8'))

for (const v of vectors) {
  test(`unwrap: ${v.name}`, () => assert.equal(unwrap(v.in), v.out))
}
