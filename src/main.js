/**
 * main.js — UI de Dotrino Terminal. Dos estados:
 *   1. Sin enlazar → instrucciones para descargar y configurar el vault
 *      en tu máquina antes de usar la terminal.
 *   2. Enlazado → Conectar: abre una shell real en la máquina del vault, cifrada
 *      punto a punto. Solo este dispositivo puede.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { loadLink, clearLink } from './vaultLink.js'
import { AgentClient } from './agentClient.js'

const app = document.getElementById('app')
const unlinkBtn = document.getElementById('unlinkBtn')

// --- Instalar (PWA) ---
let deferredPrompt = null
const installBtn = document.getElementById('installBtn')
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false })
window.addEventListener('appinstalled', () => { installBtn.hidden = true; deferredPrompt = null })
installBtn.addEventListener('click', async () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; installBtn.hidden = true } })

unlinkBtn.addEventListener('click', () => {
  if (confirm('¿Desenlazar este dispositivo? Tendrás que emparejarlo de nuevo. (Revoca también en el vault con `dotrino-vault revoke`).')) {
    clearLink(); render()
  }
})

function el (html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }

function render () {
  const link = loadLink()
  unlinkBtn.hidden = !link
  app.innerHTML = ''
  app.appendChild(link ? terminalScreen(link) : linkScreen())
}

// --- Pantalla: vault requerido ---
function linkScreen () {
  const node = el(`
    <section class="card">
      <h1>Dotrino Vault requerido</h1>
      <p>Dotrino Terminal necesita un <b>vault</b> corriendo en tu máquina.</p>
      <p>El vault es tu certificador personal: custodia tu identidad y autoriza
      qué dispositivos pueden acceder a tu máquina. Sin él, la terminal no puede
      abrir una consola.</p>
      <p class="cta">Descárgalo, instálalo y enlaza este dispositivo desde
      <a href="https://vault.dotrino.com" target="_blank" rel="noopener">vault.dotrino.com</a></p>
    </section>`)
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
      <div class="machine-bar">
        <select id="machineSel"><option value="">— máquina guardada —</option></select>
        <input id="machineAddr" type="text" placeholder="Dirección de la máquina (la que imprime el agente)" />
        <input id="machineAlias" type="text" class="alias" placeholder="Alias (opcional)" />
        <button id="openBtn" class="primary">Abrir consola</button>
      </div>
      <div id="tabs" class="tabs"></div>
      <div id="terms" class="terms"></div>
      <span id="hint" class="status">Enlazado a <code>${link.iss.slice(0, 12)}…</code> · abre una o varias consolas en tus máquinas.</span>
    </section>`)
  const qs = (s) => node.querySelector(s)
  const tabsEl = qs('#tabs'); const termsEl = qs('#terms'); const hint = qs('#hint')

  // sesiones: { id, alias, pub, agent, term, fit, box, tab, status, onResize }
  const sessions = []
  let active = null
  let counter = 0

  function refreshMachineSelect () {
    const sel = qs('#machineSel')
    const machines = loadMachines()
    sel.hidden = !machines.length
    sel.innerHTML = '<option value="">— máquina guardada —</option>' +
      machines.map((m) => `<option value="${m.pub}">${m.alias}</option>`).join('')
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
    s.tab = el(`<button class="tab"><span class="dot"></span><span class="tlabel">${s.alias}</span><span class="x" title="Cerrar">×</span></button>`)
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
    hint.textContent = `Conectando a ${s.alias}…`
    try {
      s.agent = new AgentClient(link, { agentPubkey: pub })
      s.agent.onError = (e) => { s.status = e.message; setTabState(s, 'err'); if (active === s) hint.textContent = 'Error: ' + e.message }
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
      if (active === s) hint.textContent = `Conectado a ${s.alias}`
      setActive(s)
    } catch (e) {
      s.status = e.message; setTabState(s, 'err')
      if (active === s) hint.textContent = 'No se pudo conectar: ' + e.message
      if (s.term) { try { s.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`) } catch {} }
    }
  }

  qs('#openBtn').addEventListener('click', () => {
    const pub = qs('#machineAddr').value.trim()
    const alias = qs('#machineAlias').value.trim()
    if (!pub) { hint.textContent = 'Pega la dirección de la máquina (la imprime `dotrino-terminal-agent`).'; return }
    qs('#machineAddr').value = ''; qs('#machineAlias').value = ''
    openConsole(pub, alias)
  })

  return node
}

render()

// --- Service worker ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      setInterval(() => reg.update(), 30 * 60 * 1000)
    }).catch(() => {})
  })
}
