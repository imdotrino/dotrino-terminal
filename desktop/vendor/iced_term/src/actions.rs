#[derive(Debug, Clone, PartialEq, Default)]
pub enum Action {
    Shutdown,
    ChangeTitle(String),
    /// Parche de Dotrino: Ctrl+clic sobre un enlace o una ruta. Lo abre la app, que sabe de qué
    /// máquina es la consola y en qué carpeta está (el crate lo abría él, y se caía si fallaba).
    OpenLink(crate::links::Link),
    /// Parche de Dotrino: el programa de dentro copió algo (OSC 52; Claude Code copia así su
    /// propia selección). Lo escribe la app en el portapapeles; antes se perdía.
    CopyToClipboard(String),
    #[default]
    Ignore,
}
