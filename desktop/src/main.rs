//! Dotrino Terminal — la app de escritorio (Linux y macOS).
//!
//! Cada ventana es una terminal nativa (`iced` + `iced_term`, sobre `alacritty_terminal`).
//!
//! - **Por defecto, con perfil** (ver `default_profile`). **Sin perfil** es solo el repliegue
//!   cuando no hay ninguno, y el título lo dice: una terminal más, la shell del usuario directa,
//!   sin agente. Funciona aunque `dotrino-terminal` no esté instalado.
//! - **Con perfil** ejecuta `dotrino-terminal --name <perfil>`, el cliente TTY del paquete
//!   `@dotrino/terminal-agent`. La shell vive en el agente del perfil, así que lo que se abre
//!   aquí también se puede abrir desde los otros aparatos de esa cuenta. Esta app no habla el
//!   protocolo del agente; solo pone la ventana y elige el perfil.
//!
//! Las opciones van en la barra de menú de la ventana (Archivo, Editar, Perfil, Ayuda).
//!
//! - Cambiar de perfil cierra la TTY de la ventana (su consola muere, como al cerrarla) y abre
//!   otra en el agente del perfil nuevo.
//! - «Enrolar» corre `dotrino-terminal link` DENTRO de la ventana: la invitación y el código se
//!   ven en la propia TTY. Al terminar, la ventana pasa al perfil recién enlazado.
//! - Ctrl+Shift+N (Cmd+N en macOS) abre otra ventana con el mismo perfil; Ctrl+Shift+W la cierra.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

use iced::keyboard::{self, Key, Modifiers};
use iced::widget::{button, column, container, keyed_column, row, rule, space, text};
use iced::{Border, Color, Element, Event, Length, Size, Subscription, Task, Theme, window};
use iced_aw::ContextMenu;
use iced_aw::menu::{Item, Menu, MenuBar};
use serde::Deserialize;

const CLIENT: &str = "dotrino-terminal";
const CLIENT_PKG: &str = "@dotrino/terminal-agent";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// «Ayuda → Cómo se usa»: la página del wiki de esta app, en el idioma del sistema.
fn help_url() -> &'static str {
    if es() { "https://wiki.dotrino.com/herramientas/terminal-escritorio/" } else { "https://wiki.dotrino.com/en/herramientas/terminal-escritorio/" }
}

fn main() -> iced::Result {
    // Lo que la app no dice en pantalla queda en su registro: por qué se cerró una ventana, y un
    // fallo del programa con su sitio. Sin esto una ventana que desaparece no deja nada que leer.
    std::panic::set_hook(Box::new(|info| {
        log(&format!("panic: {info}"));
        eprintln!("{info}");
    }));
    log(&format!("start {}", env!("CARGO_PKG_VERSION")));
    iced::daemon(App::boot, App::update, App::view)
        .title(App::title)
        .subscription(App::subscription)
        .theme(|_: &App, _| Theme::Dark)
        .run()
}

/// Cómo se lanza el cliente en cada ventana.
#[derive(Clone)]
struct Launch {
    program: PathBuf,
    path: String,
    /// La versión del cliente instalado (de su package.json), si se pudo leer.
    version: Option<(u32, u32, u32)>,
}

/// Desde qué versión de `dotrino-terminal` entiende el cliente los atajos con los que la app
/// maneja sus consolas: Ctrl+] a<id>⏎ (pasar a otra), Ctrl+] n (nueva), Ctrl+] r (tamaño), y
/// `--tag`. A uno anterior NO se le mandan: los pasaría a la shell, que los ejecutaría como texto
/// (el id acababa como «command not found»).
const PANEL_CLIENT: (u32, u32, u32) = (0, 11, 0);
/// Desde qué versión entiende el cliente Ctrl+] p / u (fijar o soltar el tamaño).
const PIN_CLIENT: (u32, u32, u32) = (0, 14, 0);

/// La versión del cliente sin ejecutarlo (ejecutarlo podría levantar un agente): su package.json,
/// junto al script al que apunta el enlace de npm (`…/@dotrino/terminal-agent/bin/terminal.js`).
fn client_version(program: &Path) -> Option<(u32, u32, u32)> {
    let real = std::fs::canonicalize(program).ok()?;
    let pkg = real.parent()?.parent()?.join("package.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(pkg).ok()?).ok()?;
    let mut it = v["version"].as_str()?.split(['.', '-']).map(|n| n.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// Un perfil, tal como lo cuenta `dotrino-terminal profiles --json`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
struct Profile {
    name: String,
    linked: bool,
    id: Option<String>,
    vault: Option<String>,
    dir: String,
}

impl std::fmt::Display for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.id, self.linked) {
            (Some(id), true) => write!(f, "{}  ·  {id}", self.name),
            _ => write!(f, "{}  ·  {}", self.name, t("solo esta máquina", "this machine only")),
        }
    }
}

/// Una consola del agente, tal como la cuenta `list` (ver agent/consoles.js `info()`).
#[derive(Debug, Clone, Deserialize)]
struct ConsoleInfo {
    id: String,
    /// Su número, fijo mientras viva (lo da el agente ≥ 0.12). Con uno anterior, la posición.
    #[serde(default)]
    n: Option<u32>,
    /// `local` (abierta desde esta máquina) o `remote` (desde otro aparato).
    #[serde(default)]
    origin: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    watchers: Vec<Watcher>,
    /// Quién tiene el tamaño: quien lo fijó (⤢) o el último que se enganchó (agente ≥ 0.14).
    #[serde(default, rename = "sizeBy")]
    size_by: Option<SizeBy>,
    #[serde(default)]
    cols: u32,
    #[serde(default)]
    rows: u32,
    /// `busy` (trabajando) o `idle`: lo dice el agente ≥ 0.17 (el título del programa, o su salida).
    #[serde(default)]
    activity: String,
    /// Terminó, o pidió atención, y nadie ha entrado ni tecleado desde entonces (ms).
    #[serde(default, rename = "doneAt")]
    done_at: Option<u64>,
}

/// Qué hace una consola, para el color del panel.
#[derive(Clone, Copy, PartialEq)]
enum Act {
    Idle,
    Busy,
    Done,
}

impl ConsoleInfo {
    fn act(&self) -> Act {
        if self.activity == "busy" {
            Act::Busy
        } else if self.done_at.is_some() {
            Act::Done
        } else {
            Act::Idle
        }
    }
}

/// Ámbar = trabajando · verde = terminó sin atender. Los mismos de la PWA.
const BUSY_COLOR: Color = Color::from_rgb(0.961, 0.761, 0.420);
const DONE_COLOR: Color = Color::from_rgb(0.478, 0.843, 0.761);

/// El botón de una consola en el panel, con el borde del color de lo que está haciendo.
fn console_button(selected: bool, act: Act) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let mut s = if selected { side_selected(theme, status) } else { menu_button(theme, status) };
        match act {
            Act::Busy => s.border = Border::default().rounded(4.0).width(1.5).color(BUSY_COLOR),
            Act::Done => s.border = Border::default().rounded(4.0).width(1.5).color(DONE_COLOR),
            Act::Idle => {}
        }
        s
    }
}

#[derive(Debug, Clone, Deserialize)]
struct SizeBy {
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    pinned: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct Watcher {
    origin: String,
    #[serde(default)]
    tag: Option<String>,
}

/// Lo que la ventana hace cuando su cliente termine de soltar la consola actual.
#[derive(Debug, Clone)]
enum Pending {
    /// Engancharse a esta consola.
    Attach(String),
    /// Abrir una nueva.
    New,
    /// Cerrar la ventana en cuanto el cliente haya soltado su consola (una de segundo plano: si
    /// la ventana la abrió, cerrarla sin soltarla la mataría).
    Close,
}

/// Qué corre en la TTY de la ventana.
enum Mode {
    /// Con perfil, una consola del agente de `Win::profile`; sin perfil, la shell del usuario.
    Console,
    /// `dotrino-terminal link`: al terminar se mira qué perfil quedó enlazado.
    Linking { linked_before: Vec<String> },
}

struct Win {
    /// `None`: sin perfil, una terminal más.
    profile: Option<String>,
    /// La carpeta donde abre la consola: la de quien lanzó la app (Thunar, «Abrir terminal
    /// aquí») o `--working-directory`. Una ventana nueva hereda la de la que la abrió.
    cwd: PathBuf,
    /// `-x prog args…` / `-e "orden"`: la ventana corre eso (sin perfil) y se cierra al acabar,
    /// como pide XFCE a un emulador de terminal.
    command: Option<Vec<String>>,
    mode: Mode,
    term: Option<iced_term::Terminal>,
    title: String,
    error: Option<String>,
    /// Cómo se presenta esta ventana ante el agente (`--tag`): así reconoce en la lista cuál es
    /// la consola que está mostrando.
    tag: String,
    /// La consola a la que engancharse en el próximo arranque (`None`: abrir una nueva).
    attach: Option<String>,
    /// Lo que toca cuando el cliente termine de soltar la consola (panel lateral).
    pending: Option<Pending>,
    /// La consola recién elegida en el panel, marcada YA, antes de que la próxima lectura de la
    /// lista lo confirme (si no, durante un momento salían dos marcadas, o ninguna).
    showing: Option<String>,
    /// Al terminar de soltarla para cerrar la ventana, cerrar también esta consola (ver
    /// `request_close`).
    kill_on_close: Option<String>,
    /// ¿Se ve el panel lateral de consolas en ESTA ventana? (cada ventana el suyo)
    sidebar: bool,
    /// Panel colapsado: una franja con un botón numerado por consola, para que ocupe poco.
    sidebar_collapsed: bool,
}

struct App {
    launch: Result<Launch, String>,
    profiles: Vec<Profile>,
    windows: BTreeMap<window::Id, Win>,
    by_term: HashMap<u64, window::Id>,
    next_term: u64,
    /// Se pidió instalar el cliente y todavía no aparece.
    awaiting_client: bool,
    /// La fuente de las terminales: la misma que la terminal de siempre (ver `terminal_font`).
    font: iced_term::settings::FontSettings,
    /// Los colores: los de XFCE Terminal si los tiene (ver `terminal_palette`).
    palette: iced_term::ColorPalette,
    /// Las consolas abiertas, por perfil, leídas del socket de su agente cada poco.
    consoles: HashMap<String, Vec<ConsoleInfo>>,
    /// Las consolas que usaron las ventanas de la app (perfil, id): al cerrar la última ventana se
    /// cierran, salvo las dejadas en segundo plano.
    tracked: std::collections::HashSet<(String, String)>,
    /// Las que la persona dejó en segundo plano (clic derecho en el panel): sobreviven a la app.
    background: std::collections::HashSet<(String, String)>,
    /// Consolas que se mandaron CERRAR y el agente aún no confirma: fuera del panel y sin poder
    /// elegirse. Entre pedir el cierre y que ocurra hay un instante (la ventana pasa antes a otra
    /// consola); volver a entrar en ella en ese hueco hacía que el cierre se llevara la ventana.
    dying: std::collections::HashSet<String>,
    next_tag: u64,
}

#[derive(Debug, Clone)]
enum Message {
    /// Otra ventana, con el perfil de la ventana desde la que se pidió. Se engancha a una consola
    /// que no esté abierta en ninguna ventana, si la hay; si no, abre una nueva.
    NewWindow(Option<window::Id>),
    /// Otra ventana con una consola nueva, siempre.
    NewWindowFresh(Option<window::Id>),
    /// Panel (clic derecho): dejar una consola en segundo plano, o quitarla de ahí.
    ToggleBackground(window::Id, String),
    Opened(window::Id),
    /// La ventana pidió cerrarse (la X, Alt+F4).
    Close(window::Id),
    /// `None`: sin perfil.
    SwitchProfile(window::Id, Option<String>),
    Enroll(window::Id),
    /// Renombrar el perfil de la ventana.
    Rename(window::Id),
    /// «Poner o cambiar la clave» (`true`) o «Quitar la clave» (`false`) del perfil de la ventana.
    Lock(window::Id, bool),
    /// Escribe en la consola de la ventana la orden que instala (o actualiza) el cliente.
    InstallClient(window::Id),
    /// ¿Apareció ya el cliente? (mientras se espera a que se instale)
    CheckClient,
    Copy(window::Id),
    /// Copiar un texto ya tomado: el del clic derecho, leído al abrir el menú (el clic sobre
    /// «Copiar» llega también a la terminal y empezaría una selección nueva, borrando esa).
    CopyText(window::Id, String),
    Paste(window::Id),
    Pasted(window::Id, Option<String>),
    Help,
    /// El título de un menú de la barra: abrirlo lo hace el propio menú, no hay nada que hacer.
    MenuRoot,
    /// Leer otra vez las consolas abiertas (panel lateral).
    Poll,
    /// Panel lateral: ver esta consola en la ventana.
    ShowConsole(window::Id, String),
    /// Panel lateral: abrir una consola nueva en la ventana.
    NewConsole(window::Id),
    /// Panel lateral: cerrar esa consola.
    KillConsole(window::Id, String),
    /// Panel lateral (clic derecho): abrir esa consola en una ventana nueva.
    OpenInNewWindow(window::Id, String),
    /// Cerrar la ventana aunque su cliente no haya terminado de soltar la consola.
    ForceClose(window::Id),
    /// Cerrarla ya (tras haber pasado la ventana a otra, si era la suya).
    KillNow(window::Id, String),
    ToggleSidebar(window::Id),
    /// ⤢ Esta ventana fija el tamaño de su consola (o lo suelta).
    TogglePin(window::Id),
    /// La barra de desplazamiento: llevar la vista a tantas líneas desde el final.
    ScrollTo(window::Id, f32),
    /// Colapsar el panel a solo botones (o volver a abrirlo).
    CollapseSidebar(window::Id),
    Terminal(iced_term::Event),
}

fn es() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .is_some_and(|v| v.to_lowercase().starts_with("es"))
}

fn t(es_text: &str, en_text: &str) -> String {
    if es() { es_text } else { en_text }.to_string()
}

/// La shell del usuario: `$SHELL`, y si no está (una app abierta desde el Finder de macOS),
/// la de su cuenta del sistema (`getpwuid`). Si tampoco, se dice.
fn user_shell() -> Result<String, String> {
    if let Some(sh) = std::env::var("SHELL").ok().filter(|s| !s.is_empty()) {
        return Ok(sh);
    }
    // SAFETY: getpwuid devuelve un puntero a memoria estática de libc o nulo; se copia enseguida.
    let from_passwd = unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() { None } else { Some(std::ffi::CStr::from_ptr((*pw).pw_shell).to_string_lossy().into_owned()) }
    };
    from_passwd.filter(|s| !s.is_empty()).ok_or_else(|| t("no sé cuál es tu shell: no está $SHELL ni en tu cuenta", "can't tell your shell: no $SHELL and none in your account"))
}

/// El PATH de una shell de inicio de sesión E INTERACTIVA del usuario. Una app abierta desde el
/// menú del escritorio (y en macOS, siempre) no hereda el PATH de la terminal, y ahí es donde
/// viven `node` y `dotrino-terminal`. Tiene que ser interactiva: nvm (y casi todo) se carga
/// desde `~/.bashrc`, que en una shell no interactiva sale antes de llegar a él.
///
/// `.bashrc` puede imprimir cosas, así que el PATH va en una línea marcada. Sin entrada, para
/// que no se quede esperando teclado, y con tope de tiempo: si la shell se cuelga, se dice.
fn login_path() -> Result<String, String> {
    const MARK: &str = "__DOTRINO_PATH__";
    let shell = user_shell()?;
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &format!("printf '\\n{MARK}%s\\n' \"$PATH\"")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("{shell}: {e}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while child.try_wait().map_err(|e| format!("{shell}: {e}"))?.is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err(t(&format!("{shell} -l -i tardó más de 10 s en arrancar"), &format!("{shell} -l -i took more than 10 s to start")));
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    let out = child.wait_with_output().map_err(|e| format!("{shell}: {e}"))?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix(MARK).map(|p| p.trim().to_string()))
        .filter(|p| !p.is_empty())
        .ok_or_else(|| t(&format!("{shell} -l -i no devolvió el PATH"), &format!("{shell} -l -i did not return the PATH")))
}

fn find_in(path: &str, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path).map(|dir| dir.join(name)).find(|p| is_executable(p))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Dónde está el cliente. `DOTRINO_TERMINAL_BIN` lo fija a mano; si no, se busca en el PATH
/// de inicio de sesión. Si no aparece, los perfiles no se pueden usar y el menú lo dice; la
/// ventana sin perfil funciona igual.
fn resolve() -> Result<Launch, String> {
    let path = login_path()?;
    let program = match std::env::var_os("DOTRINO_TERMINAL_BIN") {
        Some(p) => Some(PathBuf::from(p)).filter(|p| is_executable(p)).ok_or_else(|| format!("DOTRINO_TERMINAL_BIN: {}", t("no es un ejecutable", "not an executable")))?,
        None => find_in(&path, CLIENT).ok_or_else(|| {
            t(
                "Para usar perfiles, instala dotrino-terminal: npm install -g @dotrino/terminal-agent",
                "To use profiles, install dotrino-terminal: npm install -g @dotrino/terminal-agent",
            )
        })?,
    };
    let version = client_version(&program);
    Ok(Launch { program, path, version })
}

fn load_profiles(launch: &Launch) -> Result<Vec<Profile>, String> {
    let out = Command::new(&launch.program)
        .args(["profiles", "--json"])
        .env("PATH", &launch.path)
        .output()
        .map_err(|e| format!("{}: {e}", launch.program.display()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let all: Vec<Profile> = serde_json::from_slice(&out.stdout).map_err(|e| format!("dotrino-terminal profiles: {e}"))?;
    // Sin ningún perfil, el cliente cuenta uno `default` que todavía no existe (es el que usaría
    // `dotrino-terminal` a secas). Aquí «ninguno» es «sin perfil»: solo los que están en el disco.
    Ok(all.into_iter().filter(|p| p.linked || Path::new(&p.dir).is_dir()).collect())
}

/// La fuente de las ventanas: la MISMA que la terminal de siempre, para que no se note el
/// cambio. En orden: `DOTRINO_TERMINAL_FONT` («Familia tamaño», p. ej. "DejaVu Sans Mono 9"), la
/// de XFCE Terminal, la monoespaciada del escritorio (GNOME/GTK) y, si no hay ninguna, la que usa
/// la terminal del sistema por defecto. Los puntos pasan a píxeles a 96 ppp, como GTK.
fn terminal_font() -> iced_term::settings::FontSettings {
    let configured = std::env::var("DOTRINO_TERMINAL_FONT").ok().or_else(xfce_terminal_font).or_else(desktop_monospace_font);
    let (family, points) = configured.as_deref().and_then(parse_font_name).unwrap_or(if cfg!(target_os = "macos") {
        ("Menlo".to_string(), 12.0 * 72.0 / 96.0) // Terminal.app: 12 px
    } else {
        ("DejaVu Sans Mono".to_string(), 9.0)
    });
    iced_term::settings::FontSettings {
        size: points * 96.0 / 72.0,
        // Interlineado: con DejaVu 9 pt, XFCE Terminal deja 15 px por línea (12 × 1,25).
        // iced_term traía 1,3.
        scale_factor: 1.25,
        // iced pide un nombre `'static`: se crea una vez por proceso.
        font_type: iced::Font::with_name(Box::leak(family.into_boxed_str())),
    }
}

/// «DejaVu Sans Mono 9» → ("DejaVu Sans Mono", 9). El tamaño es la última palabra; si no es un
/// número, no se entiende el nombre y no se usa.
fn parse_font_name(name: &str) -> Option<(String, f32)> {
    let name = name.trim().trim_matches('\'');
    let (family, size) = name.rsplit_once(' ')?;
    let size: f32 = size.parse().ok().filter(|s: &f32| *s > 3.0 && *s < 72.0)?;
    (!family.trim().is_empty()).then(|| (family.trim().to_string(), size))
}

/// Los colores de la terminal de siempre: fondo, texto y los 16 de la paleta de XFCE Terminal.
/// Lo que no esté, o no se entienda, se queda con el de iced_term (un color mal escrito lo haría
/// entrar en pánico al pintar, por eso se valida aquí).
fn terminal_palette() -> iced_term::ColorPalette {
    let mut pal = iced_term::ColorPalette::default();
    let Some(rc) = xfce_terminalrc() else { return pal };
    let get = |key: &str| rc.lines().find_map(|l| l.strip_prefix(&format!("{key}=")).map(str::to_string));
    let set = |slot: &mut String, value: Option<String>, key: &str| match value.as_deref().map(hex6) {
        Some(Some(c)) => *slot = c,
        Some(None) => eprintln!("dotrino-terminal-desktop: {key} is not a color, keeping the default"),
        None => {}
    };
    set(&mut pal.foreground, get("ColorForeground"), "ColorForeground");
    set(&mut pal.background, get("ColorBackground"), "ColorBackground");
    if let Some(list) = get("ColorPalette") {
        let colors: Vec<String> = list.split(';').map(str::to_string).collect();
        let slots: [&mut String; 16] = [
            &mut pal.black, &mut pal.red, &mut pal.green, &mut pal.yellow, &mut pal.blue, &mut pal.magenta, &mut pal.cyan, &mut pal.white,
            &mut pal.bright_black, &mut pal.bright_red, &mut pal.bright_green, &mut pal.bright_yellow, &mut pal.bright_blue,
            &mut pal.bright_magenta, &mut pal.bright_cyan, &mut pal.bright_white,
        ];
        for (slot, value) in slots.into_iter().zip(colors) {
            set(slot, Some(value), "ColorPalette");
        }
    }
    pal
}

/// Un color en `#rrggbb`, que es lo único que entiende iced_term. GTK también guarda
/// `#rrrrggggbbbb`: se queda con el byte alto de cada canal.
fn hex6(c: &str) -> Option<String> {
    let c = c.trim();
    let hex = c.strip_prefix('#')?;
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 => Some(format!("#{}", hex.to_lowercase())),
        12 => Some(format!("#{}{}{}", &hex[0..2], &hex[4..6], &hex[8..10]).to_lowercase()),
        _ => None,
    }
}

fn xfce_terminalrc() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    std::fs::read_to_string(PathBuf::from(home).join(".config/xfce4/terminal/terminalrc")).ok()
}

fn xfce_terminal_font() -> Option<String> {
    let rc = xfce_terminalrc()?;
    // Si XFCE Terminal usa la fuente del sistema, manda la del escritorio.
    if rc.lines().any(|l| l.trim() == "FontUseSystem=TRUE") {
        return None;
    }
    rc.lines().find_map(|l| l.strip_prefix("FontName=").map(str::to_string))
}

fn desktop_monospace_font() -> Option<String> {
    let run = |cmd: &str, args: &[&str]| -> Option<String> {
        let out = Command::new(cmd).args(args).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !s.is_empty()).then_some(s)
    };
    run("xfconf-query", &["-c", "xsettings", "-p", "/Gtk/MonospaceFontName"])
        .or_else(|| run("gsettings", &["get", "org.gnome.desktop.interface", "monospace-font-name"]))
}

/// La línea de órdenes de la app. Lo que XFCE (exo) y los lanzadores esperan de un emulador de
/// terminal, más el perfil:
///   `--name <perfil>` · `--working-directory <dir>` (o `=dir`) · `-x prog args…` · `-e "orden"`
#[derive(Default, Clone)]
struct Cli {
    name: Option<String>,
    cwd: Option<PathBuf>,
    command: Option<Vec<String>>,
    error: Option<String>,
}

impl Cli {
    fn parse(args: Vec<String>) -> Result<Cli, String> {
        let mut cli = Cli::default();
        let mut it = args.into_iter();
        let need = |v: Option<String>, flag: &str| v.ok_or_else(|| format!("{flag}: {}", t("falta el valor", "missing value")));
        while let Some(a) = it.next() {
            match a.as_str() {
                "--name" => cli.name = Some(need(it.next(), "--name")?),
                "--working-directory" | "--cwd" => cli.cwd = Some(PathBuf::from(need(it.next(), &a)?)),
                // `-x`: todo lo que sigue es la orden y sus argumentos.
                "-x" | "--execute" => {
                    let rest: Vec<String> = it.by_ref().collect();
                    if rest.is_empty() {
                        return Err(format!("{a}: {}", t("falta la orden", "missing command")));
                    }
                    cli.command = Some(rest);
                }
                // `-e "orden"`: una sola cadena, que interpreta la shell.
                "-e" | "--command" => {
                    let cmd = need(it.next(), &a)?;
                    cli.command = Some(vec![user_shell()?, "-c".to_string(), cmd]);
                }
                _ if a.starts_with("--working-directory=") => cli.cwd = Some(PathBuf::from(&a["--working-directory=".len()..])),
                _ => return Err(format!("{}: {a}", t("opción desconocida", "unknown option"))),
            }
        }
        Ok(cli)
    }
}

/// Un texto como UN argumento de `sh`, entre comillas simples (y las suyas escapadas).
fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Las consolas en segundo plano, recordadas entre aperturas de la app: «perfil id» por línea.
fn background_file() -> Option<PathBuf> {
    last_profile_file().map(|f| f.with_file_name("background"))
}

fn load_background() -> std::collections::HashSet<(String, String)> {
    let Some(text) = background_file().and_then(|f| std::fs::read_to_string(f).ok()) else { return Default::default() };
    text.lines().filter_map(|l| l.split_once(' ').map(|(p, c)| (p.to_string(), c.to_string()))).collect()
}

fn save_background(set: &std::collections::HashSet<(String, String)>) {
    let Some(file) = background_file() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text: String = set.iter().map(|(p, c)| format!("{p} {c}\n")).collect();
    let _ = std::fs::write(file, text);
}

/// El registro de la app: `~/.config/dotrino-terminal/desktop.log`. Una línea por hecho, con la
/// hora. Se recorta al pasar de 256 KB (se queda la mitad más reciente).
fn log(msg: &str) {
    use std::io::Write;
    let Some(base) = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))) else { return };
    let dir = base.join("dotrino-terminal");
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("desktop.log");
    if std::fs::metadata(&file).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        if let Ok(old) = std::fs::read(&file) {
            let _ = std::fs::write(&file, &old[old.len() / 2..]);
        }
    }
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{ts} {msg}");
    }
}

/// Dónde se recuerda el último perfil elegido en la app (una preferencia, nada más).
fn last_profile_file() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("dotrino-terminal").join("last-profile"))
}

fn last_profile() -> Option<String> {
    let name = std::fs::read_to_string(last_profile_file()?).ok()?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn save_last_profile(name: &str) {
    let Some(file) = last_profile_file() else { return };
    // Si no se puede guardar, la próxima ventana elige por el orden de siempre: es una preferencia.
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, name);
}

fn linked_names(profiles: &[Profile]) -> Vec<String> {
    profiles.iter().filter(|p| p.linked).map(|p| p.name.clone()).collect()
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let launch = resolve();
        let mut app = App { launch, profiles: Vec::new(), windows: BTreeMap::new(), by_term: HashMap::new(), next_term: 0, awaiting_client: false, font: terminal_font(), palette: terminal_palette(), consoles: HashMap::new(), tracked: Default::default(), background: load_background(), dying: Default::default(), next_tag: 0 };
        let _ = app.reload_profiles();
        let cli = match Cli::parse(std::env::args().skip(1).collect()) {
            Ok(cli) => cli,
            Err(e) => Cli { error: Some(e), ..Cli::default() },
        };
        // La carpeta: la pedida, o aquella desde la que se lanzó la app (exo-open, el que usa
        // Thunar, lanza la terminal DENTRO de la carpeta).
        let cwd = cli.cwd.clone().map(Ok).unwrap_or_else(std::env::current_dir).map_err(|e| e.to_string());
        // Una orden (-x/-e) corre sin perfil: es lo que XFCE espera, y no es una consola tuya.
        let profile = if cli.command.is_some() { None } else { cli.name.clone().or_else(|| app.default_profile()) };
        let (id, task) = match (&cli.command, &profile) {
            (None, Some(p)) => {
                let free = app.free_console(p);
                app.open_window_on(profile.clone(), cwd.clone().unwrap_or_default(), free)
            }
            _ => app.open_window(profile, cwd.clone().unwrap_or_default(), cli.command.clone()),
        };
        if let Some(win) = app.windows.get_mut(&id) {
            if let Some(e) = cli.error {
                win.error = Some(e);
            } else if let Err(e) = cwd {
                win.error = Some(format!("{}: {e}", t("no puedo abrir en esta carpeta", "can't open in this folder")));
            }
        }
        (app, task)
    }

    /// El perfil con el que abre una ventana si nadie pide otro. Por defecto SE USA UN PERFIL;
    /// «sin perfil» es solo el repliegue cuando no hay ninguno (o falta el cliente), y se ve:
    /// el título lo dice. En orden: el último usado en esta app, `default`, el primero
    /// enlazado, el primero que exista.
    fn default_profile(&self) -> Option<String> {
        let has = |n: &str| self.profiles.iter().any(|p| p.name == n);
        last_profile()
            .filter(|n| has(n))
            .or_else(|| has("default").then(|| "default".to_string()))
            .or_else(|| self.profiles.iter().find(|p| p.linked).map(|p| p.name.clone()))
            .or_else(|| self.profiles.first().map(|p| p.name.clone()))
    }

    fn reload_profiles(&mut self) -> Result<(), String> {
        let launch = self.launch.as_ref().map_err(Clone::clone)?;
        self.profiles = load_profiles(launch)?;
        Ok(())
    }

    fn open_window(&mut self, profile: Option<String>, cwd: PathBuf, command: Option<Vec<String>>) -> (window::Id, Task<Message>) {
        self.open_window_with(profile, cwd, command, None)
    }

    /// Abre una ventana; con `attach`, nace enganchada a esa consola (sin abrir otra antes).
    fn open_window_with(&mut self, profile: Option<String>, cwd: PathBuf, command: Option<Vec<String>>, attach: Option<String>) -> (window::Id, Task<Message>) {
        let (id, task) = window::open(window::Settings {
            size: Size::new(960.0, 600.0),
            // El cierre lo hace la app (`Message::Close`): así sabe cuándo se fue la última
            // ventana. El evento `Closed` de iced no llega cuando ya no queda ninguna.
            exit_on_close_request: false,
            // Linux: la clase de la ventana, para que el escritorio la ate al .desktop (su icono).
            #[cfg(target_os = "linux")]
            platform_specific: window::settings::PlatformSpecific { application_id: "dotrino-terminal".into(), ..Default::default() },
            ..Default::default()
        });
        self.next_tag += 1;
        let tag = format!("desktop-{}-{}", std::process::id(), self.next_tag);
        self.windows.insert(id, Win { profile, cwd, command, mode: Mode::Console, term: None, title: String::new(), error: None, tag, attach: attach.clone(), pending: None, showing: attach, kill_on_close: None, sidebar: true, sidebar_collapsed: true });
        self.start(id, Mode::Console);
        (id, task.map(Message::Opened))
    }

    /// Pone en la ventana una TTY nueva. La anterior se suelta: su PTY se cierra, y lo que
    /// corría ahí recibe SIGHUP (sin perfil, la shell; con perfil, el cliente, y el agente mata
    /// la consola que esa TTY había abierto).
    fn start(&mut self, id: window::Id, mode: Mode) {
        let term_id = self.next_term;
        self.next_term += 1;
        let Some(win) = self.windows.get_mut(&id) else { return };
        // El tamaño del área de la terminal que se va: la nueva lo hereda al nacer (ver abajo).
        let mut inherited = None;
        if let Some(old) = win.term.take() {
            inherited = Some(old.layout_size());
            self.by_term.remove(&old.id);
        }
        win.error = None;
        win.title = String::new();
        // Una carpeta que no existe se dice: abrir en otra sin avisar haría que lo que escribas
        // corra donde no toca (y el PTY, por su cuenta, caería en silencio en otra carpeta).
        if !win.cwd.is_dir() {
            win.error = Some(format!("{}: {}", t("esa carpeta no existe", "that folder doesn't exist"), win.cwd.display()));
            return;
        }
        let plain = matches!(mode, Mode::Console) && win.profile.is_none();
        let spawn = if let (true, Some(cmd)) = (plain, win.command.clone()) {
            // Una orden de `-x`/`-e`: tal cual, sin perfil. La ventana se cierra cuando acaba.
            let mut it = cmd.into_iter();
            let program = it.next().unwrap_or_default();
            Ok((program, it.collect(), HashMap::from([("TERM".to_string(), "xterm-256color".to_string())])))
        } else if plain {
            // Sin perfil: la shell del usuario, como cualquier terminal. En macOS las terminales
            // abren una shell de inicio de sesión; en Linux, una interactiva.
            user_shell().map(|sh| {
                let args = if cfg!(target_os = "macos") { vec!["-l".to_string()] } else { Vec::new() };
                (sh, args, HashMap::from([("TERM".to_string(), "xterm-256color".to_string())]))
            })
        } else {
            self.launch.clone().map(|launch| {
                let args = match &mode {
                    Mode::Linking { .. } => vec!["link".to_string()],
                    // Engancharse a una consola que ya existe (panel lateral) o abrir una nueva.
                    Mode::Console => {
                        let mut a = match win.attach.take() {
                            Some(cid) => vec!["attach".to_string(), cid],
                            None => vec!["--cwd".to_string(), win.cwd.to_string_lossy().into_owned()],
                        };
                        a.extend(["--name".to_string(), win.profile.clone().unwrap_or_default(), "--tag".to_string(), win.tag.clone()]);
                        a
                    }
                };
                let env = HashMap::from([
                    ("PATH".to_string(), launch.path.clone()),
                    ("TERM".to_string(), "xterm-256color".to_string()),
                    // Si el cliente falla, que espere una tecla: la ventana se cierra cuando sale.
                    ("DOTRINO_TERMINAL_HOLD".to_string(), "1".to_string()),
                ]);
                (launch.program.to_string_lossy().into_owned(), args, env)
            })
        };
        win.mode = mode;
        let (program, args, env) = match spawn {
            Ok(s) => s,
            Err(e) => {
                win.error = Some(e);
                return;
            }
        };
        let settings = iced_term::settings::Settings {
            backend: iced_term::settings::BackendSettings {
                program: program.clone(),
                args,
                env,
                working_directory: Some(win.cwd.clone()),
            },
            font: self.font.clone(),
            theme: iced_term::settings::ThemeSettings::new(Box::new(self.palette.clone())),
            ..Default::default()
        };
        match iced_term::Terminal::new(term_id, settings) {
            Ok(mut term) => {
                // En el mismo instante de crearla, antes de que el programa de dentro arranque y lea
                // su tamaño: si no, nace en 80×50 píxeles (~11×3) hasta el primer evento, y al
                // engancharse a una consola compartida la encogía también en las otras ventanas.
                if let Some(size) = inherited.filter(|s| s.width > 100.0 && s.height > 50.0) {
                    term.resize_to(size);
                }
                self.by_term.insert(term_id, id);
                win.term = Some(term);
            }
            Err(e) => win.error = Some(format!("{program}: {e}")),
        }
    }

    /// El clic sobre una opción del menú contextual también le llega a la terminal de debajo,
    /// que empieza una selección con él: se quita.
    fn clear_stray_selection(&mut self, id: window::Id) {
        if let Some(term) = self.windows.get_mut(&id).and_then(|w| w.term.as_mut()) {
            term.clear_selection();
        }
    }

    fn pin_ready(&self) -> bool {
        self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= PIN_CLIENT)
    }

    /// ¿Tiene ESTA ventana fijado el tamaño de la consola que muestra?
    fn pinned_here(&self, id: window::Id) -> bool {
        let (Some(win), Some(cid)) = (self.windows.get(&id), self.mine(id)) else { return false };
        let Some(c) = win.profile.as_ref().and_then(|p| self.consoles.get(p)).and_then(|l| l.iter().find(|c| c.id == cid)) else { return false };
        c.size_by.as_ref().is_some_and(|b| b.pinned && b.tag.as_deref() == Some(win.tag.as_str()))
    }

    /// El tamaño (columnas, filas) de la consola de esta ventana cuando lo decide OTRA pantalla.
    /// `None` si lo tiene esta ventana o todavía no se sabe: entonces ocupa toda la ventana.
    fn followed_size(&self, id: window::Id) -> Option<(u32, u32)> {
        let (win, cid) = (self.windows.get(&id)?, self.mine(id)?);
        let c = win.profile.as_ref().and_then(|p| self.consoles.get(p))?.iter().find(|c| c.id == cid)?;
        let b = c.size_by.as_ref()?;
        if b.tag.as_deref() == Some(win.tag.as_str()) || c.cols == 0 || c.rows == 0 {
            return None;
        }
        Some((c.cols, c.rows))
    }

    /// Quién tiene el tamaño de una consola, dicho para esta ventana.
    fn size_owner_text(&self, id: window::Id, c: &ConsoleInfo) -> Option<String> {
        let b = c.size_by.as_ref()?;
        let my_tag = self.windows.get(&id).map(|w| w.tag.clone());
        let who = if b.tag.is_some() && b.tag == my_tag {
            t("esta ventana", "this window")
        } else if b.origin.as_deref() == Some("remote") {
            t("otro aparato", "another device")
        } else {
            t("otra ventana", "another window")
        };
        Some(format!("{} {who}", t("tamaño:", "size:")))
    }

    /// ¿Entiende el cliente instalado los atajos del panel? Si no se sabe su versión, no.
    fn panel_ready(&self) -> bool {
        self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= PANEL_CLIENT)
    }

    /// Una consola del perfil que no esté abierta en ninguna ventana (ni dejada en segundo plano):
    /// la que se reutiliza al abrir una ventana, en vez de crear otra. Se pregunta al agente en el
    /// momento, no a la lista guardada, que puede tener hasta 1,5 s.
    fn free_console(&self, profile: &str) -> Option<String> {
        if !self.panel_ready() {
            return None;
        }
        let list = self.profile_dir(profile).and_then(|dir| agent_list(&dir))?;
        // Las libres normales primero; si no hay, una de segundo plano (sigue siéndolo).
        let free: Vec<ConsoleInfo> = list.into_iter().filter(|c| c.watchers.is_empty() && !self.dying.contains(&c.id)).collect();
        let bg = |c: &ConsoleInfo| self.background.contains(&(profile.to_string(), c.id.clone()));
        free.iter().find(|c| !bg(c)).or_else(|| free.first()).map(|c| c.id.clone())
    }

    /// Abre una ventana enganchada a `attach` (si hay) o con una consola nueva.
    fn open_window_on(&mut self, profile: Option<String>, cwd: PathBuf, attach: Option<String>) -> (window::Id, Task<Message>) {
        self.open_window_with(profile, cwd, None, attach)
    }

    fn profile_dir(&self, name: &str) -> Option<PathBuf> {
        self.profiles.iter().find(|p| p.name == name).map(|p| PathBuf::from(&p.dir))
    }

    /// Las consolas de los perfiles que tienen ventanas abiertas, preguntadas al socket de su
    /// agente. Un agente que no corre no tiene consolas.
    fn poll_consoles(&mut self) {
        let profiles: std::collections::BTreeSet<String> = self.windows.values().filter_map(|w| w.profile.clone()).collect();
        let mut fresh = HashMap::new();
        for p in profiles {
            let list = self.profile_dir(&p).and_then(|dir| agent_list(&dir)).unwrap_or_default();
            fresh.insert(p, list);
        }
        // Lo que se mandó cerrar no vuelve al panel; y cuando el agente ya no lo tiene, se olvida.
        let alive_now: std::collections::HashSet<String> = fresh.values().flatten().map(|c| c.id.clone()).collect();
        self.dying.retain(|id| alive_now.contains(id));
        for list in fresh.values_mut() {
            list.retain(|c| !self.dying.contains(&c.id));
        }
        self.consoles = fresh;
        // Lo que muestran las ventanas (abierto desde esta máquina) queda a cargo de la app; lo que
        // ya no existe, se olvida.
        for w in self.windows.values() {
            let Some(p) = &w.profile else { continue };
            for c in self.consoles.get(p).into_iter().flatten() {
                if c.origin == "local" && c.watchers.iter().any(|x| x.tag.as_deref() == Some(w.tag.as_str())) {
                    self.tracked.insert((p.clone(), c.id.clone()));
                }
            }
        }
        let alive: std::collections::HashSet<(String, String)> =
            self.consoles.iter().flat_map(|(p, l)| l.iter().map(move |c| (p.clone(), c.id.clone()))).collect();
        let polled: std::collections::HashSet<String> = self.consoles.keys().cloned().collect();
        self.tracked.retain(|k| !polled.contains(&k.0) || alive.contains(k));
        let before = self.background.len();
        self.background.retain(|k| !polled.contains(&k.0) || alive.contains(k));
        if self.background.len() != before {
            save_background(&self.background);
        }
        // Lo marcado a mano se suelta en cuanto la lista lo dice (o la consola ya no está).
        let tags: Vec<(window::Id, String, Option<String>, Option<String>)> =
            self.windows.iter().map(|(id, w)| (*id, w.tag.clone(), w.profile.clone(), w.showing.clone())).collect();
        for (id, tag, profile, showing) in tags {
            let Some(want) = showing else { continue };
            let list = profile.and_then(|p| self.consoles.get(&p).cloned()).unwrap_or_default();
            let confirmed = list.iter().any(|c| c.id == want && c.watchers.iter().any(|w| w.tag.as_deref() == Some(tag.as_str())));
            if confirmed || !list.iter().any(|c| c.id == want) {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.showing = None;
                }
            }
        }
    }

    /// La consola que muestra la ventana: la que la tiene entre quienes miran, por su etiqueta.
    fn mine(&self, id: window::Id) -> Option<String> {
        let win = self.windows.get(&id)?;
        if let Some(s) = &win.showing {
            return Some(s.clone());
        }
        let list = self.consoles.get(win.profile.as_ref()?)?;
        list.iter().find(|c| c.watchers.iter().any(|w| w.tag.as_deref() == Some(win.tag.as_str()))).map(|c| c.id.clone())
    }

    /// Cambiar de consola SIN cerrar la actual y SIN reiniciar nada: el cliente de la ventana
    /// cambia por la misma conexión con sus atajos (Ctrl+] a<id>⏎ / Ctrl+] n). Antes se soltaba
    /// la consola, salía el cliente y arrancaba otro: varios cientos de ms de espera.
    fn switch_to(&mut self, id: window::Id, next: Pending) -> Task<Message> {
        if !self.panel_ready() {
            return Task::none();
        }
        let Some(win) = self.windows.get_mut(&id) else { return Task::none() };
        if !matches!(win.mode, Mode::Console) || win.profile.is_none() {
            return Task::none();
        }
        let keys = match &next {
            Pending::Attach(cid) => format!("\x1da{cid}\r"),
            Pending::New => "\x1dn".to_string(),
            Pending::Close => "\x1dd".to_string(),
        };
        win.showing = match &next {
            Pending::Attach(cid) => Some(cid.clone()),
            Pending::New | Pending::Close => None,
        };
        match win.term.as_mut() {
            Some(term) => term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(keys.into_bytes()))),
            // Sin TTY (un error a la vista): se arranca directamente.
            None => {
                win.pending = Some(next);
                return self.ended(id);
            }
        };
        // La lista, enseguida y otra vez al poco (lo que tarda el agente en repintar).
        Task::batch([later(150, Message::Poll), later(700, Message::Poll), self.focus(id)])
    }

    fn focus(&self, id: window::Id) -> Task<Message> {
        match self.windows.get(&id).and_then(|w| w.term.as_ref()) {
            Some(term) => iced_term::TerminalView::focus(term.widget_id().clone()),
            None => Task::none(),
        }
    }

    /// Cerrar una ventana. La regla (la que se lee igual que se usa): **cerrar una ventana cierra
    /// la consola que está mostrando, salvo que la esté mirando otra ventana u otro aparato, o que
    /// esté en segundo plano.** Las que dejó atrás al cambiar desde el panel siguen sueltas.
    ///
    /// Primero se SUELTA (Ctrl+] d): el agente, por su cuenta, mataría la consola que esta ventana
    /// abrió, la mire quien la mire. Luego, si toca, se cierra la que se mostraba.
    fn request_close(&mut self, id: window::Id) -> Task<Message> {
        if self.panel_ready() {
            if let (Some(cid), Some(win)) = (self.mine(id), self.windows.get(&id)) {
                let profile = win.profile.clone().unwrap_or_default();
                let tag = win.tag.clone();
                // Quién mira, preguntado en el momento (la lista guardada puede tener 1,5 s).
                let list = self.profile_dir(&profile).and_then(|d| agent_list(&d)).unwrap_or_default();
                let others = list
                    .iter()
                    .find(|c| c.id == cid)
                    .is_some_and(|c| c.watchers.iter().any(|w| w.tag.as_deref() != Some(tag.as_str())));
                let background = self.background.contains(&(profile, cid.clone()));
                let win = self.windows.get_mut(&id).expect("window");
                if let (Some(term), Mode::Console) = (win.term.as_mut(), &win.mode) {
                    win.kill_on_close = (!others && !background).then_some(cid);
                    win.pending = Some(Pending::Close);
                    term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(b"\x1dd".to_vec())));
                    // Si el cliente no contesta (colgado), la ventana se cierra igual al rato.
                    return later(3000, Message::ForceClose(id));
                }
            }
        }
        self.close(id)
    }

    /// Cerrar ya la ventana, y la consola que mostraba si `request_close` decidió cerrarla.
    fn finish_close(&mut self, id: window::Id) -> Task<Message> {
        let kill = self.windows.get_mut(&id).and_then(|w| w.kill_on_close.take().map(|c| (w.profile.clone(), c)));
        if let Some((Some(p), cid)) = kill {
            if let Some(dir) = self.profile_dir(&p) {
                agent_send(&dir, &serde_json::json!({ "type": "kill", "id": cid }));
            }
        }
        self.close(id)
    }

    fn close(&mut self, id: window::Id) -> Task<Message> {
        // La última ventana: se cierran las consolas que usaron las ventanas de la app, salvo las
        // dejadas en segundo plano y las que esté mirando alguien más (otro aparato, otra terminal).
        if self.windows.len() == 1 && self.windows.contains_key(&id) {
            self.poll_consoles();
            let ours: Vec<String> = self.windows.values().map(|w| w.tag.clone()).collect();
            for (p, cid) in self.tracked.clone() {
                if self.background.contains(&(p.clone(), cid.clone())) {
                    continue;
                }
                let Some(c) = self.consoles.get(&p).and_then(|l| l.iter().find(|c| c.id == cid)) else { continue };
                let others = c.watchers.iter().any(|w| !w.tag.as_ref().is_some_and(|t| ours.contains(t)));
                if !others {
                    if let Some(dir) = self.profile_dir(&p) {
                        agent_send(&dir, &serde_json::json!({ "type": "kill", "id": cid }));
                    }
                }
            }
        }
        if let Some(win) = self.windows.remove(&id) {
            if let Some(term) = win.term {
                self.by_term.remove(&term.id);
            }
        }
        let close = window::close(id);
        if self.windows.is_empty() { close.chain(iced::exit()) } else { close }
    }

    /// La TTY de la ventana terminó.
    fn ended(&mut self, id: window::Id) -> Task<Message> {
        let Some(win) = self.windows.get(&id) else { return Task::none() };
        log(&format!("client ended: window {} profile {:?} pending {}", win.tag, win.profile, win.pending.is_some()));
        match &win.mode {
            // La shell salió, o se soltó la consola: la ventana se va, como cualquier terminal.
            // Salvo que su perfil haya cambiado de nombre (`dotrino-terminal rename` desde esta
            // misma consola): entonces la ventana sigue, en el perfil con su nombre nuevo.
            // La ventana soltó su consola para pasar a otra (panel lateral): sigue, en esa.
            Mode::Console if matches!(win.pending, Some(Pending::Close)) => self.finish_close(id),
            Mode::Console if win.pending.is_some() => {
                let win = self.windows.get_mut(&id).expect("window");
                match win.pending.take() {
                    Some(Pending::Attach(cid)) => win.attach = Some(cid),
                    _ => win.attach = None,
                }
                self.start(id, Mode::Console);
                self.focus(id)
            }
            Mode::Console => {
                let current = win.profile.clone();
                let before: Vec<String> = self.profiles.iter().map(|p| p.name.clone()).collect();
                let _ = self.reload_profiles();
                let names: Vec<String> = self.profiles.iter().map(|p| p.name.clone()).collect();
                let renamed = current.as_ref().filter(|p| !names.contains(p)).and_then(|_| {
                    match names.iter().filter(|n| !before.contains(n)).collect::<Vec<_>>().as_slice() {
                        [only] => Some((*only).clone()),
                        _ => None,
                    }
                });
                match renamed {
                    Some(new) => {
                        if let Some(win) = self.windows.get_mut(&id) {
                            win.profile = Some(new);
                        }
                        self.start(id, Mode::Console);
                        self.focus(id)
                    }
                    None => self.close(id),
                }
            }
            // Terminó el enlace: si quedó un perfil enlazado nuevo, la ventana pasa a él; si
            // no (se canceló, falló), vuelve al que tenía.
            Mode::Linking { linked_before } => {
                let before = linked_before.clone();
                let reloaded = self.reload_profiles();
                let fresh = linked_names(&self.profiles).into_iter().find(|n| !before.contains(n));
                if let Some(win) = self.windows.get_mut(&id) {
                    if let Some(name) = fresh {
                        save_last_profile(&name);
                        win.profile = Some(name);
                    }
                }
                self.start(id, Mode::Console);
                if let (Err(e), Some(win)) = (reloaded, self.windows.get_mut(&id)) {
                    win.error = Some(e);
                }
                self.focus(id)
            }
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::NewWindow(from) | Message::NewWindowFresh(from) => {
                let fresh = matches!(message, Message::NewWindowFresh(_));
                let from = from.and_then(|id| self.windows.get(&id));
                let profile = from.and_then(|w| w.profile.clone());
                let cwd = from.map(|w| w.cwd.clone()).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_default();
                let _ = self.reload_profiles();
                let free = if fresh { None } else { profile.as_deref().and_then(|p| self.free_console(p)) };
                self.open_window_on(profile, cwd, free).1
            }
            Message::ToggleBackground(id, cid) => {
                if let Some(p) = self.windows.get(&id).and_then(|w| w.profile.clone()) {
                    let key = (p, cid);
                    if !self.background.remove(&key) {
                        self.background.insert(key);
                    }
                    save_background(&self.background);
                }
                Task::none()
            }
            Message::Opened(id) => self.focus(id),
            Message::Close(id) => self.request_close(id),
            Message::ForceClose(id) => {
                if self.windows.contains_key(&id) { self.finish_close(id) } else { Task::none() }
            }
            Message::SwitchProfile(id, name) => {
                let Some(win) = self.windows.get_mut(&id) else { return Task::none() };
                if win.profile == name && matches!(win.mode, Mode::Console) {
                    return self.focus(id);
                }
                // Elegir un perfil a mano lo deja como el de las ventanas siguientes.
                if let Some(n) = &name {
                    save_last_profile(n);
                }
                // Cambiar de perfil deja la orden de `-x`: la ventana pasa a ser una consola.
                win.command = None;
                win.profile = name;
                self.start(id, Mode::Console);
                self.focus(id)
            }
            Message::InstallClient(id) => {
                // En una ventana APARTE y en marcha ya: la persona lo pidió desde el menú (§15), la
                // salida queda a la vista hasta Enter, y su consola sigue donde estaba. Con el PATH
                // de inicio de sesión: ahí está el npm de nvm o Homebrew.
                let path = match login_path() {
                    Ok(p) => p,
                    Err(e) => {
                        if let Some(w) = self.windows.get_mut(&id) {
                            w.error = Some(e);
                        }
                        return Task::none();
                    }
                };
                let ok = t("Listo: dotrino-terminal está al día. El agente que ya corría sigue con la versión anterior hasta que se reinicie.", "Done: dotrino-terminal is up to date. An agent that was already running keeps the old version until it restarts.");
                let fail = t("No se pudo. Si dice EACCES, tu npm instala en una carpeta del sistema: usa nvm, o instálalo con sudo.", "It failed. If it says EACCES, your npm installs into a system folder: use nvm, or install it with sudo.");
                let no_npm = t("No encuentro npm: instala Node 20 o más reciente (https://nodejs.org).", "Can't find npm: install Node 20 or newer (https://nodejs.org).");
                let close = t("Pulsa Enter para cerrar.", "Press Enter to close.");
                let script = format!(
                    "PATH={}; export PATH; if command -v npm >/dev/null; then echo '$ npm install -g {CLIENT_PKG}@latest'; npm install -g {CLIENT_PKG}@latest && echo && echo {} || {{ echo; echo {}; }}; else echo {}; fi; echo; echo {}; read _",
                    sh_quote(&path), sh_quote(&ok), sh_quote(&fail), sh_quote(&no_npm), sh_quote(&close)
                );
                let cwd = self.windows.get(&id).map(|w| w.cwd.clone()).unwrap_or_default();
                self.awaiting_client = true;
                self.open_window(None, cwd, Some(vec!["/bin/sh".into(), "-c".into(), script])).1
            }
            Message::CheckClient => {
                // Se mira hasta que haya un cliente que entienda el panel (o, si no había ninguno,
                // hasta que aparezca): su versión cambia al actualizarlo, aunque ya estuviera.
                if let Ok(launch) = resolve() {
                    let had = self.launch.is_ok();
                    let ready = launch.version.is_some_and(|v| v >= PANEL_CLIENT);
                    self.launch = Ok(launch);
                    let _ = self.reload_profiles();
                    if ready || !had {
                        self.awaiting_client = false;
                    }
                }
                Task::none()
            }
            Message::Rename(id) => {
                // Como «Instalar»: la orden queda escrita en TU consola, sin Enter, y el nombre
                // nuevo lo completas tú. Al acabar, la ventana sigue en el perfil renombrado.
                let _ = self.reload_profiles();
                if let Some(win) = self.windows.get_mut(&id) {
                    if let (Some(from), Some(term)) = (win.profile.clone(), win.term.as_mut()) {
                        let order = format!("dotrino-terminal rename {from} ");
                        term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(order.into_bytes())));
                    }
                }
                self.focus(id)
            }
            Message::Lock(id, set) => {
                // Como «Renombrar»: la orden corre en TU consola, a la vista. La clave se teclea
                // ahí (no se ve) y vale al momento para los otros aparatos, sin reiniciar nada.
                if let Some(win) = self.windows.get_mut(&id) {
                    if let (Some(profile), Some(term)) = (win.profile.clone(), win.term.as_mut()) {
                        let order = format!("dotrino-terminal lock{} --name {profile}\r", if set { "" } else { " --off" });
                        term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(order.into_bytes())));
                    }
                }
                self.focus(id)
            }
            Message::Enroll(id) => {
                let _ = self.reload_profiles();
                let linked_before = linked_names(&self.profiles);
                self.start(id, Mode::Linking { linked_before });
                self.focus(id)
            }
            Message::Copy(id) => {
                let selected = self.windows.get(&id).and_then(|w| w.term.as_ref()).map(|t| t.selected_text()).unwrap_or_default();
                if selected.is_empty() { self.focus(id) } else { iced::clipboard::write(selected).chain(self.focus(id)) }
            }
            Message::CopyText(id, selected) => {
                self.clear_stray_selection(id);
                if selected.is_empty() { self.focus(id) } else { iced::clipboard::write(selected).chain(self.focus(id)) }
            }
            Message::Paste(id) => iced::clipboard::read().map(move |c| Message::Pasted(id, c)),
            Message::Pasted(id, content) => {
                self.clear_stray_selection(id);
                if let (Some(data), Some(term)) = (content, self.windows.get_mut(&id).and_then(|w| w.term.as_mut())) {
                    // Entre corchetes si la shell lo pidió: lo pegado no se ejecuta solo.
                    let bytes = term.paste_bytes(&data);
                    term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(bytes)));
                }
                self.focus(id)
            }
            Message::MenuRoot => Task::none(),
            Message::ScrollTo(id, target) => {
                if let Some(term) = self.windows.get_mut(&id).and_then(|w| w.term.as_mut()) {
                    let (offset, _, _) = term.scroll_position();
                    let delta = target.round() as i32 - offset as i32;
                    if delta != 0 {
                        term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Scroll(delta)));
                    }
                }
                Task::none()
            }
            Message::TogglePin(id) => {
                // ⤢: esta ventana fija el tamaño de su consola, o lo suelta (Ctrl+] p / u).
                let pinned = self.pinned_here(id);
                if let Some(term) = self.windows.get_mut(&id).and_then(|w| w.term.as_mut()) {
                    let keys: &[u8] = if pinned { b"\x1du" } else { b"\x1dp" };
                    term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(keys.to_vec())));
                }
                Task::batch([later(200, Message::Poll), self.focus(id)])
            }
            Message::ToggleSidebar(id) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.sidebar = !w.sidebar;
                }
                Task::none()
            }
            Message::CollapseSidebar(id) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.sidebar_collapsed = !w.sidebar_collapsed;
                }
                Task::none()
            }
            Message::Poll => {
                self.poll_consoles();
                Task::none()
            }
            Message::ShowConsole(id, cid) => {
                if self.mine(id).as_deref() == Some(cid.as_str()) {
                    return self.focus(id);
                }
                if self.dying.contains(&cid) {
                    return self.focus(id);
                }
                // El panel puede ir un instante por detrás del agente (se acaba de cerrar esa
                // consola): se le pregunta AHORA. Si ya no existe, no se cambia a nada: se
                // refresca el panel y la ventana sigue en la suya.
                let exists = self
                    .windows
                    .get(&id)
                    .and_then(|w| w.profile.clone())
                    .and_then(|p| self.profile_dir(&p))
                    .and_then(|dir| agent_list(&dir))
                    .is_some_and(|l| l.iter().any(|c| c.id == cid));
                if !exists {
                    log(&format!("show-console: {cid} is gone; panel refreshed"));
                    self.poll_consoles();
                    return self.focus(id);
                }
                self.switch_to(id, Pending::Attach(cid))
            }
            Message::NewConsole(id) => self.switch_to(id, Pending::New),
            Message::OpenInNewWindow(id, cid) => {
                let Some(win) = self.windows.get(&id) else { return Task::none() };
                let (profile, cwd) = (win.profile.clone(), win.cwd.clone());
                // La ventana nueva nace ya enganchada a esa consola.
                self.open_window_on(profile, cwd, Some(cid)).1
            }
            Message::KillConsole(id, cid) => {
                // ¿Es la de esta ventana? Se pregunta ANTES de sacarla del panel: «la mía» se
                // lee de esa misma lista.
                let is_mine = self.mine(id).as_deref() == Some(cid.as_str());
                self.dying.insert(cid.clone());
                for list in self.consoles.values_mut() {
                    list.retain(|c| c.id != cid);
                }
                // Si es la de esta ventana, la ventana no se cierra: PRIMERO pasa a otra consola
                // abierta (o a una nueva) y luego se mata la vieja; al revés, el cliente vería
                // terminar su consola y la ventana se cerraría.
                if is_mine {
                    let other = self
                        .windows
                        .get(&id)
                        .and_then(|w| w.profile.clone())
                        .and_then(|p| self.consoles.get(&p))
                        .and_then(|list| list.iter().find(|c| c.id != cid).map(|c| c.id.clone()));
                    let switch = self.switch_to(id, other.map(Pending::Attach).unwrap_or(Pending::New));
                    return switch.chain(later(400, Message::KillNow(id, cid)));
                }
                self.update(Message::KillNow(id, cid))
            }
            Message::KillNow(id, cid) => {
                if let Some(dir) = self.windows.get(&id).and_then(|w| w.profile.clone()).and_then(|p| self.profile_dir(&p)) {
                    agent_send(&dir, &serde_json::json!({ "type": "kill", "id": cid }));
                }
                // Fuera del panel YA: el agente tarda un instante en cerrarla, y preguntarle en
                // este mismo momento la devolvía — quedaba una entrada de una consola muerta.
                for list in self.consoles.values_mut() {
                    list.retain(|c| c.id != cid);
                }
                Task::batch([later(300, Message::Poll), self.focus(id)])
            }
            Message::Help => {
                let _ = open::that_detached(help_url());
                Task::none()
            }
            Message::Terminal(iced_term::Event::BackendCall(term_id, cmd)) => {
                let Some(&id) = self.by_term.get(&term_id) else { return Task::none() };
                let Some(win) = self.windows.get_mut(&id) else { return Task::none() };
                let Some(term) = win.term.as_mut() else { return Task::none() };
                match term.handle(iced_term::Command::ProxyToBackend(cmd)) {
                    iced_term::actions::Action::Shutdown => self.ended(id),
                    iced_term::actions::Action::ChangeTitle(title) => {
                        win.title = title;
                        Task::none()
                    }
                    _ => Task::none(),
                }
            }
        }
    }

    /// La barra de menú de la ventana: Archivo, Editar, Perfil, Ayuda.
    fn menu(&self, id: window::Id, win: &Win) -> Element<'_, Message> {
        // Mientras la ventana enrola o instala, no se ofrece otra cosa que la cambie.
        let linking = matches!(win.mode, Mode::Linking { .. });
        let (new_key, close_key, copy_key, paste_key) = if cfg!(target_os = "macos") {
            ("⌘N", "⌘W", "⌘C", "⌘V")
        } else {
            ("Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Shift+C", "Ctrl+Shift+V")
        };
        let file = Menu::new(vec![
            Item::new(entry(t("Nueva ventana", "New window"), new_key, Some(Message::NewWindow(Some(id))))),
            Item::new(entry(
                t("Nueva ventana con consola nueva", "New window with a new console"),
                if cfg!(target_os = "macos") { "⌘T" } else { "Ctrl+Shift+T" },
                Some(Message::NewWindowFresh(Some(id))),
            )),
            Item::new(entry(t("Cerrar ventana", "Close window"), close_key, Some(Message::Close(id)))),
        ]);
        let edit = Menu::new(vec![
            Item::new(entry(t("Copiar", "Copy"), copy_key, Some(Message::Copy(id)))),
            Item::new(entry(t("Pegar", "Paste"), paste_key, Some(Message::Paste(id)))),
        ]);
        let mark = |on: bool| if on && !linking { "●  " } else { "     " };
        let mut profiles = vec![Item::new(entry(
            format!("{}{}", mark(win.profile.is_none()), t("Sin perfil (terminal normal)", "No profile (plain terminal)")),
            "",
            Some(Message::SwitchProfile(id, None)),
        ))];
        profiles.extend(self.profiles.iter().map(|p| {
            let on = win.profile.as_deref() == Some(p.name.as_str());
            Item::new(entry(format!("{}{p}", mark(on)), "", Some(Message::SwitchProfile(id, Some(p.name.clone())))))
        }));
        profiles.push(Item::new(separator()));
        // Renombrar el perfil de ESTA ventana (sin perfil no hay nada que renombrar).
        let rename_label = match &win.profile {
            Some(p) => format!("{} «{p}»…", t("Renombrar", "Rename")),
            None => t("Renombrar perfil…", "Rename profile…"),
        };
        profiles.push(Item::new(entry(rename_label, "", (!linking && self.launch.is_ok() && win.profile.is_some() && win.term.is_some()).then_some(Message::Rename(id)))));
        // La clave que piden los otros aparatos para abrir consolas de este perfil (opcional).
        let can_lock = !linking && self.launch.is_ok() && win.profile.is_some() && win.term.is_some();
        profiles.push(Item::new(entry(t("Poner o cambiar la clave…", "Set or change the code…"), "", can_lock.then_some(Message::Lock(id, true)))));
        profiles.push(Item::new(entry(t("Quitar la clave", "Remove the code"), "", can_lock.then_some(Message::Lock(id, false)))));
        // Sin el cliente no hay perfiles ni enrolar: se ve deshabilitado, y la razón a la vista.
        profiles.push(Item::new(entry(t("Enrolar…", "Enroll…"), "", (!linking && self.launch.is_ok()).then_some(Message::Enroll(id)))));
        if let Err(why) = &self.launch {
            profiles.push(Item::new(note(why.clone())));
        }
        let install_label = if self.launch.is_ok() { t("Actualizar dotrino-terminal…", "Update dotrino-terminal…") } else { t("Instalar dotrino-terminal…", "Install dotrino-terminal…") };
        // Corre en una ventana aparte.
        profiles.push(Item::new(entry(install_label, "", (!linking).then_some(Message::InstallClient(id)))));
        let pin_on = self.pinned_here(id);
        let view_menu = Menu::new(vec![
            Item::new(entry(
                format!("{}{}", if win.sidebar { "✓  " } else { "     " }, t("Panel de consolas", "Consoles panel")),
                if cfg!(target_os = "macos") { "⌘B" } else { "Ctrl+Shift+B" },
                Some(Message::ToggleSidebar(id)),
            )),
            // ⤢ Quién manda en el tamaño: esta ventana, si se marca (con un cliente ≥ 0.14).
            Item::new(entry(
                format!("{}{}", if pin_on { "✓  " } else { "     " }, t("Esta ventana manda en el tamaño", "This window sets the size")),
                "",
                (self.pin_ready() && win.profile.is_some() && self.mine(id).is_some()).then_some(Message::TogglePin(id)),
            )),
        ]);
        let help = Menu::new(vec![
            Item::new(entry(t("Cómo se usa", "How to use it"), "", Some(Message::Help))),
            Item::new(entry(format!("Dotrino Terminal {VERSION}"), "", None)),
        ]);
        let root = |label: String, menu: Menu<'static, Message, Theme, iced::Renderer>| Item::with_menu(top(label), menu.width(300.0).offset(2.0).padding(4));
        let bar = MenuBar::new(vec![
            root(t("Archivo", "File"), file),
            root(t("Editar", "Edit"), edit),
            root(t("Ver", "View"), view_menu),
            root(t("Perfil", "Profile"), Menu::new(profiles)),
            root(t("Ayuda", "Help"), help),
        ])
        .spacing(2.0)
        .padding([2, 4]);
        container(bar)
            .width(Length::Fill)
            .style(|theme: &Theme| container::Style { background: Some(theme.extended_palette().background.weak.color.into()), ..Default::default() })
            .into()
    }

    fn view(&self, id: window::Id) -> Element<'_, Message> {
        let Some(win) = self.windows.get(&id) else { return text("").into() };
        let body: Element<'_, Message> = match (&win.term, &win.error) {
            // Con la clave del terminal: cada TTY nueva estrena el estado del widget. Sin ella, al
            // cambiar de perfil (o enrolar, renombrar) el widget conservaba el tamaño de la
            // anterior, no se lo decía al PTY nuevo, y este se quedaba en 80×50: desbordado.
            (Some(term), None) => {
                // Si el tamaño de la consola lo tiene otra pantalla, se dibuja a ESE tamaño y el resto
                // de la ventana queda vacío, como en la PWA: así se ve que la consola es más chica.
                let (w, h) = match self.followed_size(id) {
                    Some((cols, rows)) => {
                        let cell = term.cell_size();
                        (Length::Fixed(cols as f32 * cell.width + 1.0), Length::Fixed(rows as f32 * cell.height + 1.0))
                    }
                    None => (Length::Fill, Length::Fill),
                };
                let view = keyed_column([(term.id, iced_term::TerminalView::show(term).map(Message::Terminal))])
                    .width(w)
                    .height(h);
                // La barra de desplazamiento: solo si hay historial. Arriba es el principio.
                let (offset, history, screen) = term.scroll_position();
                let view: Element<'_, Message> = if history > 0 {
                    // El asa mide lo que se ve frente al total (con un mínimo para poder agarrarla).
                    let line_px = self.font.size * self.font.scale_factor;
                    let track = screen as f32 * line_px;
                    let handle = (track * screen as f32 / (history + screen) as f32).max(24.0) as u16;
                    let bar = iced::widget::vertical_slider(0.0..=history as f32, offset as f32, move |v| Message::ScrollTo(id, v))
                        .width(10)
                        .style(move |theme: &Theme, status| scrollbar(theme, status, handle));
                    row![view, container(bar).padding([2, 1])].height(h).into()
                } else {
                    view.into()
                };
                // Clic derecho: Copiar y Pegar, lo mismo que el menú Editar.
                ContextMenu::new(view, move || {
                    let selected = term.selected_text();
                    let (copy_key, paste_key) = if cfg!(target_os = "macos") { ("⌘C", "⌘V") } else { ("Ctrl+Shift+C", "Ctrl+Shift+V") };
                    container(
                        column![
                            entry(t("Copiar", "Copy"), copy_key, (!selected.is_empty()).then(|| Message::CopyText(id, selected.clone()))),
                            entry(t("Pegar", "Paste"), paste_key, Some(Message::Paste(id))),
                        ]
                        .width(220),
                    )
                    .padding(4)
                    .style(|theme: &Theme| container::Style {
                        background: Some(theme.extended_palette().background.weak.color.into()),
                        border: Border::default().rounded(6.0),
                        ..Default::default()
                    })
                    .into()
                })
                .into()
            }
            (_, Some(err)) => column![text("Dotrino Terminal").size(22), text(err.clone()).font(iced::Font::MONOSPACE)]
                .spacing(16)
                .padding(24)
                .into(),
            (None, None) => text("").into(),
        };
        let main: Element<'_, Message> = match (win.sidebar, &win.profile) {
            (true, Some(profile)) => row![self.side(id, profile), container(body).width(Length::Fill).height(Length::Fill)].into(),
            _ => container(body).width(Length::Fill).height(Length::Fill).into(),
        };
        column![self.menu(id, win), main].into()
    }

    /// Clic derecho sobre una consola del panel (colapsado o no): lo que se puede hacer con ella.
    fn console_menu<'a>(&self, id: window::Id, cid: String, is_mine: bool, under: Element<'a, Message>) -> Element<'a, Message> {
        let ready = self.panel_ready();
        let in_bg = self.windows.get(&id).and_then(|w| w.profile.clone()).is_some_and(|p| self.background.contains(&(p, cid.clone())));
        let bg_label = if in_bg { t("Quitar de segundo plano", "Remove from background") } else { t("Dejar en segundo plano", "Keep in background") };
        let pin_label = if self.pinned_here(id) { t("Soltar el tamaño", "Release the size") } else { t("Usar el tamaño de esta ventana", "Use this window's size") };
        let can_pin = is_mine && self.pin_ready();
        ContextMenu::new(under, move || {
            let here = (!is_mine && ready).then(|| Message::ShowConsole(id, cid.clone()));
            container(
                column![
                    entry(t("Abrir aquí", "Open here"), "", here),
                    entry(t("Abrir en otra ventana", "Open in another window"), "", Some(Message::OpenInNewWindow(id, cid.clone()))),
                    // Las de segundo plano siguen vivas al cerrar la app; las demás se cierran con ella.
                    entry(bg_label.clone(), "", Some(Message::ToggleBackground(id, cid.clone()))),
                    entry(pin_label.clone(), "", can_pin.then_some(Message::TogglePin(id))),
                    separator(),
                    entry(t("Cerrar consola", "Close console"), "", Some(Message::KillConsole(id, cid.clone()))),
                ]
                .width(220),
            )
            .padding(4)
            .style(|theme: &Theme| container::Style {
                background: Some(theme.extended_palette().background.weak.color.into()),
                border: Border::default().rounded(6.0),
                ..Default::default()
            })
            .into()
        })
        .into()
    }

    /// El panel lateral: un botón por cada consola abierta en el perfil de la ventana.
    fn side(&self, id: window::Id, profile: &str) -> Element<'_, Message> {
        let mine = self.mine(id);
        let list = self.consoles.get(profile).cloned().unwrap_or_default();
        let my_tag = self.windows.get(&id).map(|w| w.tag.clone()).unwrap_or_default();
        let panel_style = |theme: &Theme| container::Style { background: Some(theme.extended_palette().background.weak.color.into()), ..Default::default() };
        // Colapsado: una franja estrecha, un botón numerado por consola (el título, al pasar).
        let collapsed = self.windows.get(&id).is_some_and(|w| w.sidebar_collapsed);
        // Con un cliente viejo, nada de lo que cambia de consola funciona: deshabilitado, y por qué.
        let ready = self.panel_ready();
        let why = t("Actualiza dotrino-terminal (Perfil → Actualizar) para usar el panel", "Update dotrino-terminal (Profile → Update) to use the panel");
        let act = |m: Message| ready.then_some(m);
        let centered = |s: String, size: u32| text(s).size(size).width(Length::Fill).align_x(iced::alignment::Horizontal::Center);
        // ⤢ actúa sobre la consola de ESTA ventana: fija su tamaño a esta ventana, o lo suelta.
        let cur = list.iter().enumerate().find(|(_, c)| mine.as_deref() == Some(c.id.as_str())).map(|(i, c)| (c.n.map(|n| n as usize).unwrap_or(i + 1), c));
        let pin_on = self.pinned_here(id);
        let can_pin = self.pin_ready() && cur.is_some();
        let pin_tip = match cur {
            _ if !self.pin_ready() => t("Actualiza dotrino-terminal (Perfil → Actualizar) para elegir el tamaño", "Update dotrino-terminal (Profile → Update) to choose the size"),
            Some((n, _)) if pin_on => format!("{} {n} {}", t("Soltar: la consola", "Release: console"), t("deja de usar el tamaño de esta ventana", "stops using this window's size")),
            Some((n, _)) => format!("{} {n}", t("Usar el tamaño de esta ventana en la consola", "Use this window's size for console")),
            None => t("Usar el tamaño de esta ventana", "Use this window's size"),
        };
        let pin_btn = |w: f32| -> Element<'_, Message> {
            let icon = iced::widget::svg(iced::widget::svg::Handle::from_memory(ICON_SIZE)).width(14).height(14).style(move |theme: &Theme, _| iced::widget::svg::Style { color: Some(if pin_on { theme.palette().primary } else { theme.extended_palette().background.base.text.scale_alpha(0.7) }) });
            let b = button(container(icon).center_x(Length::Fill)).width(w).padding([4, 0]).style(if pin_on { side_selected } else { menu_button }).on_press_maybe(can_pin.then_some(Message::TogglePin(id)));
            iced::widget::tooltip(b, container(text(pin_tip.clone()).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right).into()
        };
        if collapsed {
            let mut strip = column![
                button(centered("»".into(), 13)).width(24).padding([2, 0]).style(menu_button).on_press(Message::CollapseSidebar(id)),
                button(centered("+".into(), 14)).width(24).padding([2, 0]).style(menu_button).on_press_maybe(act(Message::NewConsole(id))),
                pin_btn(24.0),
            ]
            .spacing(4)
            .align_x(iced::Alignment::Center);
            for (i, c) in list.iter().enumerate() {
                let n = c.n.map(|n| n as usize).unwrap_or(i + 1);
                let is_mine = mine.as_deref() == Some(c.id.as_str());
                let tip = if c.title.is_empty() { format!("{} {}", t("Consola", "Console"), n) } else { c.title.clone() };
                let b = button(centered(format!("{n}"), 12))
                    .width(24)
                    .padding([4, 0])
                    .style(console_button(is_mine, c.act()))
                    .on_press_maybe(act(Message::ShowConsole(id, c.id.clone())));
                let b = self.console_menu(id, c.id.clone(), is_mine, container(b).center_x(Length::Fill).into());
                let tip = match c.act() {
                    Act::Busy => format!("{tip} · {}", t("trabajando", "working")),
                    Act::Done => format!("{tip} · {}", t("terminó", "finished")),
                    Act::Idle => tip,
                };
                let tip = if ready { tip } else { format!("{tip}\n{why}") };
                strip = strip.push(iced::widget::tooltip(b, container(text(tip).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right));
            }
            // Lo justo para dos dígitos («00»): 24 px de botón en 30 de franja.
            return container(iced::widget::scrollable(strip)).width(30).height(Length::Fill).padding([4, 3]).style(panel_style).into();
        }
        // Como en la franja colapsada: «« » arriba y «+» en su propia fila, debajo.
        let mut items = column![
            row![
                button(text("«").size(13)).padding([0, 6]).style(menu_button).on_press(Message::CollapseSidebar(id)),
                text(t("Consolas", "Consoles")).size(13),
            ]
            .spacing(4)
            .align_y(iced::Alignment::Center)
            .padding([4, 2]),
            // El «+» en la misma columna que las «×» de abajo.
            row![
                text(t("Nueva consola", "New console")).size(12).width(Length::Fill),
                button(text("+").size(14)).padding([2, 6]).style(menu_button).on_press_maybe(act(Message::NewConsole(id))),
            ]
            .align_y(iced::Alignment::Center)
            .padding(iced::Padding { left: 8.0, ..Default::default() }),
        ]
        .spacing(2);
        // Quién tiene el tamaño de la consola de esta ventana, y el ⤢ para quedárselo.
        if let Some((n, c)) = cur {
            let who = match c.size_by.as_ref() {
                Some(b) if b.tag.is_some() && b.tag.as_deref() == Some(my_tag.as_str()) => t("esta ventana", "this window"),
                Some(b) if b.origin.as_deref() == Some("remote") => t("otro aparato", "another device"),
                Some(_) => t("otra ventana", "another window"),
                None => t("esta ventana", "this window"),
            };
            let how = if c.size_by.as_ref().is_some_and(|b| b.pinned) { t("elegido a propósito", "chosen on purpose") } else { t("lo tiene la última pantalla que la abre", "set by the last screen that opens it") };
            let dim = |theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.65)) };
            items = items.push(
                row![
                    column![
                        text(format!("{} {n}: {who} ({}×{})", t("Tamaño de la", "Size of"), c.cols, c.rows)).size(12),
                        text(how).size(11).style(dim),
                    ]
                    .width(Length::Fill),
                    pin_btn(28.0),
                ]
                .align_y(iced::Alignment::Center)
                .padding(iced::Padding { left: 8.0, ..Default::default() }),
            );
        }
        if !ready {
            items = items.push(note(why.clone()));
        }
        for (i, c) in list.iter().enumerate() {
            let n = c.n.map(|n| n as usize).unwrap_or(i + 1);
            let is_mine = mine.as_deref() == Some(c.id.as_str());
            let others = c.watchers.iter().filter(|w| w.tag.as_deref() != Some(my_tag.as_str())).collect::<Vec<_>>();
            let where_ = if others.iter().any(|w| w.origin == "remote") {
                t("abierta en otro aparato", "open on another device")
            } else if !others.is_empty() {
                t("abierta en otra ventana", "open in another window")
            } else if is_mine {
                t("en esta ventana", "in this window")
            } else if self.background.contains(&(profile.to_string(), c.id.clone())) {
                t("en segundo plano", "in the background")
            } else {
                t("suelta", "detached")
            };
            let where_ = match self.size_owner_text(id, c) {
                Some(size) if !is_mine && c.watchers.len() > 1 || c.size_by.as_ref().is_some_and(|b| b.pinned) => format!("{where_} · {size}"),
                _ => where_,
            };
            let where_ = match c.act() {
                Act::Busy => format!("{where_} · {}", t("trabajando", "working")),
                Act::Done => format!("{where_} · {}", t("terminó", "finished")),
                Act::Idle => where_,
            };
            // Con número: dos consolas con el mismo título (el prompt) se distinguen igual.
            let name = if c.title.is_empty() { format!("{} {}", t("Consola", "Console"), n) } else { format!("{n} · {}", c.title) };
            let label = column![
                text(format!("{}{name}", if is_mine { "● " } else { "" })).size(12),
                text(where_).size(11).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.65)) }),
            ];
            let pick = button(label).width(Length::Fill).padding([4, 8]).style(console_button(is_mine, c.act())).on_press_maybe(act(Message::ShowConsole(id, c.id.clone())));
            let kill = button(text("×").size(13)).padding([4, 6]).style(menu_button).on_press(Message::KillConsole(id, c.id.clone()));
            let entry_row: Element<'_, Message> = row![pick, kill].align_y(iced::Alignment::Center).into();
            items = items.push(self.console_menu(id, c.id.clone(), is_mine, entry_row));
        }
        container(iced::widget::scrollable(items)).width(210).height(Length::Fill).padding(4).style(panel_style).into()
    }

    fn title(&self, id: window::Id) -> String {
        let Some(win) = self.windows.get(&id) else { return String::new() };
        let what = match win.mode {
            Mode::Linking { .. } => t("Enrolar", "Enroll"),
            Mode::Console if win.title.is_empty() => "Dotrino Terminal".to_string(),
            Mode::Console => win.title.clone(),
        };
        match &win.profile {
            Some(p) => format!("{what} — {p}"),
            None => format!("{what} — {}", t("sin perfil", "no profile")),
        }
    }

    fn subscription(&self) -> Subscription<Message> {
        let terms = self.windows.values().filter_map(|w| w.term.as_ref()).map(|term| term.subscription().map(Message::Terminal));
        // Tras «Instalar dotrino-terminal…», se mira cada poco si ya está.
        let waiting = self.awaiting_client.then(|| iced::time::every(std::time::Duration::from_secs(3)).map(|_| Message::CheckClient));
        // El panel lateral: las consolas abiertas se releen cada poco mientras se ve.
        let polling = self.windows.values().any(|w| w.sidebar && w.profile.is_some())
            .then(|| iced::time::every(std::time::Duration::from_millis(1500)).map(|_| Message::Poll));
        Subscription::batch(terms.chain([window::close_requests().map(Message::Close), iced::event::listen_with(shortcut)]).chain(waiting).chain(polling))
    }
}

/// Los atajos del menú Archivo: Ctrl+Shift+N / Ctrl+Shift+W (Cmd+N / Cmd+W en macOS).
/// Copiar y pegar ya los atiende la propia terminal.
fn shortcut(event: Event, _status: iced::event::Status, id: window::Id) -> Option<Message> {
    let Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) = event else { return None };
    let chord = if cfg!(target_os = "macos") {
        modifiers == Modifiers::COMMAND
    } else {
        modifiers == Modifiers::CTRL | Modifiers::SHIFT
    };
    match key.as_ref() {
        Key::Character(c) if chord && c.eq_ignore_ascii_case("n") => Some(Message::NewWindow(Some(id))),
        Key::Character(c) if chord && c.eq_ignore_ascii_case("t") => Some(Message::NewWindowFresh(Some(id))),
        Key::Character(c) if chord && c.eq_ignore_ascii_case("w") => Some(Message::Close(id)),
        Key::Character(c) if chord && c.eq_ignore_ascii_case("b") => Some(Message::ToggleSidebar(id)),
        _ => None,
    }
}

/// El título de un menú de la barra (Archivo, Editar…).
fn top(label: String) -> Element<'static, Message> {
    button(text(label).size(13)).padding([3, 10]).style(menu_button).on_press(Message::MenuRoot).into()
}

/// Una opción de un menú: su nombre y, a la derecha, su atajo. Sin mensaje, deshabilitada.
fn entry(label: String, keys: &str, msg: Option<Message>) -> Element<'static, Message> {
    let keys = text(keys.to_string()).size(12).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().background.strong.color) });
    button(row![text(label).size(13), space::horizontal(), keys].align_y(iced::Alignment::Center))
        .width(Length::Fill)
        .padding([4, 10])
        .style(menu_button)
        .on_press_maybe(msg)
        .into()
}

/// Un mensaje dentro de `ms` milisegundos.
fn later(ms: u64, msg: Message) -> Task<Message> {
    Task::perform(tokio::time::sleep(std::time::Duration::from_millis(ms)), move |_| msg.clone())
}

/// Pregunta al agente de un perfil, por su socket local, qué consolas tiene. `None` si no hay
/// agente escuchando (o no contesta a tiempo): entonces no tiene consolas.
#[cfg(unix)]
fn agent_list(dir: &Path) -> Option<Vec<ConsoleInfo>> {
    use std::io::{BufRead, BufReader, Write};
    let mut sock = std::os::unix::net::UnixStream::connect(dir.join("terminal.sock")).ok()?;
    sock.set_read_timeout(Some(std::time::Duration::from_millis(500))).ok()?;
    sock.write_all(b"{\"type\":\"list\"}\n").ok()?;
    let mut reader = BufReader::new(sock);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(&line).ok()?;
        if v["type"] == "consoles" {
            return serde_json::from_value(v["list"].clone()).ok();
        }
    }
}

/// Le manda una orden al agente de un perfil, sin esperar respuesta.
#[cfg(unix)]
fn agent_send(dir: &Path, msg: &serde_json::Value) {
    use std::io::Write;
    if let Ok(mut sock) = std::os::unix::net::UnixStream::connect(dir.join("terminal.sock")) {
        let _ = sock.write_all(format!("{msg}\n").as_bytes());
    }
}

/// La barra de desplazamiento: un raíl tenue y un asa rectangular, como una barra de verdad.
fn scrollbar(theme: &Theme, status: iced::widget::slider::Status, handle_len: u16) -> iced::widget::slider::Style {
    use iced::widget::slider::{Handle, HandleShape, Rail, Style};
    let p = theme.extended_palette();
    let handle = match status {
        iced::widget::slider::Status::Active => p.background.strong.color,
        _ => p.primary.weak.color,
    };
    Style {
        rail: Rail { backgrounds: (p.background.weak.color.into(), p.background.weak.color.into()), width: 6.0, border: Border::default().rounded(3.0) },
        handle: Handle { shape: HandleShape::Rectangle { width: handle_len, border_radius: 3.0.into() }, background: handle.into(), border_width: 0.0, border_color: Color::TRANSPARENT },
    }
}

/// ⤢ «Usar el tamaño de esta ventana»: flecha diagonal doble, dibujada (no depende de las fuentes
/// del sistema). El color lo pone el estilo del widget.
const ICON_SIZE: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-11 11"/></svg>"#;

fn side_selected(theme: &Theme, status: button::Status) -> button::Style {
    let mut s = menu_button(theme, status);
    if matches!(status, button::Status::Active) {
        s.background = Some(theme.extended_palette().primary.weak.color.into());
    }
    s
}

/// Una línea de texto en un menú que no es una opción: la razón de que algo esté deshabilitado.
fn note(msg: String) -> Element<'static, Message> {
    container(text(msg).size(12).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.7)) }))
        .padding([4, 10])
        .into()
}

fn separator() -> Element<'static, Message> {
    container(rule::horizontal(1)).padding([4, 6]).into()
}

fn menu_button(theme: &Theme, status: button::Status) -> button::Style {
    let palette = theme.extended_palette();
    let base = button::Style {
        text_color: palette.background.base.text,
        border: Border::default().rounded(4.0),
        ..Default::default()
    };
    match status {
        button::Status::Hovered | button::Status::Pressed => base.with_background(palette.primary.weak.color),
        button::Status::Disabled => button::Style { text_color: palette.background.strong.color, ..base },
        button::Status::Active => base.with_background(Color::TRANSPARENT),
    }
}
