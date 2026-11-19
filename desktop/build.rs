// Windows: el icono va DENTRO del .exe (recurso), que es lo que enseñan el Explorador, la barra
// de tareas y Alt+Tab. Sin esto la app salía con el icono genérico de un programa.
fn main() {
    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.compile().expect("could not embed the Windows icon");
    }
}
