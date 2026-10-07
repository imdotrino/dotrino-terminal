package com.dotrino.terminal

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tab of a machine against a scripted agent: the same rules as the PWA's panel (pick a free
 * console, switch over the same session, the emulator follows the CONSOLE's size, ⤢, closing the
 * console on screen first moves to another one).
 */
class TabTest {
    private val me = """{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}"""
    private val other = """{"kty":"EC","crv":"P-256","x":"CCC","y":"DDD"}"""

    /** A channel that keeps what the tab sends and lets the test answer as the agent. */
    private class FakeChannel : Channel {
        val sent = ArrayList<JsonObject>()
        private val listeners = ArrayList<(JsonObject) -> Unit>()
        override fun send(payload: JsonObject) { sent.add(payload) }
        override fun onMessage(l: (JsonObject) -> Unit): () -> Unit { listeners.add(l); return { listeners.remove(l) } }
        override fun onError(l: (Exception) -> Unit): () -> Unit = {}
        override fun close() {}
        fun agent(m: JsonObject) { for (l in listeners.toList()) l(m) }
        fun last(type: String) = sent.lastOrNull { (it["type"] as JsonPrimitive).content == type }
        fun types() = sent.map { (it["type"] as JsonPrimitive).content }
    }

    private fun console(id: String, n: Int, cols: Int, rows: Int, watchers: Int = 0, by: String? = null, pinned: Boolean = false, title: String = "", watcher: String? = null) = buildJsonObject {
        put("id", id); put("n", n); put("title", title); put("cols", cols); put("rows", rows); put("viewers", watchers)
        putJsonArray("watchers") { repeat(watchers) { add(buildJsonObject { put("origin", "remote"); if (watcher != null) put("device", watcher) }) } }
        if (by != null) putJsonObject("sizeBy") { put("origin", "remote"); put("device", by); put("pinned", pinned) }
    }

    private fun consoles(vararg list: JsonObject) = buildJsonObject { put("type", "consoles"); put("list", buildJsonArray { list.forEach { add(it) } }) }
    private fun attached(c: JsonObject) = buildJsonObject { put("type", "attached"); put("id", c["id"]!!); put("console", c) }

    private fun tab(): Pair<Consoles.Tab, FakeChannel> {
        val t = Consoles.Tab(Machine(other, "PC"), me) { it() }
        val ch = FakeChannel()
        t.bind(ch, 50, 20, null)
        return t to ch
    }

    @Test fun picksAFreeConsoleAndOpensOneOnlyWhenThereIsNone() {
        val (_, ch) = tab()
        assertEquals("first it asks for the list", listOf("list"), ch.types())
        ch.agent(consoles(console("a", 1, 80, 24, watchers = 1), console("b", 2, 80, 24)))
        assertEquals("the free one", "b", (ch.last("attach")!!["id"] as JsonPrimitive).content)
        assertEquals("with this screen's size", 50, (ch.last("attach")!!["cols"] as JsonPrimitive).content.toInt())

        val (_, ch2) = tab()
        ch2.agent(consoles(console("a", 1, 80, 24, watchers = 1)))
        assertEquals("none free, but one exists: that one, not a new one", "a", (ch2.last("attach")!!["id"] as JsonPrimitive).content)
        assertFalse(ch2.types().contains("open"))

        val (_, ch3) = tab()
        ch3.agent(consoles())
        assertTrue("the machine has none: a new one", ch3.types().contains("open"))
    }

    @Test fun theEmulatorFollowsTheConsoleSizeNotTheScreen() {
        val (t, ch) = tab()
        ch.agent(consoles())
        val c = console("a", 1, 120, 40, watchers = 2, by = other)
        ch.agent(attached(c))
        assertEquals(Consoles.Tab.State.OPEN, t.state)
        assertEquals("another screen has the size: shown at it", 120, t.terminal.cols)
        assertEquals(40, t.terminal.rows)
        ch.agent(buildJsonObject { put("type", "meta"); put("console", console("a", 1, 90, 30, watchers = 2, by = other)) })
        assertEquals("and it follows it when it changes", 90, t.terminal.cols)
        // This screen's size goes as `resize`; the agent decides.
        t.screen(60, 22)
        assertEquals(60, (ch.last("resize")!!["cols"] as JsonPrimitive).content.toInt())
        assertEquals("the emulator does not take it by itself", 90, t.terminal.cols)
    }

    @Test fun switchingGoesOverTheSameSessionAndCleansTheScreen() {
        val (t, ch) = tab()
        ch.agent(consoles(console("a", 1, 50, 20), console("b", 2, 50, 20)))
        ch.agent(attached(console("a", 1, 50, 20, watchers = 1, by = me)))
        ch.agent(buildJsonObject { put("type", "replay"); put("data", "AAA") })
        t.switchTo("b")
        assertEquals("b", (ch.last("attach")!!["id"] as JsonPrimitive).content)
        ch.agent(attached(console("b", 2, 50, 20, watchers = 1, by = me)))
        ch.agent(buildJsonObject { put("type", "replay"); put("data", "BBB") })
        assertEquals("b", t.consoleId)
        assertEquals(2, t.number)
        assertTrue("the screen of b only", t.terminal.text(0).startsWith("BBB"))
    }

    @Test fun sizeHereOnlyWhenThisDeviceChoseIt() {
        val (t, ch) = tab()
        ch.agent(consoles())
        ch.agent(attached(console("a", 1, 50, 20, watchers = 2, by = me)))
        assertFalse("it has the size, but did not choose it", t.sizeHere)
        assertTrue(t.sizeIsMine(t.current))
        t.useMySize(true)
        assertEquals("resize first, then pin", listOf("resize", "pin"), ch.types().takeLast(2))
        ch.agent(buildJsonObject { put("type", "meta"); put("console", console("a", 1, 50, 20, watchers = 2, by = me, pinned = true)) })
        assertTrue(t.sizeHere)
        ch.agent(buildJsonObject { put("type", "meta"); put("console", console("a", 1, 50, 20, watchers = 2, by = other, pinned = true)) })
        assertFalse("another device chose it", t.sizeHere)
    }

    @Test fun closingTheConsoleOnScreenFirstMovesToAnother() {
        val (t, ch) = tab()
        ch.agent(consoles(console("a", 1, 50, 20), console("b", 2, 50, 20)))
        ch.agent(attached(console("a", 1, 50, 20, watchers = 1, by = me)))
        t.killConsole("a")
        val tail = ch.types().takeLast(3)
        assertEquals(listOf("attach", "kill", "list"), tail)
        assertEquals("b", (ch.last("attach")!!["id"] as JsonPrimitive).content)
        assertEquals("a", (ch.last("kill")!!["id"] as JsonPrimitive).content)
    }

    @Test fun titlesAreCutOnTheLeftKeepingTheLastFolder() {
        assertEquals("~", shortTitle("seyacat@loca: ~"))
        assertEquals("…/desktop/vendor", shortTitle("seyacat@loca: /mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor"))
        assertEquals("/mnt/sda1/Dotrino", shortTitle("seyacat@loca: /mnt/sda1/Dotrino"))
        assertEquals("vim main.rs", shortTitle("vim main.rs"))
        assertNull(consoleOf(buildJsonObject { put("n", 1) }))
    }

    @Test fun activityIsWhatTheAgentSays() {
        val base = console("a", 1, 50, 20)
        assertEquals(ConsoleInfo.Activity.IDLE, consoleOf(base)!!.activity)
        assertEquals(ConsoleInfo.Activity.BUSY, consoleOf(JsonObject(base + ("activity" to JsonPrimitive("busy"))))!!.activity)
        assertEquals(ConsoleInfo.Activity.DONE, consoleOf(JsonObject(base + ("activity" to JsonPrimitive("idle")) + ("doneAt" to JsonPrimitive(1759700000000))))!!.activity)
        // An agent older than 0.17 says nothing: idle, not an error.
        assertNull(consoleOf(base)!!.doneAt)
    }

    @Test fun comingBackToAConsoleThatIsGoneOpensANewOneAndSaysIt() {
        val t = Consoles.Tab(Machine(other, "PC"), me) { it() }
        val ch = FakeChannel()
        var gone = 0
        t.onGone = { gone++ }
        t.bind(ch, 50, 20, "old")                                     // over a new session, back to the console it had
        assertEquals("old", (ch.last("attach")!!["id"] as JsonPrimitive).content)
        ch.agent(buildJsonObject { put("type", "fail"); put("code", "no-console"); put("message", "no such console") })
        assertEquals("open", ch.types().last())
        assertEquals(1, gone)
        ch.agent(attached(console("new", 1, 50, 20, watchers = 1, by = me)))
        assertEquals(Consoles.Tab.State.OPEN, t.state); assertEquals("new", t.consoleId)
        // Picking, by hand, a console that is gone is still said as gone: nothing is opened behind the user's back.
        t.switchTo("stale")
        ch.agent(buildJsonObject { put("type", "fail"); put("code", "no-console") })
        assertEquals(Consoles.Tab.State.EXITED, t.state); assertEquals(1, gone)
    }

    private fun fail(code: String, retryMs: Long? = null) = buildJsonObject { put("type", "fail"); put("code", code); if (retryMs != null) put("retryMs", retryMs) }

    @Test fun aMachineWithACodeAsksForItAndGoesOnOnceTyped() {
        Consoles.codes.clear()
        val (tab, ch) = tab()
        ch.agent(fail("locked"))                                    // the first `list` was refused
        assertEquals(Consoles.Tab.State.LOCKED, tab.state)
        assertNull(ch.last("unlock"))                               // nothing remembered: the screen asks
        tab.unlock("0000")
        ch.agent(fail("bad-code"))
        assertEquals(Consoles.Tab.State.LOCKED, tab.state); assertEquals("bad-code", tab.codeProblem)
        tab.unlock("4821")
        ch.agent(buildJsonObject { put("type", "unlocked") })
        assertEquals(Consoles.Tab.State.CONNECTING, tab.state)
        assertEquals("list", ch.types().last())                     // it goes on where it was: picking a console
        assertEquals("4821", Consoles.codes[tab.machine.pubkey])
    }

    @Test fun theRememberedCodeIsTriedOnceByItselfAndForgottenIfWrong() {
        Consoles.codes.clear()
        val (tab, ch) = tab()
        Consoles.codes[tab.machine.pubkey] = "4821"
        ch.agent(fail("locked"))
        assertEquals("4821", (ch.last("unlock")!!["code"] as JsonPrimitive).content)
        val sent = ch.sent.size
        ch.agent(fail("locked"))                                    // another refusal meanwhile: not sent again
        assertEquals(sent, ch.sent.size)
        ch.agent(fail("wait", 90_000))
        assertEquals("wait", tab.codeProblem); assertEquals(90_000L, tab.codeWaitMs)
        assertNull(Consoles.codes[tab.machine.pubkey])
    }

    @Test fun backFromTheBackgroundTheTabSaysItIsCheckingUntilTheMachineAnswers() {
        val (tab, ch) = tab()
        val c = console("a", 1, 50, 20, watchers = 1, by = me)
        ch.agent(consoles()); ch.agent(attached(c))
        assertEquals(Consoles.Tab.State.OPEN, tab.state); assertFalse(tab.checking)
        val before = ch.sent.size
        tab.check()
        assertTrue(tab.checking)
        assertEquals("list", ch.types().last()); assertEquals(before + 1, ch.sent.size)
        ch.agent(consoles(c))                                        // any answer: the connection is alive
        assertFalse(tab.checking)
    }

    @Test fun aConsoleOnlyThisPhoneWatchesIsNotOnAnotherDevice() {
        // The phone's old session still attached on the machine (the app slept): it is ours.
        val (t, ch) = tab()
        ch.agent(consoles(console("a", 1, 80, 24, watchers = 1, watcher = other), console("b", 2, 80, 24, watchers = 1, watcher = me)))
        assertEquals("b", (ch.last("attach")!!["id"] as JsonPrimitive).content)
        assertEquals(0, t.othersWatching(t.consoles.first { it.id == "b" }))
        assertEquals(1, t.othersWatching(t.consoles.first { it.id == "a" }))
    }

    @Test fun closingTheConsoleOnScreenGoesToAnExistingOneEvenIfWatchedAndOpensOneOnlyIfItWasTheLast() {
        val (t, ch) = tab()
        val a = console("a", 1, 50, 20, watchers = 1, watcher = other)
        val c = console("c", 3, 50, 20, watchers = 1, by = me, watcher = me)
        ch.agent(consoles(a, c)); ch.agent(attached(c)); ch.agent(consoles(a, c))
        t.killConsole("c")
        assertEquals("a", (ch.last("attach")!!["id"] as JsonPrimitive).content)
        assertFalse(ch.types().contains("open"))

        val (t2, ch2) = tab()
        val only = console("x", 1, 50, 20, watchers = 1, by = me, watcher = me)
        ch2.agent(consoles()); ch2.agent(attached(only)); ch2.agent(consoles(only))
        val opens = ch2.types().count { it == "open" }
        t2.killConsole("x")
        assertEquals("it was the last one: a new one", opens + 1, ch2.types().count { it == "open" })
    }

    @Test fun thePanelSaysWhatAndWhereInAtMostTwoLinesWithoutTheHost() {
        assertEquals("~/proyectos/dotrino" to null, panelLines("seyacat@loca: ~/proyectos/dotrino", "~/proyectos/dotrino"))
        assertEquals("~/proyectos/dotrino" to null, panelLines("seyacat@loca: ~/proyectos/dotrino", null))   // an older agent
        assertEquals("✳ Sefjr improvement" to "/mnt/sda1/Dotrino", panelLines("✳ Sefjr improvement", "/mnt/sda1/Dotrino"))
        assertEquals("~" to null, panelLines("", "~"))
        assertEquals(null to null, panelLines("", null))
    }
}
