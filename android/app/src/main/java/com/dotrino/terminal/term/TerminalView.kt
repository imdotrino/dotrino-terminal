package com.dotrino.terminal.term

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.util.TypedValue
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.OverScroller
import com.dotrino.terminal.term.Terminal.Style
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The screen of a [Terminal]: draws its cells on a Canvas and turns the keyboard (the phone's
 * or a real one) into what a shell expects. A plain View: no WebView, no AppCompat
 * (CONVENCIONES §16.2).
 *
 * It owns nothing of the console: whoever puts it on screen gives it the [terminal] to show and
 * listens to [onInput] (what was typed) and [onResize] (how many columns and rows fit now).
 *
 * The emulator has the CONSOLE's size, which another screen may decide: it is drawn at that size,
 * and the rest of the view is left in another colour (as the PWA does). A console wider than the
 * view is panned sideways with the finger.
 */
class TerminalView(context: Context) : View(context) {
    var terminal: Terminal? = null
        set(value) { field = value; scrollBack = 0; panX = 0; refit(); invalidate() }

    /** What was typed, already as the bytes a shell reads. */
    var onInput: (String) -> Unit = {}
    /** The columns and rows that fit changed (the view's size, the font, the keyboard). */
    var onResize: (cols: Int, rows: Int) -> Unit = { _, _ -> }
    var onLongPress: () -> Unit = {}

    /** A cell of the buffer, by ABSOLUTE line (history first, then the screen): stable while the
     *  console scrolls and while new output pushes lines into the history. */
    data class Cell(val line: Int, val col: Int)
    /** What the finger selected (long press, then drag): the two ends, in any order. Null = nothing. */
    var selection: Pair<Cell, Cell>? = null; private set
    private var selecting = false
    private val selectionPaint = Paint().apply { color = 0x5981CFFF.toInt() }
    val hasSelection: Boolean get() = selection != null

    fun clearSelection() { if (selection != null) { selection = null; invalidate() } }

    /** The buffer cell under a point of the view, or null outside the console. */
    private fun cellAt(px: Float, py: Float): Cell? {
        val t = terminal ?: return null
        val y = (py / cellH).toInt(); val x = (px / cellW).toInt() + panX
        if (y < 0 || y >= min(rows, t.rows) || x < 0 || x >= t.cols) return null
        return Cell(t.historySize + topLine(t) + y, x)
    }

    private fun ordered(): Pair<Cell, Cell>? {
        val (a, b) = selection ?: return null
        return if (b.line < a.line || (b.line == a.line && b.col < a.col)) b to a else a to b
    }

    /** The selected text: whole lines between the ends, the ends cut at their columns, no false
     *  line breaks where a line wrapped, and no trailing spaces. */
    fun selectedText(): String {
        val t = terminal ?: return ""
        val (a, b) = ordered() ?: return ""
        val sb = StringBuilder()
        for (abs in a.line..b.line) {
            val line = abs - t.historySize
            if (line < -t.historySize || line >= t.rows) continue
            val r = t.row(line)
            val from = if (abs == a.line) a.col else 0
            val to = if (abs == b.line) minOf(b.col + 1, r.cp.size) else r.cp.size
            val text = StringBuilder()
            for (i in from until to) if (r.cp[i] != Terminal.WIDE_TAIL) text.appendCodePoint(r.cp[i])
            sb.append(text.toString().trimEnd(' '))
            if (abs != b.line && !r.wrapped) sb.append('\n')
        }
        return sb.toString()
    }
    /** A sticky modifier was used up by the key that followed it. */
    var onModifiersChanged: () -> Unit = {}

    /** Sticky modifiers of the extra-keys row: they apply to the NEXT key and switch off. */
    var ctrl = false
    var alt = false

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.MONOSPACE }
    private val bold = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
    private val bgPaint = Paint()
    private var fontSp = 11f
    private var cellW = 1f
    private var cellH = 1f
    private var baseline = 0f
    /** Lines scrolled back into the history (0 = the live screen). */
    private var scrollBack = 0

    /** Rows of the console that do not fit in the view (another screen has its size, or the keyboard is up). */
    private fun below(t: Terminal) = max(0, t.rows - rows)
    /** The console line on the view's first row when nothing is scrolled. A console taller than the
     *  view FOLLOWS THE CURSOR: drawn always from the top, what was being typed stayed out of reach
     *  under the keyboard. */
    private fun liveTop(t: Terminal) = (t.cursorY - rows + 1).coerceIn(0, below(t))
    /** How far the view can go: up, the hidden rows above and then the history; down (negative), the hidden rows below. */
    private fun maxBack(t: Terminal) = t.historySize + liveTop(t)
    private fun minBack(t: Terminal) = liveTop(t) - below(t)
    private fun back(t: Terminal) = scrollBack.coerceIn(minBack(t), maxBack(t))
    /** The console line on the view's first row (negative = history). */
    private fun topLine(t: Terminal) = liveTop(t) - back(t)
    private var scrollRemainder = 0f
    /** Columns panned sideways, when the console is wider than the view. */
    private var panX = 0
    private var panRemainder = 0f
    private val scroller = OverScroller(context)

    var cols = 80; private set
    var rows = 24; private set

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        setFont(fontSp)
    }

    // ---------- size ----------

    private fun setFont(sp: Float) {
        fontSp = sp.coerceIn(7f, 30f)
        paint.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, fontSp, resources.displayMetrics)
        paint.typeface = Typeface.MONOSPACE
        cellW = paint.measureText("M")
        val fm = paint.fontMetrics
        cellH = (fm.descent - fm.ascent).let { Math.ceil(it.toDouble()).toFloat() }
        baseline = -fm.ascent
        fit()
    }

    private fun fit() {
        if (width == 0 || height == 0) return
        val c = max(2, (width / cellW).toInt()); val r = max(2, (height / cellH).toInt())
        if (c == cols && r == rows) return
        cols = c; rows = r
        onResize(max(MIN_COLS, c), r)
    }

    /** Say again what fits (a new terminal on screen must hear it). */
    fun refit() {
        if (width == 0 || height == 0) return
        cols = max(2, (width / cellW).toInt()); rows = max(2, (height / cellH).toInt())
        onResize(max(MIN_COLS, cols), rows)
    }

    companion object {
        /** The console is never asked to be narrower than this (owner, 2026-10-07: with the panel open
         *  the view got 16 columns and the shell reflowed everything). Narrower views pan sideways. */
        const val MIN_COLS = 40
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); fit() }

    // ---------- drawing ----------

    // «Cool & Cozy», oscuro (CONVENCIONES y la PWA): fondo surface, texto on-surface, cursor primary.
    private val defaultFg = 0xFFDFE3E6.toInt()
    private val defaultBg = 0xFF0F1416.toInt()
    /** The part of the view outside the console, when the console is smaller than the screen. */
    private val outsideBg = 0xFF1C2022.toInt()
    private val cursorColor = 0xFF81CFFF.toInt()
    private val ansi = intArrayOf(
        0xFF262A2D.toInt(), 0xFFF87171.toInt(), 0xFF34D399.toInt(), 0xFFFBBF24.toInt(), 0xFF60A5FA.toInt(), 0xFFC084FC.toInt(), 0xFF22D3EE.toInt(), 0xFFD4D0EE.toInt(),
        0xFF6B6494.toInt(), 0xFFFCA5A5.toInt(), 0xFF6EE7B7.toInt(), 0xFFFDE68A.toInt(), 0xFF93C5FD.toInt(), 0xFFD8B4FE.toInt(), 0xFF67E8F9.toInt(), 0xFFFFFFFF.toInt(),
    )

    private fun color(c: Int, fallback: Int): Int = when {
        c == Style.DEFAULT_COLOR -> fallback
        c and Style.RGB != 0 -> 0xFF000000.toInt() or (c and 0xFFFFFF)
        c < 16 -> ansi[c]
        c < 232 -> {                                              // the 6×6×6 colour cube
            val n = c - 16; val l = intArrayOf(0, 95, 135, 175, 215, 255)
            0xFF000000.toInt() or (l[n / 36] shl 16) or (l[(n / 6) % 6] shl 8) or l[n % 6]
        }
        else -> { val g = 8 + (c - 232) * 10; 0xFF000000.toInt() or (g shl 16) or (g shl 8) or g }   // the grey ramp
    }

    private val run = StringBuilder()

    override fun onDraw(canvas: Canvas) {
        val t = terminal ?: run { canvas.drawColor(defaultBg); return }
        canvas.drawColor(outsideBg)
        panX = panX.coerceIn(0, max(0, t.cols - cols))
        val top = topLine(t)
        val visibleRows = min(rows, t.rows)
        val shownCols = min(t.cols - panX, cols + 1)
        bgPaint.color = defaultBg
        canvas.drawRect(0f, 0f, shownCols * cellW, visibleRows * cellH, bgPaint)
        canvas.save()
        canvas.clipRect(0f, 0f, shownCols * cellW, visibleRows * cellH)
        canvas.translate(-panX * cellW, 0f)
        for (y in 0 until visibleRows) {
            val line = top + y
            if (line >= t.rows) break
            drawRow(canvas, t.row(line), y * cellH, min(panX + cols + 1, t.cols))
        }
        ordered()?.let { (a, b) ->
            for (y in 0 until visibleRows) {
                val abs = t.historySize + top + y
                if (abs < a.line || abs > b.line) continue
                val from = if (abs == a.line) a.col else 0
                val to = if (abs == b.line) b.col + 1 else t.cols
                if (to > from) canvas.drawRect(from * cellW, y * cellH, to * cellW, (y + 1) * cellH, selectionPaint)
            }
        }
        val cursorRow = t.cursorY - top
        if (t.cursorVisible && cursorRow in 0 until visibleRows && t.cursorX < t.cols) {
            val x = t.cursorX * cellW; val y = cursorRow * cellH
            bgPaint.color = cursorColor
            canvas.drawRect(x, y, x + cellW, y + cellH, bgPaint)
            val cp = t.row(t.cursorY).cp[t.cursorX]
            if (cp > 32) {
                paint.color = defaultBg; paint.typeface = Typeface.MONOSPACE
                canvas.drawText(String(Character.toChars(cp)), x, y + baseline, paint)
            }
        }
        canvas.restore()
    }

    private fun drawRow(canvas: Canvas, r: Terminal.Row, top: Float, n: Int) {
        var x = 0
        while (x < n) {
            val st = r.st[x]
            // A run: neighbouring cells with the same style, drawn at once.
            var end = x + 1
            while (end < n && r.st[end] == st) end++
            val flags = Style.flags(st)
            var fg = color(Style.fg(st), defaultFg); var bg = color(Style.bg(st), defaultBg)
            if (flags and Style.INVERSE != 0) { val s = fg; fg = bg; bg = s }
            if (flags and Style.DIM != 0) fg = (fg and 0xFFFFFF) or 0x99000000.toInt()
            if (bg != defaultBg) { bgPaint.color = bg; canvas.drawRect(x * cellW, top, end * cellW, top + cellH, bgPaint) }
            if (flags and Style.INVISIBLE == 0) {
                paint.color = fg
                paint.typeface = if (flags and Style.BOLD != 0) bold else Typeface.MONOSPACE
                paint.textSkewX = if (flags and Style.ITALIC != 0) -0.2f else 0f
                paint.isUnderlineText = flags and Style.UNDERLINE != 0
                paint.isStrikeThruText = flags and Style.STRIKE != 0
                // Plain ASCII goes as one string (the font is monospace). Anything else goes cell by
                // cell: a glyph from a fallback font has its own width and would push the rest.
                var i = x
                while (i < end) {
                    val cp = r.cp[i]
                    if (cp in 33..126) {
                        run.setLength(0); val start = i
                        while (i < end && r.cp[i] in 32..126) run.append(r.cp[i++].toChar())
                        canvas.drawText(run, 0, run.length, start * cellW, top + baseline, paint)
                    } else {
                        if (cp > 32 && cp != Terminal.WIDE_TAIL) canvas.drawText(String(Character.toChars(cp)), i * cellW, top + baseline, paint)
                        i++
                    }
                }
            }
            x = end
        }
    }

    // ---------- touch: scroll the history, zoom the font, open the keyboard ----------

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean { scroller.forceFinished(true); return true }
        override fun onSingleTapUp(e: MotionEvent): Boolean { clearSelection(); showKeyboard(); return true }
        // Long press: the cell under the finger starts a selection; dragging extends it (handled in
        // onTouchEvent: the detector stops scrolling after a long press); lifting shows the menu.
        override fun onLongPress(e: MotionEvent) {
            val c = cellAt(e.x, e.y) ?: return
            selection = c to c; selecting = true
            performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            invalidate()
        }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean {
            if (selecting) return true
            // Sideways only pans a console wider than the view; up and down is the history.
            if (kotlin.math.abs(dx) > kotlin.math.abs(dy)) panBy(dx) else scrollBy(-dy)
            return true
        }
        override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
            val t = terminal ?: return true
            scroller.fling(0, (scrollBack * cellH).toInt(), 0, vy.toInt(), 0, 0, (minBack(t) * cellH).toInt(), (maxBack(t) * cellH).toInt())
            postInvalidateOnAnimation()
            return true
        }
    })

    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            val next = fontSp * d.scaleFactor
            if (kotlin.math.abs(next - fontSp) >= 0.5f) setFont(next)
            invalidate()
            return true
        }
    })

    private fun scrollBy(pixels: Float) {
        val t = terminal ?: return
        scrollRemainder += pixels
        val lines = (scrollRemainder / cellH).toInt()
        if (lines == 0) return
        scrollRemainder -= lines * cellH
        scrollBack = (back(t) + lines).coerceIn(minBack(t), maxBack(t))
        invalidate()
    }

    private fun panBy(pixels: Float) {
        val t = terminal ?: return
        if (t.cols <= cols) return
        panRemainder += pixels
        val n = (panRemainder / cellW).toInt()
        if (n == 0) return
        panRemainder -= n * cellW
        panX = (panX + n).coerceIn(0, t.cols - cols)
        invalidate()
    }

    override fun computeScroll() {
        if (!scroller.computeScrollOffset()) return
        val t = terminal ?: return
        scrollBack = (scroller.currY / cellH).roundToInt().coerceIn(minBack(t), maxBack(t))
        postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (selecting) {
            when (event.actionMasked) {
                MotionEvent.ACTION_MOVE -> { val c = cellAt(event.x, event.y); val s = selection; if (c != null && s != null) { selection = s.first to c; invalidate() } }
                MotionEvent.ACTION_UP -> { selecting = false; onLongPress() }
                MotionEvent.ACTION_CANCEL -> { selecting = false; clearSelection() }
            }
            gestures.onTouchEvent(event)
            return true
        }
        pinch.onTouchEvent(event)
        if (!pinch.isInProgress) gestures.onTouchEvent(event)
        return true
    }

    fun showKeyboard() {
        requestFocus()
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(this, 0)
    }

    /** The shell wrote something: draw it, and go back to the live screen if it was scrolled a little. */
    fun onOutput() { postInvalidateOnAnimation() }

    // ---------- keyboard ----------

    /** Send what a key means, applying the sticky modifiers of the extra row to it. */
    fun type(text: String) {
        if (text.isEmpty()) return
        var out = text
        if (ctrl && text.length == 1) controlOf(text[0])?.let { out = it.toString() }
        if (alt) out = "\u001b" + out
        if (ctrl || alt) { ctrl = false; alt = false; onModifiersChanged() }
        scrollBack = 0
        onInput(out)
    }

    private fun controlOf(c: Char): Char? = when (c) {
        in 'a'..'z' -> (c - 'a' + 1).toChar()
        in 'A'..'Z' -> (c - 'A' + 1).toChar()
        ' ', '2', '@' -> 0.toChar()
        '[', '3' -> 27.toChar()
        '\\', '4' -> 28.toChar()
        ']', '5' -> 29.toChar()
        '^', '6' -> 30.toChar()
        '_', '7', '/' -> 31.toChar()
        '?', '8' -> 127.toChar()
        else -> null
    }

    /** A named key of the extra row or of a real keyboard, as the escape sequence a shell expects. */
    fun key(name: String) {
        val app = terminal?.appCursorKeys == true
        val seq = when (name) {
            "esc" -> "\u001b"; "tab" -> "\t"; "enter" -> "\r"; "backspace" -> "\u007f"
            "up" -> if (app) "\u001bOA" else "\u001b[A"
            "down" -> if (app) "\u001bOB" else "\u001b[B"
            "right" -> if (app) "\u001bOC" else "\u001b[C"
            "left" -> if (app) "\u001bOD" else "\u001b[D"
            "home" -> if (app) "\u001bOH" else "\u001b[H"
            "end" -> if (app) "\u001bOF" else "\u001b[F"
            "pgup" -> "\u001b[5~"; "pgdn" -> "\u001b[6~"; "del" -> "\u001b[3~"; "ins" -> "\u001b[2~"
            "f1" -> "\u001bOP"; "f2" -> "\u001bOQ"; "f3" -> "\u001bOR"; "f4" -> "\u001bOS"
            "f5" -> "\u001b[15~"; "f6" -> "\u001b[17~"; "f7" -> "\u001b[18~"; "f8" -> "\u001b[19~"
            "f9" -> "\u001b[20~"; "f10" -> "\u001b[21~"; "f11" -> "\u001b[23~"; "f12" -> "\u001b[24~"
            else -> return
        }
        // Ctrl does not change these keys; Alt still prefixes them.
        val out = if (alt) "\u001b" + seq else seq
        if (ctrl || alt) { ctrl = false; alt = false; onModifiersChanged() }
        scrollBack = 0
        onInput(out)
    }

    /** Paste: bracketed when the program asked for it, so it does not run what was pasted line by line. */
    fun paste(text: String) {
        if (text.isEmpty()) return
        val body = text.replace("\r\n", "\r").replace('\n', '\r')
        scrollBack = 0
        onInput(if (terminal?.bracketedPaste == true) "\u001b[200~$body\u001b[201~" else body)
    }

    /** What is on screen now, as text (for «copy»). Wrapped lines are joined. */
    fun screenText(): String {
        val t = terminal ?: return ""
        val sb = StringBuilder()
        val back = min(scrollBack, t.historySize)
        for (y in 0 until t.rows) {
            val line = y - back
            sb.append(t.text(line))
            if (!t.row(line).wrapped) sb.append('\n')
        }
        return sb.toString().trimEnd('\n')
    }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(out: EditorInfo): InputConnection {
        // «Visible password»: the keyboard does not predict, correct nor compose — each key arrives as typed.
        out.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        out.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
        return object : BaseInputConnection(this, true) {
            private fun flush() {
                val e = editable ?: return
                val s = e.toString()
                if (s.isNotEmpty()) { e.clear(); type(s.replace('\n', '\r')) }
            }
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean { super.commitText(text, newCursorPosition); flush(); return true }
            override fun finishComposingText(): Boolean { super.finishComposingText(); flush(); return true }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                // The keyboard deleting «the character before the cursor» is the Backspace key.
                repeat(max(1, beforeLength)) { key("backspace") }
                return true
            }
            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) onKeyDown(event.keyCode, event)
                return true
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val named = when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "enter"
            KeyEvent.KEYCODE_DEL -> "backspace"
            KeyEvent.KEYCODE_FORWARD_DEL -> "del"
            KeyEvent.KEYCODE_TAB -> "tab"
            KeyEvent.KEYCODE_ESCAPE -> "esc"
            KeyEvent.KEYCODE_DPAD_UP -> "up"; KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            KeyEvent.KEYCODE_DPAD_LEFT -> "left"; KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
            KeyEvent.KEYCODE_MOVE_HOME -> "home"; KeyEvent.KEYCODE_MOVE_END -> "end"
            KeyEvent.KEYCODE_PAGE_UP -> "pgup"; KeyEvent.KEYCODE_PAGE_DOWN -> "pgdn"
            KeyEvent.KEYCODE_INSERT -> "ins"
            in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "f${keyCode - KeyEvent.KEYCODE_F1 + 1}"
            else -> null
        }
        if (named != null) { key(named); return true }
        if (keyCode == KeyEvent.KEYCODE_BACK || event.isSystem) return super.onKeyDown(keyCode, event)
        // A real keyboard: Ctrl and Alt come in the event itself.
        val meta = event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv()
        val c = event.getUnicodeChar(meta)
        if (c <= 0) return super.onKeyDown(keyCode, event)            // nothing printable (or a dead key: its flag makes it negative)
        if (event.isCtrlPressed) ctrl = true
        if (event.isAltPressed) alt = true
        type(String(Character.toChars(c)))
        return true
    }
}
