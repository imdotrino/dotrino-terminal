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

## iced_aw 0.14.1

Copia de [iced_aw](https://github.com/iced-rs/iced_aw) 0.14.1 (MIT) con UN cambio, en
`src/widget/context_menu.rs` (`ContextMenu::operate`). Con el menú abierto, upstream pasaba la
operación al contenido del MENÚ con el layout de lo que hay DEBAJO; los dos árboles no cuadran y
un botón del menú hacía `unwrap()` de un hijo del layout que no existe
(`iced_widget/src/button.rs`, «called `Option::unwrap()` on a `None` value»): la app se caía con
cualquier operación de foco mientras había un menú de clic secundario abierto (la ventana recibe
el foco, la app devuelve el teclado a la terminal). Ahora la operación va siempre a lo de debajo;
el contenido del menú lo opera su overlay, con su propio layout.

Solo se copió lo que compila (`src/`, `font.ttf`, `Cargo.toml` sin sus ejemplos ni pruebas).
Cuando upstream lo corrija, se borra esta carpeta y el parche.

Segundo cambio, obligado por copiarla: en `src/lib.rs` la macro de iconos lee `font.ttf` desde
el directorio de trabajo de la compilación, que para una dependencia por ruta es `desktop/` y no
la carpeta del crate. La ruta pasa a `vendor/iced_aw/font.ttf`.
