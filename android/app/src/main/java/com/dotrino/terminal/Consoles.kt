package com.dotrino.terminal

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.dotrino.sdk.Delegation
import com.dotrino.sdk.PhoneIdentity
import com.dotrino.sdk.Profile
import com.dotrino.sdk.ProxyConnection
import com.dotrino.sdk.RemoteAgent
import com.dotrino.terminal.term.Terminal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A machine of the account running the terminal agent, as the list shows it. */
data class Machine(val pubkey: String, val label: String) {
    /** `AB12-CD34`: the id `dotrino-vault members` shows for it. */
    val id: String get() = Delegation.keyLabel(pubkey)
}

/** Who has a console's size: the screen that chose it with ⤢, or else the last one that attached. */
data class SizeBy(val origin: String?, val device: String?, val tag: String?, val pinned: Boolean)

/** A console open on a machine (the agent's `consoles` list): the same fields the PWA reads. */
data class ConsoleInfo(
    val id: String, val n: Int, val title: String, val origin: String?,
    val cols: Int, val rows: Int, val viewers: Int, val watchers: Int,
    /** A window of the machine itself is showing it. */
    val watchedLocally: Boolean,
    val sizeBy: SizeBy?, val lastActive: Long,
    /** Something is working in it now (the agent says it, ≥ 0.17: its title or screen keeps changing). */
    val busy: Boolean = false,
    /** It finished (or rang the bell) and nobody has looked at it yet. */
    val doneAt: Long? = null,
    /** The device of each one watching it (null for a window of the machine itself). */
    val watcherDevices: List<String?> = emptyList(),
) {
    enum class Activity { IDLE, BUSY, DONE }
    val activity: Activity get() = if (busy) Activity.BUSY else if (doneAt != null) Activity.DONE else Activity.IDLE
}

/** What a [Consoles.Tab] needs from its session. An interface so the protocol can be tested without a network. */
interface Channel {
    fun send(payload: JsonObject)
    fun onMessage(l: (JsonObject) -> Unit): () -> Unit
    fun onError(l: (Exception) -> Unit): () -> Unit
    fun close()
}

fun RemoteAgent.Session.channel(): Channel = object : Channel {
    override fun send(payload: JsonObject) = this@channel.send(payload)
    override fun onMessage(l: (JsonObject) -> Unit) = this@channel.onMessage(l)
    override fun onError(l: (Exception) -> Unit) = this@channel.onError { l(it) }
    override fun close() = this@channel.close()
}

/** Reads one console of the agent's list (or of `attached` / `meta`). */
fun consoleOf(o: JsonObject): ConsoleInfo? {
    fun str(k: String, from: JsonObject = o) = (from[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun int(k: String) = (o[k] as? JsonPrimitive)?.intOrNull ?: 0
    val id = str("id") ?: return null
    val by = (o["sizeBy"] as? JsonObject)?.let {
        SizeBy(str("origin", it), str("device", it), str("tag", it), (it["pinned"] as? JsonPrimitive)?.booleanOrNull == true)
    }
    return ConsoleInfo(
        id, int("n"), str("title").orEmpty(), str("origin"), int("cols"), int("rows"), int("viewers"),
        (o["watchers"] as? JsonArray)?.size ?: 0,
        (o["watchers"] as? JsonArray).orEmpty().any { ((it as? JsonObject)?.get("origin") as? JsonPrimitive)?.content == "local" },
        by, (o["lastActive"] as? JsonPrimitive)?.longOrNull ?: 0,
        str("activity") == "busy", (o["doneAt"] as? JsonPrimitive)?.longOrNull,
        (o["watchers"] as? JsonArray).orEmpty().map { w -> (w as? JsonObject)?.let { str("device", it) } },
    )
}

/**
 * The title of a console for the panel. The shell sets it as «user@host: path»; what matters is
 * the last folder, so «user@host:» goes (the machine is known) and the path is cut ON THE LEFT,
 * by whole folders, down to [max] characters. The same as the PWA (`shortTitle`).
 */
fun shortTitle(title: String, max: Int = 24): String {
    val text = Regex("""^[^\s:]+@[^\s:]+:\s*(.+)$""").find(title)?.groupValues?.get(1) ?: title
    if (text.length <= max) return text
    val parts = text.split('/').toMutableList()
    var out = parts.removeAt(parts.size - 1)
    while (parts.isNotEmpty() && out.length + parts.last().length + 1 <= max - 1) out = parts.removeAt(parts.size - 1) + "/" + out
    return "…/" + if (out.length > max - 2) "…" + out.takeLast(max - 3) else out
}

object Consoles {
    const val KIND = "terminal-agent"
    private const val DEFAULT_PROXY = "wss://proxy.dotrino.com"

    class BootError(message: String, val code: String) : Exception(message)

    @Volatile var profile: Profile? = null; private set
    private var identity: PhoneIdentity? = null
    private var conn: ProxyConnection? = null
    private val connLock = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val ui = Handler(Looper.getMainLooper())

    val tabs = ArrayList<Tab>()
    /** Something the screen shows changed (a tab's state, its title, the connection). Always on the main thread. */
    var onChange: () -> Unit = {}
    /** The connection to the proxy: `online`, `connecting`, `offline`. */
    @Volatile var link = "connecting"; private set

    private fun changed() = ui.post { onChange() }

    /** The phone's profile. Throws [BootError]: `no-identity-app`, `no-profile`, `no-profile-keys`, `no-vault`. */
    suspend fun boot(context: Context): Profile {
        profile?.let { return it }
        val id = identity ?: PhoneIdentity(context.applicationContext).also { identity = it }
        val p = try { id.profile() } catch (e: Profile.ProfileError) { throw BootError(e.message ?: e.code, e.code) }
        // Without a vault there is no record that names other machines: nothing to connect to.
        if (p.vault == null) throw BootError("this profile is not linked to a vault", "no-vault")
        profile = p
        return p
    }

    /** DEBUG demo (src/debug/DemoConsolesActivity): a tab fed by a scripted agent, with no profile nor network. */
    @Volatile var demo = false; private set

    fun demoTab(machine: Machine, me: String, ch: Channel): Tab {
        demo = true; link = "online"
        val tab = Tab(machine, me) { ui.post(it) }.apply { onChange = { changed() } }
        tabs.add(tab); tab.bind(ch, 80, 24, null)
        return tab
    }

    /** The profile changed in the identity app (another account): start over. */
    fun forget() {
        for (t in tabs.toList()) t.drop()
        tabs.clear(); profile = null
        conn?.close(); conn = null
    }

    /** The connection, identified as the profile. One at a time: two callers must not open two. */
    private suspend fun connection(): ProxyConnection = connLock.withLock {
        conn?.let { return it }
        val p = profile ?: throw BootError("no profile", "no-profile")
        link = "connecting"; changed()
        val c = ProxyConnection(p.vault?.proxy ?: DEFAULT_PROXY, "terminal")
        try {
            c.connect()
            c.identifyAs(p.publickey) { p.signData(it) }
        } catch (e: Exception) { c.close(); link = "offline"; changed(); throw e }
        conn = c; link = "online"; changed()
        // When it drops, every session over it is gone: the tabs come back by themselves.
        scope.launch {
            c.awaitClosed()
            connLock.withLock { if (conn === c) conn = null }
            link = "offline"; changed()
            for (t in tabs.toList()) t.lost()
            reconnect()
        }
        c
    }

    /** How long the machine has to answer, coming back from the background, before the connection is taken for dead. */
    const val WAKE_MS = 2500L

    /**
     * The app came back to the front. Android may have frozen it and the socket may be dead
     * without anyone knowing yet (it took seconds to find out, with the screen deaf meanwhile).
     * So it is ASKED: every open tab says «checking» at once and pings its machine; if one gets
     * no answer in [WAKE_MS] the connection is dropped here, and the usual way back starts.
     */
    fun wake() {
        if (demo || profile == null) return
        val asked = tabs.filter { it.state == Tab.State.OPEN }
        for (t in asked) t.check()
        scope.launch {
            // No connection at all (it dropped while asleep): try now, not when the back-off says.
            if (conn == null && tabs.any { it.state == Tab.State.LOST }) {
                try { connection() } catch (_: Exception) { return@launch }
                for (t in tabs.toList()) if (t.state == Tab.State.LOST) resume(t)
                return@launch
            }
            delay(WAKE_MS)
            if (asked.any { it.checking }) connLock.withLock { conn }?.close()
        }
    }

    private suspend fun reconnect() {
        var wait = 1_000L
        while (profile != null && tabs.any { it.state != Tab.State.EXITED }) {
            try { connection(); break } catch (_: Exception) { delay(wait); wait = minOf(wait * 2, 30_000) }
        }
        for (t in tabs.toList()) if (t.state == Tab.State.LOST) scope.launch { resume(t) }
    }

    /** The machines of the account that are ON and run the terminal agent. */
    suspend fun machines(): List<Machine> {
        val p = profile ?: throw BootError("no profile", "no-profile")
        val candidates = RemoteAgent.candidates(p)
        val found = RemoteAgent.probe(connection(), candidates.map { it.first })
        return candidates.filter { found[it.first] == KIND }
            .map { (pub, label) -> Machine(pub, label?.takeIf { it.isNotBlank() } ?: Delegation.keyLabel(pub)) }
            .sortedBy { it.label.lowercase() }
    }

    /**
     * The tab of [machine]: one per machine, as in the PWA. If it is already open, that one; if not, a
     * new one that attaches to a free console of the machine (or opens one when none is free).
     */
    suspend fun enter(machine: Machine, cols: Int, rows: Int): Tab {
        tabs.firstOrNull { it.machine == machine }?.let { return it }
        val p = profile ?: throw BootError("no profile", "no-profile")
        val session = openSession(p, machine)
        val tab = Tab(machine, p.publickey) { ui.post(it) }.apply { onChange = { changed() } }
        ui.post { tabs.add(tab); tab.bind(session.channel(), cols, rows, null); changed() }
        return tab
    }

    /**
     * A session with [machine]. If its paper names a record newer than the phone's (the vault
     * changed it), the phone catches up from the vault once and keeps the new record for every
     * app; until then this failed with `acta-vieja`.
     */
    private suspend fun openSession(p: Profile, machine: Machine): RemoteAgent.Session {
        val c = connection()
        return RemoteAgent.open(p, c, machine.pubkey, catchUp = {
            val id = identity ?: throw BootError("no identity", "no-identity-app")
            id.catchUp(p, c).also { profile = it }
        })
    }

    /** Over a new session, the tab comes back to the console it had (the screen is replayed). */
    private suspend fun resume(tab: Tab) {
        try {
            val p = profile ?: return
            val s = openSession(p, tab.machine)
            ui.post { tab.bind(s.channel(), tab.screenCols, tab.screenRows, tab.consoleId); changed() }
        } catch (e: Exception) { tab.lostWith(e.message) }
    }

    /**
     * The code of each machine that asks for one, by the machine's key. In MEMORY only: it lasts
     * while the app lives, so coming back after a dropped connection does not ask again.
     */
    internal val codes = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * A machine on screen: its session, the console it shows ([consoleId]) and the machine's
     * consoles ([consoles], for the panel). The same rules as the PWA (`src/main.js`):
     *  · switching to another console goes over the same session (`attach` / `open`);
     *  · the emulator has the CONSOLE's size, not the screen's: whoever has the size decides it
     *    (⤢, or the last one that attached), and this screen shows it at that size;
     *  · the screen's size is said with `resize`, and the agent applies it only if it is ours.
     * [post] runs on the main thread (the tests run it right away).
     */
    class Tab(val machine: Machine, private val myDevice: String?, private val post: (() -> Unit) -> Unit) {
        /** LOCKED: the machine asks for its code (`dotrino-terminal lock`) and it has not been typed on this session. */
        enum class State { CONNECTING, OPEN, LOCKED, LOST, EXITED, FAILED }

        val terminal = Terminal(80, 24)
        var state = State.CONNECTING; private set
        /** The console on screen. */
        var consoleId: String? = null; private set
        /** The machine's consoles, sorted by their number. */
        var consoles: List<ConsoleInfo> = emptyList(); private set
        /** Why it failed, or the exit code as text. */
        var note: String? = null; private set
        /** The columns and rows that fit on this screen (not the console's). */
        var screenCols = 80; private set
        var screenRows = 24; private set
        /** Redraw the emulator (main thread). */
        var onOutput: () -> Unit = {}
        var onBell: () -> Unit = {}
        /** Something the panel or the tab strip shows changed. */
        var onChange: () -> Unit = {}
        /** Coming back, its console was gone on the machine (it restarted): a new one was opened instead. */
        var onGone: () -> Unit = {}

        private var channel: Channel? = null
        private var off: (() -> Unit)? = null
        private var offError: (() -> Unit)? = null
        private var fresh = true                                      // the next replay starts a clean screen
        private var choosing = false                                  // waiting for the list to pick a free console
        private var resuming = false                                  // coming back to the console it had, over a new session
        private var trying: String? = null                            // the code sent, waiting for the agent's answer
        private var triedKept = false                                 // the remembered code was already sent on this lock
        /** Back from the background: the machine was asked and has not answered yet ([Consoles.wake]). */
        var checking = false; private set
        /** While LOCKED: why the last code was not taken (`bad-code`, `wait`), or null if none was tried. */
        var codeProblem: String? = null; private set
        /** With `wait`: how long the machine makes everyone wait, in ms. */
        var codeWaitMs = 0L; private set

        init {
            // What the emulator answers by itself (a cursor report) goes back as typed input.
            terminal.onReply = { input(it) }
            terminal.onBell = { onBell() }
        }

        /**
         * How many OTHERS watch a console: windows of the machine and other devices. This phone
         * does not count, on screen or not: after the app slept, its old session stays attached on
         * the machine for a while, and that made its own consoles look «open on another device».
         */
        fun othersWatching(c: ConsoleInfo): Int = c.watcherDevices.count { !Delegation.samePubkey(it, myDevice) }

        /**
         * The console to show when none was asked for (entering the machine, or closing the one on
         * screen, [except]): one nobody else is watching; if all are watched, the first anyway. A
         * NEW one only when the machine has none left (owner, 2026-10-07).
         */
        private fun pick(except: String?): ConsoleInfo? {
            val rest = consoles.filter { it.id != except }
            return rest.firstOrNull { othersWatching(it) == 0 } ?: rest.firstOrNull()
        }

        /** The console on screen, as the agent last described it. */
        val current: ConsoleInfo? get() = consoles.firstOrNull { it.id == consoleId }
        /** Its number (fixed while it lives), or null. */
        val number: Int? get() = current?.n?.takeIf { it > 0 }
        val label: String get() = machine.label

        fun bind(ch: Channel, cols: Int, rows: Int, resume: String?) {
            release()
            channel = ch; fresh = true; state = State.CONNECTING; note = null
            screenCols = cols; screenRows = rows
            off = ch.onMessage { m -> post { handle(m) } }
            offError = ch.onError { e -> post { if (state == State.OPEN || state == State.CONNECTING) lostWith(e.message) } }
            resuming = resume != null
            if (resume != null) send("attach", resume)
            else { choosing = true; list() }                          // a free console if there is one
        }

        private fun send(type: String, id: String?) {
            fresh = true
            channel?.send(buildJsonObject {
                put("type", type); if (id != null) put("id", id)
                put("cols", screenCols); put("rows", screenRows)
            })
        }

        /** Ask the agent for the machine's consoles (the panel). */
        fun list() { try { channel?.send(buildJsonObject { put("type", "list") }) } catch (_: Exception) {} }

        /** Ask the machine anything, to know the connection is alive. Any answer clears [checking]. */
        internal fun check() { if (state != State.OPEN) return; checking = true; onChange(); list() }

        internal fun handle(m: JsonObject) {
            if (checking) { checking = false; onChange() }
            when ((m["type"] as? JsonPrimitive)?.content) {
                "consoles" -> {
                    consoles = (m["list"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::consoleOf) }.sortedBy { it.n }
                    if (choosing) {
                        choosing = false
                        val pick = pick(null)
                        if (pick != null) send("attach", pick.id) else send("open", null)
                    }
                    current?.let(::follow)
                    onChange()
                }
                // The screen as the agent keeps it, in pieces: a clean emulator first, then the pieces.
                "replay" -> { if (fresh) { terminal.feed("\u001bc"); fresh = false }; feed(m) }
                "out" -> feed(m)
                "attached" -> {
                    consoleId = (m["id"] as? JsonPrimitive)?.content
                    (m["console"] as? JsonObject)?.let(::consoleOf)?.let { upsert(it); follow(it) }
                    state = State.OPEN; note = null; resuming = false
                    list(); onChange()
                }
                "meta" -> {
                    val info = (m["console"] as? JsonObject)?.let(::consoleOf) ?: return
                    upsert(info)
                    if (info.id == consoleId) follow(info)
                    onChange()
                }
                "exit" -> { state = State.EXITED; note = (m["code"] as? JsonPrimitive)?.content; list(); onChange() }
                // The machine's code was right: it is remembered while the app lives, and the tab goes on.
                "unlocked" -> {
                    trying?.let { codes[machine.pubkey] = it }
                    trying = null; triedKept = false; codeProblem = null; codeWaitMs = 0
                    state = State.CONNECTING
                    if (consoleId != null) { resuming = true; send("attach", consoleId) } else { choosing = true; list() }
                    onChange()
                }
                "fail" -> {
                    val code = (m["code"] as? JsonPrimitive)?.content
                    // The machine asks for its code. The one typed before (if any) is tried once by
                    // itself; if there is none or it no longer works, the screen asks.
                    if (code == "locked") {
                        if (state != State.LOCKED) { state = State.LOCKED; codeProblem = null }
                        val kept = codes[machine.pubkey]
                        if (kept != null && !triedKept && trying == null) { triedKept = true; unlock(kept) }
                        onChange(); return
                    }
                    if (code == "bad-code" || code == "wait") {
                        codes.remove(machine.pubkey); trying = null
                        state = State.LOCKED; codeProblem = code
                        codeWaitMs = (m["retryMs"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toLong() ?: 0
                        onChange(); return
                    }
                    // Coming back after the machine restarted: its consoles died with it. A new one, and it is said (as the PWA).
                    if (code == "no-console" && resuming) { resuming = false; consoleId = null; send("open", null); onGone(); return }
                    // The console is gone on the machine (it was closed there, or the agent restarted).
                    if (code == "no-console") { state = State.EXITED; note = code } else { state = State.FAILED; note = (m["message"] as? JsonPrimitive)?.content ?: code }
                    list(); onChange()
                }
            }
        }

        private fun upsert(info: ConsoleInfo) {
            consoles = (consoles.filter { it.id != info.id } + info).sortedBy { it.n }
        }

        /** The emulator takes the console's size: if another screen has it, this one shows it at that size. */
        private fun follow(info: ConsoleInfo) {
            if (info.cols <= 0 || info.rows <= 0) return
            if (info.cols != terminal.cols || info.rows != terminal.rows) { terminal.resize(info.cols, info.rows); onOutput() }
        }

        private fun feed(m: JsonObject) {
            val data = (m["data"] as? JsonPrimitive)?.content ?: return
            terminal.feed(data); onOutput()
        }

        /** Type the machine's code. The agent answers `unlocked`, or says why not ([codeProblem]). */
        fun unlock(code: String) {
            trying = code
            try { channel?.send(buildJsonObject { put("type", "unlock"); put("code", code) }) } catch (_: Exception) { trying = null }
        }

        fun input(text: String) {
            if (state != State.OPEN) return
            try { channel?.send(buildJsonObject { put("type", "input"); put("data", text) }) } catch (_: Exception) { /* the connection dropped: `lost` brings it back */ }
        }

        /** What fits on this screen changed (rotating, the keyboard, the font). The agent applies it only if the size is ours. */
        fun screen(cols: Int, rows: Int) {
            if (cols == screenCols && rows == screenRows) return
            screenCols = cols; screenRows = rows
            if (state != State.OPEN) return
            try { channel?.send(buildJsonObject { put("type", "resize"); put("cols", cols); put("rows", rows) }) } catch (_: Exception) {}
        }

        /** Another console of the machine (or a new one, with null) on this screen, over the same session. */
        fun switchTo(id: String?) {
            if (id != null && id == consoleId && state == State.OPEN) return
            state = State.CONNECTING; note = null
            send(if (id != null) "attach" else "open", id)
            onChange()
        }

        /** ⤢ Does the console on screen use THIS screen's size, on purpose? */
        val sizeHere: Boolean get() = current?.sizeBy?.let { it.pinned && Delegation.samePubkey(it.device, myDevice) } == true

        /** Does this screen have the console's size now (chosen or because it arrived last)? */
        fun sizeIsMine(c: ConsoleInfo?): Boolean = c?.sizeBy?.let { Delegation.samePubkey(it.device, myDevice) } == true

        /** ⤢: the console on screen uses this screen's size (on), or stops (off). */
        fun useMySize(on: Boolean) {
            if (state != State.OPEN) return
            try {
                if (on) channel?.send(buildJsonObject { put("type", "resize"); put("cols", screenCols); put("rows", screenRows) })
                channel?.send(buildJsonObject { put("type", "pin"); put("on", on) })
            } catch (_: Exception) {}
        }

        /** Close a console on the machine. If it is the one on screen, first move to another free one (or a new one). */
        fun killConsole(id: String) {
            if (id == consoleId) switchTo(pick(id)?.id)
            try { channel?.send(buildJsonObject { put("type", "kill"); put("id", id) }) } catch (_: Exception) {}
            list()
        }

        /** The tab's ×: closes the console on screen on the machine too (as the PWA's × does), and the tab. */
        fun kill() {
            if (state == State.OPEN) try { channel?.send(buildJsonObject { put("type", "close") }) } catch (_: Exception) {}
            drop()
        }

        /** Leave the tab without touching the console: it stays alive on the machine. */
        internal fun drop() { release(); tabs.remove(this); changed() }

        internal fun release() { off?.invoke(); offError?.invoke(); off = null; offError = null; channel?.close(); channel = null }

        /** The connection dropped under this tab: it comes back by itself. */
        internal fun lost() { checking = false; if (state == State.OPEN || state == State.CONNECTING) { release(); state = State.LOST; onChange() } }

        internal fun lostWith(why: String?) { release(); state = State.LOST; note = why; onChange(); scope.launch { resume(this@Tab) } }

        /** Try again by hand, from the tab's note. */
        fun retry() { scope.launch { resume(this@Tab) } }
    }
}
