/**
 * Los códigos con que fallan las preguntas sobre otras máquinas caen en su texto. El de
 * «no hay acta» lo pone `@dotrino/remote-agent/discover`, así que se prueba con el de verdad:
 * si el pilar renombra el código y aquí no se sigue, el usuario vería el mensaje crudo.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { listAgentsByLabel } from '@dotrino/remote-agent/discover'
import { farMessage } from '../far-messages.js'

const t = (es, en) => en
const ME = 'BME' + 'x'.repeat(84)

test('sin acta de la bóveda: el código de discover tiene su explicación', async () => {
  const mute = { me: { publickey: ME }, listVaultDevices: async () => { throw new Error('the vault did not answer') }, profileActa: async () => null }
  const e = await listAgentsByLabel(mute, 'terminal-agent').then(() => null, (err) => err)
  assert.ok(e, 'sin acta no se contesta «ninguno»')
  assert.equal(farMessage({ code: e.code, message: e.message }, t),
    'could not ask your vault which machines you have. Check that it is on and that this machine is online.')
})

test('un código desconocido se enseña crudo, con su motivo', () => {
  assert.equal(farMessage({ code: 'weird', message: 'boom' }, t), 'boom (weird)')
})
