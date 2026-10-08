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
import { DemoAgentClient, DEMO_MACHINE } from './demoAgent.js'
import { panelLines, dropTarget } from './panel.js'
import { clampRatio, splitLeaf, removeLeaf, layoutIds, restoreSaved } from './layout.js'
import { listAgentsByLabel, probeAgents } from '@dotrino/remote-agent/discover'
import { pubkeyId } from '@dotrino/identity/capabilities'

// Lo que contesta el agente de terminal cuando se le pregunta qué es (agent/link.js).
// NO es el nombre del acta: ese lo pone el dueño al emparejar («TerminalLocal»).
const AGENT_KIND = 'terminal-agent'

// ---------- i18n (bilingüe es/en, §9) ----------
const M = {
  es: {
    home_title: 'Tu terminal, también desde el teléfono',
    home_lead: 'Una terminal para tu computadora. Cada ventana que abres la puedes retomar desde el navegador de otro aparato tuyo, tal como la dejaste.',
    home_download: 'Descargar para tu computadora',
    home_platforms: 'Linux y macOS',
    home_open: 'Abrir mis consolas',
    home_how: 'Cómo instalar',
    home_p1: 'Tus ventanas, en cualquier aparato',
    home_p1_d: 'Abre en el teléfono la consola que dejaste en la computadora y sigue donde ibas. Las dos pantallas ven lo mismo.',
    home_p2: 'Solo entran tus aparatos',
    home_p2_d: 'Entra únicamente el aparato que tú enlazaste, y lo que escribes viaja cifrado de punta a punta. Si alguien abre una de tus ventanas desde fuera, la ventana te avisa.',
    home_p3: 'Varios perfiles, una terminal',
    home_p3_d: 'Tu cuenta personal y la del trabajo en la misma computadora. Cambias de una a otra desde el menú.',
    home_remote: '¿Solo quieres entrar a una computadora desde el navegador?',
    home_remote_link: 'Así se prepara',
    step1: '1 · Instala la bóveda en tu PC desde',
    step2: '2 · Conecta este dispositivo (escanea el QR de <code>dotrino-vault pair</code>) en',
    step3: '3 · Vuelve aquí y pulsa:',
    recheck: 'Ya lo conecté',
    checking: 'Comprobando…',
    still_not: 'Este dispositivo aún no está conectado a una bóveda.',
    machines_title: 'Tus máquinas',
    machine_open: (n) => `Abrir una consola en ${n}`,
    machines_loading: 'Buscando tus máquinas…',
    machines_none: 'No se puede conectar con ninguna de tus máquinas.',
    conn_machine: (a) => `No se pudo conectar con ${a}.`,
    how_link: 'Cómo ponerla en marcha',
    machines_err: 'No se pudo consultar tu bóveda (¿está encendida?).',
    machine_online: 'En línea',
    machine_offline: 'Desconectada',
    machine_checking: 'Comprobando…',
    linked_to: (dev) => `Dispositivo <code>${dev}</code> conectado a tu bóveda · abre una o varias consolas en tus máquinas.`,
    self_hint: 'Este navegador es tu bóveda · abre una o varias consolas en tus máquinas.',
    connecting: (a) => `Conectando a ${a}…`,
    connected: (a) => `Conectado a ${a}`,
    error: 'Error: ',
    close: 'Cerrar',
    close_tab: 'Cerrar la pestaña (la consola sigue en la máquina)',
    exited: (c) => `[la consola terminó (${c})]`,
    new_console: 'Nueva consola',
    kill_console: 'Cerrar esta consola',
    move_old_agent: 'Esa máquina todavía no sabe ordenar las consolas. Actualiza allí dotrino-terminal.',
    consoles: 'Consolas',
    panel_open: 'Abrir el panel',
    panel_close: 'Colapsar el panel',
    pin_here: 'Esta pantalla manda en el tamaño',
    pin_title: (n, on) => on ? `Soltar: la consola ${n} deja de usar el tamaño de esta pantalla` : `Usar el tamaño de esta pantalla en la consola ${n}`,
    act_busy: 'trabajando',
    act_done: 'terminó',
    pinned_now: (n, cols, rows) => `Consola ${n}: usa el tamaño de esta pantalla (${cols}×${rows}). Las demás la ven a ese tamaño.`,
    unpinned_now: (n) => `Consola ${n}: ya no usa el tamaño de esta pantalla. Lo tiene la última pantalla que la abre.`,
    size_label: 'tamaño',
    size_here: 'esta pantalla',
    size_device: 'otro aparato',
    size_window: 'una ventana de la máquina',
    open_here: 'Abrir aquí',
    console_here: 'en esta pestaña',
    console_other: 'abierta en otro aparato',
    console_free: 'suelta',
    console_local: 'ventana abierta en la máquina',
    split_right: 'Dividir a la derecha', split_down: 'Dividir abajo', open_right: 'Abrir a la derecha', open_down: 'Abrir abajo', close_pane: 'Cerrar este panel', pane_last: 'Es el único panel: cierra la pestaña',
    console_gone: 'Esta consola ya no existe en la máquina: se cerró, o el agente se reinició.',
    closed_by_other: (n) => `Otra pantalla cerró la consola ${n}. Esta es otra.`,
    closed_by_other_new: (n) => `Otra pantalla cerró la consola ${n}. Esta es una nueva.`,
    self_choice_title: '¿Cómo quieres entrar?',
    self_choice_intro: 'Para abrir una consola en tus máquinas necesitas certificarlas con una identidad. Elige dónde vive esa identidad:',
    self_choice_vault: 'Conectar tu bóveda',
    self_choice_vault_d: 'Tienes un vault (PC/servidor). Centraliza tu identidad en él.',
    self_choice_self: 'Usar este dispositivo como bóveda',
    self_choice_self_d: 'Sin vault: la identidad de este navegador certifica tus máquinas directamente.',
    self_back_vault: 'Usar una bóveda externa',
    code_title: (alias) => `${alias} pide su clave`,
    code_lead: 'La pusiste en esa máquina con «dotrino-terminal lock». Se recuerda hasta que cierres o recargues esta página.',
    code_label: 'Clave de la máquina',
    code_wrong: 'Esa no es la clave.',
    code_wait: (min) => `Demasiados intentos. Espera ${min} min y vuelve a probar.`,
    code_ok: 'Entrar',
    code_cancel: 'Cancelar',
    code_needed: (alias) => `${alias} pide su clave y no se escribió.`,
  },
  en: {
    home_title: 'Your terminal, from your phone too',
    home_lead: 'A terminal for your computer. Every window you open can be picked up from the browser on another device of yours, right where you left it.',
    home_download: 'Download for your computer',
    home_platforms: 'Linux and macOS',
    home_open: 'Open my consoles',
    home_how: 'How to install',
    home_p1: 'Your windows, on any device',
    home_p1_d: 'Open on your phone the console you left on your computer and carry on. Both screens see the same thing.',
    home_p2: 'Only your devices get in',
    home_p2_d: 'Only a device you linked gets in, and what you type is end-to-end encrypted. If someone opens one of your windows from outside, the window tells you.',
    home_p3: 'Several profiles, one terminal',
    home_p3_d: 'Your personal account and your work one on the same computer. You switch between them from the menu.',
    home_remote: 'Just want to reach a computer from the browser?',
    home_remote_link: 'Here is how to set it up',
    step1: '1 · Install the vault on your PC from',
    step2: '2 · Connect this device (scan the QR from <code>dotrino-vault pair</code>) at',
    step3: '3 · Come back here and press:',
    recheck: 'I connected it',
    checking: 'Checking…',
    still_not: 'This device is not connected to a vault yet.',
    machines_title: 'Your machines',
    machine_open: (n) => `Open a console on ${n}`,
    machines_loading: 'Looking for your machines…',
    machines_none: "Can't connect to any of your machines.",
    conn_machine: (a) => `Couldn't connect to ${a}.`,
    how_link: 'How to get it running',
    machines_err: 'Could not reach your vault (is it on?).',
    machine_online: 'Online',
    machine_offline: 'Offline',
    machine_checking: 'Checking…',
    linked_to: (dev) => `Device <code>${dev}</code> connected to your vault · open one or more consoles on your machines.`,
    self_hint: 'This browser is your vault · open one or more consoles on your machines.',
    connecting: (a) => `Connecting to ${a}…`,
    connected: (a) => `Connected to ${a}`,
    error: 'Error: ',
    close: 'Close',
    close_tab: 'Close the tab (the console stays on the machine)',
    exited: (c) => `[console ended (${c})]`,
    new_console: 'New console',
    kill_console: 'Close this console',
    move_old_agent: 'That machine cannot reorder consoles yet. Update dotrino-terminal there.',
    consoles: 'Consoles',
    panel_open: 'Open the panel',
    panel_close: 'Collapse the panel',
    pin_here: 'This screen sets the size',
    pin_title: (n, on) => on ? `Release: console ${n} stops using this screen's size` : `Use this screen's size for console ${n}`,
    act_busy: 'working',
    act_done: 'finished',
    pinned_now: (n, cols, rows) => `Console ${n}: uses this screen's size (${cols}×${rows}). Other screens show it at that size.`,
    unpinned_now: (n) => `Console ${n}: no longer uses this screen's size. The last screen that opens it sets it.`,
    size_label: 'size',
    size_here: 'this screen',
    size_device: 'another device',
    size_window: 'a window on the machine',
    open_here: 'Open here',
    console_here: 'in this tab',
    console_other: 'open on another device',
    console_free: 'detached',
    console_local: 'window open on the machine',
    split_right: 'Split right', split_down: 'Split down', open_right: 'Open to the right', open_down: 'Open below', close_pane: 'Close this pane', pane_last: 'The only pane: close the tab instead',
    console_gone: 'This console no longer exists on the machine: it was closed, or the agent restarted.',
    closed_by_other: (n) => `Another screen closed console ${n}. This is another one.`,
    closed_by_other_new: (n) => `Another screen closed console ${n}. This is a new one.`,
    self_choice_title: 'How do you want to sign in?',
    self_choice_intro: 'To open a console on your machines you need to certify them with an identity. Choose where that identity lives:',
    self_choice_vault: 'Connect your vault',
    self_choice_vault_d: 'You have a vault (PC/server). It centralizes your identity.',
    self_choice_self: 'Use this device as its own vault',
    self_choice_self_d: 'No vault: this browser\'s identity certifies your machines directly.',
    self_back_vault: 'Use an external vault',
    code_title: (alias) => `${alias} asks for its code`,
    code_lead: 'You set it on that machine with "dotrino-terminal lock". It is remembered until you close or reload this page.',
    code_label: 'Machine code',
    code_wrong: 'That is not the code.',
    code_wait: (min) => `Too many tries. Wait ${min} min and try again.`,
    code_ok: 'Enter',
    code_cancel: 'Cancel',
    code_needed: (alias) => `${alias} asks for its code and it was not typed.`,
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

// Rutas (§5.1: una pantalla es informativa o administrativa, nunca las dos):
//  · `/`          la portada: qué es, descargar la app, cómo instalar. No hace nada del usuario.
//  · `/consoles`  las consolas: tus máquinas, las pestañas. Solo aquí se abre la bóveda.
const onConsoles = /\/consoles\/?$/.test(location.pathname)
const RELEASES = 'https://github.com/imdotrino/dotrino-terminal/releases/latest'
// La portada es la página de entrada: no se vuelve de ninguna parte.
if (!onConsoles) topbar.setAttribute('no-back', '')
const WIKI = (page) => `https://wiki.dotrino.com${lang === 'en' ? '/en' : ''}/herramientas/${page}/`

function homeScreen () {
  const points = [1, 2, 3].map((i) => `<div class="point"><b>${t('home_p' + i)}</b><span>${t('home_p' + i + '_d')}</span></div>`).join('')
  return el(`
    <section class="home" data-testid="home">
      <h1>${t('home_title')}</h1>
      <p class="lead">${t('home_lead')}</p>
      <div class="home-cta">
        <a class="btn primary" href="${RELEASES}" target="_blank" rel="noopener" data-testid="home-download">${t('home_download')}</a>
        <a class="btn" href="/consoles" data-testid="home-consoles">${t('home_open')}</a>
      </div>
      <p class="home-how">${t('home_platforms')} · <a href="${WIKI('terminal-escritorio')}" target="_blank" rel="noopener" data-testid="home-how">${t('home_how')}</a></p>
      <div class="home-points">${points}</div>
      <p class="home-remote">${t('home_remote')} <a href="${WIKI('terminal')}" target="_blank" rel="noopener">${t('home_remote_link')}</a></p>
    </section>`)
}

async function render () {
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null }
  if (_probeClient) { try { _probeClient.close() } catch (_) {} _probeClient = null }
  installEl.setAttribute('lang', lang)
  if (!onConsoles) { app.replaceChildren(homeScreen()); return }
  // `?demo`: la pantalla con un agente de muestra, sin red ni perfil (como en Android e iOS).
  if (new URLSearchParams(location.search).has('demo')) { app.replaceChildren(terminalScreen({ mode: 'demo', paired: true })); return }
  link = await getLink().catch(() => ({ paired: false }))
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
/**
 * El diálogo de la clave de una máquina (`dotrino-terminal lock`). Devuelve lo tecleado, o null
 * si la persona lo deja. `wrong`: el fallo del intento anterior (`bad-code` / `wait`).
 */
function askMachineCode (alias, wrong) {
  return new Promise((resolve) => {
    const why = !wrong ? '' : wrong.code === 'wait' ? t('code_wait', Math.max(1, Math.ceil((wrong.retryMs || 0) / 60000))) : t('code_wrong')
    const back = el(`<div class="modal-back" data-testid="code-modal">
      <form class="card modal">
        <h2>${esc(t('code_title', alias))}</h2>
        <p class="status">${esc(t('code_lead'))}</p>
        ${why ? `<p class="status machine-code-why" data-testid="code-why">${esc(why)}</p>` : ''}
        <input type="password" class="machine-code" autocomplete="off" aria-label="${esc(t('code_label'))}" placeholder="${esc(t('code_label'))}" data-testid="code-input">
        <div class="modal-row">
          <button type="button" data-testid="code-cancel">${esc(t('code_cancel'))}</button>
          <button type="submit" class="primary" data-testid="code-ok">${esc(t('code_ok'))}</button>
        </div>
      </form>
    </div>`)
    const input = back.querySelector('input')
    const done = (v) => { back.remove(); resolve(v) }
    back.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); if (input.value) done(input.value) })
    back.querySelector('[data-testid=code-cancel]').addEventListener('click', () => done(null))
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null) })
    document.body.appendChild(back)
    input.focus()
  })
}

function loadTabs () { try { return JSON.parse(sessionStorage.getItem(SS_TABS) || '[]') } catch { return [] } }
function saveTabs (list) { try { sessionStorage.setItem(SS_TABS, JSON.stringify(list)) } catch {} }


function makeSessionHost ({ tabsEl, termsEl, hint, link }) {
  // Una pestaña es una MÁQUINA con uno o varios PANELES (split, dueño 2026-10-07): cada panel es
  // su propia conexión al agente con su xterm. `s.agent`/`s.term`/`s.fit`/`s.view` son los del
  // panel con el foco, para que el panel de consolas, el tamaño y el menú sigan hablando de «la
  // consola de esta pestaña». El reparto es un árbol: { pane } | { dir: 'row'|'col', a, b, ratio }.
  const sessions = [] // { id, alias, pub, panes: [pane], focus: pane, layout, box, side, panesEl, tab, status, list, collapsed, poll }
  let active = null
  let counter = 0
  let paneCounter = 0

  /** El árbol, con los `consoleId` en las hojas (para recordarlo al recargar). */
  const consoleOf = (p) => p.agent?.consoleId
  const persist = () => saveTabs(sessions.filter((s) => s.agent?.consoleId).map((s) => ({ sub: s.pub, alias: s.alias, consoleId: s.agent.consoleId, layout: layoutIds(s.layout, consoleOf) })))

  /** Las consolas abiertas en cualquier panel de cualquier pestaña. */
  const openEverywhere = () => new Set(sessions.flatMap((x) => x.panes.map((p) => p.agent?.consoleId)).filter(Boolean))

  function newPane (s, collapsed = true) {
    // Cada panel lleva SU panel de consolas (dueño, 2026-10-08): elige, abre y cierra para ese panel.
    const p = { id: ++paneCounter, s, collapsed }
    p.el = el(`<div class="pane" data-testid="pane"><div class="side" data-testid="pane-side" hidden></div><div class="pane-tools">
      <button data-p="right" title="${esc(t('split_right'))}" aria-label="${esc(t('split_right'))}">◫</button>
      <button data-p="down" title="${esc(t('split_down'))}" aria-label="${esc(t('split_down'))}">⊟</button>
      <button data-p="close" title="${esc(t('close_pane'))}" aria-label="${esc(t('close_pane'))}">×</button>
    </div><div class="term"></div></div>`)
    p.view = p.el.querySelector('.term')
    p.side = p.el.querySelector('.side')
    wireSide(s, p)
    p.el.addEventListener('pointerdown', () => focusPane(s, p), true)
    p.el.querySelector('.pane-tools').addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.p; if (!a) return
      e.stopPropagation()
      if (a === 'close') closePane(s, p)
      else splitPane(s, p, a === 'right' ? 'row' : 'col', null)
    })
    s.panes.push(p)
    return p
  }

  function focusPane (s, p) {
    if (s.focus === p) return
    s.focus = p
    for (const x of s.panes) x.el.classList.toggle('focus', x === p)
    try { p.term?.focus() } catch {}
  }

  /** Pinta el árbol en `.panes`: los elementos de los paneles se REUBICAN (el xterm no se vuelve a montar). */
  function renderLayout (s) {
    const build = (n) => {
      if ('pane' in n) return n.pane.el
      const box = el(`<div class="split dir-${n.dir}"></div>`)
      const a = build(n.a); const b = build(n.b)
      const bar = el('<div class="divider" role="separator"></div>')
      box.append(a, bar, b)
      const apply = () => { a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0` }
      apply()
      // Arrastrar el divisor cambia el reparto; los xterm se ajustan por su ResizeObserver.
      bar.addEventListener('pointerdown', (e) => {
        e.preventDefault(); bar.setPointerCapture(e.pointerId)
        const r = box.getBoundingClientRect()
        const move = (ev) => {
          const f = n.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height
          n.ratio = clampRatio(f); apply()
        }
        const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); persist() }
        bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up)
      })
      return box
    }
    const root = build(s.layout)
    // La raíz ocupa todo: un panel que venía de una división trae puesto su reparto (la mitad), y
    // al quedarse solo dejaba vacío el sitio del que se cerró.
    root.style.flex = ''
    s.panesEl.replaceChildren(root)
    for (const p of s.panes) p.el.classList.toggle('focus', p === s.focus)
    s.panesEl.classList.toggle('single', s.panes.length === 1)
  }

  /**
   * Divide el panel `p`: a la derecha (`row`) o abajo (`col`), con la consola `consoleId` o —sin
   * ella— con una libre que no esté abierta en ningún panel, o una nueva.
   */
  async function splitPane (s, p, dir, consoleId) {
    const q = newPane(s, p.collapsed)
    splitLeaf(s.layout, p, dir, q)
    renderLayout(s)
    focusPane(s, q)
    await connectPane(s, q, consoleId)
    persist(); refresh(s)
  }

  /** Cierra el panel `p` (la consola sigue viva en la máquina). El último no se cierra: para eso está la pestaña. */
  function closePane (s, p) {
    if (s.panes.length === 1) { hint.textContent = t('pane_last'); return }
    if (!removeLeaf(s.layout, p)) return
    try { p.agent?.disconnect() } catch {}
    p.resizeObs?.disconnect()
    try { p.term?.dispose() } catch {}
    p.el.remove()
    s.panes.splice(s.panes.indexOf(p), 1)
    if (s.focus === p) { s.focus = null; focusPane(s, s.panes[0]) }
    renderLayout(s); persist(); refresh(s)
  }

  // Al cambiar de pestaña no se toca el tamaño de nadie (§ tamaño: la pantalla lo toma al abrir o
  // cambiar de consola, o con «Ajustar a esta pantalla»).
  function setActive (s) {
    active = s
    for (const x of sessions) {
      x.box.style.display = x === s ? 'flex' : 'none'
      x.tab.classList.toggle('on', x === s)
    }
    if (s?.term) { try { s.term.focus() } catch {} }
  }

  function removeSession (s) {
    clearInterval(s.poll)
    for (const p of s.panes) { p.resizeObs?.disconnect(); try { p.term?.dispose() } catch {} }
    s.box.remove(); s.tab.remove()
    const i = sessions.indexOf(s); if (i >= 0) sessions.splice(i, 1)
    persist()
    if (active === s) setActive(sessions[sessions.length - 1] || null)
  }
  // La × de la pestaña SUELTA las consolas (siguen vivas en la máquina; dueño, 2026-10-07: cerrar la
  // pestaña nunca cierra la consola) y quita la pestaña. Una consola se cierra desde el panel.
  function closeSession (s) { for (const p of s.panes) { try { p.agent?.disconnect() } catch {} } removeSession(s) }

  function renderTab (s) {
    s.tab = el(`<button class="tab" data-testid="term-tab"><span class="dot"></span><span class="tlabel" title="${esc(s.alias)}">${esc(s.alias.split(' · ')[0])}</span><span class="x" title="${t('close_tab')}">×</span></button>`)
    s.tab.addEventListener('click', (e) => { if (!e.target.classList.contains('x')) setActive(s) })
    s.tab.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeSession(s) })
    tabsEl.appendChild(s.tab)
  }
  function setTabState (s, state) { // 'conn' | 'ok' | 'err'
    s.tab.querySelector('.dot').className = 'dot ' + state
    s.tab.title = state === 'err' ? (s.status || 'error') : ''
  }

  /** El tamaño que cabe en el panel `p` de esta pantalla. */
  const fitted = (p) => p.fit.proposeDimensions() || { cols: p.term.cols, rows: p.term.rows }

  /**
   * La vista sigue el tamaño de la consola: si otra pantalla lo tiene, se muestra a ese tamaño (con
   * desplazamiento), sin encogerla.
   */
  function follow (p, info) {
    if (!info?.cols || !info?.rows) return
    if (info.cols !== p.term.cols || info.rows !== p.term.rows) { try { p.term.resize(info.cols, info.rows) } catch {} }
  }

  function mountTerm (s, p) {
    p.term = new Terminal({ fontSize: 14, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', cursorBlink: true, theme: { background: '#0f1416', foreground: '#dfe3e6', cursor: '#81cfff', selectionBackground: '#004c6b' } })
    p.fit = new FitAddon(); p.term.loadAddon(p.fit)
    p.view.replaceChildren()
    p.term.open(p.view); p.fit.fit()
    p.agent.onData = (d) => p.term.write(d)
    p.agent.onExit = (code, why) => {
      if (why?.closedBy === 'other') return closedByOther(s, p, why.id)
      p.term.write(`\r\n${t('exited', code)}\r\n`); persist(); refresh(s)
    }
    p.agent.onMeta = (info) => follow(p, info)
    p.term.onData((d) => p.agent.input(d))
    // Cambió el espacio del panel (girar el teléfono, redimensionar, aparecer o colapsar el panel
    // de consolas, mover un divisor): se le dice al agente, que lo aplica solo si el tamaño es de
    // este panel; si no, la vista sigue al tamaño de la consola.
    let pending = false
    p.onResize = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        if (active === s && p.agent?.consoleId) { const d = fitted(p); p.agent.resize(d.cols, d.rows) }
      })
    }
    p.resizeObs = new ResizeObserver(p.onResize)
    p.resizeObs.observe(p.view)
  }

  // ---- El panel de consolas: el mismo de la app de escritorio ----

  /** ⤢ «Usar el tamaño de esta pantalla»: una flecha diagonal doble, dibujada (no depende de fuentes). */
  const ICON_SIZE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-11 11"/></svg>'

  /** Las líneas de una consola en el panel: máquina (si es otra), carpeta y título del programa. */
  function linesOf (c) {
    const l = panelLines(c.title, c.cwd, c.host)
    return [l.host, l.dir && shortTitle(l.dir), l.name].filter(Boolean)
  }

  /** Esas líneas como filas del panel abierto; el número va con la primera. */
  function rows (c, i, mine) {
    const [first, ...more] = linesOf(c)
    const head = `${c.id === mine ? '● ' : ''}${numOf(c, i)}${first ? ' · ' + esc(first) : ''}`
    return `<span>${head}</span>` + more.map((l) => `<span>${esc(l)}</span>`).join('')
  }

  /**
   * Una ruta para el panel: lo que importa es la carpeta final, así que se recorta POR LA
   * IZQUIERDA, por carpetas enteras, hasta `max` caracteres.
   */
  function shortTitle (text, max = 24) {
    if (text.length <= max) return text
    const parts = text.split('/')
    let out = parts.pop()
    while (parts.length && out.length + parts[parts.length - 1].length + 1 <= max - 1) out = parts.pop() + '/' + out
    return '…/' + (out.length > max - 2 ? '…' + out.slice(-(max - 3)) : out)
  }

  /** Número fijo (lo da el agente ≥ 0.12); con uno anterior, la posición. */
  const numOf = (c, i) => c.n ?? i + 1

  /** La llave de este aparato: con ella se reconoce, en `sizeBy`, si el tamaño es nuestro. */
  const myDevice = () => link?.id?.me?.publickey || null

  function where (s, c, p) {
    const inPane = s.panes.some((p) => p.agent?.consoleId === c.id)
    const others = (c.watchers || []).length - (inPane ? 1 : 0)
    let w = t('console_free')
    if ((c.watchers || []).some((v) => v.origin === 'local')) w = t('console_local')
    else if (others > 0) w = t('console_other')
    else if (inPane) w = t('console_here')
    // Quién tiene el tamaño, si se comparte o se eligió a propósito.
    const b = c.sizeBy
    if (b && c.id !== p.agent?.consoleId && ((c.watchers || []).length > 1 || b.pinned)) {
      const who = sizeWho(b)
      w += ` · ${t('size_label')}: ${who}`
    }
    return w
  }

  /** ¿Usa la consola del panel `p`, a propósito, el tamaño de esta pantalla? */
  function pinnedHere (s, p) {
    const c = (s.list || []).find((x) => x.id === p.agent?.consoleId)
    return !!(c?.sizeBy?.pinned && c.sizeBy.device && c.sizeBy.device === myDevice())
  }

  /** La consola del panel `p` (con su número), tal como la cuenta el agente. */
  function current (s, p) {
    const list = s.list || []
    const i = list.findIndex((x) => x.id === p.agent?.consoleId)
    return i < 0 ? null : { c: list[i], n: numOf(list[i], i) }
  }

  function sizeWho (b) {
    return b?.device && b.device === myDevice() ? t('size_here') : b?.origin === 'local' ? t('size_window') : t('size_device')
  }

  /**
   * El estado de una consola, que da el agente (≥ 0.17): `busy` = está trabajando (un agente de
   * IA lo dice en su título; para lo demás, salida sostenida); `doneAt` = terminó, o pidió
   * atención, y nadie ha entrado ni tecleado desde entonces.
   */
  const actClass = (c) => c.activity === 'busy' ? ' busy' : c.doneAt ? ' done' : ''
  const actText = (c) => c.activity === 'busy' ? ` · ${t('act_busy')}` : c.doneAt ? ` · ${t('act_done')}` : ''

  /** El panel de consolas de CADA panel de la pestaña: la lista es de la máquina, la marcada es la suya. */
  function renderSide (s) { for (const p of s.panes) renderPaneSide(s, p) }

  function renderPaneSide (s, p) {
    if (p.drag?.on) return             // a media arrastrada no se repinta: se llevaría lo que se arrastra
    const list = s.list || []
    const cur = current(s, p)
    const pinOn = pinnedHere(s, p)
    const pinTitle = cur ? t('pin_title', cur.n, pinOn) : t('pin_here')
    const mine = p.agent?.consoleId
    const inPane = (c) => c.id !== mine && s.panes.some((x) => x.agent?.consoleId === c.id) ? ' here' : ''
    const side = p.side
    side.classList.toggle('collapsed', p.collapsed)
    if (p.collapsed) {
      side.innerHTML = `
        <button class="sbtn" data-act="expand" title="${esc(t('panel_open'))}">»</button>
        <button class="sbtn" data-act="new" title="${esc(t('new_console'))}">+</button>
        <button class="sbtn pin${pinOn ? ' on' : ''}" data-act="pin" title="${esc(pinTitle)}" aria-label="${esc(pinTitle)}" aria-pressed="${pinOn}" ${cur ? '' : 'disabled'}>${ICON_SIZE}</button>
        ${list.map((c, i) => `<button class="sbtn num${c.id === mine ? ' on' : ''}${inPane(c)}${actClass(c)}" data-id="${esc(c.id)}" title="${esc((linesOf(c).join('\n') || String(numOf(c, i))) + actText(c))}">${numOf(c, i)}</button>`).join('')}`
    } else {
      side.innerHTML = `
        <div class="srow head"><button class="sbtn" data-act="collapse" title="${esc(t('panel_close'))}">«</button><b>${t('consoles')}</b></div>
        <div class="srow"><span class="grow">${t('new_console')}</span><button class="sbtn" data-act="new">+</button></div>
        ${cur ? `<div class="srow"><span class="grow" data-testid="panel-size">${cur.c.cols}×${cur.c.rows}</span><button class="sbtn pin${pinOn ? ' on' : ''}" data-act="pin" title="${esc(pinTitle)}" aria-label="${esc(pinTitle)}" aria-pressed="${pinOn}">${ICON_SIZE}</button></div>` : ''}
        ${list.map((c, i) => `<div class="srow item${c.id === mine ? ' on' : ''}${inPane(c)}${actClass(c)}" data-id="${esc(c.id)}">
          <span class="grip" aria-hidden="true">⠿</span>
          <button class="pick" data-id="${esc(c.id)}" title="${esc(c.title || '')}">${rows(c, i, mine)}<small>${esc(where(s, c, p) + actText(c))}</small></button>
          <button class="sbtn" data-kill="${esc(c.id)}" title="${esc(t('kill_console'))}">×</button>
        </div>`).join('')}`
    }
  }

  async function refresh (s) {
    if (!s.agent?.rc?.key) return
    try { s.list = await s.agent.list(); renderSide(s) } catch (_) {}
  }

  /** Pasar a otra consola (o a una nueva) en la misma conexión: toma el tamaño de esta pantalla. */
  async function switchTo (s, id, p = s.focus) {
    if (id && id === p.agent.consoleId) return
    // Si esa consola ya está en otro panel de esta pestaña, se va a ese panel en vez de verla dos veces.
    const already = id && s.panes.find((x) => x !== p && x.agent?.consoleId === id)
    if (already) { focusPane(s, already); return }
    const { cols, rows } = fitted(p)
    try {
      p.term.reset()
      try { p.term.resize(cols, rows) } catch {}
      const r = id ? await p.agent.attach(id, cols, rows) : await p.agent.open(cols, rows)
      follow(p, r.console)
      persist()
    } catch (e) {
      p.term.write(`\r\n\x1b[31m${e.code === 'no-console' ? t('console_gone') : e.message}\x1b[0m\r\n`)
    }
    refresh(s); p.term.focus()
  }

  /**
   * Dejar la consola `id` por otra. A una que YA existe: primero una que no mire nadie; si todas
   * se miran, la primera igual. Una NUEVA solo si la máquina se queda sin ninguna (dueño,
   * 2026-10-07: vale para todo cliente remoto). Si la elegida ya no existía (el panel iba un
   * instante por detrás), se vuelve a elegir con la lista fresca, una vez. Devuelve si abrió una nueva.
   */
  async function moveAway (s, p, id, fresh = false) {
    const list = fresh ? await p.agent.list().catch(() => []) : (s.list || [])
    const open = openEverywhere()
    const rest = list.filter((c) => c.id !== id && !open.has(c.id))
    const other = rest.find((c) => !(c.watchers || []).length) || rest[0]
    await switchTo(s, other?.id || null, p)
    const now = p.agent.consoleId
    if (now && now !== id) return !other
    if (fresh) return false
    return moveAway(s, p, id, true)
  }

  /** Cerrar una consola. Si está en un panel de esta pestaña, ese panel pasa antes a otra (o a una nueva). */
  async function killConsole (s, id) {
    const p = s.panes.find((x) => x.agent?.consoleId === id)
    if (p) await moveAway(s, p, id)
    s.agent.kill(id)
    setTimeout(() => refresh(s), 200)
  }

  /**
   * OTRA pantalla cerró la consola de esta pestaña (el teléfono, una ventana de la máquina). La
   * pestaña no se queda muerta: pasa a una consola que ya existe, o a una nueva, y lo dice —
   * la misma regla que la ventana de la máquina (agente 0.24.1).
   */
  async function closedByOther (s, p, id) {
    const n = (s.list || []).find((c) => c.id === id)?.n ?? '?'
    const isNew = await moveAway(s, p, id, true)
    persist()
    if (active === s) hint.textContent = t(isNew ? 'closed_by_other_new' : 'closed_by_other', n)
  }

  /**
   * ⤢ «Esta pantalla manda en el tamaño»: la consola toma el tamaño de esta pestaña y lo sigue
   * (girar el teléfono…) hasta que se suelte, o lo fije otra pantalla. Sin fijar, lo tiene el
   * último que se enganchó.
   */
  function togglePin (s, p) {
    const cur = current(s, p)
    if (!cur) return
    const on = !pinnedHere(s, p)
    const { cols, rows } = fitted(p)
    if (on) {
      try { p.term.resize(cols, rows) } catch {}
      p.agent.resize(cols, rows)
    }
    p.agent.pin(on)
    // Dicho en la línea de estado: si esta pantalla ya tenía el tamaño, no se ve otro cambio.
    hint.textContent = on ? t('pinned_now', cur.n, cols, rows) : t('unpinned_now', cur.n)
    setTimeout(() => refresh(s), 200)
    p.term.focus()
  }

  /** Clic derecho (o mantener pulsado) sobre una consola: lo que se puede hacer con ella. */
  function consoleMenu (s, p, id, x, y) {
    document.querySelector('.cmenu')?.remove()
    const inPane = s.panes.some((x) => x.agent?.consoleId === id)
    const m = el(`<div class="cmenu" style="left:${x}px;top:${y}px">
      <button data-a="here" ${inPane ? 'disabled' : ''}>${t('open_here')}</button>
      <button data-a="right" ${inPane ? 'disabled' : ''}>${t('open_right')}</button>
      <button data-a="down" ${inPane ? 'disabled' : ''}>${t('open_down')}</button>
      <button data-a="kill">${t('kill_console')}</button>
    </div>`)
    m.addEventListener('click', (e) => {
      const a = e.target.dataset.a
      m.remove()
      if (a === 'here') switchTo(s, id, p)
      if (a === 'right' || a === 'down') splitPane(s, p, a === 'right' ? 'row' : 'col', id)
      if (a === 'kill') killConsole(s, id)
    })
    document.body.appendChild(m)
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0)
  }

  function wireSide (s, p) {
    p.side.addEventListener('click', (e) => {
      if (p.dragged) { p.dragged = false; return }   // soltar tras arrastrar no es un clic
      const b = e.target.closest('button'); if (!b) return
      if (b.dataset.act === 'expand' || b.dataset.act === 'collapse') { p.collapsed = !p.collapsed; renderPaneSide(s, p); return }
      if (b.dataset.act === 'new') return switchTo(s, null, p)
      if (b.dataset.act === 'pin') return togglePin(s, p)
      if (b.dataset.kill) return killConsole(s, b.dataset.kill)
      if (b.dataset.id) return switchTo(s, b.dataset.id, p)
    })
    const menuAt = (target, x, y) => { const id = target.closest('[data-id]')?.dataset.id; if (id) consoleMenu(s, p, id, x, y) }
    p.side.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-id]')) { e.preventDefault(); menuAt(e.target, e.clientX, e.clientY) } })
    // Mantener pulsado en el teléfono: lo mismo que el clic derecho.
    let hold = null
    p.side.addEventListener('touchstart', (e) => { const tt = e.touches[0]; hold = setTimeout(() => menuAt(e.target, tt.clientX, tt.clientY), 550) }, { passive: true })
    for (const ev of ['touchend', 'touchmove', 'touchcancel']) p.side.addEventListener(ev, () => clearTimeout(hold), { passive: true })

    // ORDENAR ARRASTRANDO, solo en el panel ABIERTO: una consola se suelta sobre otra y toma su sitio.
    // Con ratón se arrastra la fila entera; con el dedo, por el asa ⠿, para que el resto de la fila
    // siga sirviendo para desplazar el panel. En la franja plegada NO se ordena con nada (dueño,
    // 2026-10-07, dos veces): los números solo se tocan, y la franja se desplaza. El orden es de la máquina.
    const ITEMS = '.srow.item'
    const unmark = () => { for (const el of p.side.querySelectorAll('.drop-before, .drop-after, .dragged')) el.classList.remove('drop-before', 'drop-after', 'dragged') }
    const endDrag = () => { p.drag = null; p.side.classList.remove('dragging'); unmark() }
    p.side.addEventListener('pointerdown', (e) => {
      const item = e.target.closest(ITEMS)
      if (!item || e.button !== 0 || e.target.closest('[data-kill]')) return
      if (e.pointerType !== 'mouse' && !e.target.closest('.grip')) return
      p.drag = { id: item.dataset.id, y: e.clientY, pointer: e.pointerId, on: false, over: null }
    })
    p.side.addEventListener('pointermove', (e) => {
      const d = p.drag
      if (!d || e.pointerId !== d.pointer) return
      if (!d.on) {
        if (Math.abs(e.clientY - d.y) < 6) return      // un clic con el pulso flojo no es arrastrar
        d.on = true
        clearTimeout(hold)
        try { p.side.setPointerCapture(e.pointerId) } catch {}
        p.side.classList.add('dragging')
      }
      const items = [...p.side.querySelectorAll(ITEMS)]
      if (!items.length) return
      // La fila bajo el puntero; por encima de la primera o por debajo de la última, esa.
      const over = items.find((el) => e.clientY < el.getBoundingClientRect().bottom) || items[items.length - 1]
      const ids = items.map((el) => el.dataset.id)
      unmark()
      items[ids.indexOf(d.id)]?.classList.add('dragged')
      d.over = over.dataset.id
      const to = dropTarget(ids, d.id, d.over)
      if (to) over.classList.add(ids.indexOf(d.over) < ids.indexOf(d.id) ? 'drop-before' : 'drop-after')
    })
    p.side.addEventListener('pointerup', async (e) => {
      const d = p.drag
      if (!d || e.pointerId !== d.pointer) return
      const ids = (s.list || []).map((c) => c.id)
      endDrag()
      if (!d.on) return
      p.dragged = true; setTimeout(() => { p.dragged = false }, 0)
      const to = d.over && dropTarget(ids, d.id, d.over)
      if (!to) return renderPaneSide(s, p)
      try { s.list = await p.agent.move(d.id, to.before) } catch (err) { p.term.write(`\r\n\x1b[33m${err.code === 'timeout' ? t('move_old_agent') : err.message}\x1b[0m\r\n`) }
      renderPaneSide(s, p)
    })
    p.side.addEventListener('pointercancel', () => { if (p.drag) { endDrag(); renderPaneSide(s, p) } })
  }

  /**
   * Se engancha a la consola `target`, o abre una nueva si no hay `target`. Si `target` ya no
   * existe (la máquina se reinició, o alguien la cerró), lo dice en la pantalla y pasa a una que SÍ
   * exista —una que no mire nadie y no esté en otra pestaña, o la primera—; una nueva solo si la
   * máquina se quedó sin ninguna (dueño, 2026-10-07: vale para todo cliente remoto; antes aquí se
   * abría siempre una nueva y la máquina acababa con consolas de más).
   */
  async function attachOrOpen (s, p, target) {
    const { cols, rows } = fitted(p)
    try {
      const r = target ? await p.agent.attach(target, cols, rows) : await p.agent.open(cols, rows)
      follow(p, r.console)
    } catch (e) {
      if (e.code !== 'no-console') throw e
      p.term.write(`\x1b[33m${t('console_gone')}\x1b[0m\r\n`)
      const open = openEverywhere()
      const list = (await p.agent.list().catch(() => [])).filter((c) => c.id !== target && !open.has(c.id))
      const other = list.find((c) => !(c.watchers || []).length) || list[0]
      const r = other ? await p.agent.attach(other.id, cols, rows) : await p.agent.open(cols, rows)
      follow(p, r.console)
    }
  }

  /**
   * Conecta el panel `p` a la máquina de `s` y lo engancha a `consoleId`; sin él, a una consola
   * que no mire nadie y no esté en ningún panel, o a una nueva.
   */
  async function connectPane (s, p, consoleId) {
    p.agent = link.mode === 'demo' ? new DemoAgentClient() : new AgentClient(link, { agentPubkey: s.pub })
    p.agent.askCode = ({ wrong }) => askMachineCode(s.alias, wrong)
    p.agent.onError = (e) => { s.status = e.message; setTabState(s, 'err'); if (active === s) hint.textContent = t('error') + e.message }
    // La máquina se reinició (sus sesiones viven en memoria) y el pilar ya volvió a saludar:
    // a la misma consola si sigue viva, o a otra diciéndolo.
    p.agent.onResumed = () => {
      attachOrOpen(s, p, p.agent.consoleId).then(() => {
        persist()
        s.status = 'conectado'; setTabState(s, 'ok')
        if (active === s) hint.textContent = t('connected', s.alias)
      }).catch((e) => p.agent.onError(e))
    }
    await p.agent.connect()
    mountTerm(s, p)
    let target = consoleId
    if (!target) {
      const open = openEverywhere()
      target = (await p.agent.list()).find((c) => !(c.watchers || []).length && !open.has(c.id))?.id
    }
    await attachOrOpen(s, p, target)
    p.side.hidden = false               // el panel de consolas, solo con la máquina conectada
    renderPaneSide(s, p)
  }

  /**
   * Abre una pestaña con la máquina `pub`. Con `consoleId` se engancha a esa consola (al
   * recargar); sin él, a una consola libre de la máquina, o a una nueva si no hay.
   * @param {string} pub
   * @param {string} [alias]
   * @param {{ consoleId?: string }} [opts]
   */
  async function openConsole (pub, alias, { consoleId, layout } = {}) {
    const id = ++counter
    const s = { id, pub, alias: alias || `#${id} ${pub.slice(0, 8)}…`, status: 'conectando', list: [], panes: [], focus: null }
    // Lo del panel con el foco, con los nombres de siempre.
    Object.defineProperties(s, {
      agent: { get: () => s.focus?.agent },
      term: { get: () => s.focus?.term },
      fit: { get: () => s.focus?.fit },
      view: { get: () => s.focus?.view },
    })
    s.box = el('<div class="term-wrap"><div class="panes"></div></div>'); s.box.style.display = 'none'
    s.panesEl = s.box.querySelector('.panes')
    termsEl.appendChild(s.box)
    sessions.push(s)
    const first = newPane(s)
    s.focus = first
    s.layout = { pane: first }
    renderLayout(s)
    renderTab(s); setActive(s); setTabState(s, 'conn')
    hint.textContent = t('connecting', s.alias)
    try {
      // Como en la app de escritorio: una consola que no esté abierta en ninguna parte, antes
      // que crear otra.
      await connectPane(s, first, consoleId)
      persist()
      s.status = 'conectado'; setTabState(s, 'ok')
      if (active === s) hint.textContent = t('connected', s.alias)
      setActive(s)
      refresh(s)
      s.poll = setInterval(() => { if (active === s) refresh(s) }, 2000)
      // El reparto que había antes de recargar: los demás paneles, uno a uno.
      if (layout && !(typeof layout === 'string')) await restoreLayout(s, first, layout)
    } catch (e) {
      // Sin conexión no queda una pestaña vacía (ni al recargar, que las reabre): se quita y se
      // dice, con el enlace a la guía.
      for (const p of s.panes) { try { p.agent?.disconnect() } catch {} }
      removeSession(s)
      if (e.code === 'locked') { hint.textContent = t('code_needed', s.alias); hint.title = ''; return }
      hint.innerHTML = `${esc(t('conn_machine', s.alias))} <a href="${WIKI('terminal')}" target="_blank" rel="noopener">${t('how_link')}</a>`
      hint.title = e.message
    }
  }

  /**
   * Reconstruye un reparto guardado a partir de su PRIMER panel (`first`, ya conectado a la primera
   * hoja): cada división se vuelve a hacer con la consola que tenía la otra rama; si ya no existe,
   * `attachOrOpen` elige otra y lo dice.
   */
  async function restoreLayout (s, first, saved) {
    await restoreSaved(saved, first, async (pane, dir, ratio, consoleId) => {
      const q = newPane(s)
      splitLeaf(s.layout, pane, dir, q, ratio)
      renderLayout(s)
      // Un panel que no llega a conectarse se quita, y su rama no se sigue.
      try { await connectPane(s, q, consoleId); return q } catch { closePane(s, q); return null }
    })
    focusPane(s, first); persist(); refresh(s)
  }

  /** Vuelve a abrir las pestañas que había antes de recargar. */
  function restore () { for (const x of loadTabs()) openConsole(x.sub, x.alias, { consoleId: x.consoleId, layout: x.layout }) }

  // Al irse (recargar, cerrar), se SUELTAN las consolas: siguen vivas en la máquina.
  window.addEventListener('pagehide', () => { for (const x of sessions) for (const p of x.panes) { try { p.agent?.disconnect() } catch {} } })

  return { openConsole, restore, sessions }
}

// --- Pantalla: gestor multi-consola (modo vault externo) ---
function terminalScreen (link) {
  const node = el(`
    <section class="card term-card">
      <div class="bar">
        <div id="tabs" class="tabs"></div>
        <div id="machines" class="machines">
          <span class="status">${t('machines_loading')}</span>
        </div>
      </div>
      <div id="terms" class="terms"></div>
      <span id="hint" class="status">${link.mode === 'self' ? t('self_hint') : t('linked_to', esc(link.deviceId || ''))}</span>
    </section>`)
  const qs = (s) => node.querySelector(s)
  const tabsEl = qs('#tabs'); const termsEl = qs('#terms'); const hint = qs('#hint')
  const host = makeSessionHost({ tabsEl, termsEl, hint, link })
  host.restore()

  if (link.mode === 'demo') {
    const box = qs('#machines')
    box.innerHTML = `<span class="mlabel">${t('machines_title')}</span><div class="machine-list"><div class="machine-row" data-sub="${DEMO_MACHINE.sub}"><button class="machine" data-testid="machine-item"><span class="mdot on"></span>${DEMO_MACHINE.label} +</button></div></div>`
    box.querySelector('.machine').addEventListener('click', () => host.openConsole(DEMO_MACHINE.sub, DEMO_MACHINE.label))
    return node
  }

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
      if (!holder) { box.innerHTML = `<span class="mlabel">${t('machines_title')}</span><div class="machine-list"></div>`; holder = box.querySelector('.machine-list') }
      return holder
    }
    // Página administrativa (§5.1): dice lo que pasa y enlaza la guía; cómo se instala y se
    // pone en marcha vive en el wiki (§9.2), no aquí.
    const showNone = () => {
      box.innerHTML = `<p class="status" data-testid="no-machines">${t('machines_none')} <a href="${WIKI('terminal')}" target="_blank" rel="noopener">${t('how_link')}</a></p>`
    }
    const update = async () => {
      if (!_probeClient) return
      const found = await probeAgents(_probeClient, members.map((m) => m.sub))
      for (const m of members) {
        if (found.get(m.sub)?.kind !== AGENT_KIND || seen.has(m.sub)) continue
        const deviceId = (await pubkeyId(m.sub)).slice(0, 8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2')
        const name = m.label ? `${m.label} · ${deviceId}` : deviceId
        const row = el(`<div class="machine-row" data-sub="${esc(m.sub)}">
          <button class="machine" data-testid="machine-item" title="${esc(t('machine_open', name))}"><span class="mdot"></span>${esc(m.label || deviceId)} +</button>
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
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      setInterval(() => reg.update(), 30 * 60 * 1000)
    }).catch(() => {})
  })
}
