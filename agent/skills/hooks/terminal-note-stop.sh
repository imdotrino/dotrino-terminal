#!/usr/bin/env bash
# Stop: dentro de una consola de Dotrino Terminal, no deja terminar el turno con la tarjeta
# vieja. Si en este turno se usaron herramientas y la tarea no se puso DESPUÉS de la última, la
# tarjeta dice algo que ya no es cierto («Ahora: compilando» con todo terminado): se le devuelve
# a Claude para que la ponga al día. Una sola vez por parada (stop_hook_active), sin bucles.
[ -n "$DOTRINO_TERMINAL_CONSOLE" ] || exit 0
command -v dotrino-terminal >/dev/null 2>&1 || exit 0
input=$(cat)
case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
key="$HOME/.claude/hooks/state/note-$DOTRINO_TERMINAL_CONSOLE"
prompt=$(cat "$key.prompt" 2>/dev/null || echo 0)
tool=$(cat "$key.tool" 2>/dev/null || echo 0)
task=$(cat "$key.task" 2>/dev/null || echo 0)
# Sin herramientas en este turno no cambió nada: la tarjeta sigue valiendo.
[ "$tool" -gt "$prompt" ] || exit 0
[ "$task" -gt "$tool" ] && exit 0
echo "La tarjeta de esta consola quedó vieja: en este turno hiciste cosas y no pusiste la tarea después. Antes de terminar, ponla al día con \`dotrino-terminal note --task\` (lo que quedó hecho, y si terminaste o qué esperas; nada de «Ahora:» que ya no ocurre). Solo --task; no lo anuncies." >&2
exit 2
