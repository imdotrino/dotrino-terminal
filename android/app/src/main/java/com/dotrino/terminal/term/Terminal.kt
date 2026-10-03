package com.dotrino.terminal.term

/**
 * A terminal emulator (xterm, the part real programs use): what the agent's shell writes goes
 * in through [feed], and the screen is read back through [row]. Pure Kotlin, no Android: the
 * view draws it, the tests feed it escape sequences.
 *
 * Written for this app instead of taking Termux's, whose code is GPLv3 (Dotrino is MIT).
 *
 * What it knows: the cursor and its movements, erasing and inserting, scroll regions, the
 * alternate screen (vim, htop), 16/256/24-bit colours and the usual attributes, UTF-8 with
 * wide characters, tab stops, the line-drawing charset, and the modes a shell asks for
 * (application cursor keys, bracketed paste, wraparound, origin). The main screen keeps a
 * history ([scrollback] rows); the alternate one does not.
 */
class Terminal(cols: Int, rows: Int, private val scrollback: Int = 2000) {
    var cols = cols; private set
    var rows = rows; private set

    /** One line of the screen: code points and a packed style per cell. A wide character owns two cells; the second holds [WIDE_TAIL]. */
    class Row(cols: Int) {
        var cp = IntArray(cols) { ' '.code }
        var st = LongArray(cols) { Style.DEFAULT }
        /** The line continues on the next one (it wrapped): for copying text without false line breaks. */
        var wrapped = false
        fun clear(from: Int, to: Int, style: Long) { for (i in from until minOf(to, cp.size)) { cp[i] = ' '.code; st[i] = style } }
        fun resize(cols: Int) {
            if (cols == cp.size) return
            val n = minOf(cols, cp.size)
            cp = IntArray(cols) { if (it < n) cp[it] else ' '.code }
            st = LongArray(cols) { if (it < n) st[it] else Style.DEFAULT }
        }
    }

    /** A cell's colours and attributes in one Long: fg (26 bits), bg (26 bits), flags. */
    object Style {
        const val DEFAULT_COLOR = 256           // «the terminal's own» foreground or background
        const val RGB = 1 shl 24                // the 24 low bits are a colour, not an index
        const val BOLD = 1; const val DIM = 2; const val ITALIC = 4; const val UNDERLINE = 8
        const val INVERSE = 16; const val INVISIBLE = 32; const val STRIKE = 64
        fun pack(fg: Int, bg: Int, flags: Int): Long = fg.toLong() or (bg.toLong() shl 26) or (flags.toLong() shl 52)
        fun fg(s: Long) = (s and 0x3FFFFFF).toInt()
        fun bg(s: Long) = ((s shr 26) and 0x3FFFFFF).toInt()
        fun flags(s: Long) = (s shr 52).toInt()
        val DEFAULT = pack(DEFAULT_COLOR, DEFAULT_COLOR, 0)
    }

    companion object {
        const val WIDE_TAIL = -1
        private const val ESC = 27
        /** DEC special graphics (`ESC ( 0`): the box-drawing characters of dialogs and tmux borders. */
        private const val LINE_DRAWING = "◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·"

        /** How many cells a code point takes: 0 (combining), 1, or 2 (East Asian wide, emoji). */
        fun width(c: Int): Int = when {
            c < 0x300 -> 1
            c in 0x300..0x36F || c in 0x200B..0x200F || c in 0xFE00..0xFE0F || c == 0xFEFF || c in 0x1AB0..0x1AFF || c in 0x20D0..0x20FF -> 0
            c in 0x1100..0x115F || c in 0x2E80..0x303E || c in 0x3041..0x33FF || c in 0x3400..0x4DBF || c in 0x4E00..0x9FFF ||
                c in 0xA000..0xA4CF || c in 0xAC00..0xD7A3 || c in 0xF900..0xFAFF || c in 0xFE30..0xFE4F || c in 0xFF00..0xFF60 ||
                c in 0xFFE0..0xFFE6 || c in 0x1F300..0x1F64F || c in 0x1F900..0x1F9FF || c in 0x1F680..0x1F6FF || c in 0x20000..0x3FFFD -> 2
            else -> 1
        }
    }

    // ---------- what the outside hears ----------

    /** What the terminal answers by itself (a status report): it goes back to the shell as input. */
    var onReply: (String) -> Unit = {}
    var onTitle: (String) -> Unit = {}
    var onBell: () -> Unit = {}

    // ---------- the two screens ----------

    private val history = ArrayDeque<Row>()                       // lines that scrolled off the top of the main screen
    private var main = MutableList(rows) { Row(cols) }
    private var alt = MutableList(rows) { Row(cols) }
    private var screen = main
    var altScreen = false; private set

    /** Lines of history above the screen. */
    val historySize: Int get() = if (altScreen) 0 else history.size

    /** Line [y] of the screen; negative [y] goes back into the history (`-1` is the last line that scrolled off). */
    fun row(y: Int): Row = if (y >= 0) screen[y] else history[history.size + y]

    var cursorX = 0; private set
    var cursorY = 0; private set
    var cursorVisible = true; private set
    /** The cursor keys send `ESC O A` instead of `ESC [ A` (vim, less). */
    var appCursorKeys = false; private set
    var appKeypad = false; private set
    var bracketedPaste = false; private set

    private var style = Style.DEFAULT
    private var top = 0
    private var bottom = rows - 1
    private var autowrap = true
    private var originMode = false
    private var insertMode = false
    private var wrapPending = false                                // the cursor sits past the last column; the next character wraps
    private var tabs = BooleanArray(cols) { it % 8 == 0 }
    private var g0Graphics = false
    private var g1Graphics = false
    private var shiftOut = false
    private var lastChar = ' '.code

    private class Saved(val x: Int, val y: Int, val style: Long, val origin: Boolean, val g0: Boolean, val g1: Boolean)
    private var savedMain: Saved? = null
    private var savedAlt: Saved? = null

    // ---------- the parser ----------

    private enum class State { GROUND, ESCAPE, CHARSET, CSI, OSC, OSC_ESC, STRING, STRING_ESC }
    private var state = State.GROUND
    private var charsetSlot = 0
    private val params = ArrayList<Int>()                          // -1 = not given
    private var paramOpen = false
    private var prefix = 0                                         // '?', '>', '=' right after CSI
    private var intermediate = 0                                   // ' ', '!', '"', '$' before the final byte
    private val osc = StringBuilder()
    private var highSurrogate = 0.toChar()

    /** What the shell wrote. A sequence cut between two calls continues in the next one. */
    fun feed(text: String) {
        var i = 0
        while (i < text.length) {
            val ch = text[i++]
            if (Character.isHighSurrogate(ch)) { highSurrogate = ch; continue }
            val c = if (Character.isLowSurrogate(ch) && highSurrogate != 0.toChar()) Character.toCodePoint(highSurrogate, ch) else ch.code
            highSurrogate = 0.toChar()
            accept(c)
        }
    }

    private fun accept(c: Int) {
        when (state) {
            State.GROUND -> ground(c)
            State.ESCAPE -> escape(c)
            State.CHARSET -> { when (charsetSlot) { 0 -> g0Graphics = c == '0'.code; 1 -> g1Graphics = c == '0'.code }; state = State.GROUND }
            State.CSI -> csi(c)
            State.OSC -> when (c) {
                7 -> { oscDone(); state = State.GROUND }
                ESC -> state = State.OSC_ESC
                else -> if (osc.length < 4096) osc.appendCodePoint(c)
            }
            State.OSC_ESC -> { if (c == '\\'.code) oscDone(); state = State.GROUND; if (c != '\\'.code) escapeStart(c) }
            // DCS, APC, PM, SOS: a string nobody here reads, up to its terminator.
            State.STRING -> if (c == ESC) state = State.STRING_ESC else if (c == 7) state = State.GROUND
            State.STRING_ESC -> state = if (c == '\\'.code) State.GROUND else State.STRING
        }
    }

    private fun escapeStart(c: Int) { state = State.ESCAPE; escape(c) }

    private fun ground(c: Int) {
        when (c) {
            ESC -> state = State.ESCAPE
            7 -> onBell()
            8 -> { if (cursorX > 0) cursorX--; wrapPending = false }
            9 -> tab(1)
            10, 11, 12 -> lineFeed()
            13 -> { cursorX = 0; wrapPending = false }
            14 -> shiftOut = true
            15 -> shiftOut = false
            else -> if (c >= 32 && c != 127) print(c)
        }
    }

    private fun escape(c: Int) {
        state = State.GROUND
        when (c.toChar()) {
            '[' -> { params.clear(); paramOpen = false; prefix = 0; intermediate = 0; state = State.CSI }
            ']' -> { osc.setLength(0); state = State.OSC }
            'P', '_', '^', 'X' -> state = State.STRING
            '(' -> { charsetSlot = 0; state = State.CHARSET }
            ')' -> { charsetSlot = 1; state = State.CHARSET }
            '*', '+', '#', '%', ' ' -> { charsetSlot = 2; state = State.CHARSET }     // one more byte follows; it changes nothing here
            '7' -> saveCursor()
            '8' -> restoreCursor()
            'D' -> lineFeed()
            'E' -> { cursorX = 0; lineFeed() }
            'M' -> reverseIndex()
            'H' -> if (cursorX < cols) tabs[cursorX] = true
            'c' -> reset()
            '=' -> appKeypad = true
            '>' -> appKeypad = false
            '\\' -> {}
            else -> {}
        }
    }

    private fun csi(c: Int) {
        when {
            c in '0'.code..'9'.code -> {
                if (!paramOpen) { params.add(0); paramOpen = true }
                val n = params.last().toLong() * 10 + (c - '0'.code)
                params[params.size - 1] = minOf(n, 99999L).toInt()
            }
            c == ';'.code || c == ':'.code -> { if (!paramOpen) params.add(-1); paramOpen = false }
            c == '?'.code || c == '>'.code || c == '='.code || c == '<'.code -> prefix = c
            c in 0x20..0x2F -> intermediate = c
            c in 0x40..0x7E -> { if (!paramOpen && params.isNotEmpty()) params.add(-1); state = State.GROUND; command(c.toChar()) }
            c == ESC -> state = State.ESCAPE
            c == 10 || c == 13 || c == 8 -> ground(c)                 // a control character in the middle of a sequence acts and the sequence goes on
            else -> state = State.GROUND
        }
    }

    private fun arg(i: Int, default: Int): Int = params.getOrNull(i)?.takeIf { it > 0 } ?: default
    private fun raw(i: Int, default: Int): Int = params.getOrNull(i)?.takeIf { it >= 0 } ?: default

    private fun command(f: Char) {
        if (intermediate != 0) {
            // DECSCUSR (cursor shape) and DECSTR (soft reset) are the ones programs send; the rest are ignored.
            if (intermediate == '!'.code && f == 'p') softReset()
            return
        }
        if (prefix == '?'.code) { when (f) { 'h' -> modes(true); 'l' -> modes(false) }; return }
        if (prefix == '>'.code) { if (f == 'c') onReply("\u001b[>0;10;1c"); return }
        if (prefix != 0) return
        when (f) {
            'A' -> moveY(-arg(0, 1)); 'B', 'e' -> moveY(arg(0, 1))
            'C', 'a' -> { cursorX = minOf(cols - 1, cursorX + arg(0, 1)); wrapPending = false }
            'D' -> { cursorX = maxOf(0, minOf(cursorX, cols - 1) - arg(0, 1)); wrapPending = false }
            'E' -> { moveY(arg(0, 1)); cursorX = 0 }
            'F' -> { moveY(-arg(0, 1)); cursorX = 0 }
            'G', '`' -> { cursorX = (arg(0, 1) - 1).coerceIn(0, cols - 1); wrapPending = false }
            'H', 'f' -> moveTo(arg(1, 1) - 1, arg(0, 1) - 1)
            'd' -> moveTo(cursorX, arg(0, 1) - 1)
            'I' -> tab(arg(0, 1))
            'Z' -> backTab(arg(0, 1))
            'J' -> eraseDisplay(raw(0, 0))
            'K' -> eraseLine(raw(0, 0))
            'L' -> insertLines(arg(0, 1))
            'M' -> deleteLines(arg(0, 1))
            '@' -> insertChars(arg(0, 1))
            'P' -> deleteChars(arg(0, 1))
            'X' -> screen[cursorY].clear(cursorX, cursorX + arg(0, 1), blank())
            'S' -> repeat(arg(0, 1)) { scrollUp() }
            'T' -> repeat(arg(0, 1)) { scrollDown() }
            'b' -> repeat(minOf(arg(0, 1), cols * rows)) { print(lastChar) }
            'm' -> sgr()
            'r' -> { val t = arg(0, 1) - 1; val b = arg(1, rows) - 1; if (t < b && b < rows) { top = t; bottom = b; moveTo(0, 0) } }
            's' -> saveCursor()
            'u' -> restoreCursor()
            'h' -> if (raw(0, 0) == 4) insertMode = true
            'l' -> if (raw(0, 0) == 4) insertMode = false
            'g' -> when (raw(0, 0)) { 0 -> if (cursorX < cols) tabs[cursorX] = false; 3 -> tabs.fill(false) }
            'n' -> when (raw(0, 0)) { 5 -> onReply("\u001b[0n"); 6 -> onReply("\u001b[${cursorY - (if (originMode) top else 0) + 1};${minOf(cursorX, cols - 1) + 1}R") }
            'c' -> onReply("\u001b[?1;2c")
            else -> {}
        }
    }

    private fun modes(on: Boolean) {
        for (p in params) when (p) {
            1 -> appCursorKeys = on
            6 -> { originMode = on; moveTo(0, 0) }
            7 -> autowrap = on
            25 -> cursorVisible = on
            47, 1047 -> useAlt(on, clear = false)
            1048 -> if (on) saveCursor() else restoreCursor()
            1049 -> { if (on) saveCursor(); useAlt(on, clear = true); if (!on) restoreCursor() }
            2004 -> bracketedPaste = on
            else -> {}                                               // mouse reporting, focus events, blinking: not needed on a touch screen
        }
    }

    private fun useAlt(on: Boolean, clear: Boolean) {
        if (on == altScreen) return
        altScreen = on
        screen = if (on) alt else main
        if (on && clear) for (r in alt) { r.clear(0, cols, Style.DEFAULT); r.wrapped = false }
        top = 0; bottom = rows - 1; wrapPending = false
    }

    private fun oscDone() {
        val s = osc.toString()
        val sep = s.indexOf(';')
        if (sep <= 0) return
        when (s.substring(0, sep)) { "0", "2" -> onTitle(s.substring(sep + 1)) }
    }

    // ---------- writing ----------

    private fun blank(): Long = Style.pack(Style.DEFAULT_COLOR, Style.bg(style), 0)      // an erased cell keeps the current background

    private fun print(code: Int) {
        var c = code
        if ((if (shiftOut) g1Graphics else g0Graphics) && c in 0x60..0x7E) c = LINE_DRAWING[c - 0x60].code
        val w = width(c)
        if (w == 0) return                                           // combining marks are dropped rather than misplaced
        if (wrapPending || cursorX + w > cols) {
            if (autowrap) { screen[cursorY].wrapped = true; cursorX = 0; lineFeed() } else cursorX = cols - w
            wrapPending = false
        }
        val r = screen[cursorY]
        if (insertMode) shiftRight(r, cursorX, w)
        unwide(r, cursorX); if (w == 2) unwide(r, cursorX + 1)
        r.cp[cursorX] = c; r.st[cursorX] = style
        if (w == 2) { r.cp[cursorX + 1] = WIDE_TAIL; r.st[cursorX + 1] = style }
        lastChar = c
        cursorX += w
        if (cursorX >= cols) { cursorX = cols - 1; wrapPending = true }
    }

    /** Overwriting half of a wide character leaves the other half blank, not a broken glyph. */
    private fun unwide(r: Row, x: Int) {
        if (x !in 0 until cols) return
        if (r.cp[x] == WIDE_TAIL && x > 0) r.cp[x - 1] = ' '.code
        else if (x + 1 < cols && r.cp[x + 1] == WIDE_TAIL) r.cp[x + 1] = ' '.code
    }

    private fun shiftRight(r: Row, x: Int, n: Int) {
        for (i in cols - 1 downTo x + n) { r.cp[i] = r.cp[i - n]; r.st[i] = r.st[i - n] }
        r.clear(x, x + n, blank())
    }

    private fun insertChars(n: Int) { shiftRight(screen[cursorY], cursorX, minOf(n, cols - cursorX)) }

    private fun deleteChars(count: Int) {
        val r = screen[cursorY]; val n = minOf(count, cols - cursorX)
        for (i in cursorX until cols - n) { r.cp[i] = r.cp[i + n]; r.st[i] = r.st[i + n] }
        r.clear(cols - n, cols, blank())
    }

    private fun eraseLine(mode: Int) {
        val r = screen[cursorY]; val x = minOf(cursorX, cols - 1)
        when (mode) { 0 -> r.clear(x, cols, blank()); 1 -> r.clear(0, x + 1, blank()); 2 -> r.clear(0, cols, blank()) }
        if (mode != 1) r.wrapped = false
        wrapPending = false
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> { eraseLine(0); for (y in cursorY + 1 until rows) wipe(screen[y]) }
            1 -> { eraseLine(1); for (y in 0 until cursorY) wipe(screen[y]) }
            2 -> for (r in screen) wipe(r)
            3 -> history.clear()
        }
    }

    private fun wipe(r: Row) { r.clear(0, cols, blank()); r.wrapped = false }

    // ---------- moving ----------

    private fun moveTo(x: Int, y: Int) {
        val (lo, hi) = if (originMode) top to bottom else 0 to rows - 1
        cursorX = x.coerceIn(0, cols - 1)
        cursorY = ((if (originMode) top else 0) + y).coerceIn(lo, hi)
        wrapPending = false
    }

    private fun moveY(d: Int) {
        // Inside the scroll region the cursor does not leave it; outside, it stops at the screen's edge.
        val lo = if (cursorY >= top) top else 0
        val hi = if (cursorY <= bottom) bottom else rows - 1
        cursorY = (cursorY + d).coerceIn(lo, hi)
        wrapPending = false
    }

    private fun tab(n: Int) {
        repeat(n) {
            var x = cursorX + 1
            while (x < cols - 1 && !tabs[x]) x++
            cursorX = minOf(x, cols - 1)
        }
        wrapPending = false
    }

    private fun backTab(n: Int) {
        repeat(n) {
            var x = cursorX - 1
            while (x > 0 && !tabs[x]) x--
            cursorX = maxOf(x, 0)
        }
    }

    private fun lineFeed() {
        wrapPending = false
        if (cursorY == bottom) scrollUp() else if (cursorY < rows - 1) cursorY++
    }

    private fun reverseIndex() {
        wrapPending = false
        if (cursorY == top) scrollDown() else if (cursorY > 0) cursorY--
    }

    /** The region moves up one line: the top one leaves (to the history, if it is the whole main screen). */
    private fun scrollUp() {
        val gone = screen.removeAt(top)
        if (!altScreen && top == 0) {
            history.addLast(gone)
            if (history.size > scrollback) history.removeFirst()
            screen.add(bottom, Row(cols).also { it.clear(0, cols, blank()) })
        } else {
            wipe(gone); screen.add(bottom, gone)
        }
    }

    private fun scrollDown() {
        val gone = screen.removeAt(bottom)
        wipe(gone); screen.add(top, gone)
    }

    private fun insertLines(n: Int) {
        if (cursorY !in top..bottom) return
        repeat(minOf(n, bottom - cursorY + 1)) { val gone = screen.removeAt(bottom); wipe(gone); screen.add(cursorY, gone) }
        cursorX = 0; wrapPending = false
    }

    private fun deleteLines(n: Int) {
        if (cursorY !in top..bottom) return
        repeat(minOf(n, bottom - cursorY + 1)) { val gone = screen.removeAt(cursorY); wipe(gone); screen.add(bottom, gone) }
        cursorX = 0; wrapPending = false
    }

    private fun saveCursor() {
        val s = Saved(cursorX, cursorY, style, originMode, g0Graphics, g1Graphics)
        if (altScreen) savedAlt = s else savedMain = s
    }

    private fun restoreCursor() {
        val s = (if (altScreen) savedAlt else savedMain) ?: Saved(0, 0, Style.DEFAULT, false, false, false)
        cursorX = s.x.coerceIn(0, cols - 1); cursorY = s.y.coerceIn(0, rows - 1)
        style = s.style; originMode = s.origin; g0Graphics = s.g0; g1Graphics = s.g1; wrapPending = false
    }

    private fun softReset() {
        style = Style.DEFAULT; top = 0; bottom = rows - 1
        autowrap = true; originMode = false; insertMode = false; cursorVisible = true
        appCursorKeys = false; appKeypad = false; g0Graphics = false; g1Graphics = false; shiftOut = false
    }

    private fun reset() {
        softReset()
        useAlt(false, clear = false)
        for (r in main) wipe(r); for (r in alt) wipe(r)
        history.clear()
        cursorX = 0; cursorY = 0; wrapPending = false; bracketedPaste = false
        tabs = BooleanArray(cols) { it % 8 == 0 }
        savedMain = null; savedAlt = null
    }

    // ---------- colours ----------

    private fun sgr() {
        if (params.isEmpty()) { style = Style.DEFAULT; return }
        var fg = Style.fg(style); var bg = Style.bg(style); var flags = Style.flags(style)
        var i = 0
        while (i < params.size) {
            when (val p = maxOf(params[i], 0)) {
                0 -> { fg = Style.DEFAULT_COLOR; bg = Style.DEFAULT_COLOR; flags = 0 }
                1 -> flags = flags or Style.BOLD
                2 -> flags = flags or Style.DIM
                3 -> flags = flags or Style.ITALIC
                4 -> flags = flags or Style.UNDERLINE
                7 -> flags = flags or Style.INVERSE
                8 -> flags = flags or Style.INVISIBLE
                9 -> flags = flags or Style.STRIKE
                21, 22 -> flags = flags and (Style.BOLD or Style.DIM).inv()
                23 -> flags = flags and Style.ITALIC.inv()
                24 -> flags = flags and Style.UNDERLINE.inv()
                27 -> flags = flags and Style.INVERSE.inv()
                28 -> flags = flags and Style.INVISIBLE.inv()
                29 -> flags = flags and Style.STRIKE.inv()
                in 30..37 -> fg = p - 30
                39 -> fg = Style.DEFAULT_COLOR
                in 40..47 -> bg = p - 40
                49 -> bg = Style.DEFAULT_COLOR
                in 90..97 -> fg = p - 90 + 8
                in 100..107 -> bg = p - 100 + 8
                38, 48 -> {
                    // 38;5;N (the 256 palette) · 38;2;R;G;B (24 bits) · and the same with ':' and an empty colour space.
                    val color: Int?
                    when (params.getOrNull(i + 1)) {
                        5 -> { color = params.getOrNull(i + 2)?.takeIf { it in 0..255 }; i += 2 }
                        2 -> {
                            val rest = params.subList(minOf(i + 2, params.size), params.size)
                            val skip = if (rest.size >= 4 && rest[0] < 0) 1 else 0       // 38:2::R:G:B
                            val r = rest.getOrNull(skip); val g = rest.getOrNull(skip + 1); val b = rest.getOrNull(skip + 2)
                            color = if (r != null && g != null && b != null) Style.RGB or ((r and 255) shl 16) or ((g and 255) shl 8) or (b and 255) else null
                            i += 4 + skip
                        }
                        else -> color = null
                    }
                    if (color != null) { if (p == 38) fg = color else bg = color }
                }
                else -> {}
            }
            i++
        }
        style = Style.pack(fg, bg, flags)
    }

    // ---------- the size ----------

    /**
     * The screen changes size. Lines are cut or padded, not reflowed: the shell redraws its
     * prompt on the size change, and a full-screen program redraws everything. On the main
     * screen, losing rows pushes the top ones to the history and gaining rows brings them back.
     */
    fun resize(newCols: Int, newRows: Int) {
        if (newCols < 2 || newRows < 2 || (newCols == cols && newRows == rows)) return
        if (newRows < rows) {
            // Where the main screen's cursor is (kept aside while the alternate screen is up).
            var mainY = if (altScreen) (savedMain?.y ?: 0) else cursorY
            repeat(rows - newRows) {
                // The lines below the cursor go first; then the top ones leave to the history.
                if (mainY < main.size - 1) main.removeAt(main.size - 1)
                else {
                    history.addLast(main.removeAt(0)); if (history.size > scrollback) history.removeFirst()
                    mainY = maxOf(0, mainY - 1)
                }
                alt.removeAt(alt.size - 1)
            }
            if (!altScreen) cursorY = mainY
        } else {
            repeat(newRows - rows) {
                if (history.isNotEmpty()) { main.add(0, history.removeLast()); if (!altScreen) cursorY++ } else main.add(Row(newCols))
                alt.add(Row(newCols))
            }
        }
        for (r in main) r.resize(newCols); for (r in alt) r.resize(newCols); for (r in history) r.resize(newCols)
        tabs = BooleanArray(newCols) { if (it < tabs.size) tabs[it] else it % 8 == 0 }
        cols = newCols; rows = newRows
        top = 0; bottom = rows - 1
        cursorX = cursorX.coerceIn(0, cols - 1); cursorY = cursorY.coerceIn(0, rows - 1)
        wrapPending = false
    }

    /** The text of line [y] (history when negative), without trailing blanks. For tests and for copying. */
    fun text(y: Int): String {
        val r = row(y); val sb = StringBuilder()
        for (c in r.cp) if (c != WIDE_TAIL) sb.appendCodePoint(c)
        return sb.toString().trimEnd()
    }
}
