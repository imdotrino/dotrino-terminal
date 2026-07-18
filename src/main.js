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
import { createVaultReputation } from '@dotrino/reputation'
import { getLink, getSelfLink, identity } from './vault.js'
import { AgentClient } from './agentClient.js'

// ---------- i18n (bilingüe es/en, §9) ----------
const M = {
  es: {
    step1: '1 · Instala la bóveda en tu PC desde',
    step2: '2 · Conecta este dispositivo (escanea el QR de <code>dotrino-vault pair</code>) en',
    step3: '3 · Vuelve aquí y pulsa:',
    recheck: 'Ya lo conecté',
    checking: 'Comprobando…',
    still_not: 'Este dispositivo aún no está conectado a una bóveda.',
    install: 'Instalar',
    machines_title: 'Tus máquinas',
    machines_loading: 'Buscando tus máquinas…',
    machines_none: 'Aún no tienes ninguna máquina con el agente instalado.',
    machines_err: 'No se pudo consultar tu bóveda (¿está encendida?).',
    machine_online: 'En línea',
    machine_offline: 'Desconectada',
    machine_checking: 'Comprobando…',
    setup_title: 'Instala el agente en la máquina que quieres controlar',
    setup_body: 'En esa máquina (servidor, otra PC…), pega esto y listo:',
    install_alt: 'O, si ya tienes Node 20+:',
    install_win: 'En Windows (PowerShell):',
    setup_s1: 'Enlázala a tu bóveda: te pedirá el código de <code>dotrino-vault pair</code> (en el PC de tu bóveda) y su aprobación.',
    setup_s2: 'Déjalo corriendo. La máquina aparecerá aquí sola, en "Tus máquinas".',
    linked_to: (dev) => `Dispositivo <code>${dev}</code> conectado a tu bóveda · abre una o varias consolas en tus máquinas.`,
    self_hint: 'Este navegador es tu bóveda · abre una o varias consolas en tus máquinas.',
    connecting: (a) => `Conectando a ${a}…`,
    connected: (a) => `Conectado a ${a}`,
    conn_fail: 'No se pudo conectar: ',
    error: 'Error: ',
    close: 'Cerrar',
    self_choice_title: '¿Cómo quieres entrar?',
    self_choice_intro: 'Para abrir una consola en tus máquinas necesitas certificarlas con una identidad. Elige dónde vive esa identidad:',
    self_choice_vault: 'Conectar tu bóveda',
    self_choice_vault_d: 'Tienes un vault (PC/servidor). Centraliza tu identidad en él.',
    self_choice_self: 'Usar este dispositivo como bóveda',
    self_choice_self_d: 'Sin vault: la identidad de este navegador certifica tus máquinas directamente.',
    self_back_vault: 'Usar una bóveda externa',
  },
  en: {
    step1: '1 · Install the vault on your PC from',
    step2: '2 · Connect this device (scan the QR from <code>dotrino-vault pair</code>) at',
    step3: '3 · Come back here and press:',
    recheck: 'I connected it',
    checking: 'Checking…',
    still_not: 'This device is not connected to a vault yet.',
    install: 'Install',
    machines_title: 'Your machines',
    machines_loading: 'Looking for your machines…',
    machines_none: 'You have no machine with the agent installed yet.',
    machines_err: 'Could not reach your vault (is it on?).',
    machine_online: 'Online',
    machine_offline: 'Offline',
    machine_checking: 'Checking…',
    setup_title: 'Install the agent on the machine you want to control',
    setup_body: 'On that machine (a server, another PC…), paste this and you\'re set:',
    install_alt: 'Or, if you already have Node 20+:',
    install_win: 'On Windows (PowerShell):',
    setup_s1: 'Link it to your vault: it will ask for the code from <code>dotrino-vault pair</code> (on your vault PC) and its approval.',
    setup_s2: 'Leave it running. The machine will show up here by itself, under "Your machines".',
    linked_to: (dev) => `Device <code>${dev}</code> connected to your vault · open one or more consoles on your machines.`,
    self_hint: 'This browser is your vault · open one or more consoles on your machines.',
    connecting: (a) => `Connecting to ${a}…`,
    connected: (a) => `Connected to ${a}`,
    conn_fail: 'Could not connect: ',
    error: 'Error: ',
    close: 'Close',
    self_choice_title: 'How do you want to sign in?',
    self_choice_intro: 'To open a console on your machines you need to certify them with an identity. Choose where that identity lives:',
    self_choice_vault: 'Connect your vault',
    self_choice_vault_d: 'You have a vault (PC/server). It centralizes your identity.',
    self_choice_self: 'Use this device as its own vault',
    self_choice_self_d: 'No vault: this browser\'s identity certifies your machines directly.',
    self_back_vault: 'Use an external vault',
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

// ---------- Mi perfil (§6.1): el topbar es DUEÑO del modal ----------
// Le pasamos identity + reputation del vault; el topbar deriva el avatar del perfil
// activo y abre <dotrino-profile mode="self"> él mismo (read-only, tematizado por el
// bloque `dotrino-profile { --ccp-* }` de style.css). Esta app ya no renderiza el modal
// ni fija @dotrino/profile: viaja dentro de @dotrino/topbar.
;(async () => {
  try {
    const id = await identity()
    let reputation = null
    try { reputation = createVaultReputation(id) } catch {}
    topbar.identity = id
    topbar.reputation = reputation
  } catch {}
})()

// Desconectar/revocar este dispositivo se hace desde profile.dotrino.com (el
// gestor de dispositivos del vault), no desde cada app — por eso no hay botón aquí.

// ---------- Render de estados ----------
let link = null // { paired, id, cert, iss, proxy, deviceId } (modo vault)
let _probeTimer = null // re-sondeo de presencia; se limpia al re-renderizar
let _probeClient = null // cliente del proxy solo para la sonda de presencia (modo vault externo)

// ¿Este navegador (su propia identidad) tiene máquinas enroladas bajo su self-vault
// (activado en profile.dotrino.com/#myvault)? Mismo filtro que usa terminalScreen para
// autodescubrir: dispositivos con label real (no 'cli'), que no sean uno mismo, vigentes.
async function selfMachines (id) {
  const { devices } = await id.listVaultDevices()
  const mine = id.me?.publickey
  const now = Date.now()
  return (devices || []).filter((d) => d.sub && d.sub !== mine && d.label && d.label !== 'cli' && (!d.exp || d.exp > now))
}

async function render () {
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null }
  if (_probeClient) { try { _probeClient.close() } catch (_) {} _probeClient = null }
  link = await getLink().catch(() => ({ paired: false }))
  installBtn.textContent = t('install')
  app.innerHTML = ''
  if (link.paired) {
    app.appendChild(terminalScreen(link))
    return
  }
  // Sin vault externo: ¿este navegador es su PROPIA bóveda (self)? Si su identidad
  // ya tiene máquinas enroladas (self-vault activado y agentes enlazados desde
  // profile.dotrino.com/#myvault), operamos en modo self reusando el gestor de
  // consolas — el emparejamiento en sí se hace en profile, no aquí.
  try {
    const selfLink = await getSelfLink()
    if (selfLink.id?.me?.publickey && (await selfMachines(selfLink.id)).length) {
      app.appendChild(terminalScreen(selfLink))
      return
    }
  } catch (_) { /* sin self-vault o sin máquinas: cae a la elección de modo */ }
  app.appendChild(choiceScreen())
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
  node.querySelector('#goSelf').addEventListener('click', () => {
    const back = encodeURIComponent(location.origin + location.pathname)
    location.href = `https://profile.dotrino.com/?back=${back}#myvault`
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
      <span id="hint" class="status">${link.mode === 'self' ? t('self_hint') : t('linked_to', esc(link.deviceId || ''))}</span>
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
