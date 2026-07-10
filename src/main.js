/**
 * main.js — UI de Dotrino Terminal. Tres estados:
 *   1. Sin vault/enlace → pasos: instala el vault y conecta este dispositivo
 *      desde profile.dotrino.com/#vault (emparejamiento estándar del ecosistema).
 *   2. Enlazado → abre una o varias shells en tus máquinas, cifradas punto a punto.
 * El enlace vive en el pilar de identidad (ver vault.js), NO en esta app.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import '@dotrino/topbar' // barra superior estándar (marca+volver+idioma+perfil+support)
import { avatarDataUri, pubkeyId } from '@dotrino/identity/capabilities'
import { createVaultProfileProvider } from '@dotrino/profile'
import { createVaultReputation } from '@dotrino/reputation'
import { startDeviceVault } from '@dotrino/vault'
import { getLink, getSelfLink, identity, selfModeEnabled, setSelfMode } from './vault.js'
import { AgentClient } from './agentClient.js'
import { qrSvg } from './qr.js'

// ---------- i18n (bilingüe es/en, §9) ----------
const M = {
  es: {
    linked_title: 'Conecta tu bóveda',
    need_vault: 'Dotrino Terminal abre una consola en tus máquinas. Para entrar, este dispositivo debe estar conectado a tu bóveda (tu certificador personal).',
    step1: '1 · Instala la bóveda en tu PC desde',
    step2: '2 · Conecta este dispositivo (escanea el QR de <code>dotrino-vault pair</code>) en',
    step3: '3 · Vuelve aquí y pulsa:',
    recheck: 'Ya lo conecté',
    checking: 'Comprobando…',
    still_not: 'Este dispositivo aún no está conectado a una bóveda.',
    expired: (d) => `Tu conexión con la bóveda <b>venció</b> (${d}). Vuelve a conectar este dispositivo (paso 2).`,
    cancel: 'Cancelar',
    install: 'Instalar',
    machines_title: 'Tus máquinas',
    machines_loading: 'Buscando tus máquinas…',
    machines_none: 'Aún no tienes ninguna máquina con el agente instalado.',
    machines_err: 'No se pudo consultar tu bóveda (¿está encendida?).',
    machine_online: 'En línea',
    machine_offline: 'Desconectada',
    machine_checking: 'Comprobando…',
    machine_remove: 'Quitar',
    remove_confirm: (dev) => `¿Quitar la máquina <code>${dev}</code>? Se revoca su acceso; para reconectarla tendrás que enrolarla de nuevo.`,
    setup_title: 'Instala el agente en la máquina que quieres controlar',
    setup_body: 'En esa máquina (servidor, otra PC…), pega esto y listo:',
    install_alt: 'O, si ya tienes Node 20+:',
    install_win: 'En Windows (PowerShell):',
    setup_s1: 'Enlázala a tu bóveda: te pedirá el código de <code>dotrino-vault pair</code> (en el PC de tu bóveda) y su aprobación.',
    setup_s2: 'Déjalo corriendo. La máquina aparecerá aquí sola, en "Tus máquinas".',
    linked_to: (dev) => `Dispositivo <code>${dev}</code> conectado a tu bóveda · abre una o varias consolas en tus máquinas.`,
    connecting: (a) => `Conectando a ${a}…`,
    connected: (a) => `Conectado a ${a}`,
    conn_fail: 'No se pudo conectar: ',
    error: 'Error: ',
    close: 'Cerrar',
    my_profile: 'Mi perfil',
    self_choice_title: '¿Cómo quieres entrar?',
    self_choice_intro: 'Para abrir una consola en tus máquinas necesitas certificarlas con una identidad. Elige dónde vive esa identidad:',
    self_choice_vault: 'Conectar tu bóveda',
    self_choice_vault_d: 'Tienes un vault (PC/servidor). Centraliza tu identidad en él.',
    self_choice_self: 'Usar este dispositivo como bóveda',
    self_choice_self_d: 'Sin vault: la identidad de este navegador certifica tus máquinas directamente.',
    self_active: (dev) => `La identidad de este navegador (<code>${dev}</code>) es tu bóveda. Enlaza tus máquinas abajo y abre consolas en ellas.`,
    self_pair_title: 'Enlaza una máquina',
    self_pair_body: 'En la máquina destino (servidor, otra PC…), pega esto y listo:',
    self_pair_step1: '1 · Pega este código al enrolar el agente (o pégalo después):',
    self_pair_step2: '2 · Cuando la máquina se conecte, escribe aquí el código de 6 dígitos que <b>ella</b> muestra y apruébala.',
    self_pair_wait: 'Esperando a que la máquina se conecte…',
    self_pair_again: 'Generar otro código',
    self_pair_new: 'Enlazar otra máquina',
    self_empty: 'Aún no tienes máquinas enlazadas. Genera un código arriba y enrólalo en la máquina destino.',
    self_pending: (dev) => `La máquina <code>${dev}</code> pide acceso. Escribe el código que <b>muestra la máquina</b> para aprobarla:`,
    self_code_ph: 'Código de 6 dígitos',
    self_approve: 'Aprobar',
    self_reject: 'Rechazar',
    self_approved: (dev) => `Máquina <code>${dev}</code> enlazada.`,
    self_rejected: 'Emparejamiento rechazado.',
    self_qr_alt: 'Copia este código y pégalo en el agente',
    self_back_vault: 'Usar una bóveda externa',
    self_copy: 'Copiar',
    self_copied: 'Copiado',
    self_start_daemon: 'Activando modo dispositivo…',
    self_no_identity: 'Aún no tienes identidad. Crea una en',
    self_proxy_err: 'No se pudo conectar con el transporte (proxy). Inténtalo de nuevo.'
  },
  en: {
    linked_title: 'Connect your vault',
    need_vault: 'Dotrino Terminal opens a console on your machines. To get in, this device must be connected to your vault (your personal certifier).',
    step1: '1 · Install the vault on your PC from',
    step2: '2 · Connect this device (scan the QR from <code>dotrino-vault pair</code>) at',
    step3: '3 · Come back here and press:',
    recheck: 'I connected it',
    checking: 'Checking…',
    still_not: 'This device is not connected to a vault yet.',
    expired: (d) => `Your vault connection <b>expired</b> (${d}). Connect this device again (step 2).`,
    cancel: 'Cancel',
    install: 'Install',
    machines_title: 'Your machines',
    machines_loading: 'Looking for your machines…',
    machines_none: 'You have no machine with the agent installed yet.',
    machines_err: 'Could not reach your vault (is it on?).',
    machine_online: 'Online',
    machine_offline: 'Offline',
    machine_checking: 'Checking…',
    machine_remove: 'Remove',
    remove_confirm: (dev) => `Remove machine <code>${dev}</code>? Its access is revoked; to reconnect it you'll need to enroll it again.`,
    setup_title: 'Install the agent on the machine you want to control',
    setup_body: 'On that machine (a server, another PC…), paste this and you\'re set:',
    install_alt: 'Or, if you already have Node 20+:',
    install_win: 'On Windows (PowerShell):',
    setup_s1: 'Link it to your vault: it will ask for the code from <code>dotrino-vault pair</code> (on your vault PC) and its approval.',
    setup_s2: 'Leave it running. The machine will show up here by itself, under "Your machines".',
    linked_to: (dev) => `Device <code>${dev}</code> connected to your vault · open one or more consoles on your machines.`,
    connecting: (a) => `Connecting to ${a}…`,
    connected: (a) => `Connected to ${a}`,
    conn_fail: 'Could not connect: ',
    error: 'Error: ',
    close: 'Close',
    my_profile: 'My profile',
    self_choice_title: 'How do you want to sign in?',
    self_choice_intro: 'To open a console on your machines you need to certify them with an identity. Choose where that identity lives:',
    self_choice_vault: 'Connect your vault',
    self_choice_vault_d: 'You have a vault (PC/server). It centralizes your identity.',
    self_choice_self: 'Use this device as its own vault',
    self_choice_self_d: 'No vault: this browser\'s identity certifies your machines directly.',
    self_active: (dev) => `This browser's identity (<code>${dev}</code>) is your vault. Link your machines below and open consoles on them.`,
    self_pair_title: 'Link a machine',
    self_pair_body: 'On the target machine (a server, another PC…), paste this and you\'re set:',
    self_pair_step1: '1 · Paste this code when enrolling the agent (or paste it later):',
    self_pair_step2: '2 · When the machine connects, type here the 6-digit code <b>it</b> shows and approve it.',
    self_pair_wait: 'Waiting for the machine to connect…',
    self_pair_again: 'Generate another code',
    self_pair_new: 'Link another machine',
    self_empty: 'You have no machines linked yet. Generate a code above and enroll it on the target machine.',
    self_pending: (dev) => `Machine <code>${dev}</code> is requesting access. Type the code <b>shown on the machine</b> to approve it:`,
    self_code_ph: '6-digit code',
    self_approve: 'Approve',
    self_reject: 'Reject',
    self_approved: (dev) => `Machine <code>${dev}</code> linked.`,
    self_rejected: 'Pairing rejected.',
    self_qr_alt: 'Copy this code and paste it into the agent',
    self_back_vault: 'Use an external vault',
    self_copy: 'Copy',
    self_copied: 'Copied',
    self_start_daemon: 'Activating device mode…',
    self_no_identity: 'You have no identity yet. Create one at',
    self_proxy_err: 'Could not reach the transport (proxy). Try again.'
  }
}
// Idioma: lo gobierna <dotrino-topbar> (clave compartida del ecosistema
// 'dotrino.lang'); aquí solo reflejamos su valor para traducir el contenido.
const topbar = document.getElementById('topbar')
let lang = 'es'
try { lang = (localStorage.getItem('dotrino.lang') || (navigator.language || 'es').slice(0, 2)) === 'en' ? 'en' : 'es' } catch {}
const t = (k, ...a) => { const v = M[lang][k]; return typeof v === 'function' ? v(...a) : v }
topbar.addEventListener('dotrino-lang', (e) => { lang = e.detail.lang; render() })

const app = document.getElementById('app')

// --- Instalar (PWA): botón propio en el slot "end" del topbar ---
let deferredPrompt = null
const installBtn = document.getElementById('installBtn')
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false })
window.addEventListener('appinstalled', () => { installBtn.hidden = true; deferredPrompt = null })
installBtn.addEventListener('click', async () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; installBtn.hidden = true } })

function el (html) { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Comandos para instalar/correr el agente en la máquina destino. El one-liner
// curl/irm (instalador universal hosteado en dotrino.com) baja Node si falta →
// "pega y ya"; npx queda como alternativa si ya tienes Node. Mismo instalador
// reutilizable por cualquier app del ecosistema (solo cambia el paquete).
const AGENT_PKG = '@dotrino/terminal-agent'
function installCmds (sub) {
  const arg = sub ? ' ' + sub : ''
  const sh = `curl -fsSL https://dotrino.com/install.sh | sh -s -- ${AGENT_PKG}${arg}`
  const ps = `& ([scriptblock]::Create((irm https://dotrino.com/install.ps1))) ${AGENT_PKG}${arg}`
  const npx = `npx ${AGENT_PKG}${arg}`
  // Cada comando en su propio bloque copiable (mismo formato para los tres).
  return `<pre><code>${esc(sh)}</code></pre>
      <p class="status">${t('install_win')}</p>
      <pre><code>${esc(ps)}</code></pre>
      <p class="status">${t('install_alt')}</p>
      <pre><code>${esc(npx)}</code></pre>`
}

// Confirmación con modal propio (nunca confirm() del navegador — §5). Devuelve bool.
function confirmModal (html, { okText, danger = false } = {}) {
  return new Promise((resolve) => {
    const back = el(`<div class="modal-back"><div class="card modal">
      <p>${html}</p>
      <div class="modal-row">
        <button class="ghost" data-cancel>${esc(t('cancel'))}</button>
        <button class="primary${danger ? ' danger' : ''}" data-ok>${esc(okText || t('machine_remove'))}</button>
      </div></div></div>`)
    const done = (v) => { back.remove(); resolve(v) }
    back.querySelector('[data-ok]').addEventListener('click', () => done(true))
    back.querySelector('[data-cancel]').addEventListener('click', () => done(false))
    back.addEventListener('click', (e) => { if (e.target === back) done(false) })
    document.body.appendChild(back)
  })
}

// Sonda de presencia (liveness) por ping/pong: manda un ping a cada pubkey por el
// cliente del proxy y marca online las que responden `terminal.pong` dentro del
// timeout. Definitivo (round-trip real), sin abrir sesión. Devuelve Set de pubkeys online.
const PROBE = { PING: 'terminal.ping', PONG: 'terminal.pong' }
function probeOnline (client, subs, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!client || !subs || !subs.length) return resolve(new Set())
    const nonceToSub = new Map()
    const online = new Set()
    const off = client.on('message', (_from, p) => {
      if (p && p.type === PROBE.PONG && nonceToSub.has(p.n)) online.add(nonceToSub.get(p.n))
    })
    for (const sub of subs) {
      const n = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('')
      nonceToSub.set(n, sub)
      try { client.sendByPubkey(sub, { type: PROBE.PING, n }) } catch (_) {}
    }
    setTimeout(() => { try { off() } catch (_) {} resolve(online) }, timeoutMs)
  })
}

// ---------- Mi perfil (§6.1): el botón lo pone el topbar; abrimos <dotrino-profile> ----------
let _provider = null
async function ensureProvider (id) {
  if (_provider) return _provider
  let reputation = null
  try { reputation = createVaultReputation(id) } catch {}
  try { _provider = createVaultProfileProvider({ identity: id, reputation }) } catch { _provider = null }
  return _provider
}
async function openMyProfile () {
  const id = await identity().catch(() => null)
  const pk = id?.me?.publickey
  if (!pk) return
  document.querySelector('dotrino-profile')?.remove()
  const p = document.createElement('dotrino-profile')
  p.setAttribute('modal', '')
  p.setAttribute('mode', 'self')
  p.setAttribute('pubkey', pk)
  if (id.me?.nickname) p.setAttribute('name', id.me.nickname)
  p.setAttribute('lang', lang)
  ensureProvider(id).then((prov) => { if (prov) p.provider = prov })
  p.addEventListener('cc-profile-close', () => p.remove())
  document.body.appendChild(p)
}
topbar.addEventListener('dotrino-profile', openMyProfile)
;(async () => { // avatar del perfil ACTIVO → se lo pasamos al topbar por atributo
  try {
    const id = await identity()
    const prof = id.currentProfile ? await id.currentProfile() : null
    const pk = prof?.pubkey || id?.me?.publickey
    if (pk) topbar.setAttribute('avatar', avatarDataUri(pk, { size: 64 }))
  } catch {}
})()

// Desconectar/revocar este dispositivo se hace desde profile.dotrino.com (el
// gestor de dispositivos del vault), no desde cada app — por eso no hay botón aquí.

// ---------- Render de estados ----------
let link = null // { paired, id, cert, iss, proxy, deviceId } (modo vault)
let deviceVault = null // handle de @dotrino/vault (este dispositivo como bóveda)
let _probeTimer = null // re-sondeo de presencia; se limpia al re-renderizar
let _probeClient = null // cliente del proxy solo para la sonda de presencia (modo vault externo)

async function render () {
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null }
  if (_probeClient) { try { _probeClient.close() } catch (_) {} _probeClient = null }
  link = await getLink().catch(() => ({ paired: false }))
  installBtn.textContent = t('install')
  app.innerHTML = ''
  if (link.paired) {
    app.appendChild(terminalScreen(link))
  } else if (selfModeEnabled()) {
    app.appendChild(await selfTerminalScreen())
  } else {
    app.appendChild(choiceScreen())
  }
}

/** Sale del modo standalone (cierra el daemon) y vuelve a la pantalla de elección. */
async function exitSelfMode () {
  setSelfMode(false)
  try { deviceVault?.close() } catch (_) {}
  deviceVault = null
  render()
}

// --- Pantalla: elegir modo (vault externo vs dispositivo como vault) ---
function choiceScreen () {
  const node = el(`
    <section class="card">
      <h1>${t('self_choice_title')}</h1>
      <p>${t('self_choice_intro')}</p>
      <div class="choice">
        <button class="choice-card" id="goSelf">
          <b>📱 ${t('self_choice_self')}</b>
          <span class="status">${t('self_choice_self_d')}</span>
        </button>
        <button class="choice-card" id="goVault">
          <b>🗄 ${t('self_choice_vault')}</b>
          <span class="status">${t('self_choice_vault_d')}</span>
        </button>
      </div>
      <div id="vaultSteps" hidden>
        <p class="cta">${t('step1')} <a href="https://vault.dotrino.com" target="_blank" rel="noopener">vault.dotrino.com</a></p>
        <p class="cta">${t('step2')} <a href="https://profile.dotrino.com/#vault" target="_blank" rel="noopener">profile.dotrino.com</a></p>
        <p>${t('step3')} <button id="recheck" class="primary">${t('recheck')}</button> <span id="chkmsg" class="status"></span></p>
      </div>
      <p class="status"><button id="backFromVault" hidden class="link">${t('self_back_vault')}</button></p>
    </section>`)
  const steps = node.querySelector('#vaultSteps')
  const backBtn = node.querySelector('#backFromVault')
  node.querySelector('#goVault').addEventListener('click', () => { steps.hidden = false; backBtn.hidden = false })
  node.querySelector('#backFromVault').addEventListener('click', () => { steps.hidden = true; backBtn.hidden = true })
  node.querySelector('#recheck').addEventListener('click', async (e) => {
    e.target.disabled = true
    node.querySelector('#chkmsg').textContent = t('checking')
    const l = await getLink().catch(() => ({ paired: false }))
    if (l.paired) return render()
    node.querySelector('#chkmsg').textContent = t('still_not')
    e.target.disabled = false
  })
  node.querySelector('#goSelf').addEventListener('click', async () => {
    setSelfMode(true)
    render()
  })
  return node
}

// --- Gestor de sesiones multi-consola (compartido por modo vault y modo self) ---
// Mantiene las pestañas, los terminales xterm.js y la conexión AgentClient de cada
// shell abierta. Recibe el `link` (vault o self) y los contenedores del DOM.
function makeSessionHost ({ tabsEl, termsEl, hint, link }) {
  const sessions = [] // { id, alias, pub, agent, term, fit, box, tab, status, onResize }
  let active = null
  let counter = 0

  function setActive (s) {
    active = s
    for (const x of sessions) {
      x.box.style.display = x === s ? 'block' : 'none'
      x.tab.classList.toggle('on', x === s)
    }
    if (s) { try { s.fit.fit(); s.agent.resize(s.term.cols, s.term.rows); s.term.focus() } catch {} }
  }

  function closeSession (s) {
    window.removeEventListener('resize', s.onResize)
    try { s.agent.close() } catch {}
    try { s.term.dispose() } catch {}
    s.box.remove(); s.tab.remove()
    const i = sessions.indexOf(s); if (i >= 0) sessions.splice(i, 1)
    if (active === s) setActive(sessions[sessions.length - 1] || null)
  }

  function renderTab (s) {
    s.tab = el(`<button class="tab" data-testid="term-tab"><span class="dot"></span><span class="tlabel">${esc(s.alias)}</span><span class="x" title="${t('close')}">×</span></button>`)
    s.tab.querySelector('.tlabel').addEventListener('click', () => setActive(s))
    s.tab.addEventListener('click', (e) => { if (!e.target.classList.contains('x')) setActive(s) })
    s.tab.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeSession(s) })
    tabsEl.appendChild(s.tab)
  }
  function setTabState (s, state) { // 'conn' | 'ok' | 'err'
    s.tab.querySelector('.dot').className = 'dot ' + state
    s.tab.title = state === 'err' ? (s.status || 'error') : ''
  }

  async function openConsole (pub, alias) {
    const id = ++counter
    const s = { id, pub, alias: alias || `#${id} ${pub.slice(0, 8)}…`, status: 'conectando' }
    s.box = el('<div class="term"></div>'); s.box.style.display = 'none'
    termsEl.appendChild(s.box)
    sessions.push(s)
    renderTab(s); setActive(s); setTabState(s, 'conn')
    hint.textContent = t('connecting', s.alias)
    try {
      s.agent = new AgentClient(link, { agentPubkey: pub })
      s.agent.onError = (e) => { s.status = e.message; setTabState(s, 'err'); if (active === s) hint.textContent = t('error') + e.message }
      await s.agent.connect()

      s.term = new Terminal({ fontSize: 14, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', cursorBlink: true, theme: { background: '#0e0b1a' } })
      s.fit = new FitAddon(); s.term.loadAddon(s.fit)
      s.term.open(s.box); s.fit.fit()
      s.agent.onData = (d) => s.term.write(d)
      s.term.onData((d) => s.agent.input(d))
      await s.agent.openShell(s.term.cols, s.term.rows)
      s.onResize = () => { if (active === s) { try { s.fit.fit(); s.agent.resize(s.term.cols, s.term.rows) } catch {} } }
      window.addEventListener('resize', s.onResize)
      s.status = 'conectado'; setTabState(s, 'ok')
      if (active === s) hint.textContent = t('connected', s.alias)
      setActive(s)
    } catch (e) {
      s.status = e.message; setTabState(s, 'err')
      if (active === s) hint.textContent = t('conn_fail') + e.message
      if (s.term) { try { s.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`) } catch {} }
    }
  }

  return { openConsole, sessions }
}

// --- Pantalla: gestor multi-consola (modo vault externo) ---
function terminalScreen (link) {
  const node = el(`
    <section class="card term-card">
      <div id="machines" class="machines">
        <span class="status">${t('machines_loading')}</span>
      </div>
      <div id="tabs" class="tabs"></div>
      <div id="terms" class="terms"></div>
      <span id="hint" class="status">${t('linked_to', esc(link.deviceId || ''))}</span>
    </section>`)
  const qs = (s) => node.querySelector(s)
  const tabsEl = qs('#tabs'); const termsEl = qs('#terms'); const hint = qs('#hint')
  const host = makeSessionHost({ tabsEl, termsEl, hint, link })

  // --- AUTODESCUBRIMIENTO: tus máquinas = los dispositivos enrolados en TU vault
  // (vault.devices trae la pubkey `sub` de cada uno = su dirección en el proxy).
  // Sin pegar nada: eliges y abres. El manual queda como camino avanzado.
  ;(async () => {
    const box = qs('#machines')
    try {
      const { devices } = await link.id.listVaultDevices()
      const mine = link.id.me?.publickey
      const now = Date.now()
      const bySub = new Map() // dedupe por pubkey (renovaciones/re-emparejes) → el cert más nuevo
      for (const d of devices || []) {
        if (!d.sub || d.sub === mine || (d.exp && d.exp <= now)) continue
        // Solo MÁQUINAS con agente (label propio, p. ej. 'terminal-agent'); los
        // navegadores enrolados quedan con label 'cli' y no atienden consolas.
        if (!d.label || d.label === 'cli') continue
        if (!bySub.has(d.sub) || (d.exp || 0) > (bySub.get(d.sub).exp || 0)) bySub.set(d.sub, d)
      }
      const list = [...bySub.values()]
      if (!list.length) {
        box.innerHTML = `
          <p class="status">${t('machines_none')}</p>
          <div class="setup">
            <b>${t('setup_title')}</b>
            <p class="status">${t('setup_body')}</p>
            ${installCmds()}
            <p class="status">1 · ${t('setup_s1')}</p>
            <p class="status">2 · ${t('setup_s2')}</p>
          </div>`
        return
      }
      box.innerHTML = `<b>${t('machines_title')}</b><div class="machine-list"></div>`
      const holder = box.querySelector('.machine-list')
      for (const d of list) {
        const name = d.label && d.label !== 'cli' ? `${d.label} · ${d.deviceId}` : d.deviceId
        const row = el(`<div class="machine-row" data-sub="${esc(d.sub)}">
          <button class="machine" data-testid="machine-item" title="${esc(d.deviceId)}"><span class="mdot conn" title="${esc(t('machine_checking'))}"></span>🖥 ${esc(name)}</button>
        </div>`)
        row.querySelector('.machine').addEventListener('click', () => host.openConsole(d.sub, name))
        holder.appendChild(row)
      }
      // Presencia (ping/pong) igual que en modo dispositivo: un cliente del proxy
      // manda un ping a cada máquina y pinta el punto verde/gris según responda.
      const subs = list.map((d) => d.sub)
      const updatePresence = async () => {
        if (!_probeClient) return
        const online = await probeOnline(_probeClient, subs)
        for (const row of box.querySelectorAll('.machine-row')) {
          const dot = row.querySelector('.mdot'); if (!dot) continue
          const on = online.has(row.dataset.sub)
          dot.className = 'mdot ' + (on ? 'on' : 'off')
          dot.title = on ? t('machine_online') : t('machine_offline')
        }
      }
      try {
        const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
        _probeClient = new WebSocketProxyClient({ url: link.proxy || 'wss://proxy.dotrino.com', enableWebRTC: false, autoReconnect: true })
        await _probeClient.connect()
        await updatePresence()
        // Re-sondeo periódico: cubre "el agente se cerró con la app abierta".
        _probeTimer = setInterval(updatePresence, 30000)
      } catch (_) { /* sin presencia si el proxy no conecta; la lista sigue usable */ }
    } catch {
      box.innerHTML = `<span class="status">${t('machines_err')}</span>`
    }
  })()

  return node
}

// --- Pantalla: gestor multi-consola en MODO DISPOSITIVO (este navegador = vault) ---
async function selfTerminalScreen () {
  const id = await identity().catch(() => null)
  if (!id?.me?.publickey) {
    return el(`<section class="card"><p class="status">${t('self_no_identity')} <a href="https://profile.dotrino.com" target="_blank" rel="noopener">profile.dotrino.com</a></p></section>`)
  }
  // Levanta el demonio (listener de enrolamiento + consulta de máquinas/revocación).
  let sm
  try {
    sm = await startDeviceVault(id)
    deviceVault = sm
  } catch (_) {
    return el(`<section class="card"><p class="cta">${t('self_proxy_err')}</p>
      <p><button id="retrySelf" class="primary">${t('recheck')}</button>
         <button id="exitSelf" class="link">${t('self_back_vault')}</button></p></section>`)
  }
  const selfLink = await getSelfLink()
  selfLink.getSelfCert = sm.getSelfCert
  const devShort = (await pubkeyId(sm.iss)).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2')

  const node = el(`
    <section class="card term-card">
      <div id="selfPair" class="machines"></div>
      <div id="machines" class="machines"><span class="status">${t('machines_loading')}</span></div>
      <div id="tabs" class="tabs"></div>
      <div id="terms" class="terms"></div>
      <span id="hint" class="status">${t('self_active', esc(devShort))}</span>
      <p class="status"><button id="exitSelf2" class="link">${t('self_back_vault')}</button></p>
    </section>`)
  const qs = (s) => node.querySelector(s)
  const tabsEl = qs('#tabs'); const termsEl = qs('#terms'); const hint = qs('#hint')
  const host = makeSessionHost({ tabsEl, termsEl, hint, link: selfLink })
  qs('#exitSelf2').addEventListener('click', exitSelfMode)

  // --- Emparejamiento: generar QR y aprobar máquinas que pidan acceso ---
  const pairBox = qs('#selfPair')
  let _autoPaired = false // primera entrada sin máquinas → mostrar el QR de una
  function renderPairIdle () {
    pairBox.innerHTML = `<div class="setup">
      <b>${t('self_pair_title')}</b>
      <p class="status">${t('self_pair_body')}</p>
      ${installCmds()}
      <button id="startPair" class="primary">${t('self_pair_new')}</button>
    </div>`
    pairBox.querySelector('#startPair').addEventListener('click', startPairing)
  }
  function startPairing () {
    const { qr } = sm.startPairing()
    const payload = JSON.stringify(qr)
    pairBox.innerHTML = `<div class="setup">
      <b>${t('self_pair_title')}</b>
      <p class="status">${t('self_pair_body')}</p>
      ${installCmds()}
      <p class="status">${t('self_pair_step1')}</p>
      <div class="qr-wrap" title="${esc(t('self_qr_alt'))}">${qrSvg(payload)}</div>
      <div class="qr-code"><pre><code>${esc(payload)}</code></pre></div>
      <button id="copyQr" class="link">${t('self_copy')}</button>
      <span class="status" id="copyMsg"></span>
      <p class="status">${t('self_pair_step2')}</p>
      <p class="status">⏳ ${t('self_pair_wait')}</p>
      <button id="cancelPair" class="link">${t('cancel')}</button>
    </div>`
    pairBox.querySelector('#copyQr').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(payload); pairBox.querySelector('#copyMsg').textContent = t('self_copied') } catch {}
    })
    pairBox.querySelector('#cancelPair').addEventListener('click', renderPairIdle)
  }
  function renderPending (list) {
    if (!list || !list.length) {
      // si estaba mostrando aprobación y ya no hay pendientes → volver a idle
      if (pairBox.querySelector('[data-pending]')) renderPairIdle()
      return
    }
    // NO mostramos el código: el humano lo LEE de la máquina y lo TIPEA aquí. La
    // máquina solo acepta el cert si el código coincide con el que ella generó →
    // aprobar a ciegas (sin ir a la máquina) no enrola a un impostor.
    const rows = list.map((x) => `
      <div class="pending" data-pending data-device="${esc(x.deviceId)}">
        <p class="status">${t('self_pending', esc(x.deviceId))}</p>
        <div class="pair-actions">
          <input class="code-input" data-code="${esc(x.deviceId)}" type="text" inputmode="numeric"
                 autocomplete="off" maxlength="8" placeholder="${esc(t('self_code_ph'))}"
                 aria-label="${esc(t('self_code_ph'))}" data-testid="pair-code" />
          <button class="primary" data-approve="${esc(x.deviceId)}" data-testid="pair-approve">${t('self_approve')}</button>
          <button class="link" data-reject="${esc(x.deviceId)}">${t('self_reject')}</button>
        </div>
      </div>`).join('')
    pairBox.innerHTML = `<div class="setup">${rows}</div>`
    const approveWith = async (b) => {
      const dev = b.dataset.approve
      const input = pairBox.querySelector(`input[data-code="${CSS.escape(dev)}"]`)
      const code = (input?.value || '').trim()
      if (!code) { input?.focus(); return }
      b.disabled = true
      try { await sm.approve(dev, code); hint.textContent = t('self_approved', esc(dev)) }
      catch (e) { hint.textContent = t('error') + e.message; b.disabled = false }
    }
    pairBox.querySelectorAll('[data-approve]').forEach((b) => {
      b.addEventListener('click', () => approveWith(b))
      const input = pairBox.querySelector(`input[data-code="${CSS.escape(b.dataset.approve)}"]`)
      input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') approveWith(b) })
    })
    pairBox.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => {
      sm.reject(b.dataset.reject); hint.textContent = t('self_rejected')
    }))
  }
  sm.onPendingChange(() => renderPending(sm.listPending()))
  renderPairIdle()

  // --- Máquinas: las enroladas bajo esta identidad (P), con su estado online ---
  // Sondea presencia (ping/pong) y pinta el punto verde/gris de cada fila.
  async function updatePresence (subs) {
    const online = await probeOnline(sm.client, subs)
    for (const row of node.querySelectorAll('.machine-row')) {
      const dot = row.querySelector('.mdot'); if (!dot) continue
      const on = online.has(row.dataset.sub)
      dot.className = 'mdot ' + (on ? 'on' : 'off')
      dot.title = on ? t('machine_online') : t('machine_offline')
    }
  }
  // Quitar (revocar) una máquina: confirma, revoca el cert y refresca la lista.
  async function removeMachine (d) {
    if (!await confirmModal(t('remove_confirm', esc(d.deviceId)), { danger: true })) return
    try { await sm.revoke(d.nonce); refreshMachines() }
    catch (e) { hint.textContent = t('error') + e.message }
  }
  async function refreshMachines () {
    const box = qs('#machines')
    try {
      const list = await sm.listMachines()
      if (!list.length) {
        box.innerHTML = `<p class="status">${t('self_empty')}</p>`
        // Aún sin máquinas: enseña el QR + código directamente (no tras un botón),
        // salvo que ya haya una máquina esperando aprobación (SAS) en el panel.
        if (!_autoPaired && !sm.listPending().length) { _autoPaired = true; startPairing() }
        return
      }
      box.innerHTML = `<b>${t('machines_title')}</b><div class="machine-list"></div>`
      const holder = box.querySelector('.machine-list')
      for (const d of list) {
        const name = d.label ? `${d.label} · ${d.deviceId}` : d.deviceId
        const row = el(`<div class="machine-row" data-sub="${esc(d.sub)}">
          <button class="machine" data-testid="machine-item" title="${esc(d.deviceId)}"><span class="mdot conn" title="${esc(t('machine_checking'))}"></span>🖥 ${esc(name)}</button>
          <button class="machine-x" data-testid="machine-remove" title="${esc(t('machine_remove'))}" aria-label="${esc(t('machine_remove'))}">✕</button>
        </div>`)
        row.querySelector('.machine').addEventListener('click', () => host.openConsole(d.sub, name))
        row.querySelector('.machine-x').addEventListener('click', () => removeMachine(d))
        holder.appendChild(row)
      }
      updatePresence(list.map((d) => d.sub))
    } catch {
      box.innerHTML = `<span class="status">${t('machines_err')}</span>`
    }
  }
  refreshMachines()
  // Re-sondeo periódico: cubre "el agente se cerró mientras la app seguía abierta".
  // Se limpia en render() al re-renderizar la pantalla.
  _probeTimer = setInterval(() => {
    const subs = [...node.querySelectorAll('.machine-row')].map((r) => r.dataset.sub)
    if (subs.length) updatePresence(subs)
  }, 30000)
  // Refresca la lista tras aprobar una máquina (aparece de inmediato).
  const _origApprove = sm.approve.bind(sm)
  sm.approve = async (...a) => { const r = await _origApprove(...a); refreshMachines(); return r }

  return node
}

document.documentElement.lang = lang
render()

// --- Service worker ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      setInterval(() => reg.update(), 30 * 60 * 1000)
    }).catch(() => {})
  })
}
