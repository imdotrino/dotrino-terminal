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

    override fun onResume() { super.onResume(); if (Consoles.profile == null) boot() }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    @Deprecated("Activity without AndroidX: the back button still comes here")
    override fun onBackPressed() {
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
        status = label("", 13f, col(R.color.t_muted)).apply { setPadding(px(16), px(6), px(16), px(6)); visibility = View.GONE; setBackgroundColor(col(R.color.t_panel2)) }
        addView(status)
        content = FrameLayout(this@MainActivity)
        addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun boot() {
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
        if (a != null) { renderTabs(); renderNote() } else if (Consoles.profile != null && problem == null) renderMachines()
    }

    private fun render() {
        if (Consoles.profile == null) return
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
        view = null; tabStrip = null; tabNote = null
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

    /** Into a machine: its open consoles to pick up, or a new one right away if it has none. */
    private fun enter(m: Machine) {
        status?.apply { visibility = View.VISIBLE; text = t("machine.connecting", "name" to m.label) }
        scope.launch {
            try {
                val (session, consoles) = Consoles.enter(m)
                status?.visibility = View.GONE
                if (consoles.isEmpty()) { openTab(m, session, null); return@launch }
                val (dialog, body) = sheet(t("resume.title"))
                var picked = false
                consoles.forEachIndexed { i, c ->
                    body.add(card().apply {
                        tag = "resume-console"; isClickable = true
                        addView(label(c.title.ifBlank { t("resume.item", "n" to i + 1) }, 16f, bold = true))
                        val notes = listOfNotNull(
                            t("resume.ago", "when" to ago(c.lastActive)),
                            t("resume.local").takeIf { c.local }, t("resume.inUse").takeIf { c.viewers > 0 },
                        )
                        addView(label(notes.joinToString(" · "), 13f, col(R.color.t_muted)))
                        setOnClickListener { picked = true; dialog.dismiss(); openTab(m, session, c.id) }
                    }, top = 10)
                }
                body.add(pill(t("resume.new"), filled = true) { picked = true; dialog.dismiss(); openTab(m, session, null) }.apply { tag = "new-console" }, top = 16)
                // Closing the sheet without choosing opens nothing; the session is let go.
                dialog.setOnDismissListener { if (!picked) session.close() }
                dialog.show()
            } catch (e: Exception) {
                status?.apply { visibility = View.VISIBLE; text = t("machine.failed", "why" to (e.message ?: e.toString())) }
            }
        }
    }

    private fun ago(ts: Long): String {
        val m = (System.currentTimeMillis() - ts) / 60_000
        return when { m < 1 -> t("ago.now"); m < 60 -> t("ago.min", "n" to m); else -> t("ago.h", "n" to m / 60) }
    }

    private fun openTab(m: Machine, session: com.dotrino.sdk.RemoteAgent.Session, resume: String?) {
        // The size the terminal will have: the one on screen if there is one, or a first guess the view corrects.
        val v = view
        active = Consoles.open(m, session, resume, v?.cols ?: 80, v?.rows ?: 24)
        render()
    }

    // ---------- a console ----------

    private fun renderTerminal() {
        val c = content ?: return
        val tab = active ?: return
        val tv = TerminalView(this).apply {
            tag = "terminal"
            terminal = tab.terminal
            onInput = { active?.input(it) }
            onResize = { cols, rows -> active?.resize(cols, rows) }
            onLongPress = { consoleMenu() }
            onModifiersChanged = { renderModifiers() }
        }
        view = tv
        bindOutput()
        val strip = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(px(8), px(6), px(8), px(6)) }
        tabStrip = strip
        val note = label("", 13f, col(R.color.t_muted)).apply { setPadding(px(16), px(8), px(16), px(8)); setBackgroundColor(col(R.color.t_panel2)); visibility = View.GONE }
        tabNote = note
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; setBackgroundColor(col(R.color.t_panel)); addView(strip) })
            addView(note)
            addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(extraKeys())
        })
        renderTabs(); renderNote()
        tv.showKeyboard()
    }

    private fun bindOutput() {
        for (tab in Consoles.tabs) { tab.onOutput = {}; tab.onBell = {} }
        active?.onOutput = { view?.onOutput() }
    }

    private fun renderTabs() {
        val strip = tabStrip ?: return
        strip.removeAllViews()
        for (tab in Consoles.tabs) {
            val on = tab === active
            strip.addView(LinearLayout(this).apply {
                tag = "tab"; gravity = Gravity.CENTER_VERTICAL
                background = rounded(col(if (on) R.color.t_accent else R.color.t_panel2), px(16))
                setPadding(px(12), px(6), px(4), px(6))
                val dot = when (tab.state) { Consoles.Tab.State.OPEN -> R.color.t_online; Consoles.Tab.State.CONNECTING, Consoles.Tab.State.LOST -> R.color.t_muted; else -> R.color.t_danger }
                addView(View(context).apply { background = rounded(col(dot), px(4)) }, LinearLayout.LayoutParams(px(8), px(8)).apply { marginEnd = px(8) })
                addView(label(tab.label.take(24), 14f, col(if (on) R.color.t_on_accent else R.color.t_text), bold = on))
                addView(label("×", 18f, col(if (on) R.color.t_on_accent else R.color.t_muted)).apply {
                    tag = "tab-close"; contentDescription = t("tab.close"); setPadding(px(10), 0, px(8), 0)
                    setOnClickListener { tab.kill() }
                })
                setOnClickListener { if (active !== tab) { active = tab; view?.terminal = tab.terminal; bindOutput(); renderTabs(); renderNote(); view?.let { tab.resize(it.cols, it.rows) } } }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = px(6) })
        }
        strip.addView(label("＋", 20f, col(R.color.t_text)).apply {
            tag = "tab-new"; contentDescription = t("tab.new"); setPadding(px(12), px(2), px(12), px(2))
            setOnClickListener { active = null; render(); loadMachines() }
        })
    }

    /** What the active tab has to say when it is not simply open. */
    private fun renderNote() {
        val note = tabNote ?: return; val tab = active ?: return
        val text = when (tab.state) {
            Consoles.Tab.State.OPEN -> null
            Consoles.Tab.State.CONNECTING -> t("tab.connecting")
            Consoles.Tab.State.LOST -> t("tab.lost")
            Consoles.Tab.State.EXITED -> if (tab.note == "no-console") t("tab.gone") else t("tab.exited")
            Consoles.Tab.State.FAILED -> t("tab.failed", "why" to (tab.note ?: "?"))
        }
        note.visibility = if (text == null) View.GONE else View.VISIBLE
        note.text = text.orEmpty()
        note.setOnClickListener(if (tab.state == Consoles.Tab.State.LOST || tab.state == Consoles.Tab.State.FAILED) View.OnClickListener { tab.retry() } else null)
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
