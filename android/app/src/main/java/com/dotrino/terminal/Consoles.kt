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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** A machine of the account running the terminal agent, as the list shows it. */
data class Machine(val pubkey: String, val label: String) {
    /** `AB12-CD34`: the id `dotrino-vault members` shows for it. */
    val id: String get() = Delegation.keyLabel(pubkey)
}

/** A console open on a machine (the agent's `consoles` list). */
data class ConsoleInfo(val id: String, val title: String, val local: Boolean, val viewers: Int, val lastActive: Long)

/**
 * The terminal of this process: ONE per app, not per screen (turning the phone or leaving to
 * the machines list must not drop the consoles). The phone's profile, one connection to the
 * proxy identified as it, and the open tabs.
 *
 * The same domain protocol as the PWA (`src/agentClient.js`) inside a `RemoteAgent.Session`:
 * `list` · `open` · `attach` · `input` · `resize` · `close` → `consoles` · `replay` ·
 * `attached` · `out` · `meta` · `exit` · `fail`.
 */
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

    private suspend fun reconnect() {
        var wait = 1_000L
        while (profile != null && tabs.any { it.state != Tab.State.EXITED }) {
            try { connection(); break } catch (_: Exception) { delay(wait); wait = minOf(wait * 2, 30_000) }
        }
        for (t in tabs.toList()) if (t.state == Tab.State.LOST) scope.launch { t.resume() }
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

    /** A session with [machine], and the consoles it has open. The caller picks one (or none) and calls [open]. */
    suspend fun enter(machine: Machine): Pair<RemoteAgent.Session, List<ConsoleInfo>> {
        val p = profile ?: throw BootError("no profile", "no-profile")
        val session = RemoteAgent.open(p, connection(), machine.pubkey)
        val mine = tabs.mapNotNull { it.consoleId }.toSet()
        return session to list(session).filter { it.id !in mine }
    }

    private suspend fun list(session: RemoteAgent.Session): List<ConsoleInfo> {
        val got = CompletableDeferred<JsonArray>()
        val off = session.onMessage { m -> if (m["type"]?.jsonPrimitive?.content == "consoles") got.complete(m["list"] as? JsonArray ?: JsonArray(emptyList())) }
        try {
            session.send(buildJsonObject { put("type", "list") })
            return withTimeout(8_000) { got.await() }.mapNotNull { it as? JsonObject }.mapNotNull(::consoleOf).sortedByDescending { it.lastActive }
        } finally { off() }
    }

    private fun consoleOf(o: JsonObject): ConsoleInfo? {
        val id = (o["id"] as? JsonPrimitive)?.content ?: return null
        return ConsoleInfo(
            id, (o["title"] as? JsonPrimitive)?.content.orEmpty(), (o["origin"] as? JsonPrimitive)?.content == "local",
            (o["viewers"] as? JsonPrimitive)?.intOrNull ?: 0, (o["lastActive"] as? JsonPrimitive)?.longOrNull ?: 0,
        )
    }

    /** A new tab on [session]: attached to console [resume], or to a new one. */
    fun open(machine: Machine, session: RemoteAgent.Session, resume: String?, cols: Int, rows: Int): Tab {
        val tab = Tab(machine)
        tabs.add(tab)
        tab.bind(session, resume, cols, rows)
        changed()
        return tab
    }

    /** One console on screen: its emulator, and the session that feeds it. */
    class Tab internal constructor(val machine: Machine) {
        enum class State { CONNECTING, OPEN, LOST, EXITED, FAILED }

        val terminal = Terminal(80, 24)
        var state = State.CONNECTING; private set
        var consoleId: String? = null; private set
        var title = ""; private set
        /** Why it failed, or the exit code as text. */
        var note: String? = null; private set
        /** The shell wrote: redraw (main thread). */
        var onOutput: () -> Unit = {}
        var onBell: () -> Unit = {}

        private var session: RemoteAgent.Session? = null
        private var off: (() -> Unit)? = null
        private var offError: (() -> Unit)? = null
        private var fresh = true                                      // the next replay starts a clean screen

        init {
            // What the emulator answers by itself (a cursor report) goes back as typed input.
            terminal.onReply = { input(it) }
            terminal.onBell = { onBell() }
        }

        val label: String get() = title.ifBlank { machine.label }

        internal fun bind(s: RemoteAgent.Session, resume: String?, cols: Int, rows: Int) {
            session = s; fresh = true
            off = s.onMessage { m -> ui.post { handle(m) } }
            offError = s.onError { e -> ui.post { if (state == State.OPEN || state == State.CONNECTING) { state = State.LOST; note = e.message; changed(); scope.launch { resume() } } } }
            terminal.resize(cols, rows)
            s.send(buildJsonObject {
                if (resume != null) { put("type", "attach"); put("id", resume) } else put("type", "open")
                put("cols", cols); put("rows", rows)
            })
        }

        private fun handle(m: JsonObject) {
            when (m["type"]?.jsonPrimitive?.content) {
                // The screen as the agent keeps it, in pieces: a clean emulator first, then the pieces.
                "replay" -> { if (fresh) { terminal.feed("\u001bc"); fresh = false }; feed(m) }
                "out" -> feed(m)
                "attached" -> {
                    consoleId = (m["id"] as? JsonPrimitive)?.content
                    (m["console"] as? JsonObject)?.let { title = (it["title"] as? JsonPrimitive)?.content.orEmpty() }
                    state = State.OPEN; note = null; changed()
                }
                "meta" -> { (m["console"] as? JsonObject)?.let { title = (it["title"] as? JsonPrimitive)?.content.orEmpty() }; changed() }
                "exit" -> { state = State.EXITED; note = (m["code"] as? JsonPrimitive)?.content; release(); changed() }
                "fail" -> {
                    val code = (m["code"] as? JsonPrimitive)?.content
                    // The console is gone on the machine (it was closed there, or the agent restarted).
                    if (code == "no-console") { state = State.EXITED; note = code; release() } else { state = State.FAILED; note = (m["message"] as? JsonPrimitive)?.content ?: code }
                    changed()
                }
            }
        }

        private fun feed(m: JsonObject) {
            val data = (m["data"] as? JsonPrimitive)?.content ?: return
            terminal.feed(data); onOutput()
        }

        fun input(text: String) {
            if (state != State.OPEN) return
            try { session?.send(buildJsonObject { put("type", "input"); put("data", text) }) } catch (_: Exception) { /* the connection dropped: `lost` brings it back */ }
        }

        fun resize(cols: Int, rows: Int) {
            if (cols == terminal.cols && rows == terminal.rows) return
            terminal.resize(cols, rows)
            if (state != State.OPEN) return
            try { session?.send(buildJsonObject { put("type", "resize"); put("cols", cols); put("rows", rows) }) } catch (_: Exception) {}
        }

        /** The ×: close the console on the machine too (as the PWA's × does), and the tab. */
        fun kill() {
            if (state == State.OPEN) try { session?.send(buildJsonObject { put("type", "close") }) } catch (_: Exception) {}
            drop()
        }

        /** Leave the tab without touching the console: it stays alive on the machine. */
        internal fun drop() { release(); tabs.remove(this); changed() }

        private fun release() { off?.invoke(); offError?.invoke(); off = null; offError = null; session?.close(); session = null }

        /** The connection dropped under this tab. */
        internal fun lost() { if (state == State.OPEN || state == State.CONNECTING) { release(); state = State.LOST; changed() } }

        /** Come back to the same console over a new session (the screen is replayed). */
        internal suspend fun resume() {
            val id = consoleId
            if (id == null) { state = State.FAILED; note = "no-console"; changed(); return }
            try {
                val p = profile ?: return
                val s = RemoteAgent.open(p, connection(), machine.pubkey)
                ui.post { release(); state = State.CONNECTING; bind(s, id, terminal.cols, terminal.rows); changed() }
            } catch (e: Exception) { state = State.LOST; note = e.message; changed() }
        }

        /** Try again by hand, from the tab's «retry». */
        fun retry() { scope.launch { resume() } }
    }
}
