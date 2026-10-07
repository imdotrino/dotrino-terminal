package com.dotrino.terminal

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * DEBUG ONLY (src/debug): the consoles screen fed by a scripted agent, with no profile and no
 * network. To look at the panel, ⤢ and the console drawn at its own size on an emulator:
 *
 *   adb shell am start -n com.dotrino.terminal/.DemoConsolesActivity
 *
 * The machine has three consoles: 1 is free; 2 is shown by a window of the machine that CHOSE its
 * size (120×40, wider than a phone); 3 has a long path as its title. The size rules are the
 * agent's (`agent/consoles.js`): the screen that chose it, or the last one that attached.
 */
class DemoConsolesActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Consoles.tabs.isEmpty()) Consoles.demoTab(Machine(WINDOW, "TerminalLocal"), ME, DemoAgent())
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private companion object {
        const val ME = """{"kty":"EC","crv":"P-256","x":"demo-phone","y":"1"}"""
        const val WINDOW = """{"kty":"EC","crv":"P-256","x":"demo-machine","y":"1"}"""
    }

    private class DemoAgent : Channel {
        private class C(val id: String, val n: Int, val title: String, var cols: Int, var rows: Int, val window: Boolean, var chosenBy: String?, var holder: String?)

        private val ui = Handler(Looper.getMainLooper())
        private val listeners = ArrayList<(JsonObject) -> Unit>()
        private val consoles = mutableListOf(
            C("c1", 1, "✳ Sefjr improvement", 80, 24, false, null, null),   // a program that names its session, not its folder
            C("c2", 2, "seyacat@loca: ~/proyectos/dotrino", 120, 40, true, "window", "window"),
            C("c3", 3, "seyacat@loca: /mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor", 80, 24, false, null, null),
        )
        private var current: C? = null
        private var cols = 80
        private var rows = 24

        override fun onMessage(l: (JsonObject) -> Unit): () -> Unit { listeners.add(l); return { listeners.remove(l) } }
        override fun onError(l: (Exception) -> Unit): () -> Unit = {}
        override fun close() {}

        private fun reply(m: JsonObject) = ui.postDelayed({ for (l in listeners.toList()) l(m) }, 60)

        private fun decider(c: C) = c.chosenBy ?: c.holder

        private fun info(c: C) = buildJsonObject {
            put("id", c.id); put("n", c.n); put("title", c.title); put("origin", "local")
            put("cwd", if (c.id == "c1") "/mnt/sda1/Dotrino/dotrino-terminal/android/app/src/main" else c.title.substringAfter(": "))
            put("cols", c.cols); put("rows", c.rows); put("lastActive", System.currentTimeMillis())
            // 2 is working and 3 finished without anyone looking, to see the panel's colours.
            if (c.n == 2) put("activity", "busy") else put("activity", "idle")
            if (c.n == 3 && current !== c) put("doneAt", System.currentTimeMillis())
            val watchers = buildJsonArray {
                if (c.window) add(buildJsonObject { put("origin", "local"); put("tag", "desktop-1") })
                if (current === c) add(buildJsonObject { put("origin", "remote"); put("device", ME) })
            }
            put("viewers", watchers.size); put("watchers", watchers)
            decider(c)?.let { who ->
                putJsonObject("sizeBy") {
                    if (who == "phone") { put("origin", "remote"); put("device", ME) } else { put("origin", "local"); put("tag", "desktop-1") }
                    put("pinned", c.chosenBy == who)
                }
            }
        }

        private fun list() = reply(buildJsonObject { put("type", "consoles"); put("list", buildJsonArray { consoles.forEach { add(info(it)) } }) })
        private fun meta(c: C) = reply(buildJsonObject { put("type", "meta"); put("console", info(c)) })

        /** The phone's size applies only if the phone decides. */
        private fun applySize(c: C) { if (decider(c) == "phone") { c.cols = cols; c.rows = rows } }

        private fun attach(c: C) {
            current?.let { prev -> if (prev.holder == "phone") prev.holder = if (prev.window) "window" else null; if (prev.window && prev.holder == "window") { prev.cols = 120; prev.rows = 40 } }
            current = c
            c.holder = "phone"
            applySize(c)
            reply(buildJsonObject { put("type", "attached"); put("id", c.id); put("console", info(c)) })
            reply(buildJsonObject { put("type", "replay"); put("data", sample(c)) })
        }

        private fun sample(c: C): String {
            val e = "\u001b"
            val wide = if (c.cols > 100) "$e[2m" + "·".repeat(c.cols - 1) + "$e[0m\r\n" else ""
            return "$e[1;32mseyacat@loca$e[0m:$e[1;34m${c.title.substringAfter(": ")}$e[0m$ ls\r\n" +
                "$e[1;34msrc$e[0m  $e[1;34mdocs$e[0m  $e[1;32mrun.sh$e[0m  README.md\r\n" + wide +
                "Consola ${c.n} · ${c.cols}×${c.rows}\r\n$ "
        }

        override fun send(payload: JsonObject) {
            fun int(k: String) = (payload[k] as? JsonPrimitive)?.intOrNull
            when ((payload["type"] as JsonPrimitive).content) {
                "list" -> list()
                "open" -> {
                    cols = int("cols") ?: cols; rows = int("rows") ?: rows
                    val n = (1..99).first { k -> consoles.none { it.n == k } }
                    val c = C("c$n-${System.nanoTime()}", n, "seyacat@loca: ~", cols, rows, false, null, null)
                    consoles.add(c); attach(c)
                }
                "attach" -> {
                    cols = int("cols") ?: cols; rows = int("rows") ?: rows
                    consoles.firstOrNull { it.id == (payload["id"] as JsonPrimitive).content }?.let(::attach)
                        ?: reply(buildJsonObject { put("type", "fail"); put("code", "no-console") })
                }
                "resize" -> { cols = int("cols") ?: cols; rows = int("rows") ?: rows; current?.let { val b = it.cols to it.rows; applySize(it); if (b != it.cols to it.rows) meta(it) } }
                "pin" -> current?.let { c ->
                    val on = (payload["on"] as? JsonPrimitive)?.booleanOrNull == true
                    if (on) c.chosenBy = "phone" else if (c.chosenBy == "phone") c.chosenBy = null
                    applySize(c); meta(c)
                }
                "input" -> reply(buildJsonObject { put("type", "out"); put("data", (payload["data"] as JsonPrimitive).content.replace("\r", "\r\n$ ")) })
                "kill" -> { consoles.removeAll { it.id == (payload["id"] as JsonPrimitive).content }; list() }
                // The panel's order, as the agent keeps it: `id` goes right before `before` (or last).
                "move" -> {
                    val c = consoles.firstOrNull { it.id == (payload["id"] as JsonPrimitive).content } ?: return
                    consoles.remove(c)
                    val at = consoles.indexOfFirst { it.id == (payload["before"] as? JsonPrimitive)?.content }
                    if (at < 0) consoles.add(c) else consoles.add(at, c)
                    list()
                }
                "close" -> { current?.let { consoles.remove(it) }; current = null }
            }
        }
    }
}
