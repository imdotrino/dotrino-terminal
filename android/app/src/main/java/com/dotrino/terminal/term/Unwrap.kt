package com.dotrino.terminal.term

/**
 * «Copiar sin saltos»: deshace los saltos que mete quien ajusta el texto al ancho de la pantalla
 * (Claude Code y otras TUI parten las líneas largas con saltos de verdad y una sangría, así que un
 * enlace copiado sale roto). Es el puerto de `src/unwrap.js`, que manda: la misma regla en las
 * cuatro versiones y los mismos casos (`test/unwrap.vectors.json`, UnwrapTest).
 */
object Unwrap {
    private const val MIN_WRAP = 40
    private const val MARGIN = 15
    private const val LONG_TOKEN = 30

    private fun hasUrl(s: String) = s.contains("http://") || s.contains("https://") || s.contains("www.")
    private fun urlChar(c: Char) = (c in 'A'..'Z') || (c in 'a'..'z') || (c in '0'..'9') || c in "%&=?/._~:+#@!$'()*,;[]-"

    /** Removes 2+ space gaps inside a link: the next row's indent when the terminal joined the rows on copy. */
    private fun closeUrlGaps(s: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            if (!(s.startsWith("http://", i) || s.startsWith("https://", i) || s.startsWith("www.", i))) { out.append(s[i]); i++; continue }
            var j = i
            while (true) {
                while (j < s.length && !s[j].isWhitespace()) out.append(s[j++])
                var k = j
                while (k < s.length && s[k] == ' ') k++
                if (k - j >= 2 && k < s.length && urlChar(s[k])) { j = k; continue }
                break
            }
            i = j
        }
        return out.toString()
    }

    private fun indent(s: String) = s.length - s.trimStart().length
    private fun len(s: String) = s.codePointCount(0, s.length)

    fun unwrap(text: String): String {
        val lines = text.replace("\r", "").split('\n').map { it.trimEnd() }
        if (lines.size < 2) return closeUrlGaps(text.trim())
        val width = lines.maxOf { len(it) }
        val common = lines.drop(1).filter { it.isNotEmpty() }.minOfOrNull { indent(it) } ?: 0
        val out = StringBuilder(lines[0].trimStart())
        for (i in 1 until lines.size) {
            val prev = lines[i - 1]
            val cur = lines[i].trim()
            if (cur.isEmpty()) { out.append('\n'); continue }
            val n = len(prev)
            val last = out.split(Regex("\\s+")).lastOrNull { it.isNotEmpty() } ?: ""
            val inUrl = hasUrl(last)
            val first = cur[0]
            val sentence = !inUrl && prev.isNotEmpty() && prev.last() in ".:;!?" && first.isUpperCase()
            val wrapped = prev.isNotEmpty() && n >= MIN_WRAP && !sentence && (n >= width - MARGIN || first.isLowerCase())
            when {
                !wrapped -> out.append('\n').append(lines[i].substring(minOf(common, indent(lines[i]))))
                inUrl || len(last) >= LONG_TOKEN -> out.append(cur)
                else -> out.append(' ').append(cur)
            }
        }
        return closeUrlGaps(out.toString().trim())
    }
}
