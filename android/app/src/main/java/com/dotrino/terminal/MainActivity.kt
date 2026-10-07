package com.dotrino.terminal

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.dotrino.sdk.ui.DotrinoLocale
import com.dotrino.sdk.ui.DotrinoTopbar
import com.dotrino.sdk.ui.DotrinoWebActivity
import com.dotrino.sdk.ui.IdentityRequired
import com.dotrino.terminal.term.TerminalView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The app: your machines and, from there, their consoles in tabs. «Back» from a console
 * returns to the machines (the consoles stay open); from the machines, leaves. Plain native
 * views. The consoles themselves live in [Consoles], not here: turning the phone keeps them.
 */
class MainActivity : Activity() {
    private companion object {
        const val WIKI = "https://wiki.dotrino.com"
        /** The keys a phone keyboard lacks. A name [TerminalView.key] knows, or a literal character. */
        val EXTRA_KEYS = listOf("esc", "tab", "ctrl", "alt", "up", "down", "left", "right", "home", "end", "pgup", "pgdn", "-", "/", "|", "~")
        val KEY_LABELS = mapOf("esc" to "Esc", "tab" to "Tab", "up" to "↑", "down" to "↓", "left" to "←", "right" to "→", "home" to "Home", "end" to "End", "pgup" to "PgUp", "pgdn" to "PgDn")
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var content: FrameLayout? = null
    private var status: TextView? = null
    /** The tab on screen; null = the machines list. */
    private var active: Consoles.Tab? = null
    private var view: TerminalView? = null
    private var tabStrip: LinearLayout? = null
    private var tabNote: TextView? = null
    private var modKeys = HashMap<String, TextView>()
    private var machines: List<Machine>? = null
    private var problem: String? = null

    override fun attachBaseContext(base: Context) = super.attachBaseContext(DotrinoLocale.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        I18n.load(this)
        setContentView(shell())
        Consoles.onChange = { refresh() }
        boot()
    }

    override fun onResume() { super.onResume(); if (Consoles.profile == null && !Consoles.demo) boot() }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    @Deprecated("Activity without AndroidX: the back button still comes here")
    override fun onBackPressed() {
        if (drawer != null) { openDrawer(false); return }
        if (active != null) { active = null; render(); return }
        @Suppress("DEPRECATION") super.onBackPressed()
    }

    // ---------- the frame ----------

    private fun shell(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(col(R.color.t_bg))
        fitsSystemWindows = true
        addView(DotrinoTopbar(this@MainActivity, repo = "imdotrino/dotrino-terminal",
            brand = DotrinoTopbar.Brand("Terminal", R.drawable.terminal_brand),
            profile = Consoles.profile?.topbar(),
        ) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://dotrino.com/"))) }.view)
        // The status («Conectando…», «Sin conexión») FLOATS over the content, at the top. As a row of
        // the column it pushed everything down when it showed, and the console changed size.
        // Rule (owner, 2026-10-07): nothing that comes and goes may change the console's size.
        status = label("", 13f, col(R.color.t_text)).apply {
            tag = "status"; setPadding(px(14), px(7), px(14), px(7)); visibility = View.GONE
            background = rounded(col(R.color.t_panel2), px(14), px(1), col(R.color.t_line)); elevation = px(6).toFloat()
        }
        content = FrameLayout(this@MainActivity)
        addView(FrameLayout(this@MainActivity).apply {
            addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = px(8); marginStart = px(24); marginEnd = px(24) })
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun boot() {
        if (Consoles.demo) { setContentView(shell()); active = Consoles.tabs.lastOrNull(); render(); return }
        if (!IdentityRequired.check(this)) { showProblem(t("boot.noIdentityApp")); return }
        scope.launch {
            try {
                Consoles.boot(this@MainActivity)
                setContentView(shell())                              // the bar again, now with the profile
                render()
                loadMachines()
            } catch (e: Consoles.BootError) {
                when (e.code) {
                    "no-identity-app" -> { IdentityRequired.show(this@MainActivity); showProblem(t("boot.noIdentityApp")) }
                    "no-profile", "no-profile-keys" -> showProblem(t("boot.noProfile"), profileActions = true)
                    "no-vault" -> showProblem(t("boot.noVault"), vaultAction = true)
                    else -> showProblem(e.message ?: e.code)
                }
            } catch (e: Exception) { showProblem(e.message ?: e.toString()) }
        }
    }

    private fun showProblem(msg: String, profileActions: Boolean = false, vaultAction: Boolean = false) {
        val c = content ?: return
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(px(32), px(32), px(32), px(32))
            add(label(msg, 16f, col(R.color.t_muted)).apply { gravity = Gravity.CENTER })
            val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
            if (profileActions) {
                add(pill(t("boot.create"), filled = true) { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.CREATE_URL) }.apply { tag = "create-profile" }, top = 20, width = wrap)
                add(pill(t("boot.adopt")) { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.ADOPT_URL) }.apply { tag = "adopt-profile" }, top = 12, width = wrap)
            }
            if (vaultAction) add(pill(t("boot.connectVault"), filled = true) { DotrinoWebActivity.open(this@MainActivity, DotrinoTopbar.ADOPT_URL) }.apply { tag = "connect-vault" }, top = 20, width = wrap)
            add(pill(t("boot.retry"), filled = !profileActions && !vaultAction) { Consoles.forget(); boot() }.apply { tag = "retry" }, top = 20, width = wrap)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    /** Something in [Consoles] changed: the bar's status always; the screen, only what it shows. */
    private fun refresh() {
        status?.apply {
            when (Consoles.link) {
                "online" -> visibility = View.GONE
                "connecting" -> { visibility = View.VISIBLE; text = t("link.connecting") }
                else -> { visibility = View.VISIBLE; text = t("link.offline") }
            }
        }
        val a = active
        if (a != null && a !in Consoles.tabs) { active = Consoles.tabs.lastOrNull(); render(); return }
        if (a != null) { renderTabs(); renderNote(); renderPanel() } else if (Consoles.profile != null && problem == null) renderMachines()
    }

    private fun render() {
        if (Consoles.profile == null && !Consoles.demo) return
        if (active != null) renderTerminal() else renderMachines()
    }

    // ---------- your machines ----------

    private fun loadMachines() {
        machines = null; problem = null
        if (active == null) renderMachines()
        scope.launch {
            try { machines = Consoles.machines() } catch (e: Exception) { machines = emptyList(); problem = t("machines.error", "why" to (e.message ?: e.toString())) }
            if (active == null) renderMachines()
        }
    }

    private fun renderMachines() {
        val c = content ?: return
        view = null; tabStrip = null; tabNote = null; panel = null; drawer = null; drawerHost = null; poll?.cancel()
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(16), px(16), px(16), px(24)) }
        if (Consoles.tabs.isNotEmpty()) {
            body.add(pill(t("machines.open", "n" to Consoles.tabs.size), filled = true) { active = Consoles.tabs.last(); render() }.apply { tag = "open-consoles" })
        }
        body.add(label(t("machines.title"), 20f, bold = true), top = if (Consoles.tabs.isEmpty()) 0 else 20)
        val list = machines
        when {
            list == null -> body.add(label(t("machines.loading"), 15f, col(R.color.t_muted)), top = 12)
            list.isEmpty() -> {
                body.add(label(problem ?: t("machines.none"), 15f, col(R.color.t_muted)), top = 12)
                if (problem == null) body.add(pill(t("machines.howto")) { openWiki("terminal") }.apply { tag = "howto" }, top = 16, width = ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            else -> for (m in list) body.add(machineRow(m), top = 12)
        }
        if (list != null) body.add(pill(t("machines.refresh")) { loadMachines() }.apply { tag = "refresh" }, top = 20, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        c.removeAllViews()
        c.addView(ScrollView(this).apply { addView(body) })
    }

    private fun machineRow(m: Machine): View = card().apply {
        tag = "machine"; contentDescription = m.label
        isClickable = true; isFocusable = true
        addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(View(context).apply { background = rounded(col(R.color.t_online), px(5)) }, LinearLayout.LayoutParams(px(10), px(10)).apply { marginEnd = px(12) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(label(m.label, 17f, bold = true))
                addView(label(m.id, 13f, col(R.color.t_muted)).apply { typeface = android.graphics.Typeface.MONOSPACE })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(label("›", 24f, col(R.color.t_muted)))
        })
        setOnClickListener { enter(m) }
    }

    private fun openWiki(page: String) {
        val lang = if (I18n.lang == "en") "/en" else ""
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$WIKI$lang/herramientas/$page/")))
    }

    /** Into a machine: its tab if it is open; if not, a new one on a free console (or a new console). */
    private fun enter(m: Machine) {
        status?.apply { visibility = View.VISIBLE; text = t("machine.connecting", "name" to m.label) }
        scope.launch {
            try {
                // The size the console will have: the one on screen if there is one, or a first guess the view corrects.
                val tab = Consoles.enter(m, view?.cols ?: 80, view?.rows ?: 24)
                status?.visibility = View.GONE
                active = tab; render()
            } catch (e: Exception) {
                status?.apply { visibility = View.VISIBLE; text = t("machine.failed", "why" to (e.message ?: e.toString())) }
            }
        }
    }

    // ---------- a console ----------

    private var panel: LinearLayout? = null
    private var drawer: View? = null
    private var drawerHost: FrameLayout? = null
    private var panelOpen = false
    private var poll: kotlinx.coroutines.Job? = null

    private fun renderTerminal() {
        val c = content ?: return
        val tab = active ?: return
        val tv = TerminalView(this).apply {
            tag = "terminal"
            onInput = { active?.input(it) }
            onResize = { cols, rows -> active?.screen(cols, rows) }
            onLongPress = { consoleMenu() }
            onModifiersChanged = { renderModifiers() }
            terminal = tab.terminal
        }
        view = tv
        bindOutput()
        val strip = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(px(6), px(4), px(6), px(4)) }
        tabStrip = strip
        // What the tab has to say («Conectando…», «pide su clave»): a card floating OVER the console.
        // In the column it pushed the console down each time it showed, and the whole screen jumped.
        val note = label("", 14f, col(R.color.t_text)).apply {
            tag = "tab-note"; gravity = Gravity.CENTER
            setPadding(px(18), px(12), px(18), px(12))
            background = rounded(col(R.color.t_panel2), px(14), px(1), col(R.color.t_line))
            elevation = px(6).toFloat(); visibility = View.GONE
        }
        tabNote = note
        // The consoles panel, as in the PWA: a strip on the left; open, it slides over the console
        // (on a phone, pushing the console aside would change its size).
        val side = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, px(4), 0, px(4)) }
        panel = side
        val stage = FrameLayout(this).apply {
            addView(tv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(note, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { marginStart = px(24); marginEnd = px(24) })
        }
        val body = LinearLayout(this).apply {
            addView(ScrollView(context).apply { isVerticalScrollBarEnabled = false; setBackgroundColor(col(R.color.t_panel)); addView(side) }, LinearLayout.LayoutParams(px(40), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(stage, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        // The open panel goes over the WHOLE row (strip included), so the strip and the panel are
        // never seen at once; and over it, not beside it, so the console keeps its size.
        val row = FrameLayout(this).apply { addView(body, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) }
        drawerHost = row
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; setBackgroundColor(col(R.color.t_panel)); addView(strip) })
            addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(extraKeys())
        })
        drawer = null
        renderTabs(); renderNote(); renderPanel()
        tv.showKeyboard()
        // The panel says what happens on the machine (other screens, titles): ask every 2 s while on screen.
        poll?.cancel()
        poll = scope.launch { while (true) { kotlinx.coroutines.delay(2_000); if (view === tv) active?.list() else break } }
    }

    private fun bindOutput() {
        for (tab in Consoles.tabs) { tab.onOutput = {}; tab.onBell = {}; tab.onGone = { toast(t("tab.goneNew")) } }
        active?.onOutput = { view?.onOutput() }
    }

    /** The tabs: one per machine. */
    private fun renderTabs() {
        val strip = tabStrip ?: return
        strip.removeAllViews()
        for (tab in Consoles.tabs) {
            val on = tab === active
            strip.addView(LinearLayout(this).apply {
                tag = "tab"; gravity = Gravity.CENTER_VERTICAL
                background = rounded(col(if (on) R.color.t_panel2 else R.color.t_panel), px(10), px(1), col(if (on) R.color.t_accent else R.color.t_line))
                setPadding(px(10), px(3), px(2), px(3))
                val dot = when (tab.state) { Consoles.Tab.State.OPEN -> R.color.t_online; Consoles.Tab.State.CONNECTING, Consoles.Tab.State.LOST -> R.color.t_muted; else -> R.color.t_danger }
                addView(View(context).apply { background = rounded(col(dot), px(4)) }, LinearLayout.LayoutParams(px(7), px(7)).apply { marginEnd = px(6) })
                addView(label(tab.label.take(20), 12f, col(R.color.t_text), bold = true))
                addView(label("×", 15f, col(R.color.t_muted)).apply {
                    tag = "tab-close"; contentDescription = t("tab.close"); setPadding(px(8), 0, px(6), 0)
                    setOnClickListener { tab.kill() }
                })
                setOnClickListener { if (active !== tab) { active = tab; render() } }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = px(4) })
        }
        strip.addView(label("＋", 16f, col(R.color.t_text)).apply {
            tag = "tab-new"; contentDescription = t("tab.new"); setPadding(px(10), px(2), px(10), px(2))
            setOnClickListener { active = null; render(); loadMachines() }
        })
    }

    private fun sizeWho(tab: Consoles.Tab, c: ConsoleInfo): String = when {
        tab.sizeIsMine(c) -> t("size.here")
        c.sizeBy?.origin == "local" -> t("size.window")
        else -> t("size.device")
    }

    /** Where a console is, said for this screen (the same words as the PWA's panel). */
    private fun where(tab: Consoles.Tab, c: ConsoleInfo): String {
        val mine = c.id == tab.consoleId
        val others = c.watchers - if (mine) 1 else 0
        var w = when {
            c.watchedLocally -> t("where.local")
            others > 0 -> t("where.other")
            mine -> t("where.here")
            else -> t("where.free")
        }
        if (!mine && c.sizeBy != null && (c.watchers > 1 || c.sizeBy.pinned)) w += " · ${t("size.label")}: ${sizeWho(tab, c)}"
        return w
    }

    /** ⤢ as a small button: dim when off; lit, with the accent, when this screen chose the size. */
    private fun sizeButton(tab: Consoles.Tab): View {
        val on = tab.sizeHere
        val n = tab.number
        return android.widget.ImageView(this).apply {
            tag = "size"; setImageResource(R.drawable.ic_size)
            setColorFilter(col(if (on) R.color.t_accent else R.color.t_muted))
            imageAlpha = if (n == null) 70 else 255
            background = if (on) rounded(col(R.color.t_accent_soft), px(6)) else null
            setPadding(px(7), px(7), px(7), px(7))
            contentDescription = if (n == null) t("size.use", "n" to "") else if (on) t("size.release", "n" to n) else t("size.use", "n" to n)
            isEnabled = n != null
            setOnClickListener { toggleSize(tab) }
        }
    }

    private fun toggleSize(tab: Consoles.Tab) {
        val n = tab.number ?: return
        val on = !tab.sizeHere
        tab.useMySize(on)
        // Said out loud: if this screen already had the size, nothing else changes on screen.
        toast(if (on) t("size.usedNow", "n" to n, "cols" to tab.screenCols, "rows" to tab.screenRows) else t("size.releasedNow", "n" to n))
        scope.launch { kotlinx.coroutines.delay(300); tab.list() }
    }

    private fun actColor(c: ConsoleInfo): Int? = when (c.activity) {
        ConsoleInfo.Activity.BUSY -> R.color.t_busy
        ConsoleInfo.Activity.DONE -> R.color.t_online
        ConsoleInfo.Activity.IDLE -> null
    }

    private fun actText(c: ConsoleInfo): String = when (c.activity) {
        ConsoleInfo.Activity.BUSY -> " · " + t("act.busy")
        ConsoleInfo.Activity.DONE -> " · " + t("act.done")
        ConsoleInfo.Activity.IDLE -> ""
    }

    private fun renderPanel() {
        val side = panel ?: return
        val tab = active ?: return
        side.removeAllViews()
        fun btn(text: String, tagName: String, desc: String, onClick: () -> Unit) = label(text, 15f, col(R.color.t_text)).apply {
            tag = tagName; contentDescription = desc; gravity = Gravity.CENTER
            setPadding(0, px(6), 0, px(6)); isClickable = true
            setOnClickListener { onClick() }
        }
        val full = ViewGroup.LayoutParams.MATCH_PARENT
        side.addView(btn("»", "panel-open", t("panel.open")) { openDrawer(true) }, LinearLayout.LayoutParams(full, ViewGroup.LayoutParams.WRAP_CONTENT))
        side.addView(btn("+", "console-new", t("console.new")) { tab.switchTo(null) }, LinearLayout.LayoutParams(full, ViewGroup.LayoutParams.WRAP_CONTENT))
        side.addView(sizeButton(tab), LinearLayout.LayoutParams(px(30), px(30)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = px(2); bottomMargin = px(4) })
        for (c in tab.consoles) {
            val on = c.id == tab.consoleId
            // Amber while something works in it, green when it finished and nobody looked (as the PWA's panel).
            val act = actColor(c)
            side.addView(label("${c.n}", 13f, col(if (on) R.color.t_on_accent else act ?: R.color.t_text), bold = on || act != null).apply {
                tag = "console-${c.n}"; contentDescription = c.title.ifBlank { t("console.n", "n" to c.n) } + actText(c)
                gravity = Gravity.CENTER; setPadding(0, px(5), 0, px(5))
                background = when {
                    on && act != null -> rounded(col(R.color.t_accent), px(6), px(2), col(act))
                    on -> rounded(col(R.color.t_accent), px(6))
                    act != null -> rounded(col(R.color.t_panel), px(6), px(1), col(act))
                    else -> null
                }
                setOnClickListener { tab.switchTo(c.id) }
                setOnLongClickListener { consoleActions(tab, c); true }
            }, LinearLayout.LayoutParams(px(30), ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = px(3) })
        }
        if (panelOpen) openDrawer(true)
    }

    /** The open panel: over the console, with the titles, where each one is, and who has the size. */
    private fun openDrawer(open: Boolean) {
        val stage = drawerHost ?: return
        drawer?.let { stage.removeView(it) }; drawer = null
        panelOpen = open
        if (!open) return
        val tab = active ?: return
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(8), px(6), px(8), px(10)) }
        list.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(label("«", 16f, col(R.color.t_text)).apply { tag = "panel-close"; contentDescription = t("panel.close"); setPadding(px(6), px(4), px(10), px(4)); setOnClickListener { openDrawer(false) } })
            addView(label(t("panel.title"), 14f, bold = true))
        })
        list.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(px(6), px(6), 0, px(6))
            addView(label(t("console.new"), 13f, col(R.color.t_muted)), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(label("+", 17f).apply { tag = "drawer-new"; setPadding(px(12), 0, px(12), 0); setOnClickListener { tab.switchTo(null); openDrawer(false) } })
        })
        tab.current?.let { cur ->
            list.addView(LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(px(6), px(4), 0, px(8))
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(label(t("size.row", "n" to cur.n, "who" to sizeWho(tab, cur), "cols" to cur.cols, "rows" to cur.rows), 12f, col(R.color.t_muted)))
                    addView(label(if (cur.sizeBy?.pinned == true) t("size.pinned") else t("size.last"), 11f, col(R.color.t_muted)))
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(sizeButton(tab), LinearLayout.LayoutParams(px(32), px(32)))
            })
        }
        for (c in tab.consoles) {
            val on = c.id == tab.consoleId
            list.addView(LinearLayout(this).apply {
                tag = "drawer-console"; gravity = Gravity.CENTER_VERTICAL
                background = if (on) rounded(col(R.color.t_accent_soft), px(8)) else null
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL; setPadding(px(8), px(5), px(4), px(5))
                    val name = (if (on) "● " else "") + "${c.n}" + if (c.title.isNotBlank()) " · " + shortTitle(c.title) else ""
                    addView(label(name, 13f).apply { maxLines = 1 })
                    addView(label(where(tab, c) + actText(c), 11f, col(actColor(c) ?: R.color.t_muted)))
                    setOnClickListener { tab.switchTo(c.id); openDrawer(false) }
                    setOnLongClickListener { consoleActions(tab, c); true }
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(label("×", 16f, col(R.color.t_muted)).apply { tag = "console-kill"; contentDescription = t("console.kill"); setPadding(px(10), px(4), px(8), px(4)); setOnClickListener { tab.killConsole(c.id) } })
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = px(2) })
        }
        val d = ScrollView(this).apply { tag = "drawer"; setBackgroundColor(col(R.color.t_panel)); elevation = px(8).toFloat(); addView(list) }
        stage.addView(d, FrameLayout.LayoutParams(px(270), ViewGroup.LayoutParams.MATCH_PARENT))
        drawer = d
    }

    /** Long press on a console of the panel: what can be done with it. */
    private fun consoleActions(tab: Consoles.Tab, c: ConsoleInfo) {
        val (dialog, body) = sheet(c.title.ifBlank { t("console.n", "n" to c.n) }.let { "${c.n} · " + shortTitle(it) })
        if (c.id != tab.consoleId) body.add(pill(t("console.openHere"), filled = true) { dialog.dismiss(); tab.switchTo(c.id); openDrawer(false) }.apply { tag = "open-here" }, top = 8)
        body.add(pill(t("console.kill")) { dialog.dismiss(); tab.killConsole(c.id) }.apply { tag = "kill" }, top = 10)
        dialog.show()
    }

    /** What the active tab has to say when it is not simply open. */
    private fun renderNote() {
        val note = tabNote ?: return; val tab = active ?: return
        val text = when (tab.state) {
            Consoles.Tab.State.OPEN -> null
            Consoles.Tab.State.CONNECTING -> t("tab.connecting")
            Consoles.Tab.State.LOCKED -> t("code.note")
            Consoles.Tab.State.LOST -> t("tab.lost")
            Consoles.Tab.State.EXITED -> if (tab.note == "no-console") t("tab.gone") else t("tab.exited")
            Consoles.Tab.State.FAILED -> t("tab.failed", "why" to (tab.note ?: "?"))
        }
        note.visibility = if (text == null) View.GONE else View.VISIBLE
        note.text = text.orEmpty()
        note.setOnClickListener(when (tab.state) {
            Consoles.Tab.State.LOST, Consoles.Tab.State.FAILED -> View.OnClickListener { tab.retry() }
            Consoles.Tab.State.LOCKED -> View.OnClickListener { askCode(tab) }
            else -> null
        })
        // The machine asks for its code: the sheet comes up by itself, once per answer of the agent.
        if (tab.state == Consoles.Tab.State.LOCKED) {
            val asked = tab to tab.codeProblem
            if (codeSheet?.isShowing != true && codeAsked != asked) { codeAsked = asked; askCode(tab) }
        } else { codeAsked = null; codeSheet?.dismiss(); codeSheet = null }
    }

    private var codeSheet: android.app.Dialog? = null
    private var codeAsked: Pair<Consoles.Tab, String?>? = null

    /** The machine's code (`dotrino-terminal lock`, set on that machine): typed here, kept only in memory. */
    private fun askCode(tab: Consoles.Tab) {
        codeSheet?.dismiss()
        val (dialog, body) = sheet(t("code.title", "name" to tab.label))
        body.add(label(t("code.lead"), 14f, col(R.color.t_muted)), top = 4)
        when (tab.codeProblem) {
            "bad-code" -> body.add(label(t("code.wrong"), 14f, col(R.color.t_busy)).apply { tag = "code-why" }, top = 10)
            "wait" -> body.add(label(t("code.wait", "min" to maxOf(1, (tab.codeWaitMs + 59_999) / 60_000)), 14f, col(R.color.t_busy)).apply { tag = "code-why" }, top = 10)
        }
        val input = android.widget.EditText(this).apply {
            tag = "code-input"; hint = t("code.label")
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(col(R.color.t_text)); setHintTextColor(col(R.color.t_muted))
            background = rounded(col(R.color.t_panel), px(12), px(1), col(R.color.t_line))
            setPadding(px(14), px(12), px(14), px(12))
        }
        body.add(input, top = 12)
        val go = { val v = input.text.toString(); if (v.isNotEmpty()) { dialog.dismiss(); tab.unlock(v) } }
        input.setOnEditorActionListener { _, _, _ -> go(); true }
        body.add(pill(t("code.ok"), filled = true) { go() }.apply { tag = "code-ok" }, top = 12)
        dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE or android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        codeSheet = dialog
        dialog.show(); input.requestFocus()
    }

    private fun extraKeys(): View {
        modKeys.clear()
        val row = LinearLayout(this).apply { setPadding(px(4), px(4), px(4), px(4)) }
        for (k in EXTRA_KEYS) {
            val key = label(KEY_LABELS[k] ?: when (k) { "ctrl" -> t("key.ctrl"); "alt" -> t("key.alt"); else -> k }, 14f, bold = true).apply {
                tag = "key-$k"; gravity = Gravity.CENTER; minWidth = px(44)
                setPadding(px(10), px(9), px(10), px(9))
                background = rounded(col(R.color.t_panel2), px(8))
                isClickable = true
                setOnClickListener {
                    val v = view ?: return@setOnClickListener
                    when (k) {
                        "ctrl" -> { v.ctrl = !v.ctrl; renderModifiers() }
                        "alt" -> { v.alt = !v.alt; renderModifiers() }
                        in KEY_LABELS.keys -> v.key(k)
                        else -> v.type(k)
                    }
                }
            }
            if (k == "ctrl" || k == "alt") modKeys[k] = key
            row.addView(key, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = px(4) })
        }
        return HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; setBackgroundColor(col(R.color.t_panel)); addView(row) }
    }

    /** Ctrl and Alt stay lit until the next key uses them. */
    private fun renderModifiers() {
        val v = view ?: return
        modKeys["ctrl"]?.background = rounded(col(if (v.ctrl) R.color.t_accent else R.color.t_panel2), px(8))
        modKeys["alt"]?.background = rounded(col(if (v.alt) R.color.t_accent else R.color.t_panel2), px(8))
    }

    private fun consoleMenu() {
        val (dialog, body) = sheet(t("menu.title"))
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        body.add(pill(t("menu.paste"), filled = true) {
            dialog.dismiss()
            clipboard.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()?.let { view?.paste(it) }
        }.apply { tag = "paste" }, top = 8)
        body.add(pill(t("menu.copy")) {
            dialog.dismiss()
            clipboard.setPrimaryClip(ClipData.newPlainText("terminal", view?.screenText().orEmpty()))
            toast(t("menu.copied"))
        }.apply { tag = "copy" }, top = 10)
        dialog.show()
    }
}
