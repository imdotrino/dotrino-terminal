#!/usr/bin/env bash
# UserPromptSubmit: dentro de una consola de Dotrino Terminal, recuerda en cada mensaje que la
# tarjeta «de qué va» se mantiene al día. Fuera de una consola no dice nada.
# Lo instala `dotrino-terminal claude` (y lo quita `dotrino-terminal claude --off`).
[ -n "$DOTRINO_TERMINAL_CONSOLE" ] || exit 0
command -v dotrino-terminal >/dev/null 2>&1 || exit 0
# En qué momento empezó este turno (lo usa terminal-note-stop.sh). Un contador, no la hora: el
# `date` de macOS no da fracciones de segundo, y dos cosas en el mismo segundo no se ordenarían.
dir="$HOME/.claude/hooks/state"; key="$dir/note-$DOTRINO_TERMINAL_CONSOLE"
mkdir -p "$dir"
n=$(( $(cat "$key.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$key.n"; echo "$n" > "$key.prompt"
cat <<'MSG'
[Dotrino Terminal] Esta sesión corre en una consola con tarjeta «de qué va». Mantén la tarea al día con `dotrino-terminal note --task … --title '<de qué va, en pocas palabras>'` (skill dotrino-terminal-note; el título es el nombre de la consola: el mismo mientras la tarea sea la misma, otro cuando cambie): al empezar lo que pide este mensaje, CADA VEZ que pase algo (un paso terminado, algo publicado, un fallo, un cambio de rumbo, quedar esperando algo) y al terminar. La última línea, siempre: `Modelo: <el modelo que eres>`. Solo `--task` y `--title`: las notas personales del dueño no se tocan. Sin anunciarlo en la respuesta.
MSG
