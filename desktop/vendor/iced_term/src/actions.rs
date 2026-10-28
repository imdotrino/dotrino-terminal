#[derive(Debug, Clone, PartialEq, Default)]
pub enum Action {
    Shutdown,
    ChangeTitle(String),
    /// Parche de Dotrino: Ctrl+clic sobre un enlace o una ruta. Lo abre la app, que sabe de qué
    /// máquina es la consola y en qué carpeta está (el crate lo abría él, y se caía si fallaba).
    OpenLink(crate::links::Link),
    #[default]
    Ignore,
}
