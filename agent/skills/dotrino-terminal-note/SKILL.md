---
name: dotrino-terminal-note
description: Mantiene al día la tarjeta «de qué va» de la consola de Dotrino Terminal en la que corres (la ve el dueño flotando sobre la consola, en todas sus pantallas). Úsalo AL EMPEZAR cada tarea, cuando la tarea cambia de rumbo, y al terminar o quedar esperando al usuario, siempre que exista la variable de entorno DOTRINO_TERMINAL_CONSOLE. También cuando el usuario diga «nota de la consola», «el flotante», «la tarjeta», «de qué va este chat» o pida anotar algo en la consola. Orden: `dotrino-terminal note`.
---

# La nota de la consola (Dotrino Terminal)

Cada consola de Dotrino Terminal tiene una **nota**: texto libre que sale en una tarjeta flotante
sobre la consola y, su primera línea, en la lista de consolas. Existe para que el dueño, con varias
consolas abiertas, sepa **de qué va la tarea en curso de cada una** sin entrar a leerla. La escribes
tú y también la edita él a mano: es de los dos.

## Cuándo

1. Comprueba que corres dentro de una consola: `echo "$DOTRINO_TERMINAL_CONSOLE"`. Vacío = no hay
   consola ni tarjeta: no hagas nada y no lo menciones.
2. **Al empezar una tarea**: escribe la nota.
3. **Cuando cambia** (otra tarea, otro rumbo, un bloqueo): reescríbela.
4. **Al terminar o al quedar esperando al usuario**: déjalo dicho en la primera línea.

Una orden por momento, sin anunciarlo ni comentarlo en la respuesta.

## Cómo

```bash
dotrino-terminal note                      # la enseña (léela ANTES de reemplazarla)
dotrino-terminal note "texto"              # la reemplaza
dotrino-terminal note - <<'EOF_NOTE'       # varias líneas, por la entrada estándar
Arreglando el login de facturero
Falta: probar con firma real
EOF_NOTE
dotrino-terminal note --add "línea"        # le añade una línea al final
dotrino-terminal note --clear              # la borra
dotrino-terminal note --json               # { id, n, title, note }
```

No hace falta decir qué consola: es la tuya. `--id <id>` apunta a otra (`dotrino-terminal ls`).

## Qué escribir

- **Primera línea = la tarea, en una frase corta** (hasta ~60 caracteres): es lo único que se ve en
  la lista. «Tarjeta de notas en dotrino-terminal», no «Trabajando en lo que pidió el usuario».
- Debajo, solo lo que ayuda a retomar: el estado (`Hecho:` / `Falta:` / `Espera: tu visto bueno`).
  Tres o cuatro líneas; el máximo son 4000 caracteres.
- En el idioma del usuario. Sin secretos, llaves ni rutas con credenciales: la nota la ven todos
  los aparatos de la cuenta.
- **Lo que escribió el dueño se respeta.** Lee la nota antes: si hay líneas que no son tuyas,
  consérvalas (reescribe las tuyas y deja las suyas, o usa `--add`). No la borres al terminar: di
  que terminó.

## Si falla

- `no console to act on` / «no sé de qué consola»: no corres dentro de Dotrino Terminal. Sigue sin nota.
- «el agente no contestó: es anterior a la 0.36.0»: el agente de esta máquina es viejo. Díselo al
  usuario una vez (se arregla con `npm i -g @dotrino/terminal-agent@latest` y reiniciándolo él:
  reiniciar el agente cierra sus consolas, **incluida esta**) y no lo reintentes en esa sesión.
- **Nunca reinicies ni actualices el agente tú**: corres dentro de él.
