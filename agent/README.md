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
npx @dotrino/terminal-agent update           # cómo se actualiza: [--approval on|off] [--notify on|off]
#   [--proxy wss://…] [--shell /bin/zsh] [--dir /ruta]
```

### Se actualiza solo

Instalado con `npm install -g` en un prefijo del usuario (nvm o similar), el agente mira una
vez al día si hay versión nueva, comprueba que el paquete de npm cuadra con lo que midió su
release de GitHub (`npm-integrity.json`) y la instala (`@dotrino/update/npm`, CONVENCIONES §15).
Corrido con `npx`, desde un checkout o en un prefijo de root no se toca: lo dice y, si hace
falta root, avisa a quien aprueba en tu cuenta.

- **Dos ajustes, de cada agente** (`update --approval on|off`, `update --notify on|off`): pedir
  antes aprobación a tu bóveda (apagado) y avisar de que se actualizó (encendido).
- **Reiniciar cierra las consolas**, así que la versión nueva se instala al salir pero el
  agente solo se reinicia cuando no queda ninguna consola abierta, y solo si hay quien lo
  levante (systemd, pm2).
- `info` dice si hay una versión que se pidió y no se aprobó, o que necesita permisos de
  administrador.

Las ventanas de esta máquina:

```sh
dotrino-terminal                         # abre una consola nueva en esta TTY (levanta el agente si hace falta)
dotrino-terminal --name casa             # en el agente del perfil «casa»
dotrino-terminal ls                      # las consolas abiertas: id, origen, título, quién mira
dotrino-terminal attach <id>             # retomar una
dotrino-terminal kill <id>
dotrino-terminal machines [--json]       # las OTRAS máquinas de la cuenta que están encendidas, y sus consolas
dotrino-terminal --machine <id|nombre>   # abrir / attach / ls / kill, pero en otra máquina (≥ 0.38)
dotrino-terminal profiles [--json]       # los perfiles (agentes con nombre) de esta máquina
dotrino-terminal link [--name <n>]       # enlazar un perfil con tu bóveda
dotrino-terminal rename <perfil> [nuevo] # renombrarlo (mueve su carpeta y para su agente; mismo aparato)
dotrino-terminal vscode [--name <n>]     # la terminal embebida de VS Code abre consolas de aquí (--off lo deshace)
dotrino-terminal claude                  # Claude Code mantiene la tarjeta de su consola: skill + hooks en ~/.claude (--off lo deshace, --status lo dice)
dotrino-terminal desktop update [--check] # actualiza la app de escritorio: baja, verifica la firma e instala
dotrino-terminal agents [--json]          # con qué versión corre el agente de cada perfil
dotrino-terminal network [--name <n>]     # el uso de red del agente: por dónde va cada conexión (directo, TURN o el proxio) y cuánto pasó
dotrino-terminal restart [--name <n>]     # para el agente para que arranque con la versión instalada (cierra sus consolas; --stale: solo los atrasados)
dotrino-terminal service install|uninstall|status [--name <n>]  # el agente como servicio del usuario
```

Cerrar la ventana no cierra la consola: sigue viva en el agente y se retoma después (se cierra
saliendo de su shell o desde el panel); **Ctrl+] y luego d** la suelta sin cerrar la ventana, **Ctrl+] n** abre otra (soltando la actual) y **Ctrl+] a<id> Enter** pasa a otra consola,
por la misma conexión, y **Ctrl+] r** ajusta la consola al tamaño de esta ventana (la app de
escritorio lo manda al ganar el foco). `--tag <t>` presenta la ventana en la lista de quién mira. Si un aparato remoto entra en una ventana local, esa ventana suena y lo dice en el
título. Sin enlace el agente atiende solo a las ventanas locales; al enlazarlo
(`dotrino-terminal link`) enciende la parte remota sin reiniciarse. La app de escritorio
(`desktop/` del repo) es una ventana nativa que corre este mismo cliente.

**Las consolas de las otras máquinas** (`far.js`, ≥ 0.38). El agente de esta máquina hace de
CLIENTE de los otros agentes de la cuenta, con su propio enlace (`clientLink` de
`@dotrino/remote-agent`): es un aparato del acta y entra con lo que el acta le reconozca
(`sign`) y con la clave de la otra máquina si la tiene. Por el socket local se suman tres
mensajes: `{ type:'machines' }` (qué máquinas hay y sus consolas; contesta de memoria y
refresca por detrás), `{ type:'via', machine }` como PRIMER mensaje (la conexión pasa a hablar
con esa máquina, con el mismo protocolo) y `{ type:'far', machine, msg }` (una orden suelta).
La clave de una máquina se recuerda solo en memoria, cuando una ventana la escribió bien.
Solo esta máquina necesita la 0.38: las otras atienden como a cualquier aparato.

`dotrino-terminal vscode` escribe el perfil de terminal «Dotrino» en el `settings.json` de VS Code,
VS Code Insiders, VSCodium y Cursor (los que haya, Linux, macOS y Windows) y lo deja por defecto; conserva
los comentarios y el resto del archivo (`editors.js`, con `jsonc-parser`). El perfil apunta a Node
y al script por su ruta, porque un editor lanzado desde el escritorio no hereda el PATH de la shell:
al cambiar de Node se vuelve a correr. En esa terminal (`TERM_PROGRAM=vscode`, sin `--tag`) cerrar
la pestaña CIERRA la consola: el editor no tiene panel de consolas, y soltarla dejaba una consola
que nadie mira por cada pestaña cerrada. En cualquier otra ventana se suelta y sigue viva.

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

## La nota de una consola (de qué va)

Cada consola lleva una nota de texto libre: la tarea en curso, lo que falta. Sale en una tarjeta
flotante sobre la consola (junto con su título) y, su primera línea, en la lista de consolas. La
edita la persona desde la tarjeta, o el programa que corre dentro:

```bash
dotrino-terminal note                 # la enseña
dotrino-terminal note "texto"         # la reemplaza («-» la lee de la entrada estándar)
dotrino-terminal note --add "línea"   # le añade una línea
dotrino-terminal note --clear         # la borra
dotrino-terminal note --task "tarea"  # la TAREA en curso, que va aparte de la nota
dotrino-terminal note --title "título" # el TÍTULO de la consola, en vez del de la shell (solo o con --task)
```

Son dos campos: la **nota** es de la persona (la edita desde la tarjeta) y la **tarea** es del
programa que corre dentro (`--task`). En la tarjeta la tarea se ve y se quita, no se edita; y
`--task` no puede tocar la nota.

Sin `--id`, es la consola en la que corre la orden: el agente pone su id en
`DOTRINO_TERMINAL_CONSOLE`. Vive en memoria, como la consola: se va con ella. Hasta 4000 caracteres.

Para que un agente de IA la mantenga al día, el paquete trae un skill de Claude Code
(`skills/dotrino-terminal-note/`) y tres hooks (`skills/hooks/`): uno recuerda la tarjeta en cada
mensaje, otro apunta qué herramientas se usan y el tercero no deja terminar un turno con la tarjeta
vieja. `dotrino-terminal claude` los pone en `~/.claude` y los engancha en su `settings.json` sin
tocar lo demás (`claude.js`); `--off` quita exactamente eso. Fuera de una consola no hacen nada.

## Imágenes desde otro aparato

Desde el teléfono o el navegador se puede adjuntar una imagen a la consola: viaja por la sesión
(cifrada, en trozos con acuse), el agente la guarda en `uploads/` dentro de la carpeta del perfil
y contesta la ruta, que es lo que el aparato escribe en la consola. Así se le enseña una foto o
una captura a lo que corre dentro.

- Solo PNG, JPEG, GIF y WebP, y qué es lo dicen los primeros bytes del archivo, no quien lo manda.
- El nombre lo pone el agente (`img-<fecha>-<hora>-<azar>.<ext>`); la carpeta es solo del usuario.
- Tope de 12 MB por imagen (el aparato la reduce antes de mandarla). Se borran solas a los 7 días.

Protocolo: `{ type:'file', up, seq, data, last? }` → `{ type:'filed', up, seq, path? }` (`uploads.js`).

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
- A los **tres fallos seguidos** toca esperar, cada vez más (freno local de este agente). Y si un
  mismo aparato falla tres veces seguidas, el agente **reporta el incidente a la bóveda**
  (`reportIncident` de `@dotrino/remote-agent` ≥ 0.16.0): los aparatos que aprueban lo ven y
  eligen bloquear o ignorar. Bloqueado, no entra en ningún agente ni en la bóveda hasta
  `dotrino-vault unblock <ID>`.
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

## Como servicio (arrancar al encender)

`dotrino-terminal service install [--name <n>]` escribe una unidad de systemd **del usuario**
(`~/.config/systemd/user/dotrino-terminal-agent-<perfil>.service`, `Restart=always`, con el `PATH`
de quien instala) y pide `loginctl enable-linger` para que arranque sin sesión; en macOS, un
LaunchAgent (`~/Library/LaunchAgents/com.dotrino.terminal-agent.<perfil>.plist`); en Windows, el valor
`DotrinoTerminalAgent-<perfil>` en `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, que al iniciar
sesión corre `dotrino-terminal-agent supervise`: se vuelve a lanzar sin ventana y levanta el agente cada
vez que sale (`supervisor.pid` en la carpeta del perfil). Ni el Programador de tareas ni un servicio de
Windows: los dos piden derechos que una cuenta normal no tiene. Es de usuario
para que el agente se siga actualizando solo (§15): con quien lo levante ya puede reiniciarse.
Un agente que ya corre por su cuenta no se para (cerraría sus consolas): el servicio queda
habilitado, y `dotrino-terminal`, cuando no encuentra agente, arranca el servicio en vez de
levantar uno propio. Código en `service.js`; probado con systemd en un contenedor de Fedora,
Windows de punta a punta en el runner `windows-latest` (`test/windows.test.mjs`), macOS solo con
pruebas unitarias.

## Windows

El agente corre en Windows (≥ 0.47.0) y abre **PowerShell** (`powershell.exe`; otra con `--shell`).
Las ventanas locales no van por un socket Unix sino por una **tubería con nombre**: su nombre es
aleatorio y, junto con una llave, queda en `terminal.pipe` dentro de la carpeta del perfil. La ventana
manda la llave en su primera línea (`{ type:'local-auth', key }`) y sin ella el agente corta sin
contestar: la lista de tuberías la ve cualquier usuario de la máquina, la carpeta del perfil no.
La app de escritorio (`desktop/`) todavía no tiene versión para Windows.
