package com.dotrino.terminal.term

/**
 * Los enlaces y las rutas de una línea de la consola, para abrirlos con un toque. Es el puerto de
 * `src/links.js`: la MISMA regla en las cuatro versiones (web, escritorio, Android, iOS) y los
 * mismos casos de prueba (`test/links.vectors.json`, LinksTest). Si una reconoce algo que otra no,
 * el usuario ve dos terminales distintas: un cambio aquí va también allí.
 *
 * La línea se parte en trozos por los espacios, las comillas y `<>|;()[]{}`. A cada trozo se le
 * quita la puntuación del final (`.,:;!?`) y se mira qué es:
 *   - un enlace: empieza por `http://`, `https://`, `ftp://`, `file://` o `mailto:`;
 *   - una ruta: empieza por `/`, `~/`, `./` o `../` (o va tras un `=`: `--out=/tmp/x`), y tiene
 *     al menos una letra o un número (así `//` o `/` sueltos no cuentan).
 * De una ruta, `target` quita el `:línea:columna` del final (`src/a.js:12:3`).
 *
 * Las posiciones son en unidades UTF-16, como en JavaScript.
 */
object Links {
    enum class Kind { URL, PATH }

    /** [start]/[end]: positions in the line ([end] excluded). */
    data class Link(val start: Int, val end: Int, val text: String, val kind: Kind, val target: String)

    // `\s` de JavaScript (Unicode), más las comillas y `<>|;()[]{}`.
    private const val SEP = " \t\n\u000B\u000C\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'\"`<>|;()[]{}"
    private val TRAIL = Regex("[.,:;!?]+$")
    private val URL_START = Regex("^(?:(?:https?|ftp|file)://|mailto:)", RegexOption.IGNORE_CASE)
    private val PATH_START = Regex("^(?:/|~/|\\.\\.?/)")
    private val LETTER_OR_DIGIT = Regex("[\\p{L}\\p{N}]")
    private val LINE_COL = Regex(":\\d+(?::\\d+)?$")

    private fun isSep(c: Char) = SEP.indexOf(c) >= 0

    fun find(line: String): List<Link> {
        val out = ArrayList<Link>()
        var i = 0
        while (i < line.length) {
            if (isSep(line[i])) { i++; continue }
            var j = i
            while (j < line.length && !isSep(line[j])) j++
            classify(line.substring(i, j))?.let { (at, l) -> out += l.copy(start = i + at, end = i + at + l.text.length) }
            i = j
        }
        return out
    }

    /** The link of [line] that covers position [col], or null. */
    fun at(line: String, col: Int): Link? = find(line).firstOrNull { col >= it.start && col < it.end }

    private fun classify(token: String): Pair<Int, Link>? {
        val text = token.replace(TRAIL, "")
        URL_START.find(text)?.let { m ->
            return if (text.length > m.value.length) 0 to Link(0, 0, text, Kind.URL, text) else null
        }
        var at = 0
        if (!PATH_START.containsMatchIn(text)) {
            val eq = text.lastIndexOf('=')
            if (eq < 0 || !PATH_START.containsMatchIn(text.substring(eq + 1))) return null
            at = eq + 1
        }
        val p = text.substring(at)
        if (p.startsWith("//") || !LETTER_OR_DIGIT.containsMatchIn(p)) return null
        return at to Link(0, 0, p, Kind.PATH, p.replace(LINE_COL, ""))
    }

    /** A `file://` link is a path of the machine; a path is itself; any other link is not a path (null). */
    fun asPath(l: Link): String? = when {
        l.kind == Kind.PATH -> l.target
        l.target.startsWith("file://", ignoreCase = true) ->
            java.net.URLDecoder.decode(l.target.replace(Regex("^file://[^/]*", RegexOption.IGNORE_CASE), "").replace("+", "%2B"), "UTF-8")
        else -> null
    }

    /**
     * The link under a cell of [t]: [line] as [Terminal.row] counts it (negative = history), [col]
     * the column. The row is read whole with the rows it wrapped into, so a long path cut at the
     * edge of the screen is still one path.
     */
    fun at(t: Terminal, line: Int, col: Int): Link? {
        if (line < -t.historySize || line >= t.rows) return null
        var first = line
        while (first - 1 >= -t.historySize && t.row(first - 1).wrapped) first--
        var last = line
        while (last + 1 < t.rows && t.row(last).wrapped) last++
        val sb = StringBuilder()
        var pos = -1
        for (y in first..last) {
            val r = t.row(y)
            for (x in r.cp.indices) {
                val cp = r.cp[x]
                if (cp == Terminal.WIDE_TAIL) { if (y == line && x == col) pos = maxOf(0, sb.length - 1); continue }
                if (y == line && x == col) pos = sb.length
                if (cp < 32) sb.append(' ') else sb.appendCodePoint(cp)
            }
        }
        if (pos < 0) return null
        return at(sb.toString(), pos)
    }

    /** What the system knows how to open, by its name (the same list as `src/links.js`). */
    private val MIME = mapOf(
        "pdf" to "application/pdf", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "gif" to "image/gif", "webp" to "image/webp", "svg" to "image/svg+xml",
        "txt" to "text/plain", "md" to "text/plain", "log" to "text/plain", "json" to "application/json", "csv" to "text/csv", "html" to "text/html", "htm" to "text/html",
        "mp3" to "audio/mpeg", "wav" to "audio/wav", "ogg" to "audio/ogg", "mp4" to "video/mp4", "webm" to "video/webm", "zip" to "application/zip",
    )
    private val EXT = Regex("\\.([^./]+)$")
    fun mimeOf(name: String): String = MIME[EXT.find(name)?.groupValues?.get(1)?.lowercase().orEmpty()] ?: "application/octet-stream"
}
