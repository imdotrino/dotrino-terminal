package com.dotrino.terminal

import com.dotrino.terminal.term.Terminal
import com.dotrino.terminal.term.Terminal.Style
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The emulator, fed what real programs write. Each test is something a shell, vim or htop does. */
class TerminalTest {
    private val E = "\u001b"
    private fun term(cols: Int = 20, rows: Int = 5) = Terminal(cols, rows)
    private fun Terminal.screen() = (0 until rows).joinToString("\n") { text(it) }.trimEnd('\n')

    @Test fun plainTextAndNewlines() {
        val t = term(); t.feed("hola\r\nmundo")
        assertEquals("hola\nmundo", t.screen())
        assertEquals(5, t.cursorX); assertEquals(1, t.cursorY)
    }

    @Test fun aLongLineWrapsAndTheScreenScrollsIntoHistory() {
        val t = term(cols = 5, rows = 2)
        t.feed("abcdefgh\r\nxy\r\nz")
        assertEquals("xy\nz", t.screen())
        assertEquals(2, t.historySize)
        assertEquals("abcde", t.text(-2)); assertEquals("fgh", t.text(-1))
        assertTrue("the first line continues on the next", t.row(-2).wrapped)
    }

    @Test fun theLastColumnDoesNotWrapUntilTheNextCharacter() {
        val t = term(cols = 3, rows = 2); t.feed("abc")
        assertEquals(0, t.cursorY)                       // still on the first line
        t.feed("\r\nd")
        assertEquals("abc\nd", t.screen())               // CR LF after a full line is ONE new line, not two
    }

    @Test fun cursorMovesAndErasing() {
        val t = term(); t.feed("0123456789")
        t.feed("$E[5D$E[K"); assertEquals("01234", t.screen())
        t.feed("$E[2;3Hab$E[1;1HX"); assertEquals("X1234\n  ab", t.screen())
        t.feed("$E[2J"); assertEquals("", t.screen())
    }

    @Test fun insertAndDeleteCharactersAndLines() {
        val t = term(); t.feed("abcdef$E[1;3H$E[2@"); assertEquals("ab  cdef", t.text(0))
        t.feed("$E[2P"); assertEquals("abcdef", t.text(0))
        t.feed("\r\nline2\r\nline3$E[2;1H$E[L"); assertEquals("abcdef\n\nline2\nline3", t.screen())
        t.feed("$E[M"); assertEquals("abcdef\nline2\nline3", t.screen())
    }

    @Test fun coloursAndAttributes() {
        val t = term(); t.feed("$E[1;31mR$E[0m $E[38;5;208mO$E[48;2;10;20;30mB$E[38:2::1:2:3mC")
        val r = t.row(0)
        assertEquals(1, Style.fg(r.st[0])); assertEquals(Style.BOLD, Style.flags(r.st[0]))
        assertEquals(Style.DEFAULT, r.st[1])
        assertEquals(208, Style.fg(r.st[2]))
        assertEquals(Style.RGB or (10 shl 16) or (20 shl 8) or 30, Style.bg(r.st[3]))
        assertEquals(Style.RGB or (1 shl 16) or (2 shl 8) or 3, Style.fg(r.st[4]))
    }

    @Test fun theAlternateScreenComesAndGoesAndLeavesTheShellAsItWas() {
        val t = term(); t.feed("prompt$ vim")
        t.feed("$E[?1049h$E[2J$E[Hfile contents")
        assertTrue(t.altScreen); assertEquals("file contents", t.text(0))
        t.feed("$E[?1049l")
        assertFalse(t.altScreen); assertEquals("prompt$ vim", t.text(0)); assertEquals(11, t.cursorX)
    }

    @Test fun aScrollRegionOnlyMovesItsOwnLines() {
        val t = term(rows = 4); t.feed("top\r\na\r\nb\r\nbottom")
        t.feed("$E[2;3r$E[3;1H\nc")            // a line feed at the region's bottom scrolls only lines 2-3
        assertEquals("top\nb\nc\nbottom", t.screen())
        assertEquals("nothing left the region to the history", 0, t.historySize)
    }

    @Test fun reverseIndexAtTheTopScrollsDown() {
        val t = term(rows = 3); t.feed("a\r\nb\r\nc$E[H${E}M")
        assertEquals("\na\nb", t.screen())
    }

    @Test fun wideCharactersTakeTwoCellsAndWrapWhole() {
        val t = term(cols = 4, rows = 2); t.feed("a日本x")
        assertEquals("a日", t.text(0)); assertEquals("本x", t.text(1))
        assertEquals(Terminal.WIDE_TAIL, t.row(0).cp[2])
    }

    @Test fun emojiOutsideTheBasicPlane() {
        val t = term(); t.feed("ok 😀!")
        assertEquals("ok 😀!", t.text(0)); assertEquals(6, t.cursorX)
    }

    @Test fun lineDrawingCharset() {
        val t = term(); t.feed("$E(0lqk$E(Blqk")
        assertEquals("┌─┐lqk", t.text(0))
    }

    @Test fun tabs() {
        val t = term(); t.feed("a\tb\t\tc")
        assertEquals("a       b", t.text(0).take(9)); assertEquals(19, t.cursorX)
    }

    @Test fun titleAndReports() {
        val t = term(); val replies = ArrayList<String>(); var title = ""
        t.onReply = { replies.add(it) }; t.onTitle = { title = it }
        t.feed("$E]0;user@host: ~\u0007$E]2;second$E\\ab$E[6n$E[c")
        assertEquals("second", title)
        assertEquals(listOf("$E[1;3R", "$E[?1;2c"), replies)
    }

    @Test fun aSequenceCutBetweenTwoChunksStillWorks() {
        val t = term(); t.feed("a$E[3"); t.feed("1mb$E]0;ti"); var title = ""; t.onTitle = { title = it }; t.feed("tle\u0007c")
        assertEquals("abc", t.text(0)); assertEquals(1, Style.fg(t.row(0).st[1])); assertEquals("title", title)
    }

    @Test fun modesAShellAsksFor() {
        val t = term(); t.feed("$E[?1h$E[?2004h$E[?25l")
        assertTrue(t.appCursorKeys); assertTrue(t.bracketedPaste); assertFalse(t.cursorVisible)
        t.feed("$E[?1l$E[?2004l$E[?25h")
        assertFalse(t.appCursorKeys); assertFalse(t.bracketedPaste); assertTrue(t.cursorVisible)
    }

    @Test fun resizingKeepsWhatWasOnScreen() {
        val t = term(cols = 10, rows = 4); t.feed("1\r\n2\r\n3\r\n4")
        t.resize(10, 2)                                   // the top lines go to the history, the cursor stays on its line
        assertEquals("3\n4", t.screen()); assertEquals(2, t.historySize); assertEquals(1, t.cursorY)
        t.resize(12, 4)                                   // and come back when there is room again
        assertEquals("1\n2\n3\n4", t.screen()); assertEquals(0, t.historySize); assertEquals(3, t.cursorY)
    }

    @Test fun eraseKeepsTheBackgroundColour() {
        val t = term(); t.feed("$E[44m$E[K")
        assertEquals(4, Style.bg(t.row(0).st[10]))
    }

    @Test fun historyIsBounded() {
        val t = Terminal(10, 2, scrollback = 5); repeat(50) { t.feed("l$it\r\n") }
        assertEquals(5, t.historySize); assertEquals("l48", t.text(-1))
    }
}

class I18nTest {
    @Test fun bothLanguagesSayTheSameThings() = assertEquals(emptySet<String>(), I18n.missing())
}
