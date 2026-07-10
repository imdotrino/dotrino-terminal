# Dotrino Terminal — tu consola, en tu máquina

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Tu información, en tu
> servidor, bajo tus reglas — sin anuncios, sin cookies, sin rastreo.

Abre una **terminal real** (una shell: `bash`, `zsh`, `powershell`…) en **cualquiera
de tus máquinas**, desde el navegador de otro dispositivo. **Solo dispositivos que
enlaces con tu vault** pueden entrar; todo el I/O viaja **cifrado punto a punto**.
No hay cuentas, ni puertos abiertos, ni servidor que vea tus comandos.

Hay **dos modos** de usarlo, ambos sin cuentas ni claves en la nube:

- **Con vault externo** — centralizas tu identidad en un PC (`dotrino-vault`); el
  navegador y cada máquina se enrolan como dispositivos de ese vault.
- **Dispositivo como vault** — sin vault externo: la identidad del **propio
  navegador** certifica tus máquinas directamente. Útil si no quieres mantener un
  vault encendido; el costo es que el navegador debe estar abierto para enrolar y
  para que las máquinas refresquen revocaciones (el cert de 30 días acota el riesgo).

El agente **no necesita correr en la máquina del vault**: se enlaza con el vault
(o con el dispositivo) como un dispositivo más (igual que el navegador), así que
puede vivir en un servidor, un contenedor u otra PC. La maestra nunca sale del
certificador.

```
 navegador (dispositivo enlazado)         máquina destino (agente enrolado)
 ┌───────────────────────────┐            ┌──────────────────────────┐
 │  terminal.dotrino.com      │            │  dotrino-terminal-agent   │
 │  · cert de dispositivo (D) │            │  · su propia D + cert     │
 │  · xterm.js                │            │  · node-pty → shell       │
 └───────────┬───────────────┘            └───────────┬──────────────┘
             │   proxy.dotrino.com  ·  sendByPubkey(pubkey de la máquina)  ·  E2E
             └────────────────────────────────────────┘
      ambas puntas están certificadas por el MISMO vault (cadena D ← maestra)
```

## Por qué es seguro — lo da el vault

- **Autorización = el vault, no una contraseña.** Cliente y agente son dos
  dispositivos enrolados en el mismo vault. Cada mensaje va firmado por la sub-clave
  `D` del emisor, con su `cert` (cadena `D ← maestra`). Cada punta verifica que el
  `cert` del otro encadena a la **misma maestra pineada** (`@dotrino/identity`
  `verifyChain`). Si no está enlazado a ESE vault, o fue revocado, **no abre nada**.
  Ninguna de las dos máquinas tiene la clave maestra.
- **Cifrado punto a punto.** Tras autorizar, las dos puntas levantan un secreto de
  sesión efímero (ECDH P-256 → HKDF → AES-256-GCM). El proxy solo transporta
  **texto cifrado**; las claves efímeras van firmadas por el vault (anti-MITM del
  relay).
- **Revocación real.** `dotrino-vault revoke <deviceId>` corta el acceso de ese
  dispositivo de inmediato (el agente consulta la lista de revocados del vault).

## Pilares del ecosistema que reusa (no reimplementa)

- **`@dotrino/identity`** — clave maestra, sub-claves de dispositivo, `verifyChain`,
  emparejamiento endurecido (SAS).
- **`@dotrino/proxy-client`** — transporte: `sendByPubkey` a la maestra, cola
  offline, el **mismo** proxy que usa el vault (fan-out por pubkey → el daemon y el
  agente conviven).
- PWA estándar: `@dotrino/install`, `@dotrino/nav`, `@dotrino/store`,
  `<dotrino-support>`.

## Uso

### 1) En la máquina destino (agente) — enlazar una vez y correr

No requiere ser la máquina del vault (aunque puede serlo). El **enrolamiento** sí
necesita que el vault esté accesible ese momento.

```sh
cd agent && npm install               # compila node-pty (necesita toolchain C++)

# a) enlazar esta máquina (una vez): pega el QR de `dotrino-vault pair`,
#    compara el código y apruébalo en el vault (`dotrino-vault approve <código>`)
npx dotrino-terminal-agent enroll

# b) correr el agente: imprime la "dirección de máquina" (su pubkey)
npx dotrino-terminal-agent
```

Repetí el enrolamiento en cada máquina a la que quieras conectarte; cada una tiene
su propia dirección. Datos en `~/.local/share/dotrino-terminal-agent`
(override `DOTRINO_TERMINAL_DIR`).

### 2) En el dispositivo enlazado (navegador)

1. Abre **https://terminal.dotrino.com**.
2. La primera vez, **elige el modo**:
   - **Conectar tu bóveda** — en el vault corre `dotrino-vault pair`, copia el
     QR/JSON y pégalo en la app (desde profile.dotrino.com/#vault); compara el
     **código de 6 dígitos** y apruébalo en el vault (`dotrino-vault approve <código>`).
   - **Usar este dispositivo como bóveda** — no necesitas vault: pulsa «Enlazar
     otra máquina», copia el código que se genera y pégalo en el agente (paso 1).
     Cuando la máquina pida acceso, compara el código de 6 dígitos y apruébalo aquí.
3. Pega la **dirección de la máquina** (la que imprime el agente) y pulsa
   **Conectar** → tienes una shell en esa máquina.

## Estructura

- **`src/` + `index.html`** — la PWA (Vite). `terminal.dotrino.com`.
- **`src/selfMaster.js`** — modo «dispositivo como vault»: el navegador actúa de
  certificador (atiende el enrolamiento del agente y firma certificados `D ← P`
  con la propia identidad). Es el mismo protocolo que el vault externo.
- **`agent/`** — el paquete `@dotrino/terminal-agent` (Node + `node-pty`) que corre
  en la máquina destino (se enrola contra el vault **o** contra el dispositivo).
- **`shared/e2e.js`** — el canal cifrado E2E (isomórfico), fuente única compartida
  por la PWA y el agente.

## Privacidad / SEO

Solo se indexa la **cáscara** de la herramienta (metadata). La sesión —tus
comandos, tu shell— nunca llega a un servidor indexable: viaja cifrada por el
proxy. Sin trackers de terceros; analítica solo GoatCounter cookieless en
producción.

MIT.
