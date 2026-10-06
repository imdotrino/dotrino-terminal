package com.dotrino.terminal

import android.content.Context
import com.dotrino.sdk.ui.DotrinoLocale

/**
 * The app's texts, es/en (CONVENCIONES §9: tuteo, plain language). The same wording as the PWA
 * (`src/main.js`) where the same thing is said. A missing key is an error, not a hole on screen.
 */
object I18n {
    var lang = "es"; private set
    fun load(context: Context) { lang = DotrinoLocale.current(context) }

    private val es = mapOf(
        "machines.title" to "Tus máquinas",
        "machines.loading" to "Buscando tus máquinas…",
        "machines.none" to "No hay ninguna máquina con el agente encendido. Si ya lo instalaste, comprueba que esté corriendo: aparecerá aquí sola.",
        "machines.howto" to "Cómo instalar",
        "machines.refresh" to "Buscar de nuevo",
        "machines.error" to "No se pudo buscar: {why}",
        "machines.open" to "Volver a tus consolas ({n})",
        "machine.connecting" to "Conectando a {name}…",
        "machine.failed" to "No se pudo conectar: {why}",
        "tab.close" to "Cerrar esta consola",
        "panel.open" to "Abrir el panel", "panel.close" to "Colapsar el panel", "panel.title" to "Consolas",
        "console.new" to "Nueva consola", "console.kill" to "Cerrar consola", "console.openHere" to "Abrir aquí", "console.n" to "Consola {n}",
        "where.free" to "suelta", "where.here" to "en esta pantalla", "where.other" to "abierta en otro aparato", "where.local" to "ventana abierta en la máquina",
        "size.label" to "tamaño", "size.here" to "esta pantalla", "size.window" to "una ventana de la máquina", "size.device" to "otro aparato",
        "size.row" to "Tamaño de la {n}: {who} ({cols}×{rows})",
        "size.pinned" to "elegido a propósito", "size.last" to "lo tiene la última pantalla que la abre",
        "size.use" to "Usar el tamaño de esta pantalla en la consola {n}",
        "size.release" to "Soltar: la consola {n} deja de usar el tamaño de esta pantalla",
        "size.usedNow" to "Consola {n}: usa el tamaño de esta pantalla ({cols}×{rows}). Las demás la ven a ese tamaño.",
        "size.releasedNow" to "Consola {n}: ya no usa el tamaño de esta pantalla. Lo tiene la última pantalla que la abre.",
        "tab.new" to "Otra consola",
        "tab.connecting" to "Conectando…",
        "tab.lost" to "Se perdió la conexión. Volviendo…",
        "tab.exited" to "La consola terminó.",
        "tab.gone" to "Esta consola ya no existe en la máquina: se cerró, o el agente se reinició.",
        "tab.failed" to "No se pudo abrir: {why}",
        "tab.retry" to "Reintentar",
        "menu.paste" to "Pegar",
        "menu.copy" to "Copiar la pantalla",
        "menu.copied" to "Pantalla copiada",
        "menu.title" to "Consola",
        "link.connecting" to "Conectando…",
        "link.offline" to "Sin conexión. Reintentando…",
        "boot.noIdentityApp" to "Tu perfil de Dotrino vive en la app «Identidad Dotrino». Instálala y vuelve aquí.",
        "boot.noProfile" to "Este teléfono todavía no tiene un perfil de Dotrino. Créalo aquí mismo o adopta uno que ya tengas.",
        "boot.noVault" to "Este perfil no está conectado a una bóveda. Conéctalo para ver tus máquinas.",
        "boot.connectVault" to "Conectar mi bóveda",
        "boot.create" to "Crear perfil", "boot.adopt" to "Adoptar un perfil", "boot.retry" to "Reintentar",
        "key.ctrl" to "Ctrl", "key.alt" to "Alt",
    )
    private val en = mapOf(
        "machines.title" to "Your machines",
        "machines.loading" to "Looking for your machines…",
        "machines.none" to "No machine has the agent running. If you already installed it, check that it is running: it will show up here by itself.",
        "machines.howto" to "How to install",
        "machines.refresh" to "Look again",
        "machines.error" to "Could not look: {why}",
        "machines.open" to "Back to your consoles ({n})",
        "machine.connecting" to "Connecting to {name}…",
        "machine.failed" to "Could not connect: {why}",
        "tab.close" to "Close this console",
        "panel.open" to "Open the panel", "panel.close" to "Collapse the panel", "panel.title" to "Consoles",
        "console.new" to "New console", "console.kill" to "Close console", "console.openHere" to "Open here", "console.n" to "Console {n}",
        "where.free" to "detached", "where.here" to "on this screen", "where.other" to "open on another device", "where.local" to "window open on the machine",
        "size.label" to "size", "size.here" to "this screen", "size.window" to "a window on the machine", "size.device" to "another device",
        "size.row" to "Size of {n}: {who} ({cols}×{rows})",
        "size.pinned" to "chosen on purpose", "size.last" to "set by the last screen that opens it",
        "size.use" to "Use this screen's size for console {n}",
        "size.release" to "Release: console {n} stops using this screen's size",
        "size.usedNow" to "Console {n}: uses this screen's size ({cols}×{rows}). Other screens show it at that size.",
        "size.releasedNow" to "Console {n}: no longer uses this screen's size. The last screen that opens it sets it.",
        "tab.new" to "Another console",
        "tab.connecting" to "Connecting…",
        "tab.lost" to "Connection lost. Coming back…",
        "tab.exited" to "The console ended.",
        "tab.gone" to "This console no longer exists on the machine: it was closed, or the agent restarted.",
        "tab.failed" to "Could not open: {why}",
        "tab.retry" to "Retry",
        "menu.paste" to "Paste",
        "menu.copy" to "Copy the screen",
        "menu.copied" to "Screen copied",
        "menu.title" to "Console",
        "link.connecting" to "Connecting…",
        "link.offline" to "Offline. Retrying…",
        "boot.noIdentityApp" to "Your Dotrino profile lives in the «Dotrino Identity» app. Install it and come back here.",
        "boot.noProfile" to "This phone has no Dotrino profile yet. Create it right here, or adopt one you already have.",
        "boot.noVault" to "This profile is not connected to a vault. Connect it to see your machines.",
        "boot.connectVault" to "Connect my vault",
        "boot.create" to "Create profile", "boot.adopt" to "Adopt a profile", "boot.retry" to "Retry",
        "key.ctrl" to "Ctrl", "key.alt" to "Alt",
    )

    fun t(key: String, vararg vars: Pair<String, Any>): String {
        var s = (if (lang == "en") en else es)[key] ?: throw IllegalStateException("missing i18n key: $key ($lang)")
        for ((k, v) in vars) s = s.replace("{$k}", v.toString())
        return s
    }

    /** Both languages say the same things: a key in one and not in the other is a text nobody translated. */
    fun missing(): Set<String> = (es.keys - en.keys) + (en.keys - es.keys)
}

fun t(key: String, vararg vars: Pair<String, Any>) = I18n.t(key, *vars)
