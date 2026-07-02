# @dotrino/terminal-agent

Agente de **Dotrino Terminal**: abre una shell real (PTY) **solo** para
dispositivos enlazados al mismo vault. Contraparte de la PWA
`terminal.dotrino.com`.

Puede correr en **cualquier máquina** (un servidor, un contenedor, otra PC): se
enrola con el vault como un dispositivo más, así que **no necesita la maestra** —
solo su propia sub-clave `D` + `cert` y la pública maestra pineada.

- **Autorización = el vault**: cliente y agente son peers certificados por el mismo
  vault; cada uno verifica que el `cert` del otro encadena a la maestra
  (`@dotrino/identity` `verifyChain`). Revocable desde el vault (el agente refresca
  la lista con `vault.devices` por el proxy).
- **Transporte = el proxy** (`@dotrino/proxy-client`): el agente se identifica bajo
  SU pubkey; el cliente lo direcciona por ella.
- **Cifrado E2E**: ECDH → AES-GCM por sesión; el proxy solo ve texto cifrado.

## Requisitos

- Que el vault esté accesible **al enrolar** (para el pairing). Después, las
  sesiones no necesitan el vault online (la confianza está pineada a la pública
  maestra; el TTL del cert acota el riesgo si no puede refrescar revocaciones).
- Toolchain de C++ para compilar `node-pty` (`build-essential`, `python3`).

## Uso

```sh
npm install
dotrino-terminal-agent enroll          # enlazar esta máquina (una vez)
dotrino-terminal-agent                 # correr; imprime su "dirección de máquina"
#   [--proxy wss://…] [--shell /bin/zsh] [--dir /ruta]
```

Como librería:

```js
import { startAgent } from '@dotrino/terminal-agent'
const agent = await startAgent({ /* dir, proxyUrl, shell, quiet */ })
// agent.machine    → pubkey de esta máquina (la "dirección")
// agent.machineId  → id corto legible
// agent.close()
```

Datos en `~/.local/share/dotrino-terminal-agent` (override `DOTRINO_TERMINAL_DIR`).
MIT.
