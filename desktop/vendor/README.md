# vendor/

## iced_term 0.8.0

Copia de [iced_term](https://github.com/Harzu/iced_term) 0.8.0 (MIT) con UN cambio:
`Terminal::selected_text()` en `src/terminal.rs`, que devuelve el texto seleccionado. Sin él,
«Editar → Copiar» del menú no tiene de dónde sacarlo (el crate solo copia con el atajo de
teclado, dentro del widget).

Se usa por `[patch.crates-io]` en `../Cargo.toml`. Cuando upstream exponga algo equivalente,
se borra esta carpeta y el parche.
