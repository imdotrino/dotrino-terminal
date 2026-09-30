/**
 * title.js — separa el título que pone la shell (OSC 0/1/2) del resto de la salida.
 *
 * La ventana local compone su propio título: el de la shell y, si alguien la tiene abierta
 * desde otro aparato, la marca que lo dice. Si el título de la shell llegara tal cual a la
 * terminal, taparía esa marca al siguiente prompt — y es un aviso que no se puede perder.
 *
 * Las secuencias llegan partidas entre trozos, así que lo que queda a medias se guarda para
 * el siguiente. Una secuencia sin terminar que crece más allá de `MAX_PENDING` no es un
 * título: se suelta tal cual.
 */
const MAX_PENDING = 4096
const TITLE = /^([012]);([\s\S]*)$/

/**
 * @param {(title: string) => void} onTitle
 * @returns {(chunk: string) => string} lo que hay que escribir en la terminal
 */
export function titleFilter (onTitle) {
  let carry = ''
  return (chunk) => {
    let data = carry + chunk
    carry = ''
    let out = ''
    let pos = 0
    while (pos < data.length) {
      const start = data.indexOf('\x1b]', pos)
      if (start < 0) {
        // Un ESC al final puede ser el principio de una secuencia que sigue en el próximo trozo.
        if (data.endsWith('\x1b')) { out += data.slice(pos, -1); carry = '\x1b' } else out += data.slice(pos)
        break
      }
      out += data.slice(pos, start)
      const bel = data.indexOf('\x07', start)
      const st = data.indexOf('\x1b\\', start)
      let end = -1; let len = 0
      if (bel >= 0 && (st < 0 || bel < st)) { end = bel; len = 1 } else if (st >= 0) { end = st; len = 2 }
      if (end < 0) {
        const rest = data.slice(start)
        if (rest.length > MAX_PENDING) out += rest; else carry = rest
        break
      }
      const body = data.slice(start + 2, end)
      const m = TITLE.exec(body)
      if (m) onTitle(m[2]); else out += data.slice(start, end + len)
      pos = end + len
    }
    return out
  }
}
