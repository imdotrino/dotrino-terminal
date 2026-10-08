# Dotrino Terminal

> **Parte del ecosistema [Dotrino](https://dotrino.com).**

Una terminal para Linux y macOS cuyas ventanas también se abren desde el navegador de otro
aparato de tu cuenta, y una shell real (`bash`, `zsh`…) de tus máquinas en ese navegador. Solo entran los aparatos que tu **acta**
reconoce con permiso `sign`, y todo viaja cifrado de punta a punta por el proxio.
No hay puertos abiertos ni contraseñas.

**Cómo se usa:** en el wiki, [la app de escritorio](https://wiki.dotrino.com/herramientas/terminal-escritorio/)
y [el acceso desde el navegador](https://wiki.dotrino.com/herramientas/terminal/).

```
 ventanas de la máquina                    ┌──────────────────────────┐
 (dotrino-terminal, app de escritorio) ──► │ socket local (0700)      │
                                           │                          │
 navegador (aparato de la cuenta)          máquina (agente)
 ┌──────────────────────────┐             ┌──────────────────────────┐
 │ terminal.dotrino.com      │             │ @dotrino/terminal-agent   │
 │ RemoteAgentClient + xterm │             │ startRemoteAgent + PTY    │
 └────────────┬─────────────┘             └────────────┬─────────────┘
              └──── proxy.dotrino.com · sesión cifrada ─┘
        las dos puntas se juzgan contra el ACTA de la cuenta
```

## Qué reusa

Todo lo común —enrolarse con la bóveda, el saludo contra el acta, el canal cifrado por
sesión, la revocación, la renovación del papel y la bitácora— es
[`@dotrino/remote-agent`](https://github.com/imdotrino/dotrino-remote-agent). Este repo
solo añade la shell:

Las shells son **consolas** que viven en el agente, aparte de las conexiones
(`agent/consoles.js`): cerrar o recargar el navegador solo las suelta, y cualquier aparato
de la cuenta puede volver a ellas y ver la pantalla como estaba (una terminal sin pantalla,
`@xterm/headless`, la reconstruye; todo en memoria). La × de la pestaña tampoco la cierra
(la suelta); una consola se cierra desde el panel o saliendo de su shell: desde
ese momento ya no existe para nadie (no se lista, no se puede volver a ella y su
número queda libre), y si la shell no se va con el SIGHUP se insiste con SIGTERM y SIGKILL
(agente ≥ 0.27.0). Si otra pantalla cierra la consola que una pestaña mira, la pestaña pasa a
otra consola que ya exista (una nueva solo si no queda ninguna). Si el agente se reinicia, se
pierden.

El mismo protocolo sirve a las dos puntas: las ventanas locales (JSON por líneas en
`~/.dotrino/agent/terminal-agent/<perfil>/terminal.sock`) y los aparatos remotos (dentro de la
sesión cifrada).

| Sentido | Payload |
|---|---|
| cliente → máquina | `list` · `open {cols,rows,cwd?,tag?}` · `attach {id,cols,rows}` · `detach` · `input {data}` · `resize {cols,rows}` · `close` (mata la enganchada) · `kill {id}` · `move {id,before?}` (el orden del panel, agente ≥ 0.26.0) |
| máquina → cliente | `consoles {list}` · `replay {id,data,last}` · `attached {id,fresh,console}` · `out {data}` · `meta {console}` · `exit {code}` · `fail {code,message}` |

Cada consola dice su `origin` (`local`/`remote`), su `title` (el de la shell) y `watchers`
(quién la mira: ventana local o aparato, con su llave, y la `tag` con la que se presentó; la app
de escritorio la usa para saber qué consola muestra cada ventana). Con varios mirando, el tamaño lo pone
el último que se enganchó o tecleó (lo que la terminal contesta sola —foco, cursor, ratón— no cuenta); teclear
gana también a una pantalla que lo tenía fijado con ⤢, que deja de estarlo. Cerrar una ventana local NUNCA
cierra una consola, tampoco la que esa ventana abrió (agente ≥ 0.31.0): al irse la sesión, la consola se suelta.

La PWA recuerda sus pestañas en `sessionStorage` y al recargar se vuelve a enganchar.

Las máquinas se encuentran preguntándoles qué son (`probeAgents`): salen las que contestan `kind: terminal-agent`, con el nombre que les puso el dueño en el acta.

## Estructura

- **`index.html` + `src/`** — la PWA (Vite), `terminal.dotrino.com`. Una sola página con dos
  rutas (§5.1: informativa o administrativa, nunca las dos):
  - `/` — la portada: qué es, descargar la app, «Cómo instalar» al wiki. No toca la bóveda.
  - `/consoles` — las consolas: tus máquinas y sus pestañas. La PWA instalada abre aquí
    (`start_url`). Pages no sabe de rutas, así que `vite.config.js` copia `index.html` a
    `dist/consoles/` y a `dist/404.html`.
- **`agent/`** — el paquete `@dotrino/terminal-agent` (Node + PTY prebuilt): el agente
  (`dotrino-terminal-agent`) y el cliente de las ventanas (`dotrino-terminal`).
- **`android/`** — la versión NATIVA de Android (`com.dotrino.terminal`, CONVENCIONES §16): las
  máquinas encendidas, sus consolas (retomar o nueva), pestañas y una fila con las teclas que
  el teclado del teléfono no tiene. Vistas nativas, sin WebView. El emulador de terminal es
  propio (`term/Terminal.kt`, Kotlin puro con sus pruebas: el de Termux es GPLv3) y lo dibuja
  `term/TerminalView.kt` en un Canvas. El perfil, la conexión y el agente remoto vienen de
  `dotrino-native` (submódulo `native/`, `RemoteAgent`). `./gradlew :app:testDebugUnitTest`;
  `DemoActivity` (solo depuración) enseña la terminal sin perfil ni red.
- **`desktop/`** — la app de escritorio (Rust: `iced` + `iced_term` sobre
  `alacritty_terminal`). Por defecto una ventana **usa un perfil** y corre
  `dotrino-terminal --name <perfil>` (el último elegido, `~/.config/dotrino-terminal/last-profile`;
  si no, `default`; si no, el primero enlazado; si no, el primero que exista). **Sin perfil** es
  el repliegue cuando no hay ninguno o falta el cliente, y el título lo dice: la shell del
  usuario directa, sin agente. «Perfil → Instalar/Actualizar dotrino-terminal…» ESCRIBE
  `npm install -g @dotrino/terminal-agent@latest` en la consola de la ventana, sin Enter (el
  `.deb` no lo trae: la instalación la dispara la persona, a la vista, §15); si faltaba el
  cliente, la app lo busca cada 3 s y activa los perfiles al aparecer.
  «Perfil → Usar en / Quitar de la terminal de VS Code» corre `dotrino-terminal vscode --name <perfil>`
  o `vscode --off` como «Actualizar»: en la ventana, en otra TTY, y al acabar vuelve a su consola (cliente ≥ 0.20.0).
  **Cerrar una ventana nunca cierra una consola** (≥ 0.2.28): la suelta (Ctrl+] d) y se va, también
  la última; se cierra con la × del panel, «Cerrar consola» o `exit`. En el panel (plegado y abierto),
  un **punto verde** en la esquina superior derecha de una consola dice que está abierta en una
  ventana de ESTA máquina (`watchers` con `origin: 'local'`: esta ventana, otra, la terminal de
  VS Code); lo remoto no cuenta. El punto parpadea si la consola terminó sin atender (`doneAt`) y
  deja de hacerlo cuando su ventana tiene el foco (`App::seen`, solo de la app: el borde verde de
  «terminó» es estado del agente y lo ven también la web y el teléfono, así que el foco no lo toca).
  Como emulador de terminal: `--working-directory <dir>` (o abre donde la lanzan, que es lo que
  hace `exo-open` desde Thunar), `-x prog args…`, `-e "orden"`, `--name <perfil>`. El `.deb`
  instala `usr/share/xfce4/helpers/dotrino-terminal.desktop`, para elegirla en «Aplicaciones
  preferidas». La carpeta viaja al agente en `open {cwd}` (agente ≥ 0.7.0); una que no existe
  se rechaza (`bad-cwd`), no se abre en otra. El menú Perfil cambia de perfil (cierra la TTY y abre
  otra) o enrola uno nuevo dentro de la ventana. El **panel de consolas** (a la izquierda) lista
  las del perfil leyendo el socket del agente cada 1,5 s, y cambia de consola sin reiniciar nada:
  le manda al cliente de la ventana `Ctrl+] a<id>⏎` o `Ctrl+] n`. `vendor/iced_term`
  es el crate con un método público más (ver su README).

## Desarrollo

```sh
npm install && npm run dev          # la PWA
npm test && npm run type-check

cd agent && npm install && npm test # el agente (prueba el PTY de verdad)
node bin/cli.js                     # enlaza (pide la invitación de `dotrino-vault pair`) y corre
```

La prueba de punta a punta (bóveda como binario, agente y otro aparato en cajas
separadas, shell por el proxio) está en `dotrino-test`: `npm run smoke:dispositivos`.

```sh
cd desktop && cargo run                  # la app de escritorio (DOTRINO_TERMINAL_BIN=../agent/bin/terminal.js)
```

## Publicar

Desde CI, nunca a mano:
- **agente**: commit → tag `agent-vX.Y.Z` → `release.yml` publica `@dotrino/terminal-agent`
  con procedencia y SBOM.
- **escritorio**: tag `desktop-vX.Y.Z` → `desktop.yml` sube `.deb`, `.tar.gz` (Linux x64) y
  `.zip` (macOS universal: Apple Silicon e Intel), atestiguados. El `.app` de macOS no va firmado por Apple todavía.

MIT.
