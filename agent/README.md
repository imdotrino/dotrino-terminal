# @dotrino/terminal-agent

Agente de [Dotrino Terminal](https://terminal.dotrino.com): abre una shell (PTY) en
esta máquina solo para los aparatos de tu cuenta. Lo común (enrolamiento, saludo contra
el acta, canal cifrado, revocación, renovación) es
[`@dotrino/remote-agent`](https://www.npmjs.com/package/@dotrino/remote-agent); esto
añade el PTY.

**Cómo se instala y se usa:** [wiki.dotrino.com/herramientas/terminal](https://wiki.dotrino.com/herramientas/terminal/).

```sh
npx @dotrino/terminal-agent          # enlaza (si falta) y corre
npx @dotrino/terminal-agent enroll   # re-enlaza y corre
#   [--proxy wss://…] [--shell /bin/zsh] [--dir /ruta]
```

Enlazar pide una terminal interactiva: se pega la invitación de `dotrino-vault pair` y
se aprueba con `dotrino-vault approve <código>`. Después puede correr como servicio
(systemd, pm2). Una vez al día avisa si hay versión nueva; no se actualiza solo.

Como librería:

```js
import { startAgent } from '@dotrino/terminal-agent'
const agent = await startAgent({ /* dir, proxyUrl, shell, quiet, onRevoked */ })
// agent.machine · agent.machineId · agent.close()
```

Datos en `~/.local/share/dotrino-terminal-agent` (override `DOTRINO_TERMINAL_DIR`). El
`link.json` guarda la llave privada de la máquina: trátalo como una llave SSH.

MIT.
