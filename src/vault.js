/**
 * vault.js — el enlace de este dispositivo al vault vive en el PILAR de
 * identidad (`@dotrino/identity`, iframe id.dotrino.com), el MISMO que usa
 * `profile.dotrino.com/#vault` para emparejar. La terminal ya NO mantiene un
 * enrolamiento propio en localStorage (el viejo `vaultLink.js`): un solo
 * emparejamiento sirve para todo el ecosistema.
 *
 * La sub-clave del dispositivo es la propia identidad del navegador (P), con
 * cert `P ← maestra` emitido al emparejar. Firmar = `id.signData` (dentro del
 * iframe; la privada nunca sale). El agente verifica la cadena con
 * `verifyChain` + scope `vault:sign`, exactamente igual que antes.
 */
import { Identity } from '@dotrino/identity'

let _id = null

export async function identity () {
  if (!_id) _id = await Identity.connect()
  return _id
}

/**
 * Estado del enlace de ESTE dispositivo:
 * { paired:false } o { paired:true, id, cert, iss, proxy, deviceId, scope }.
 */
export async function getLink () {
  const id = await identity()
  const status = await id.vaultStatus().catch(() => ({ paired: false }))
  if (!status.paired) return { paired: false, id }
  const v = await id.getVaultCert().catch(() => null)
  if (!v?.cert) return { paired: false, id }
  return {
    paired: true,
    id,
    cert: v.cert,
    iss: status.master,
    proxy: status.proxy || 'wss://proxy.dotrino.com',
    deviceId: status.deviceId,
    scope: status.scope || []
  }
}

/** Desvincula este dispositivo (borra sub-clave + cert en el iframe de identidad). */
export async function unpair () {
  const id = await identity()
  return id.unpairDevice()
}
