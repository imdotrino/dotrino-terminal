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
import { avatarDataUri } from '@dotrino/identity/capabilities'
import { createVaultProfileProvider } from '@dotrino/profile'
import { createVaultReputation } from '@dotrino/reputation'
import { getLink, unpair, identity } from './vault.js'
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
    unlink: 'Desconectar',
    unlink_q: '¿Desconectar este dispositivo de tu bóveda? Tendrás que emparejarlo de nuevo (y afecta a todas las apps Dotrino de este navegador).',
    unlink_yes: 'Sí, desconectar',
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
    my_profile: 'Mi perfil'
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
    unlink: 'Disconnect',
    unlink_q: 'Disconnect this device from your vault? You will have to pair it again (this affects every Dotrino app in this browser).',
    unlink_yes: 'Yes, disconnect',
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
    my_profile: 'My profile'
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
const unlinkBtn = document.getElementById('unlinkBtn')

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

// ---------- Desconectar (modal propio, sin confirm() — §5) ----------
unlinkBtn.addEventListener('click', () => {
  document.querySelector('.modal-back')?.remove()
  const m = el(`<div class="modal-back"><div class="modal card">
    <p>${t('unlink_q')}</p>
    <div class="modal-row">
      <button class="ghost" data-act="no">${t('cancel')}</button>
      <button class="primary" data-act="yes">${t('unlink_yes')}</button>
    </div></div></div>`)
  m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.act === 'no') m.remove() })
  m.querySelector('[data-act=yes]').addEventListener('click', async () => {
    try { await unpair() } catch {}
    m.remove(); render()
  })
  document.body.appendChild(m)
})

// ---------- Render de estados ----------
let link = null // { paired, id, cert, iss, proxy, deviceId }

async function render () {
  link = await getLink().catch(() => ({ paired: false }))
  unlinkBtn.hidden = !link.paired
  unlinkBtn.textContent = t('unlink')
  installBtn.textContent = t('install')
  app.innerHTML = ''
  app.appendChild(link.paired ? terminalScreen(link) : linkScreen())
}

// --- Pantalla: conectar la bóveda ---
function linkScreen () {
  const node = el(`
    <section class="card">
      <h1>${t('linked_title')}</h1>
      ${link?.expired ? `<p class="cta">${t('expired', new Date(link.exp).toLocaleDateString())}</p>` : ''}
      <p>${t('need_vault')}</p>
      <p class="cta">${t('step1')} <a href="https://vault.dotrino.com" target="_blank" rel="noopener">vault.dotrino.com</a></p>
      <p class="cta">${t('step2')} <a href="https://profile.dotrino.com/#vault" target="_blank" rel="noopener">profile.dotrino.com</a></p>
      <p>${t('step3')} <button id="recheck" class="primary">${t('recheck')}</button> <span id="chkmsg" class="status"></span></p>
    </section>`)
  node.querySelector('#recheck').addEventListener('click', async (e) => {
    e.target.disabled = true
    node.querySelector('#chkmsg').textContent = t('checking')
    const l = await getLink().catch(() => ({ paired: false }))
    if (l.paired) return render()
    node.querySelector('#chkmsg').textContent = t('still_not')
    e.target.disabled = false
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

// --- Pantalla: gestor multi-consola (varias máquinas / varias shells a la vez) ---
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
        b.addEventListener('click', () => openConsole(d.sub, name))
        holder.appendChild(b)
      }
    } catch {
      box.innerHTML = `<span class="status">${t('machines_err')}</span>`
    }
  })()

  // sesiones: { id, alias, pub, agent, term, fit, box, tab, status, onResize }
  const sessions = []
  let active = null
  let counter = 0

  function refreshMachineSelect () {
    const sel = qs('#machineSel')
    const machines = loadMachines()
    sel.hidden = !machines.length
    sel.innerHTML = `<option value="">${t('saved_machine')}</option>` +
      machines.map((m) => `<option value="${esc(m.pub)}">${esc(m.alias)}</option>`).join('')
  }
  refreshMachineSelect()
  qs('#machineSel').addEventListener('change', (e) => {
    if (!e.target.value) return
    qs('#machineAddr').value = e.target.value
    const m = loadMachines().find((x) => x.pub === e.target.value)
    if (m && !qs('#machineAlias').value) qs('#machineAlias').value = m.alias
  })

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
      rememberMachine(pub, alias); refreshMachineSelect()
      s.status = 'conectado'; setTabState(s, 'ok')
      if (active === s) hint.textContent = t('connected', s.alias)
      setActive(s)
    } catch (e) {
      s.status = e.message; setTabState(s, 'err')
      if (active === s) hint.textContent = t('conn_fail') + e.message
      if (s.term) { try { s.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`) } catch {} }
    }
  }

  qs('#openBtn').addEventListener('click', () => {
    const pub = qs('#machineAddr').value.trim()
    const alias = qs('#machineAlias').value.trim()
    if (!pub) { hint.textContent = t('need_addr'); return }
    qs('#machineAddr').value = ''; qs('#machineAlias').value = ''
    openConsole(pub, alias)
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
