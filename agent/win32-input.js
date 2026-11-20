/**
 * win32-input.js — quita de la salida de la consola la petición de «win32-input-mode».
 *
 * La ConPTY de una consola de Windows pide a quien la muestra que le mande las teclas como
 * eventos de Windows (`ESC[?9001h`): cada tecla llega como `ESC[Vk;Sc;Uc;Kd;Cs;Rc_`. Si el
 * cliente deja pasar esa petición a su terminal y esa terminal es otra ConPTY (la ventana de la
 * app en Windows, Windows Terminal), esta empieza a codificar así todo lo que se teclea, también
 * los atajos que manda la app (Ctrl+] d, n, a<id>⏎). El cliente ya no veía el Ctrl+]: lo pasaba
 * a la consola, y PowerShell escribía la «d» con un pitido.
 *
 * Sin la petición, la terminal local manda texto normal, que la ConPTY del otro lado entiende
 * igual (es lo que mandan Linux, macOS y el teléfono). La secuencia puede llegar partida entre
 * dos trozos: el principio que queda al final se guarda para el siguiente.
 */
const SEQ = '\x1b[?9001h'

/** @returns {(chunk: string) => string} lo que hay que escribir en la terminal */
export function win32InputFilter () {
  let carry = ''
  return (chunk) => {
    let data = (carry + chunk).split(SEQ).join('')
    carry = ''
    for (let n = Math.min(SEQ.length - 1, data.length); n > 0; n--) {
      if (SEQ.startsWith(data.slice(-n))) { carry = data.slice(-n); data = data.slice(0, -n); break }
    }
    return data
  }
}
