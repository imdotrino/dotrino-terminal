/**
 * Lo que la CLI le dice al humano cuando una pregunta sobre las otras máquinas falla.
 * Va aparte de `bin/terminal.js` para que una prueba compruebe que los códigos que llegan de
 * `far.js` y de `@dotrino/remote-agent/discover` caen en su texto: si un código cambia de
 * nombre en un lado y no en el otro, el usuario ve el mensaje crudo en vez de la explicación.
 *
 * @param {{ code?: string, message?: string }} r  el `fail` que contestó el agente
 * @param {(es: string, en: string) => string} t   elige el idioma
 */
export function farMessage (r, t) {
  return ({
    'not-linked': t('esta máquina no está enlazada con tu bóveda, así que no ve tus otras máquinas. Enlázala con: dotrino-terminal link', 'this machine is not linked to your vault, so it cannot see your other machines. Link it with: dotrino-terminal link'),
    'no-record': t('no se pudo preguntar a tu bóveda qué máquinas tienes. Comprueba que esté encendida y que esta máquina tenga conexión.', 'could not ask your vault which machines you have. Check that it is on and that this machine is online.'),
    'no-machine': t('no hay ninguna máquina encendida con ese id o nombre (mira «dotrino-terminal machines»).', 'no machine with that id or name is on (see "dotrino-terminal machines").'),
    'ambiguous-machine': t('hay más de una máquina con ese nombre: usa su id (mira «dotrino-terminal machines»).', 'more than one machine has that name: use its id (see "dotrino-terminal machines").')
  })[r.code] || `${r.message} (${r.code})`
}
