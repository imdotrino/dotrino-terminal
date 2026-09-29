# Dotrino Terminal

> **Parte del ecosistema [Dotrino](https://dotrino.com).**

Abre una shell real (`bash`, `zsh`, `powershell`…) de una de tus máquinas desde el
navegador de otro aparato de tu cuenta. Solo entran los aparatos que tu **acta**
reconoce con permiso `sign`, y todo viaja cifrado de punta a punta por el proxio.
No hay puertos abiertos ni contraseñas.

**Cómo se usa:** [wiki.dotrino.com/herramientas/terminal](https://wiki.dotrino.com/herramientas/terminal/).

```
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

| Sentido | Payload (dentro de la sesión cifrada) |
|---|---|
| navegador → máquina | `list` · `open {cols,rows}` · `attach {id,cols,rows}` · `detach` · `input {data}` · `resize {cols,rows}` · `close` (mata la enganchada) · `kill {id}` |
| máquina → navegador | `consoles {list}` · `replay {id,data,last}` · `attached {id,fresh}` · `out {data}` · `exit {code}` · `fail {code,message}` |

La PWA recuerda sus pestañas en `sessionStorage` y al recargar se vuelve a enganchar.

Las máquinas se encuentran preguntándoles qué son (`probeAgents`): salen las que contestan `kind: terminal-agent`, con el nombre que les puso el dueño en el acta.

## Estructura

- **`index.html` + `src/`** — la PWA (Vite), `terminal.dotrino.com`.
- **`agent/`** — el paquete `@dotrino/terminal-agent` (Node + PTY prebuilt).

## Desarrollo

```sh
npm install && npm run dev          # la PWA
npm test && npm run type-check

cd agent && npm install && npm test # el agente (prueba el PTY de verdad)
node bin/cli.js                     # enlaza (pide la invitación de `dotrino-vault pair`) y corre
```

La prueba de punta a punta (bóveda como binario, agente y otro aparato en cajas
separadas, shell por el proxio) está en `dotrino-test`: `npm run smoke:dispositivos`.

## Publicar el agente

Desde CI, nunca a mano: commit → tag `agent-vX.Y.Z` → `release.yml` publica
`@dotrino/terminal-agent` con procedencia y SBOM.

MIT.
