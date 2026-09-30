# Dotrino Terminal

> **Parte del ecosistema [Dotrino](https://dotrino.com).**

Una terminal para Linux y macOS cuyas ventanas también se abren desde el navegador de otro
aparato de tu cuenta, y una shell real (`bash`, `zsh`…) de tus máquinas en ese navegador. Solo entran los aparatos que tu **acta**
reconoce con permiso `sign`, y todo viaja cifrado de punta a punta por el proxio.
No hay puertos abiertos ni contraseñas.

**Cómo se usa:** [wiki.dotrino.com/herramientas/terminal](https://wiki.dotrino.com/herramientas/terminal/).

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
`@xterm/headless`, la reconstruye; todo en memoria). La × de la pestaña sí la mata. Si el
agente se reinicia, se pierden.

El mismo protocolo sirve a las dos puntas: las ventanas locales (JSON por líneas en
`~/.dotrino/agent/terminal-agent/<perfil>/terminal.sock`) y los aparatos remotos (dentro de la
sesión cifrada).

| Sentido | Payload |
|---|---|
| cliente → máquina | `list` · `open {cols,rows}` · `attach {id,cols,rows}` · `detach` · `input {data}` · `resize {cols,rows}` · `close` (mata la enganchada) · `kill {id}` |
| máquina → cliente | `consoles {list}` · `replay {id,data,last}` · `attached {id,fresh,console}` · `out {data}` · `meta {console}` · `exit {code}` · `fail {code,message}` |

Cada consola dice su `origin` (`local`/`remote`), su `title` (el de la shell) y `watchers`
(quién la mira: ventana local o aparato, con su llave). Con varios mirando, el tamaño lo pone
el último que se enganchó o escribió. Una ventana local que abrió su consola la mata al
cerrarse; una que solo se enganchó, no.

La PWA recuerda sus pestañas en `sessionStorage` y al recargar se vuelve a enganchar.

Las máquinas se encuentran preguntándoles qué son (`probeAgents`): salen las que contestan `kind: terminal-agent`, con el nombre que les puso el dueño en el acta.

## Estructura

- **`index.html` + `src/`** — la PWA (Vite), `terminal.dotrino.com`.
- **`agent/`** — el paquete `@dotrino/terminal-agent` (Node + PTY prebuilt): el agente
  (`dotrino-terminal-agent`) y el cliente de las ventanas (`dotrino-terminal`).
- **`desktop/`** — la app de escritorio (Rust: `iced` + `iced_term` sobre
  `alacritty_terminal`). Cada ventana corre `dotrino-terminal`; el menú Perfil cambia de
  perfil (cierra la TTY y abre otra) o enrola uno nuevo dentro de la ventana. `vendor/iced_term`
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
  `.zip` (macOS arm64), atestiguados. El `.app` de macOS no va firmado por Apple todavía.

MIT.
