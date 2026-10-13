#!/usr/bin/env bash
# PreToolUse (todas las herramientas): dentro de una consola de Dotrino Terminal, apunta cuándo
# fue la última herramienta usada y cuándo la última vez que se puso la tarea de la tarjeta
# (`dotrino-terminal note --task`). Con eso, terminal-note-stop.sh sabe si la tarjeta quedó vieja.
[ -n "$DOTRINO_TERMINAL_CONSOLE" ] || exit 0
dir="$HOME/.claude/hooks/state"; key="$dir/note-$DOTRINO_TERMINAL_CONSOLE"
mkdir -p "$dir"
input=$(cat)
n=$(( $(cat "$key.n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$key.n"
case "$input" in
  *'"tool_name":"Bash"'*|*'"tool_name": "Bash"'*)
    case "$input" in
      *'note --task'*) echo "$n" > "$key.task"; exit 0 ;;
    esac ;;
esac
echo "$n" > "$key.tool"
exit 0
