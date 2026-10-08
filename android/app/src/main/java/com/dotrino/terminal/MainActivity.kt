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
    // Back from the background the connection is checked at once, and it is said on screen.
    private var wasStopped = false
    override fun onStop() { super.onStop(); wasStopped = true }
    override fun onStart() { super.onStart(); if (wasStopped) { wasStopped = false; Consoles.wake() } }
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
    private var drawerHost: LinearLayout? = null
    private var stripHost: View? = null
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
        val stripScroll = ScrollView(this).apply { isVerticalScrollBarEnabled = false; setBackgroundColor(col(R.color.t_panel)); addView(side) }
        // ▲/▼ over the strip when it overflows (owner, 2026-10-07: a finger on a number sorts, so the
        // strip is not scrolled by dragging); each goes when its end is reached.
        fun arrow(text: String, dir: Int, tagName: String, desc: String) = label(text, 10f, col(R.color.t_text)).apply {
            tag = tagName; contentDescription = desc; gravity = Gravity.CENTER; setBackgroundColor(col(R.color.t_panel))
            setPadding(0, px(4), 0, px(4)); visibility = View.GONE; isClickable = true
            setOnClickListener { stripScroll.smoothScrollBy(0, dir * stripScroll.height * 6 / 10) }
        }
        val up = arrow("▲", -1, "strip-up", t("strip.up")); val down = arrow("▼", 1, "strip-down", t("strip.down"))
        val arrows = {
            val max = (side.height - stripScroll.height).coerceAtLeast(0)
            up.visibility = if (stripScroll.scrollY > 0) View.VISIBLE else View.GONE
            down.visibility = if (stripScroll.scrollY < max) View.VISIBLE else View.GONE
        }
        stripScroll.setOnScrollChangeListener { _, _, _, _, _ -> arrows() }
        stripScroll.viewTreeObserver.addOnGlobalLayoutListener { arrows() }
        val stripFrame = FrameLayout(this).apply {
            addView(stripScroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(up, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
            addView(down, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        stripHost = stripFrame
        val body = LinearLayout(this).apply {
            addView(stripFrame, LinearLayout.LayoutParams(px(40), ViewGroup.LayoutParams.MATCH_PARENT))
            addView(stage, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        // The open panel takes the strip's place, BESIDE the console (owner, 2026-10-07): it does
        // change the console's size, on purpose — over it, it covered what was being read.
        val row = body
        drawerHost = body
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; setBackgroundColor(col(R.color.t_panel)); addView(strip) })
            addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(composeBar())
            addView(extraKeys())
        })
        drawer = null
        renderTabs(); renderNote(); renderPanel()
        if (composing) composeInput?.let { it.requestFocus(); ime().showSoftInput(it, 0) } else tv.showKeyboard()
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
        val others = tab.othersWatching(c)
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
            setPadding(px(7), px(7), px(7), px(7)); scaleType = android.widget.ImageView.ScaleType.CENTER_INSIDE
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
        if (dragging != null) return        // mid-drag the panel is not redrawn: it would take the row away
        val side = panel ?: return
        val tab = active ?: return
        side.removeAllViews()
        // ALL the strip's buttons the same height (44 dp) and each with a subtle background that
        // shows its area (owner, 2026-10-07).
        fun btn(text: String, tagName: String, desc: String, onClick: () -> Unit) = label(text, 15f, col(R.color.t_text)).apply {
            tag = tagName; contentDescription = desc; gravity = Gravity.CENTER
            background = rounded(col(R.color.t_panel2), px(6)); isClickable = true
            setOnClickListener { onClick() }
        }
        side.addView(btn("»", "panel-open", t("panel.open")) { openDrawer(true) }, LinearLayout.LayoutParams(px(30), px(44)).apply { topMargin = px(3) })
        side.addView(btn("+", "console-new", t("console.new")) { tab.switchTo(null) }, LinearLayout.LayoutParams(px(30), px(44)).apply { topMargin = px(3) })
        side.addView(sizeButton(tab).apply { if (background == null) background = rounded(col(R.color.t_panel2), px(6)) }, LinearLayout.LayoutParams(px(30), px(44)).apply { topMargin = px(3) })
        val rows = ArrayList<Pair<String, View>>()
        for (c in tab.consoles) {
            val on = c.id == tab.consoleId
            // Amber while something works in it, green when it finished and nobody looked (as the PWA's panel).
            val act = actColor(c)
            side.addView(label("${c.n}", 13f, col(if (on) R.color.t_on_accent else act ?: R.color.t_text), bold = on || act != null).apply {
                rows.add(c.id to this)
                tag = "console-${c.n}"; contentDescription = c.title.ifBlank { t("console.n", "n" to c.n) } + actText(c)
                gravity = Gravity.CENTER; setPadding(0, px(5), 0, px(5))
                background = when {
                    on && act != null -> rounded(col(R.color.t_accent), px(6), px(2), col(act))
                    on -> rounded(col(R.color.t_accent), px(6))
                    act != null -> rounded(col(R.color.t_panel2), px(6), px(1), col(act))
                    else -> rounded(col(R.color.t_panel2), px(6))
                }
                // The number itself drags (there is no room for a grip, as in the PWA's strip): a tap
                // opens the console, a hold shows its actions, and moving a finger's width reorders.
                dragOrTap(tab, c.id, rows, onTap = { tab.switchTo(c.id) }, onHold = { consoleActions(tab, c) })
                // Tall (44 dp): at 30 they were hard to hit (owner, 2026-10-07).
            }, LinearLayout.LayoutParams(px(30), px(44)).apply { topMargin = px(3) })
        }
        if (panelOpen) openDrawer(true)
    }

    /**
     * Marks, while `id` is dragged, where it would land among `rows`: the dragged one fades and a
     * 2 px line of the accent colour goes above the target (it lands in front) or below (behind).
     */
    private fun marker(id: String, rows: List<Pair<String, View>>): (String?) -> Unit = { target ->
        for ((rid, row) in rows) {
            row.alpha = if (rid == id) 0.5f else 1f
            val to = if (rid == target) dropTarget(rows.map { it.first }, id, rid) else null
            row.foreground = to?.let {
                val gap = (row.height - px(2)).coerceAtLeast(0)
                if (it.before == rid) android.graphics.drawable.InsetDrawable(android.graphics.drawable.ColorDrawable(col(R.color.t_accent)), 0, 0, 0, gap)
                else android.graphics.drawable.InsetDrawable(android.graphics.drawable.ColorDrawable(col(R.color.t_accent)), 0, gap, 0, 0)
            }
        }
    }

    /** The row of `rows` under the finger (screen y); above the first or below the last, that one. */
    private fun rowAt(rows: List<Pair<String, View>>, rawY: Float): String? {
        val at = IntArray(2)
        return (rows.firstOrNull { (_, row) -> row.getLocationOnScreen(at); rawY < at[1] + row.height } ?: rows.lastOrNull())?.first
    }

    /** Ends a drag of `id`: the marks go, and the console moves if it was dropped on another. */
    private fun dropped(tab: Consoles.Tab, id: String, rows: List<Pair<String, View>>, target: String?) {
        dragging = null
        for ((_, row) in rows) { row.alpha = 1f; row.foreground = null }
        if (target != null && target != id) tab.move(id, target) else renderPanel()
    }

    /**
     * A view that is tapped, held or DRAGGED (the strip's numbers, which have no grip): a tap is
     * `onTap`, a hold without moving is `onHold`, and moving further than the touch slop starts a
     * drag that reorders among `rows`. The parent (a ScrollView) is told not to take the gesture once
     * it is a drag, so until then the strip still scrolls.
     */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun View.dragOrTap(tab: Consoles.Tab, id: String, rows: List<Pair<String, View>>, onTap: () -> Unit, onHold: () -> Unit) {
        val slop = android.view.ViewConfiguration.get(context).scaledTouchSlop
        val holdMs = android.view.ViewConfiguration.getLongPressTimeout().toLong()
        val mark = marker(id, rows)
        var downY = 0f; var over: String? = null; var held = false
        val hold = Runnable { held = true; onHold() }
        setOnTouchListener { v, e ->
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> { downY = e.rawY; over = null; held = false; v.parent?.requestDisallowInterceptTouchEvent(true); v.postDelayed(hold, holdMs); true }
                android.view.MotionEvent.ACTION_MOVE -> {
                    if (dragging != id) {
                        if (held || Math.abs(e.rawY - downY) < slop) return@setOnTouchListener true
                        v.removeCallbacks(hold); dragging = id; v.parent?.requestDisallowInterceptTouchEvent(true); mark(null)
                    }
                    over = rowAt(rows, e.rawY); mark(over); true
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    v.removeCallbacks(hold)
                    when {
                        dragging == id -> dropped(tab, id, rows, over.takeIf { e.actionMasked == android.view.MotionEvent.ACTION_UP })
                        !held && e.actionMasked == android.view.MotionEvent.ACTION_UP -> onTap()
                    }
                    true
                }
                else -> false
            }
        }
    }

    /** The console being dragged in the open panel to change its place, or null. */
    private var dragging: String? = null

    /**
     * The grip of a console's row: dragging it up or down moves the console in the panel (dropped
     * on another, it takes its place). A line marks where it would land. A grip and not the row
     * itself, so the row still opens the console, long-presses for its actions and scrolls the panel.
     */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun grip(tab: Consoles.Tab, id: String, rows: List<Pair<String, View>>): View = label("⠿", 15f, col(R.color.t_muted)).apply {
        // Wide enough for a finger (it is the only thing that drags: the row opens and scrolls).
        tag = "console-grip"; contentDescription = t("console.move"); gravity = Gravity.CENTER; minWidth = px(36); setPadding(px(6), px(14), px(4), px(14))
        var over: String? = null
        val mark = marker(id, rows)
        setOnTouchListener { v, e ->
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> { dragging = id; over = null; v.parent?.requestDisallowInterceptTouchEvent(true); mark(null); true }
                android.view.MotionEvent.ACTION_MOVE -> { over = rowAt(rows, e.rawY); mark(over); true }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                    dropped(tab, id, rows, over.takeIf { e.actionMasked == android.view.MotionEvent.ACTION_UP }); over = null; true
                }
                else -> false
            }
        }
    }

    /** The open panel: beside the console, in the strip's place, with the titles, where each one is, and who has the size. */
    private fun openDrawer(open: Boolean) {
        val stage = drawerHost ?: return
        drawer?.let { stage.removeView(it) }; drawer = null
        panelOpen = open
        stripHost?.visibility = if (open) View.GONE else View.VISIBLE
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
            addView(label("+", 17f).apply { tag = "drawer-new"; setPadding(px(12), 0, px(12), 0); setOnClickListener { tab.switchTo(null) } })
        })
        tab.current?.let { cur ->
            list.addView(LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(px(6), px(4), 0, px(8))
                // Just the size (owner, 2026-10-07): who has it is what ⤢ lights up for.
                addView(label("${cur.cols}×${cur.rows}", 13f, col(R.color.t_muted)).apply { tag = "drawer-size" }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(sizeButton(tab), LinearLayout.LayoutParams(px(32), px(32)))
            })
        }
        val rows = ArrayList<Pair<String, View>>()
        for (c in tab.consoles) {
            val on = c.id == tab.consoleId
            list.addView(LinearLayout(this).apply {
                tag = "drawer-console"; gravity = Gravity.CENTER_VERTICAL
                rows.add(c.id to this)
                addView(grip(tab, c.id, rows))
                // The status as in the collapsed strip: a BORDER in its colour (amber = working,
                // green = finished), not only a coloured line of text.
                val act = actColor(c)
                background = when {
                    on && act != null -> rounded(col(R.color.t_accent_soft), px(8), px(2), col(act))
                    on -> rounded(col(R.color.t_accent_soft), px(8))
                    act != null -> rounded(col(R.color.t_panel), px(8), px(1), col(act))
                    else -> null
                }
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL; setPadding(px(4), px(5), px(4), px(5))
                    // The number and the machine (`user@host`, always first) on the first row, as the
                    // PWA's panel; the folder and the title on their OWN rows, whole: cut to «…/…/nal»
                    // they said nothing.
                    val lines = panelLines(c.title, c.cwd, c.host)
                    addView(label((if (on) "● " else "") + "${c.n}" + (lines.host?.let { " · $it" } ?: ""), 13f, bold = true).apply {
                        tag = "drawer-host"; isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END
                    })
                    // ONE line each, never wrapped (a long path would push every row down); what does
                    // not fit is cut at the START, so the end — the folder you are in — stays.
                    fun oneLine(text: String, tagName: String, color: Int) = label(text, 12f, color).apply {
                        tag = tagName; setLineSpacing(0f, 1f); isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.START
                    }
                    lines.dir?.let { addView(oneLine(it, "drawer-cwd", col(R.color.t_text))) }
                    lines.name?.let { addView(oneLine(it, "drawer-title", col(R.color.t_text))) }
                    addView(label(where(tab, c) + actText(c), 11f, col(R.color.t_muted)))
                    setOnClickListener { tab.switchTo(c.id) }
                    setOnLongClickListener { consoleActions(tab, c); true }
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(label("×", 16f, col(R.color.t_muted)).apply { tag = "console-kill"; contentDescription = t("console.kill"); setPadding(px(10), px(4), px(8), px(4)); setOnClickListener { tab.killConsole(c.id) } })
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = px(5) })
        }
        val d = ScrollView(this).apply { tag = "drawer"; setBackgroundColor(col(R.color.t_panel)); addView(list) }
        stage.addView(d, 0, LinearLayout.LayoutParams(px(270), ViewGroup.LayoutParams.MATCH_PARENT))
        drawer = d
    }

    /** Long press on a console of the panel: what can be done with it. */
    private fun consoleActions(tab: Consoles.Tab, c: ConsoleInfo) {
        val (dialog, body) = sheet(c.title.ifBlank { t("console.n", "n" to c.n) }.let { "${c.n} · " + shortTitle(it) })
        if (c.id != tab.consoleId) body.add(pill(t("console.openHere"), filled = true) { dialog.dismiss(); tab.switchTo(c.id) }.apply { tag = "open-here" }, top = 8)
        body.add(pill(t("console.kill")) { dialog.dismiss(); tab.killConsole(c.id) }.apply { tag = "kill" }, top = 10)
        dialog.show()
    }

    /** What the active tab has to say when it is not simply open. */
    private fun renderNote() {
        val note = tabNote ?: return; val tab = active ?: return
        val text = when (tab.state) {
            Consoles.Tab.State.OPEN -> if (tab.checking) t("tab.checking") else null
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

    // ---------- writing here, sending at once ----------
    //
    // Over a slow connection every key travels to the machine and back before it shows. With the
    // writing line on (✎ in the extra row; remembered), what you type shows HERE at once and goes
    // to the machine whole, with Enter. The extra keys (arrows, Ctrl, Esc, Tab) still go straight.
    // Off, everything goes key by key, as full-screen programs (vim, htop) need.

    private var composeRow: View? = null
    private var composeInput: android.widget.EditText? = null
    private var composeKey: TextView? = null
    private val prefs by lazy { getSharedPreferences("terminal", Context.MODE_PRIVATE) }
    private var composing: Boolean
        get() = prefs.getBoolean("compose", false)
        set(v) { prefs.edit().putBoolean("compose", v).apply() }
    private fun ime() = getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager

    private fun composeBar(): View {
        val input = android.widget.EditText(this).apply {
            tag = "compose-input"; hint = t("compose.hint"); isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND or android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI
            typeface = android.graphics.Typeface.MONOSPACE; setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(col(R.color.t_text)); setHintTextColor(col(R.color.t_muted))
            background = rounded(col(R.color.t_bg), px(10), px(1), col(R.color.t_line))
            setPadding(px(12), px(9), px(12), px(9))
        }
        val send = {
            // The line and Enter, in ONE message. Empty, it is just Enter.
            active?.input(input.text.toString() + "\r"); input.setText("")
        }
        input.setOnEditorActionListener { _, _, _ -> send(); true }
        // Backspace on an empty line goes to the console: it is how you fix what is already there.
        input.setOnKeyListener { _, code, ev ->
            if (ev.action == android.view.KeyEvent.ACTION_DOWN && code == android.view.KeyEvent.KEYCODE_DEL && input.text.isEmpty()) { view?.key("backspace"); true }
            else if (ev.action == android.view.KeyEvent.ACTION_DOWN && code == android.view.KeyEvent.KEYCODE_ENTER) { send(); true }
            else false
        }
        // With Ctrl or Alt lit, the next character is a key for the console (Ctrl+C), not text.
        input.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(e: android.text.Editable) {
                val v = view ?: return
                if ((v.ctrl || v.alt) && e.isNotEmpty()) { val c = e.last().toString(); e.delete(e.length - 1, e.length); v.type(c) }
            }
        })
        composeInput = input
        val bar = LinearLayout(this).apply {
            tag = "compose-bar"; gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(col(R.color.t_panel)); setPadding(px(6), px(6), px(6), px(2))
            addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(label("⏎", 18f, col(R.color.t_on_accent), bold = true).apply {
                tag = "compose-send"; contentDescription = t("compose.send"); gravity = Gravity.CENTER
                background = rounded(col(R.color.t_accent), px(10)); setPadding(px(14), px(7), px(14), px(7))
                isClickable = true; setOnClickListener { send() }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = px(6) })
            visibility = if (composing) View.VISIBLE else View.GONE
        }
        composeRow = bar
        return bar
    }

    /** ✎: the writing line on or off. The one change of size here is asked for, and remembered. */
    private fun toggleCompose() {
        composing = !composing
        composeRow?.visibility = if (composing) View.VISIBLE else View.GONE
        composeKey?.background = rounded(col(if (composing) R.color.t_accent else R.color.t_panel2), px(8))
        composeKey?.setTextColor(col(if (composing) R.color.t_on_accent else R.color.t_text))
        if (composing) composeInput?.let { it.requestFocus(); ime().showSoftInput(it, 0) }
        else { composeInput?.setText(""); view?.showKeyboard() }
    }

    private fun extraKeys(): View {
        modKeys.clear()
        val row = LinearLayout(this).apply { setPadding(px(4), px(4), px(4), px(4)) }
        composeKey = label("✎", 14f, col(if (composing) R.color.t_on_accent else R.color.t_text), bold = true).apply {
            tag = "key-compose"; contentDescription = t("compose.toggle"); gravity = Gravity.CENTER; minWidth = px(44)
            setPadding(px(10), px(9), px(10), px(9))
            background = rounded(col(if (composing) R.color.t_accent else R.color.t_panel2), px(8))
            isClickable = true; setOnClickListener { toggleCompose() }
        }
        row.addView(composeKey, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = px(4) })
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
