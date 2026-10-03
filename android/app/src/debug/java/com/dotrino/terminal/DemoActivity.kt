package com.dotrino.terminal

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import com.dotrino.terminal.term.Terminal
import com.dotrino.terminal.term.TerminalView

/**
 * DEBUG ONLY (src/debug): the terminal drawing a sample output and echoing what is typed, with
 * no profile and no network. To look at the rendering and the keyboard on an emulator.
 */
class DemoActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val e = "\u001b"
        val term = Terminal(80, 24)
        val view = TerminalView(this).apply { terminal = term }
        view.onResize = { c, r -> term.resize(c, r) }
        view.onInput = { s -> term.feed(if (s == "\r") "\r\n$ " else if (s == "\u007f") "\b \b" else s.replace(e, "^[")); view.onOutput() }
        val sample = buildString {
            append("$e[1;32mseyacat@loca$e[0m:$e[1;34m~/proyecto$e[0m$ ls --color\r\n")
            append("$e[1;34msrc$e[0m  $e[1;34mdocs$e[0m  $e[1;32mrun.sh$e[0m  README.md  $e[1;31marchivo.tar.gz$e[0m  $e[1;36menlace$e[0m\r\n")
            append("$e[1;32mseyacat@loca$e[0m:$e[1;34m~/proyecto$e[0m$ git status\r\n")
            append("En la rama $e[32mmain$e[0m\r\n  $e[31mmodificado:  src/main.rs$e[0m\r\n  $e[32mnuevo:       android/app/…$e[0m\r\n")
            for (i in 0..7) append("$e[4${i}m  $e[0m"); append(" "); for (i in 0..7) append("$e[10${i}m  $e[0m"); append("\r\n")
            for (i in 0..35) append("$e[48;5;${16 + i * 6}m $e[0m"); append(" 256\r\n")
            for (i in 0..35) append("$e[48;2;${i * 7};80;${255 - i * 7}m $e[0m"); append(" 24 bits\r\n")
            append("$e[1mnegrita$e[0m $e[3mcursiva$e[0m $e[4msubrayado$e[0m $e[7minverso$e[0m $e[9mtachado$e[0m $e[2mtenue$e[0m\r\n")
            append("$e(0lqqqqqqqqqqqqqqk$e(B  日本語 ancho · ñ á ü · 😀\r\n$e(0x$e(B caja de tmux $e(0x$e(B\r\n$e(0mqqqqqqqqqqqqqqj$e(B\r\n")
            append("$ ")
        }
        term.feed(sample)
        setContentView(LinearLayout(this).apply { fitsSystemWindows = true; setBackgroundColor(0xFF0E0B1A.toInt()); addView(view, LinearLayout.LayoutParams(-1, -1)) })
    }
}
