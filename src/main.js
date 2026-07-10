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
import { getLink, getSelfLink, identity } from './vault.js'
import { selfModeEnabled, setSelfMode, startSelfMaster } from './selfMaster.js'
import { AgentClient } from './agentClient.js'

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
    saved_machine: '— máquina guardada —',
    addr_ph: 'Dirección de la máquina (la que imprime el agente)',
    alias_ph: 'Alias (opcional)',
    open_console: 'Abrir consola',
    machines_title: 'Tus máquinas',
    machines_loading: 'Buscando tus máquinas…',
    machines_none: 'Aún no tienes ninguna máquina con el agente instalado.',
    machines_err: 'No se pudo consultar tu bóveda (¿está encendida?).',
    manual_addr: 'Conectar por dirección (avanzado)',
    setup_title: 'Instala el agente en la máquina que quieres controlar',
    setup_body: 'En esa máquina (servidor, otra PC…), con Node 20+ y git:',
    setup_s1: 'Enlázala a tu bóveda: te pedirá el código de <code>dotrino-vault pair</code> (en el PC de tu bóveda) y su aprobación.',
    setup_s2: 'Déjalo corriendo. La máquina aparecerá aquí sola, en "Tus máquinas".',
    linked_to: (dev) => `Dispositivo <code>${dev}</code> conectado a tu bóveda · abre una o varias consolas en tus máquinas.`,
    need_addr: 'Pega la dirección de la máquina (la imprime `dotrino-terminal-agent`).',
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
    self_recommended: 'Recomendado',
    self_active: (dev) => `La identidad de este navegador (<code>${dev}</code>) es tu bóveda. Enlaza tus máquinas abajo y abre consolas en ellas.`,
    self_pair_title: 'Enlaza una máquina',
    self_pair_body: 'En la máquina destino (servidor, otra PC…), con Node 20+:',
    self_pair_step1: '1 · Pega este código al enrolar el agente (o pégalo después):',
    self_pair_step2: '2 · Compara el código de 6 dígitos que muestra el agente con el de aquí y apruébalo.',
    self_pair_wait: 'Esperando a que la máquina se conecte…',
    self_pair_again: 'Generar otro código',
    self_pair_new: 'Enlazar otra máquina',
    self_empty: 'Aún no tienes máquinas enlazadas. Genera un código arriba y enrólalo en la máquina destino.',
    self_pending: (dev, sas) => `La máquina <code>${dev}</code> pide acceso. Compara el código con el que muestra el agente y aprueba:`,
    self_sas: 'Código a comparar',
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
    saved_machine: '— saved machine —',
    addr_ph: 'Machine address (the one the agent prints)',
    alias_ph: 'Alias (optional)',
    open_console: 'Open console',
    machines_title: 'Your machines',
    machines_loading: 'Looking for your machines…',
    machines_none: 'You have no machine with the agent installed yet.',
    machines_err: 'Could not reach your vault (is it on?).',
    manual_addr: 'Connect by address (advanced)',
    setup_title: 'Install the agent on the machine you want to control',
    setup_body: 'On that machine (a server, another PC…), with Node 20+ and git:',
    setup_s1: 'Link it to your vault: it will ask for the code from <code>dotrino-vault pair</code> (on your vault PC) and its approval.',
    setup_s2: 'Leave it running. The machine will show up here by itself, under "Your machines".',
    linked_to: (dev) => `Device <code>${dev}</code> connected to your vault · open one or more consoles on your machines.`,
    need_addr: 'Paste the machine address (printed by `dotrino-terminal-agent`).',
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
    self_recommended: 'Recommended',
    self_active: (dev) => `This browser's identity (<code>${dev}</code>) is your vault. Link your machines below and open consoles on them.`,
    self_pair_title: 'Link a machine',
    self_pair_body: 'On the target machine (a server, another PC…), with Node 20+:',
    self_pair_step1: '1 · Paste this code when enrolling the agent (or paste it later):',
    self_pair_step2: '2 · Compare the 6-digit code the agent shows with the one here and approve it.',
    self_pair_wait: 'Waiting for the machine to connect…',
    self_pair_again: 'Generate another code',
    self_pair_new: 'Link another machine',
    self_empty: 'You have no machines linked yet. Generate a code above and enroll it on the target machine.',
    self_pending: (dev, sas) => `Machine <code>${dev}</code> is requesting access. Compare this code with the one the agent shows and approve:`,
    self_sas: 'Code to compare',
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
let selfMaster = null // instancia del daemon del modo dispositivo (selfMaster.js)

async function render () {
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
  try { selfMaster?.close() } catch (_) {}
  selfMaster = null
  render()
}

// --- Pantalla: elegir modo (vault externo vs dispositivo como vault) ---
function choiceScreen () {
  const node = el(`
    <section class="card">
      <h1>${t('self_choice_title')}</h1>
      <p>${t('self_choice_intro')}</p>
      <div class="choice">
        <button class="choice-card primary-card" id="goSelf">
          <b>📱 ${t('self_choice_self')}</b>
          <span class="status">${t('self_choice_self_d')}</span>
          <span class="badge">${t('self_recommended')}</span>
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

// --- Máquinas recordadas (dirección = pubkey del agente) ---
const LS_MACHINES = 'dotrino-terminal:machines'
function loadMachines () { try { return JSON.parse(localStorage.getItem(LS_MACHINES)) || [] } catch { return [] } }
function rememberMachine (pub, alias) {
  const list = loadMachines().filter((m) => m.pub !== pub)
  list.unshift({ pub, alias: alias || (pub.slice(0, 10) + '…'), at: Date.now() })
  localStorage.setItem(LS_MACHINES, JSON.stringify(list.slice(0, 8)))
}

// --- Gestor de sesiones multi-consola (compartido por modo vault y modo self) ---
// Mantiene las pestañas, los terminales xterm.js y la conexión AgentClient de cada
// shell abierta. Recibe el `link` (vault o self) y los contenedores del DOM.
function makeSessionHost ({ tabsEl, termsEl, hint, link }) {
  const sessions = [] // { id, alias, pub, agent, term, fit, box, tab, status, onResize }
  let active = null
  let counter = 0

  function refreshMachineSelect (selEl) {
    if (!selEl) return
    const machines = loadMachines()
    selEl.hidden = !machines.length
    selEl.innerHTML = `<option value="">${t('saved_machine')}</option>` +
      machines.map((m) => `<option value="${esc(m.pub)}">${esc(m.alias)}</option>`).join('')
  }

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
      rememberMachine(pub, alias)
      s.status = 'conectado'; setTabState(s, 'ok')
      if (active === s) hint.textContent = t('connected', s.alias)
      setActive(s)
    } catch (e) {
      s.status = e.message; setTabState(s, 'err')
      if (active === s) hint.textContent = t('conn_fail') + e.message
      if (s.term) { try { s.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`) } catch {} }
    }
  }

  return { openConsole, refreshMachineSelect, sessions }
}

// --- Pantalla: gestor multi-consola (modo vault externo) ---
function terminalScreen (link) {
  const node = el(`
    <section class="card term-card">
      <div id="machines" class="machines">
        <span class="status">${t('machines_loading')}</span>
      </div>
      <details class="manual">
        <summary>${t('manual_addr')}</summary>
        <div class="machine-bar">
          <select id="machineSel" data-testid="machine-select"><option value="">${t('saved_machine')}</option></select>
          <input id="machineAddr" data-testid="machine-addr" type="text" placeholder="${esc(t('addr_ph'))}" />
          <input id="machineAlias" data-testid="machine-alias" type="text" class="alias" placeholder="${esc(t('alias_ph'))}" />
          <button id="openBtn" data-testid="open-console" class="primary">${t('open_console')}</button>
        </div>
      </details>
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
            <pre><code>npx @dotrino/terminal-agent enroll   # 1 · ${lang === 'en' ? 'once' : 'una vez'}
npx @dotrino/terminal-agent          # 2 · ${lang === 'en' ? 'keep it running' : 'déjalo corriendo'}</code></pre>
            <p class="status">1 · ${t('setup_s1')}</p>
            <p class="status">2 · ${t('setup_s2')}</p>
          </div>`
        return
      }
      box.innerHTML = `<b>${t('machines_title')}</b><div class="machine-list"></div>`
      const holder = box.querySelector('.machine-list')
      for (const d of list) {
        const name = d.label && d.label !== 'cli' ? `${d.label} · ${d.deviceId}` : d.deviceId
        const b = el(`<button class="machine" data-testid="machine-item" title="${esc(d.deviceId)}">🖥 ${esc(name)}</button>`)
        b.addEventListener('click', () => host.openConsole(d.sub, name))
        holder.appendChild(b)
      }
    } catch {
      box.innerHTML = `<span class="status">${t('machines_err')}</span>`
    }
  })()

  host.refreshMachineSelect(qs('#machineSel'))
  qs('#machineSel').addEventListener('change', (e) => {
    if (!e.target.value) return
    qs('#machineAddr').value = e.target.value
    const m = loadMachines().find((x) => x.pub === e.target.value)
    if (m && !qs('#machineAlias').value) qs('#machineAlias').value = m.alias
  })

  qs('#openBtn').addEventListener('click', () => {
    const pub = qs('#machineAddr').value.trim()
    const alias = qs('#machineAlias').value.trim()
    if (!pub) { hint.textContent = t('need_addr'); return }
    qs('#machineAddr').value = ''; qs('#machineAlias').value = ''
    host.openConsole(pub, alias)
  })

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
    sm = await startSelfMaster(id)
    selfMaster = sm
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
      <details class="manual">
        <summary>${t('manual_addr')}</summary>
        <div class="machine-bar">
          <select id="machineSel" data-testid="machine-select"><option value="">${t('saved_machine')}</option></select>
          <input id="machineAddr" data-testid="machine-addr" type="text" placeholder="${esc(t('addr_ph'))}" />
          <input id="machineAlias" data-testid="machine-alias" type="text" class="alias" placeholder="${esc(t('alias_ph'))}" />
          <button id="openBtn" data-testid="open-console" class="primary">${t('open_console')}</button>
        </div>
      </details>
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
  function renderPairIdle () {
    pairBox.innerHTML = `<div class="setup">
      <b>${t('self_pair_title')}</b>
      <p class="status">${t('self_pair_body')}</p>
      <pre><code>npx @dotrino/terminal-agent enroll</code></pre>
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
      <pre><code>npx @dotrino/terminal-agent enroll</code></pre>
      <p class="status">${t('self_pair_step1')}</p>
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
    const rows = list.map((x) => `
      <div class="pending" data-pending data-device="${esc(x.deviceId)}">
        <p class="status">${t('self_pending', esc(x.deviceId), esc(x.sas || ''))}</p>
        <div class="sas">${esc(x.sas || '------')}</div>
        <span class="status">${t('self_sas')}</span>
        <div class="pair-actions">
          <button class="primary" data-approve="${esc(x.deviceId)}">${t('self_approve')}</button>
          <button class="link" data-reject="${esc(x.deviceId)}">${t('self_reject')}</button>
        </div>
      </div>`).join('')
    pairBox.innerHTML = `<div class="setup">${rows}</div>`
    pairBox.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      try { await sm.approve(b.dataset.approve); hint.textContent = t('self_approved', esc(b.dataset.approve)) } catch (e) { hint.textContent = t('error') + e.message }
    }))
    pairBox.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => {
      sm.reject(b.dataset.reject); hint.textContent = t('self_rejected')
    }))
  }
  sm.onPendingChange(() => renderPending(sm.listPending()))
  renderPairIdle()

  // --- Máquinas: las enroladas bajo esta identidad (P) ---
  async function refreshMachines () {
    const box = qs('#machines')
    try {
      const list = await sm.listMachines()
      if (!list.length) {
        box.innerHTML = `<p class="status">${t('self_empty')}</p>`
        return
      }
      box.innerHTML = `<b>${t('machines_title')}</b><div class="machine-list"></div>`
      const holder = box.querySelector('.machine-list')
      for (const d of list) {
        const name = d.label ? `${d.label} · ${(d.sub || '').slice(0, 8)}…` : (d.sub || '').slice(0, 12)
        const b = el(`<button class="machine" data-testid="machine-item">🖥 ${esc(name)}</button>`)
        b.addEventListener('click', () => host.openConsole(d.sub, name))
        holder.appendChild(b)
      }
    } catch {
      box.innerHTML = `<span class="status">${t('machines_err')}</span>`
    }
  }
  refreshMachines()
  // Refresca la lista tras aprobar una máquina (aparece de inmediato).
  const _origApprove = sm.approve.bind(sm)
  sm.approve = async (...a) => { const r = await _origApprove(...a); refreshMachines(); return r }

  host.refreshMachineSelect(qs('#machineSel'))
  qs('#machineSel').addEventListener('change', (e) => {
    if (!e.target.value) return
    qs('#machineAddr').value = e.target.value
    const m = loadMachines().find((x) => x.pub === e.target.value)
    if (m && !qs('#machineAlias').value) qs('#machineAlias').value = m.alias
  })
  qs('#openBtn').addEventListener('click', () => {
    const pub = qs('#machineAddr').value.trim()
    const alias = qs('#machineAlias').value.trim()
    if (!pub) { hint.textContent = t('need_addr'); return }
    qs('#machineAddr').value = ''; qs('#machineAlias').value = ''
    host.openConsole(pub, alias)
  })

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
