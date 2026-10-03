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
        "machines.open" to "Consolas abiertas: {n}",
        "machine.connecting" to "Conectando a {name}…",
        "machine.failed" to "No se pudo conectar: {why}",
        "resume.title" to "Esta máquina tiene consolas abiertas",
        "resume.new" to "Nueva consola",
        "resume.item" to "Consola {n}",
        "resume.local" to "ventana abierta en la máquina",
        "resume.inUse" to "en uso",
        "resume.ago" to "activa {when}",
        "ago.now" to "ahora", "ago.min" to "hace {n} min", "ago.h" to "hace {n} h",
        "tab.close" to "Cerrar esta consola",
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
        "machines.open" to "Open consoles: {n}",
        "machine.connecting" to "Connecting to {name}…",
        "machine.failed" to "Could not connect: {why}",
        "resume.title" to "This machine has open consoles",
        "resume.new" to "New console",
        "resume.item" to "Console {n}",
        "resume.local" to "window open on the machine",
        "resume.inUse" to "in use",
        "resume.ago" to "active {when}",
        "ago.now" to "now", "ago.min" to "{n} min ago", "ago.h" to "{n} h ago",
        "tab.close" to "Close this console",
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
