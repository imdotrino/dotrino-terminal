# @dotrino/terminal-agent

Agente de [Dotrino Terminal](https://terminal.dotrino.com) y el cliente de sus ventanas. El
agente tiene las shells (PTY) de esta máquina; las abren las **ventanas locales**
(`dotrino-terminal`, por un socket) y los **aparatos de tu cuenta** (por el proxio,
cifrado). Una ventana abierta aquí se puede retomar desde el teléfono, y al revés. Lo común (enrolamiento, saludo contra
el acta, canal cifrado, revocación, renovación) es
[`@dotrino/remote-agent`](https://www.npmjs.com/package/@dotrino/remote-agent); esto
añade el PTY.

**Cómo se instala y se usa:** [las ventanas y la app de escritorio](https://wiki.dotrino.com/herramientas/terminal-escritorio/) · [el acceso desde el navegador](https://wiki.dotrino.com/herramientas/terminal/).

```sh
npx @dotrino/terminal-agent                  # enlaza (si falta) y corre
npx @dotrino/terminal-agent enroll           # re-enlaza y corre
npx @dotrino/terminal-agent --name casa      # otro agente en la misma máquina, con su enlace
npx @dotrino/terminal-agent list             # los enlazados aquí
npx @dotrino/terminal-agent info             # qué aparato es: su ID, su bóveda, sus permisos
#   [--proxy wss://…] [--shell /bin/zsh] [--dir /ruta]
```

Las ventanas de esta máquina:

```sh
dotrino-terminal                         # abre una consola nueva en esta TTY (levanta el agente si hace falta)
dotrino-terminal --name casa             # en el agente del perfil «casa»
dotrino-terminal ls                      # las consolas abiertas: id, origen, título, quién mira
dotrino-terminal attach <id>             # retomar una
dotrino-terminal kill <id>
dotrino-terminal profiles [--json]       # los perfiles (agentes con nombre) de esta máquina
dotrino-terminal link [--name <n>]       # enlazar un perfil con tu bóveda
dotrino-terminal rename <perfil> [nuevo] # renombrarlo (mueve su carpeta y para su agente; mismo aparato)
```

Cerrar la ventana cierra su consola, como cualquier terminal; **Ctrl+] y luego d** la suelta
viva, **Ctrl+] n** abre otra (soltando la actual) y **Ctrl+] a<id> Enter** pasa a otra consola,
por la misma conexión, y **Ctrl+] r** ajusta la consola al tamaño de esta ventana (la app de
escritorio lo manda al ganar el foco). `--tag <t>` presenta la ventana en la lista de quién mira. Si un aparato remoto entra en una ventana local, esa ventana suena y lo dice en el
título. Sin enlace el agente atiende solo a las ventanas locales; al enlazarlo
(`dotrino-terminal link`) enciende la parte remota sin reiniciarse. La app de escritorio
(`desktop/` del repo) es una ventana nativa que corre este mismo cliente.

Enlazar pide una terminal interactiva: se pega la invitación de `dotrino-vault pair` y
se aprueba con `dotrino-vault approve <código>`. Después puede correr como servicio
(systemd, pm2). Una vez al día avisa si hay versión nueva; no se actualiza solo.

Como librería:

```js
import { startAgent } from '@dotrino/terminal-agent'
const agent = await startAgent({ /* dir, proxyUrl, shell, quiet, onRevoked, onLinked */ })
// agent.socket · agent.remote (null sin enlace) · agent.machineId · agent.consoles · agent.close()
```

Cada agente guarda su enlace en `~/.dotrino/agent/terminal-agent/<nombre>/`, el estándar de
`@dotrino/remote-agent/instances` (como `dotrino-env` en `~/.dotrino/service/`). Sin
`--name` se usa el único que haya, o `default`. `DOTRINO_TERMINAL_DIR` o `--dir` fuerzan una
carpeta concreta. El `link.json` guarda la llave privada: trátalo como una llave SSH.

MIT.

## Clave de la máquina (opcional)

Por defecto, cualquier aparato de tu cuenta con permiso abre consolas en esta máquina. Si
quieres pedir además una clave (un PIN o una contraseña):

```bash
dotrino-terminal lock [--name <perfil>]          # la pone o la cambia (se teclea dos veces, no se ve)
dotrino-terminal lock --off [--name <perfil>]    # la quita
dotrino-terminal lock --status [--name <perfil>] # dice si hay
```

En la app de escritorio: menú **Perfil → Poner o cambiar la clave… / Quitar la clave**.

- Es **del perfil**: todas sus consolas comparten la misma clave.
- La piden **solo los otros aparatos** (web, teléfono). Las ventanas de esta máquina no.
- Vale **al momento**, sin reiniciar el agente: quien ya estaba dentro tiene que escribirla
  en lo siguiente que haga.
- Cada conexión la escribe una vez. La web y las apps la recuerdan solo en memoria.
- Cinco fallos seguidos y hay que esperar (30 s, y el doble cada vez, hasta una hora). El freno
  es de la máquina, no de la conexión.
- En el disco (`access.json`, en la carpeta del perfil) quedan la sal y el resumen scrypt,
  nunca la clave. Viaja dentro de la sesión cifrada: el proxio no la ve.
- Hace falta agente ≥ 0.19.0, y web ≥ 0.8.9 o las apps ≥ 0.8.9 para poder escribirla. Un
  cliente más viejo ve el error `locked` y no entra.
