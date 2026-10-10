---
name: dotrino-terminal-note
description: Mantiene al día la tarea en curso en la tarjeta «de qué va» de la consola de Dotrino Terminal en la que corres (la ve el dueño flotando sobre la consola, en todas sus pantallas). Úsalo AL EMPEZAR cada tarea, cuando la tarea cambia de rumbo, y al terminar o quedar esperando al usuario, siempre que exista la variable de entorno DOTRINO_TERMINAL_CONSOLE. También cuando el usuario diga «nota de la consola», «el flotante», «la tarjeta» o «de qué va este chat». Orden: `dotrino-terminal note --task`. Las notas personales del dueño NO se tocan.
---

# La tarea en curso de la consola (Dotrino Terminal)

Cada consola de Dotrino Terminal tiene una **nota** que sale en una tarjeta flotante sobre la
consola y, su primera línea, en la lista de consolas. Existe para que el dueño, con varias consolas
abiertas, sepa **de qué va la tarea en curso de cada una** sin entrar a leerla.

En la nota conviven dos cosas:

- **La tarea** (líneas que empiezan por `▸ `, arriba): es TUYA. La pones con `--task`.
- **Todo lo demás**: son **notas personales del dueño**. No son tuyas.

## Regla dura: las notas personales no se tocan

**Usa SOLO `dotrino-terminal note --task`.** Esa orden reemplaza tus líneas `▸ ` y deja el resto
tal cual, así que no puedes pisar nada del dueño.

**Prohibido**, salvo que el usuario te lo pida con esas palabras en ese momento:

- `dotrino-terminal note "texto"` y `dotrino-terminal note -` (reemplazan la nota ENTERA)
- `dotrino-terminal note --add …` (escribe una línea como si fuera suya)
- `dotrino-terminal note --clear` (la borra entera)

No reescribas, ordenes, corrijas ni resumas lo que él escribió. Tampoco lo copies a tus líneas.

## Cuándo

1. Comprueba que corres dentro de una consola: `echo "$DOTRINO_TERMINAL_CONSOLE"`. Vacío = no hay
   consola ni tarjeta: no hagas nada y no lo menciones.
2. **Al empezar una tarea**: pon la tarea.
3. **Cuando cambia** (otra tarea, otro rumbo, un bloqueo): vuelve a ponerla.
4. **Al terminar o al quedar esperando al usuario**: dilo en la primera línea.

Una orden por momento, sin anunciarlo ni comentarlo en la respuesta.

## Cómo

```bash
dotrino-terminal note --task "Arreglando el login de facturero"

dotrino-terminal note --task - <<'EOF_TASK'    # varias líneas, por la entrada estándar
Arreglando el login de facturero
Falta: probar con firma real
EOF_TASK

dotrino-terminal note --task ''                # quita tu tarea (lo del dueño se queda)
dotrino-terminal note                          # solo LEER la nota entera
```

No hace falta decir qué consola: es la tuya.

## Qué escribir

- **Primera línea = la tarea, en una frase corta** (hasta ~60 caracteres): es lo que se ve en la
  lista. «Tarjeta de notas en dotrino-terminal», no «Trabajando en lo que pidió el usuario».
- Debajo, solo lo que ayuda a retomar: `Hecho:` / `Falta:` / `Espera: tu visto bueno`. Tres o
  cuatro líneas en total.
- En el idioma del usuario. Sin secretos, llaves ni rutas con credenciales: la nota la ven todos
  los aparatos de la cuenta.
- Al terminar no la quites: di que terminó (`Terminado: …`).

## Si falla

- «no sé de qué consola» / `no console to act on`: no corres dentro de Dotrino Terminal. Sigue sin nota.
- `--task` no hace nada o cambia la nota entera: el `dotrino-terminal` instalado es anterior a la
  0.36.1. **No uses las otras formas como sustituto**: díselo al usuario una vez
  (`npm i -g @dotrino/terminal-agent@latest`) y sigue sin nota.
- «el agente no contestó: es anterior a la 0.36.0»: díselo al usuario una vez y no lo reintentes.
- **Nunca reinicies el agente tú**: corres dentro de él y reiniciarlo cierra esta consola.
