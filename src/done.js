// ¿Cuándo suena el trino? El agente marca cada consola con `doneAt` cuando termina su tarea (o
// toca la campana) y lo quita cuando alguien la atiende. El trino NO suena en ese momento (ahí la
// consola solo pasa a verde): suena cuando lleva `RING_AFTER_MS` así y nadie la ha atendido
// (dueño, 2026-10-13). Si se atiende antes, o termina otra vez, esa cuenta ya no vale.
//
// Lo que ya llevaba más de ese tiempo terminado al abrir la app no es una noticia: no suena.

export const RING_AFTER_MS = 60_000

/**
 * Tracks the `doneAt` of every console seen, per machine, and calls `onRing` when one has stayed
 * finished and unattended for `afterMs`.
 * @param {{ onRing: () => void, afterMs?: number, now?: () => number, setTimer?: typeof setTimeout }} opts
 */
export function doneWatcher ({ onRing, afterMs = RING_AFTER_MS, now = Date.now, setTimer = setTimeout }) {
  const known = new Map()   // `${machine}\n${console id}` → its doneAt
  const note = (machine, c) => {
    const key = `${machine}\n${c.id}`
    if (c.doneAt == null) { known.delete(key); return }
    if (known.get(key) === c.doneAt) return
    known.set(key, c.doneAt)
    const age = now() - c.doneAt
    if (age > afterMs) return                       // already old when first seen
    const at = c.doneAt
    // Still finished with that same `doneAt` when the time is up: nobody attended it.
    setTimer(() => { if (known.get(key) === at) onRing() }, Math.max(0, afterMs - age))
  }
  return {
    /** The whole list of a machine. */
    list (machine, list) {
      const alive = new Set(list.map((c) => `${machine}\n${c.id}`))
      for (const key of known.keys()) if (key.startsWith(`${machine}\n`) && !alive.has(key)) known.delete(key)
      for (const c of list) note(machine, c)
    },
    /** One console, as the machine pushes it to whoever is watching it. */
    one (machine, c) { note(machine, c) },
  }
}
