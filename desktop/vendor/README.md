# vendor/

## iced_term 0.8.0

Copia de [iced_term](https://github.com/Harzu/iced_term) 0.8.0 (MIT) con UN cambio:
`Terminal::selected_text()` en `src/terminal.rs`, que devuelve el texto seleccionado. Sin él,
«Editar → Copiar» del menú no tiene de dónde sacarlo (el crate solo copia con el atajo de
teclado, dentro del widget).

Se usa por `[patch.crates-io]` en `../Cargo.toml`. Cuando upstream exponga algo equivalente,
se borra esta carpeta y el parche.

Segundo cambio: `Terminal::paste_bytes()` (y el atajo de pegar del widget lo usa). El crate
pegaba los bytes tal cual, así que un texto con saltos de línea se EJECUTABA al pegarlo aunque la
shell hubiera pedido el pegado entre corchetes (`ESC[?2004h`). Ahora va entre `ESC[200~` y
`ESC[201~` cuando el programa lo pide, quitando del texto cualquier `ESC[201~`.

Tercer cambio: `Terminal::clear_selection()`. El clic sobre una opción del menú contextual (clic
derecho → Copiar/Pegar) llega también a la terminal de debajo y empieza una selección; la app la
quita después de cada acción del menú.

Cuarto cambio: `Terminal::layout_size()` y `Terminal::resize_to()`. El widget solo avisa del tamaño
al PTY con el primer evento que le llega; una terminal que reemplaza a otra en la misma ventana se
quedaba hasta entonces en el tamaño de arranque del backend (80×50 píxeles: ~11×3 celdas), y el
programa que arrancaba dentro lo leía así. La app pasa el tamaño de la vieja a la nueva al crearla.

Quinto cambio: `Terminal::scroll_position()` (para la barra de desplazamiento de la app) y la
rueda a 3 líneas por golpe (traía 1).

Sexto cambio: `Backend::resize` no redimensiona el PTY hasta que el widget dice el tamaño real de su
área (antes, el primer evento lo dejaba en ~11×3 celdas, con el área de arranque de 80×50 píxeles,
y readline acababa con el cursor fuera de sitio), y solo avisa al PTY cuando el tamaño cambia (se
llamaba en cada evento, con una señal de redimensionado cada vez).

Séptimo cambio: `Terminal::cell_size()` devuelve el tamaño de una celda en píxeles, para dibujar la
consola al tamaño que tiene cuando el tamaño lo decide otra pantalla.
