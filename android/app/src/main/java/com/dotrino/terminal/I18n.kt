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
        "tab.close" to "Cerrar la pestaña (la consola sigue en la máquina)",
        "panel.open" to "Abrir el panel", "panel.close" to "Colapsar el panel", "panel.title" to "Consolas",
        "console.new" to "Nueva consola", "console.kill" to "Cerrar consola", "console.move" to "Mover la consola", "console.openHere" to "Abrir aquí", "console.n" to "Consola {n}",
        "where.free" to "suelta", "where.here" to "en esta pantalla", "where.other" to "abierta en otro aparato", "where.local" to "ventana abierta en la máquina",
        "size.label" to "tamaño", "size.here" to "esta pantalla", "size.window" to "una ventana de la máquina", "size.device" to "otro aparato",
        "size.row" to "Tamaño de la {n}: {who} ({cols}×{rows})",
        "size.use" to "Usar el tamaño de esta pantalla en la consola {n}",
        "size.usedNow" to "Consola {n}: usa el tamaño de esta pantalla ({cols}×{rows}). Las demás la ven a ese tamaño.",
        "tab.new" to "Otra consola",
        "tab.connecting" to "Conectando…",
        "tab.checking" to "Comprobando la conexión…",
        "compose.hint" to "Escribe aquí y pulsa Enter", "compose.send" to "Enviar", "compose.toggle" to "Escribir aquí y enviar de una vez",
        "tab.lost" to "Se perdió la conexión. Volviendo…",
        "tab.exited" to "La consola terminó.",
        "tab.gone" to "Esta consola ya no existe en la máquina: se cerró, o el agente se reinició.",
        "tab.goneNew" to "La consola que tenías ya no existe en la máquina. Esta es una nueva.",
        "act.busy" to "trabajando", "act.done" to "terminó",
        "about.show" to "De qué va esta consola", "about.hide" to "Plegar", "about.untitled" to "Sin título",
        "about.empty" to "Sin notas.", "about.edit" to "Editar", "about.add" to "Agregar nota", "about.save" to "Guardar",
        "about.hint" to "Tus notas sobre esta consola…", "about.taskDel" to "Quitar la tarea", "about.notes" to "Notas de la consola {n}",
        "about.old" to "Esta máquina aún no guarda notas: actualiza su terminal.",
        "tab.failed" to "No se pudo abrir: {why}",
        "tab.retry" to "Reintentar",
        "code.note" to "Esta máquina pide su clave. Toca para escribirla.",
        "code.title" to "{name} pide su clave",
        "code.lead" to "La pusiste en esa máquina con «dotrino-terminal lock». Se recuerda mientras la app siga abierta.",
        "code.label" to "Clave de la máquina", "code.ok" to "Entrar",
        "code.wrong" to "Esa no es la clave.",
        "code.wait" to "Demasiados intentos. Espera {min} min y vuelve a probar.",
        "link.connecting" to "Conectando…",
        "link.offline" to "Sin conexión. Reintentando…",
        "boot.noIdentityApp" to "Tu perfil de Dotrino vive en la app «Identidad Dotrino». Instálala y vuelve aquí.",
        "boot.noProfile" to "Este teléfono todavía no tiene un perfil de Dotrino. Créalo aquí mismo o adopta uno que ya tengas.",
        "boot.noVault" to "Este perfil no está conectado a una bóveda. Conéctalo para ver tus máquinas.",
        "boot.connectVault" to "Conectar mi bóveda",
        "boot.create" to "Crear perfil", "boot.adopt" to "Adoptar un perfil", "boot.retry" to "Reintentar",
        "key.shift" to "Shift", "key.ctrl" to "Ctrl", "key.alt" to "Alt",
        "key.copy" to "Copiar", "key.paste" to "Pegar", "key.copied" to "Copiado",
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
        "tab.close" to "Close the tab (the console stays on the machine)",
        "panel.open" to "Open the panel", "panel.close" to "Collapse the panel", "panel.title" to "Consoles",
        "console.new" to "New console", "console.kill" to "Close console", "console.move" to "Move the console", "console.openHere" to "Open here", "console.n" to "Console {n}",
        "where.free" to "detached", "where.here" to "on this screen", "where.other" to "open on another device", "where.local" to "window open on the machine",
        "size.label" to "size", "size.here" to "this screen", "size.window" to "a window on the machine", "size.device" to "another device",
        "size.row" to "Size of {n}: {who} ({cols}×{rows})",
        "size.use" to "Use this screen's size for console {n}",
        "size.usedNow" to "Console {n}: uses this screen's size ({cols}×{rows}). Other screens show it at that size.",
        "tab.new" to "Another console",
        "tab.connecting" to "Connecting…",
        "tab.checking" to "Checking the connection…",
        "compose.hint" to "Type here and press Enter", "compose.send" to "Send", "compose.toggle" to "Type here and send at once",
        "tab.lost" to "Connection lost. Coming back…",
        "tab.exited" to "The console ended.",
        "tab.gone" to "This console no longer exists on the machine: it was closed, or the agent restarted.",
        "tab.goneNew" to "The console you had no longer exists on the machine. This is a new one.",
        "act.busy" to "working", "act.done" to "finished",
        "about.show" to "What this console is about", "about.hide" to "Fold", "about.untitled" to "Untitled",
        "about.empty" to "No notes.", "about.edit" to "Edit", "about.add" to "Add a note", "about.save" to "Save",
        "about.hint" to "Your notes about this console…", "about.taskDel" to "Remove the task", "about.notes" to "Notes of console {n}",
        "about.old" to "This machine does not keep notes yet: update its terminal.",
        "tab.failed" to "Could not open: {why}",
        "tab.retry" to "Retry",
        "code.note" to "This machine asks for its code. Tap to type it.",
        "code.title" to "{name} asks for its code",
        "code.lead" to "You set it on that machine with \"dotrino-terminal lock\". It is remembered while the app stays open.",
        "code.label" to "Machine code", "code.ok" to "Enter",
        "code.wrong" to "That is not the code.",
        "code.wait" to "Too many tries. Wait {min} min and try again.",
        "link.connecting" to "Connecting…",
        "link.offline" to "Offline. Retrying…",
        "boot.noIdentityApp" to "Your Dotrino profile lives in the «Dotrino Identity» app. Install it and come back here.",
        "boot.noProfile" to "This phone has no Dotrino profile yet. Create it right here, or adopt one you already have.",
        "boot.noVault" to "This profile is not connected to a vault. Connect it to see your machines.",
        "boot.connectVault" to "Connect my vault",
        "boot.create" to "Create profile", "boot.adopt" to "Adopt a profile", "boot.retry" to "Retry",
        "key.shift" to "Shift", "key.ctrl" to "Ctrl", "key.alt" to "Alt",
        "key.copy" to "Copy", "key.paste" to "Paste", "key.copied" to "Copied",
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
