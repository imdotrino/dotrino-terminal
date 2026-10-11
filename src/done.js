// ¿Acaba de TERMINAR una consola? Lo que decide cuándo suena el trino. El agente marca cada
// consola con `doneAt` cuando termina su tarea (o toca la campana) y lo quita cuando alguien la
// atiende; aquí solo se mira si ese `doneAt` es NUEVO respecto a lo que ya se sabía.
//
// La primera lista de una máquina no suena: lo que ya estaba terminado al abrir la app no es
// una noticia. Lo que suena es lo que termina mientras miras.

/** Tracks the `doneAt` of every console seen, per machine. */
export function doneWatcher () {
  const known = new Map()   // `${machine}\n${console id}` → its doneAt
  const primed = new Set()  // machines whose first list has already been read
  const note = (machine, c, quiet) => {
    const key = `${machine}\n${c.id}`
    if (c.doneAt == null) { known.delete(key); return false }
    if (known.get(key) === c.doneAt) return false
    known.set(key, c.doneAt)
    return !quiet
  }
  return {
    /** The whole list of a machine. True when some console finished since the last look. */
    list (machine, list) {
      const first = !primed.has(machine)
      primed.add(machine)
      const alive = new Set(list.map((c) => `${machine}\n${c.id}`))
      for (const key of known.keys()) if (key.startsWith(`${machine}\n`) && !alive.has(key)) known.delete(key)
      let fresh = false
      for (const c of list) if (note(machine, c, first)) fresh = true
      return fresh
    },
    /** One console, as the machine pushes it to whoever is watching it. */
    one (machine, c) { return note(machine, c, false) },
  }
}
