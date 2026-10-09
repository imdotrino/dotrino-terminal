package com.dotrino.terminal.term

/** What a key sends to the shell, given the sticky modifiers. No view here, so it can be tested. */
internal object Keys {
    /** Typed text with the modifiers applied: Shift uppercases, Ctrl makes a control character, Alt prefixes ESC. */
    fun text(text: String, shift: Boolean, ctrl: Boolean, alt: Boolean): String {
        var out = if (shift) text.uppercase() else text
        if (ctrl && text.length == 1) controlOf(text[0])?.let { out = it.toString() }
        return if (alt) "\u001b" + out else out
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

    /**
     * A named key as the escape sequence a shell expects, or null when it sends nothing (an unknown
     * name, or Shift with a key that has no shifted form). [app]: the program asked for application
     * cursor keys. Ctrl does not change these keys; Alt prefixes them.
     */
    fun named(name: String, shift: Boolean, alt: Boolean, app: Boolean): String? {
        val seq = (if (shift) shifted(name) else plain(name, app)) ?: return null
        return if (alt) "\u001b" + seq else seq
    }

    private fun plain(name: String, app: Boolean): String? = when (name) {
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
        else -> null
    }

    /** With Shift, as xterm sends it: Shift+Tab is `CSI Z`, the rest carry the modifier `2`. */
    private fun shifted(name: String): String? = when (name) {
        "tab" -> "\u001b[Z"
        "up" -> "\u001b[1;2A"; "down" -> "\u001b[1;2B"; "right" -> "\u001b[1;2C"; "left" -> "\u001b[1;2D"
        "home" -> "\u001b[1;2H"; "end" -> "\u001b[1;2F"
        "pgup" -> "\u001b[5;2~"; "pgdn" -> "\u001b[6;2~"; "del" -> "\u001b[3;2~"; "ins" -> "\u001b[2;2~"
        "esc" -> "\u001b"; "enter" -> "\r"; "backspace" -> "\u007f"
        else -> null
    }
}
