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
 */
class TerminalView(context: Context) : View(context) {
    var terminal: Terminal? = null
        set(value) { field = value; scrollBack = 0; fit(); invalidate() }

    /** What was typed, already as the bytes a shell reads. */
    var onInput: (String) -> Unit = {}
    /** The columns and rows that fit changed (the view's size, the font, the keyboard). */
    var onResize: (cols: Int, rows: Int) -> Unit = { _, _ -> }
    var onLongPress: () -> Unit = {}
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
    private var scrollRemainder = 0f
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
        if (c == cols && r == rows && terminal?.cols == c && terminal?.rows == r) return
        cols = c; rows = r
        onResize(c, r)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); fit() }

    // ---------- drawing ----------

    private val defaultFg = 0xFFE7E3FF.toInt()
    private val defaultBg = 0xFF0E0B1A.toInt()
    private val cursorColor = 0xFFB69CFF.toInt()
    private val ansi = intArrayOf(
        0xFF1E1940.toInt(), 0xFFF87171.toInt(), 0xFF34D399.toInt(), 0xFFFBBF24.toInt(), 0xFF60A5FA.toInt(), 0xFFC084FC.toInt(), 0xFF22D3EE.toInt(), 0xFFD4D0EE.toInt(),
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
        canvas.drawColor(defaultBg)
        val t = terminal ?: return
        val back = min(scrollBack, t.historySize)
        val visibleRows = min(rows, t.rows)
        for (y in 0 until visibleRows) {
            val line = y - back
            if (line >= t.rows) break
            drawRow(canvas, t.row(line), y * cellH, min(cols, t.cols))
        }
        if (t.cursorVisible && back == 0 && t.cursorY < visibleRows && t.cursorX < cols) {
            val x = t.cursorX * cellW; val y = t.cursorY * cellH
            bgPaint.color = cursorColor
            canvas.drawRect(x, y, x + cellW, y + cellH, bgPaint)
            val cp = t.row(t.cursorY).cp[t.cursorX]
            if (cp > 32) {
                paint.color = defaultBg; paint.typeface = Typeface.MONOSPACE
                canvas.drawText(String(Character.toChars(cp)), x, y + baseline, paint)
            }
        }
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
        override fun onSingleTapUp(e: MotionEvent): Boolean { showKeyboard(); return true }
        override fun onLongPress(e: MotionEvent) { this@TerminalView.onLongPress() }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean { scrollBy(-dy); return true }
        override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
            val t = terminal ?: return true
            scroller.fling(0, (scrollBack * cellH).toInt(), 0, vy.toInt(), 0, 0, 0, (t.historySize * cellH).toInt())
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
        scrollBack = (scrollBack + lines).coerceIn(0, t.historySize)
        invalidate()
    }

    override fun computeScroll() {
        if (!scroller.computeScrollOffset()) return
        val t = terminal ?: return
        scrollBack = (scroller.currY / cellH).roundToInt().coerceIn(0, t.historySize)
        postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
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
