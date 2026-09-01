/**
 * QUIÉN PUEDE ABRIR SESIÓN CON UNA MÁQUINA: lo dice el ACTA, no una llave fija.
 *
 * Este repo no tenía NINGUNA prueba, y por eso sus dos verificaciones se cambiaron a ciegas
 * al mover el ecosistema a `certs-por-acta`. Lo que se fija aquí es justo lo que se cambió:
 *
 *   · un papel firmado por una SEGUNDA selladora del mismo perfil vale — antes no, porque se
 *     comparaba contra la maestra y por eso el multivault no servía de nada;
 *   · uno firmado por una llave que el acta NO nombra selladora, no vale;
 *   · sin acta no se juzga: se dice que no. Un repliegue aquí sería «no sé quién eres, pasa».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeDeviceKey, signWithDevice, signDelegationWith, verifyChain } from '@dotrino/identity/capabilities'
import { sealersOf } from '@dotrino/identity/acta'

const SIGN_SCOPE = 'vault:sign'

/** Un perfil con dos selladoras (multivault) y un aparato admitido. */
async function perfil () {
  const A = await makeDeviceKey()          // la bóveda del PC
  const B = await makeDeviceKey()          // la segunda bóveda (el teléfono)
  const D = await makeDeviceKey()          // la máquina que quiere hablar
  const acta = {
    v: 5, profileId: A.publickey, sealedBy: A.publickey, seq: 7,
    members: [
      { pub: A.publickey, caps: ['sign', 'read', 'store', 'sealer'] },
      { pub: B.publickey, caps: ['sign', 'read', 'store', 'sealer'] },
      { pub: D.publickey, caps: ['sign'] }
    ],
    renounced: []
  }
  return { A, B, D, acta, ctx: { actaSeq: acta.seq, sealers: sealersOf(acta) } }
}

/** El papel de `D`, emitido por `quien` (una selladora) contra el acta `seq`. */
async function papel (quien, D, seq, nonce) {
  const priv = await crypto.subtle.importKey('jwk', quien.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return signDelegationWith(priv, quien.publickey, { sub: D.publickey, scope: [SIGN_SCOPE], iat: Date.now(), seq, nonce })
}

/** Un handshake firmado por la máquina, como el que manda el cliente. */
async function hs (D, cert) {
  const data = { op: 'terminal.hs', publickey: D.publickey, eph: 'EPH', ts: Date.now() }
  const { signature } = await signWithDevice({ privateJwk: D.privateJwk, data })
  return { data, signature, cert }
}

test('el papel de la SEGUNDA selladora vale igual que el de la primera', async () => {
  const { A, B, D, acta, ctx } = await perfil()
  for (const [quien, nombre] of [[A, 'la del PC'], [B, 'la del teléfono']]) {
    const cert = await papel(quien, D, acta.seq, 'n-' + nombre)
    const r = await verifyChain({ ...(await hs(D, cert)), expectedScope: SIGN_SCOPE, ...ctx })
    assert.equal(r.ok, true, `${nombre}: ${r.reason}`)
  }
})

test('una llave que el acta no nombra selladora no certifica a nadie', async () => {
  const { D, acta, ctx } = await perfil()
  const intruso = await makeDeviceKey()
  const cert = await papel(intruso, D, acta.seq, 'n-x')
  const r = await verifyChain({ ...(await hs(D, cert)), expectedScope: SIGN_SCOPE, ...ctx })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'untrusted-issuer')
})

test('SIN ACTA no se abre sesión: no hay con qué decidir', async () => {
  const { A, D, acta } = await perfil()
  const cert = await papel(A, D, acta.seq, 'n-1')
  const r = await verifyChain({ ...(await hs(D, cert)), expectedScope: SIGN_SCOPE, actaSeq: null, sealers: null })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-acta', 'sin acta se dice que no, no se pasa por alto')
})
