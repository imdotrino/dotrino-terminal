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
import '@dotrino/install' // botón «Instalar app»: captura beforeinstallprompt al importarse
import { createVaultReputation } from '@dotrino/reputation'
import { getLink, getSelfLink, identity } from './vault.js'
import { AgentClient } from './agentClient.js'
import { listAgentsByLabel, probeAgents } from '@dotrino/remote-agent/discover'
import { pubkeyId } from '@dotrino/identity/capabilities'

// Lo que contesta el agente de terminal cuando se le pregunta qué es (agent/link.js).
// NO es el nombre del acta: ese lo pone el dueño al emparejar («TerminalLocal»).
const AGENT_KIND = 'terminal-agent'

// ---------- i18n (bilingüe es/en, §9) ----------
const M = {
  es: {
    step1: '1 · Instala la bóveda en tu PC desde',
    step2: '2 · Conecta este dispositivo (escanea el QR de <code>dotrino-vault pair</code>) en',
    step3: '3 · Vuelve aquí y pulsa:',
    recheck: 'Ya lo conecté',
    checking: 'Comprobando…',
    still_not: 'Este dispositivo aún no está conectado a una bóveda.',
    machines_title: 'Tus máquinas',
    machines_loading: 'Buscando tus máquinas…',
    machines_none: 'No hay ninguna máquina con el agente encendido. Si ya lo instalaste, comprueba que esté corriendo: aparecerá aquí sola.',
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
    exited: (c) => `[la consola terminó (${c})]`,
    resume_title: 'Esta máquina tiene consolas abiertas:',
    resume: 'Retomar',
    new_console: 'Nueva consola',
    kill_console: 'Cerrar esta consola',
    console_item: (n, ago) => `Consola ${n} · activa ${ago}`,
    console_local: 'ventana abierta en la máquina',
    console_in_use: 'en uso',
    ago_now: 'ahora',
    ago_min: (m) => `hace ${m} min`,
    ago_h: (h) => `hace ${h} h`,
    console_gone: 'Esta consola ya no existe en la máquina: se cerró, o el agente se reinició.',
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
    machines_title: 'Your machines',
    machines_loading: 'Looking for your machines…',
    machines_none: 'No machine has the agent running. If you already installed it, check that it is running: it will show up here by itself.',
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
    exited: (c) => `[console ended (${c})]`,
    resume_title: 'This machine has open consoles:',
    resume: 'Resume',
    new_console: 'New console',
    kill_console: 'Close this console',
    console_item: (n, ago) => `Console ${n} · active ${ago}`,
    console_local: 'window open on the machine',
    console_in_use: 'in use',
    ago_now: 'now',
    ago_min: (m) => `${m} min ago`,
    ago_h: (h) => `${h} h ago`,
    console_gone: 'This console no longer exists on the machine: it was closed, or the agent restarted.',
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

const installEl = document.getElementById('install')

function el (html) { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Comandos para instalar/correr el agente en la máquina destino. El one-liner
// curl/irm (instalador universal del ecosistema, en install.dotrino.com) baja Node si falta →
// "pega y ya"; npx queda como alternativa si ya tienes Node. Mismo instalador
// reutilizable por cualquier app del ecosistema (solo cambia el paquete).
const AGENT_PKG = '@dotrino/terminal-agent'
function installCmds (sub) {
  const arg = sub ? ' ' + sub : ''
  const sh = `curl -fsSL https://install.dotrino.com/install.sh | sh -s -- ${AGENT_PKG}${arg}`
  const ps = `& ([scriptblock]::Create((irm https://install.dotrino.com/install.ps1))) ${AGENT_PKG}${arg}`
  const npx = `npx ${AGENT_PKG}${arg}`
  // Cada comando en su propio bloque copiable (mismo formato para los tres).
  return `<pre><code>${esc(sh)}</code></pre>
      <p class="status">${t('install_win')}</p>
      <pre><code>${esc(ps)}</code></pre>
      <p class="status">${t('install_alt')}</p>
      <pre><code>${esc(npx)}</code></pre>`
}

// ---------- Mi perfil (§6.1) ----------
// Le pasamos identity + reputation al topbar: con eso pinta el avatar del perfil activo y
// el menú de perfiles, que navega a profile.dotrino.com (ahí se edita el perfil).
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

// ¿Este navegador (su propia identidad) tiene aparatos enrolados bajo su self-vault
// (activado en profile.dotrino.com/#myvault)? Cuáles son terminales lo dice la sonda.
async function selfMachines (id) {
  return listAgentsByLabel(id)
}

async function render () {
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null }
  if (_probeClient) { try { _probeClient.close() } catch (_) {} _probeClient = null }
  link = await getLink().catch(() => ({ paired: false }))
  installEl.setAttribute('lang', lang)
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
        <p class="cta">${t('step2')} <a href="https://profile.dotrino.com/vault" target="_blank" rel="noopener">profile.dotrino.com</a></p>
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
    location.href = `https://profile.dotrino.com/myvault?back=${back}`
  })
  return node
}

// --- Gestor de pestañas (compartido por modo vault y modo self) ---
// Cada pestaña es una conexión con una máquina enganchada a UNA consola. Las consolas viven
// en el agente: recargar o cerrar el navegador solo las suelta, y la × las mata. Las
// pestañas abiertas se recuerdan en sessionStorage (CONVENCIONES §4: sobreviven a un
// refresco, no a cerrar la pestaña) para volver a engancharlas al recargar.
const SS_TABS = 'dotrino-terminal:tabs'
function loadTabs () { try { return JSON.parse(sessionStorage.getItem(SS_TABS) || '[]') } catch { return [] } }
function saveTabs (list) { try { sessionStorage.setItem(SS_TABS, JSON.stringify(list)) } catch {} }

function agoText (ts) {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('ago_now')
  return m < 60 ? t('ago_min', m) : t('ago_h', Math.floor(m / 60))
}

function makeSessionHost ({ tabsEl, termsEl, hint, link }) {
  const sessions = [] // { id, alias, pub, agent, term, fit, box, tab, status, onResize }
  let active = null
  let counter = 0

  const persist = () => saveTabs(sessions.filter((s) => s.agent?.consoleId).map((s) => ({ sub: s.pub, alias: s.alias, consoleId: s.agent.consoleId })))

  function setActive (s) {
    active = s
    for (const x of sessions) {
      x.box.style.display = x === s ? 'block' : 'none'
      x.tab.classList.toggle('on', x === s)
    }
    if (s?.term) { try { s.fit.fit(); s.agent.resize(s.term.cols, s.term.rows); s.term.focus() } catch {} }
  }

  function removeSession (s) {
    if (s.onResize) window.removeEventListener('resize', s.onResize)
    try { s.term?.dispose() } catch {}
    s.box.remove(); s.tab.remove()
    const i = sessions.indexOf(s); if (i >= 0) sessions.splice(i, 1)
    persist()
    if (active === s) setActive(sessions[sessions.length - 1] || null)
  }
  // La × MATA la consola en la máquina (si hay una enganchada) y quita la pestaña.
  function closeSession (s) { try { s.agent?.close() } catch {} removeSession(s) }

  function renderTab (s) {
    s.tab = el(`<button class="tab" data-testid="term-tab"><span class="dot"></span><span class="tlabel">${esc(s.alias)}</span><span class="x" title="${t('close')}">×</span></button>`)
    s.tab.addEventListener('click', (e) => { if (!e.target.classList.contains('x')) setActive(s) })
    s.tab.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeSession(s) })
    tabsEl.appendChild(s.tab)
  }
  function setTabState (s, state) { // 'conn' | 'ok' | 'err'
    s.tab.querySelector('.dot').className = 'dot ' + state
    s.tab.title = state === 'err' ? (s.status || 'error') : ''
  }

  function mountTerm (s) {
    s.term = new Terminal({ fontSize: 14, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', cursorBlink: true, theme: { background: '#0e0b1a' } })
    s.fit = new FitAddon(); s.term.loadAddon(s.fit)
    s.box.replaceChildren()
    s.term.open(s.box); s.fit.fit()
    s.agent.onData = (d) => s.term.write(d)
    s.agent.onExit = (code) => { s.term.write(`\r\n${t('exited', code)}\r\n`); persist() }
    s.term.onData((d) => s.agent.input(d))
    s.onResize = () => { if (active === s) { try { s.fit.fit(); s.agent.resize(s.term.cols, s.term.rows) } catch {} } }
    window.addEventListener('resize', s.onResize)
  }

  /**
   * Cómo se nombra una consola en la lista: el título que puso su shell (si puso uno), si es
   * una ventana abierta en la propia máquina (`dotrino-terminal`) y si alguien la está usando.
   * Entrar en una ventana de la máquina avisa a quien esté delante de ella.
   */
  function consoleLabel (c, i) {
    const parts = [c.title ? `${c.title} · ${agoText(c.lastActive)}` : t('console_item', i + 1, agoText(c.lastActive))]
    if (c.origin === 'local') parts.push(t('console_local'))
    if (c.viewers > 0) parts.push(t('console_in_use'))
    return parts.join(' · ')
  }

  /**
   * Las consolas de la máquina que NO están ya en una pestaña de esta página. Si hay,
   * se ofrece retomarlas; si no, se abre una nueva sin preguntar.
   * @returns {Promise<{ resume?: string }>} qué eligió el usuario
   */
  async function choose (s) {
    const mine = new Set(sessions.map((x) => x.agent?.consoleId).filter(Boolean))
    const free = (await s.agent.list()).filter((c) => !mine.has(c.id))
    if (!free.length) return {}
    return new Promise((resolve) => {
      const node = el(`<div class="resume" data-testid="resume">
        <b>${t('resume_title')}</b>
        <div class="resume-list"></div>
        <button class="primary" data-testid="new-console">${t('new_console')}</button>
      </div>`)
      const holder = node.querySelector('.resume-list')
      free.sort((a, b) => b.lastActive - a.lastActive).forEach((c, i) => {
        const row = el(`<div class="machine-row">
          <button class="machine" data-testid="resume-console" data-console-id="${esc(c.id)}">${esc(consoleLabel(c, i))} · ${t('resume')}</button>
          <button class="machine-x" title="${esc(t('kill_console'))}" aria-label="${esc(t('kill_console'))}">×</button>
        </div>`)
        row.querySelector('.machine').addEventListener('click', () => resolve({ resume: c.id }))
        row.querySelector('.machine-x').addEventListener('click', () => { s.agent.kill(c.id); row.remove() })
        holder.appendChild(row)
      })
      node.querySelector('[data-testid=new-console]').addEventListener('click', () => resolve({}))
      s.box.replaceChildren(node)
    })
  }

  /**
   * Abre una pestaña con la máquina `pub`. Con `consoleId` se engancha a esa consola (al
   * recargar); sin él, ofrece las consolas sueltas o abre una nueva.
   * @param {string} pub
   * @param {string} [alias]
   * @param {{ consoleId?: string }} [opts]
   */
  async function openConsole (pub, alias, { consoleId } = {}) {
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
      const pick = consoleId ? { resume: consoleId } : await choose(s)
      mountTerm(s)
      if (pick.resume) {
        try { await s.agent.attach(pick.resume, s.term.cols, s.term.rows) } catch (e) {
          if (e.code !== 'no-console') throw e
          // Ya no existe: se dice en la pestaña y no se recuerda más.
          s.status = t('console_gone'); setTabState(s, 'err'); persist()
          s.term.write(`\x1b[33m${t('console_gone')}\x1b[0m\r\n`)
          if (active === s) hint.textContent = t('console_gone')
          return
        }
      } else {
        await s.agent.open(s.term.cols, s.term.rows)
      }
      persist()
      s.status = 'conectado'; setTabState(s, 'ok')
      if (active === s) hint.textContent = t('connected', s.alias)
      setActive(s)
    } catch (e) {
      s.status = e.message; setTabState(s, 'err')
      if (active === s) hint.textContent = t('conn_fail') + e.message
      if (s.term) { try { s.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`) } catch {} }
    }
  }

  /** Vuelve a abrir las pestañas que había antes de recargar. */
  function restore () { for (const x of loadTabs()) openConsole(x.sub, x.alias, { consoleId: x.consoleId }) }

  // Al irse (recargar, cerrar), se SUELTAN las consolas: siguen vivas en la máquina.
  window.addEventListener('pagehide', () => { for (const x of sessions) { try { x.agent?.disconnect() } catch {} } })

  return { openConsole, restore, sessions }
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
  host.restore()

  // --- AUTODESCUBRIMIENTO: se pregunta a los miembros del acta qué son (`probeAgents`) y
  // se listan los que contestan como terminal, con el nombre que les puso el dueño. Una
  // máquina apagada no contesta y no sale; el re-sondeo la añade en cuanto se enciende.
  ;(async () => {
    const box = qs('#machines')
    let members
    try {
      const { WebSocketProxyClient } = await import('@dotrino/proxy-client')
      members = await listAgentsByLabel(link.id)
      _probeClient = new WebSocketProxyClient({ url: link.proxy || 'wss://proxy.dotrino.com', enableWebRTC: false, autoReconnect: true })
      await _probeClient.connect()
    } catch {
      box.innerHTML = `<span class="status">${t('machines_err')}</span>`
      return
    }
    const seen = new Map() // sub → fila: las que alguna vez contestaron como terminal
    const holderOf = () => {
      let holder = box.querySelector('.machine-list')
      if (!holder) { box.innerHTML = `<b>${t('machines_title')}</b><div class="machine-list"></div>`; holder = box.querySelector('.machine-list') }
      return holder
    }
    const showNone = () => {
      box.innerHTML = `
        <p class="status">${t('machines_none')}</p>
        <div class="setup">
          <b>${t('setup_title')}</b>
          <p class="status">${t('setup_body')}</p>
          ${installCmds()}
          <p class="status">1 · ${t('setup_s1')}</p>
          <p class="status">2 · ${t('setup_s2')}</p>
        </div>`
    }
    const update = async () => {
      if (!_probeClient) return
      const found = await probeAgents(_probeClient, members.map((m) => m.sub))
      for (const m of members) {
        if (found.get(m.sub)?.kind !== AGENT_KIND || seen.has(m.sub)) continue
        const deviceId = (await pubkeyId(m.sub)).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2')
        const name = m.label ? `${m.label} · ${deviceId}` : deviceId
        const row = el(`<div class="machine-row" data-sub="${esc(m.sub)}">
          <button class="machine" data-testid="machine-item" title="${esc(deviceId)}"><span class="mdot"></span>🖥 ${esc(name)}</button>
        </div>`)
        row.querySelector('.machine').addEventListener('click', () => host.openConsole(m.sub, name))
        holderOf().appendChild(row)
        seen.set(m.sub, row)
      }
      for (const [sub, row] of seen) {
        const on = found.has(sub)
        const dot = row.querySelector('.mdot')
        dot.className = 'mdot ' + (on ? 'on' : 'off')
        dot.title = on ? t('machine_online') : t('machine_offline')
      }
      if (!seen.size) showNone()
    }
    await update()
    // Re-sondeo: añade la máquina que se enciende y apaga el punto de la que se cierra.
    _probeTimer = setInterval(update, 30000)
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
