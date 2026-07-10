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

// --- Preferencia de modo de la terminal (estado de UI, no del pilar) ---
// 'self' = este dispositivo es su propia bóveda (@dotrino/vault); ausente = vault externo.
const LS_MODE = 'dotrino-terminal:mode'
export function selfModeEnabled () {
  try { return localStorage.getItem(LS_MODE) === 'self' } catch { return false }
}
export function setSelfMode (on) {
  try { on ? localStorage.setItem(LS_MODE, 'self') : localStorage.removeItem(LS_MODE) } catch {}
}

/**
 * Estado del enlace de ESTE dispositivo:
 * { paired:false } o { paired:true, id, cert, iss, proxy, deviceId, scope }.
 */
export async function getLink () {
  const id = await identity()
  const status = await id.vaultStatus().catch(() => ({ paired: false }))
  if (!status.paired) return { paired: false, id }
  // Cert vencido = el vault rechazará todo ("no autorizado"): tratar como no
  // emparejado y avisar para re-conectar (profile.dotrino.com/#vault).
  if (status.exp && status.exp <= Date.now()) return { paired: false, expired: true, exp: status.exp, id }
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

/**
 * Enlace STANDALONE: este dispositivo (su identidad de navegador P) ES su propio
 * vault. No hay vault externo ni cert de dispositivo `P ← M`; en su lugar se usa un
 * self-cert `P ← P` (refrescado bajo demanda por el agente). La maestra pineada que
 * verifica el agente es la propia P. Ver @dotrino/vault (startDeviceVault).
 * @returns {Promise<{mode:'self', id:object, iss:string, proxy:string, getSelfCert:()=>Promise<object>}>}
 */
export async function getSelfLink () {
  const id = await identity()
  const iss = id.me?.publickey
  if (!iss) return { mode: 'self', id, paired: false }
  return {
    mode: 'self',
    id,
    iss,
    proxy: 'wss://proxy.dotrino.com',
    // Self-cert perezoso (lo provee @dotrino/vault#startDeviceVault). Si todavía no se
    // levantó el daemon, se genera uno fresco aquí vía signDelegation.
    async getSelfCert () {
      if (this._selfCert && this._selfCert.exp > Date.now() + 60_000) return this._selfCert
      const { cert } = await id.signDelegation(iss, 'vault:sign', { ttlMs: 24 * 60 * 60 * 1000 })
      this._selfCert = cert
      return cert
    },
    // `cert` se resuelve bajo demanda (lo usa AgentClient como fallback).
    get cert () { return this._selfCert || null }
  }
}
