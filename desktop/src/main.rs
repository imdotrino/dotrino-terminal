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
    #[serde(default)]
    title: String,
    #[serde(default)]
    watchers: Vec<Watcher>,
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
    next_tag: u64,
}

#[derive(Debug, Clone)]
enum Message {
    /// Otra ventana, con el perfil de la ventana desde la que se pidió.
    NewWindow(Option<window::Id>),
    Opened(window::Id),
    /// La ventana pidió cerrarse (la X, Alt+F4).
    Close(window::Id),
    /// `None`: sin perfil.
    SwitchProfile(window::Id, Option<String>),
    Enroll(window::Id),
    /// Renombrar el perfil de la ventana.
    Rename(window::Id),
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
    /// Cerrarla ya (tras haber pasado la ventana a otra, si era la suya).
    KillNow(window::Id, String),
    ToggleSidebar(window::Id),
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
    Ok(Launch { program, path })
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
        let mut app = App { launch, profiles: Vec::new(), windows: BTreeMap::new(), by_term: HashMap::new(), next_term: 0, awaiting_client: false, font: terminal_font(), palette: terminal_palette(), consoles: HashMap::new(), next_tag: 0 };
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
        let (id, task) = app.open_window(profile, cwd.clone().unwrap_or_default(), cli.command.clone());
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
        self.windows.insert(id, Win { profile, cwd, command, mode: Mode::Console, term: None, title: String::new(), error: None, tag, attach: None, pending: None, showing: None, sidebar: true, sidebar_collapsed: true });
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
        self.consoles = fresh;
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
        let Some(win) = self.windows.get_mut(&id) else { return Task::none() };
        if !matches!(win.mode, Mode::Console) || win.profile.is_none() {
            return Task::none();
        }
        let keys = match &next {
            Pending::Attach(cid) => format!("\x1da{cid}\r"),
            Pending::New => "\x1dn".to_string(),
        };
        win.showing = match &next {
            Pending::Attach(cid) => Some(cid.clone()),
            Pending::New => None,
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

    fn close(&mut self, id: window::Id) -> Task<Message> {
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
        match &win.mode {
            // La shell salió, o se soltó la consola: la ventana se va, como cualquier terminal.
            // Salvo que su perfil haya cambiado de nombre (`dotrino-terminal rename` desde esta
            // misma consola): entonces la ventana sigue, en el perfil con su nombre nuevo.
            // La ventana soltó su consola para pasar a otra (panel lateral): sigue, en esa.
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
            Message::NewWindow(from) => {
                let from = from.and_then(|id| self.windows.get(&id));
                let profile = from.and_then(|w| w.profile.clone());
                let cwd = from.map(|w| w.cwd.clone()).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_default();
                let _ = self.reload_profiles();
                self.open_window(profile, cwd, None).1
            }
            Message::Opened(id) => self.focus(id),
            Message::Close(id) => self.close(id),
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
                // Se escribe en TU consola, sin Enter: la orden queda a la vista en el prompt, la
                // lanza la persona (§15) y su salida se queda donde está. Si faltaba el cliente,
                // la app lo busca cada poco y, al aparecer, el menú Perfil se activa.
                let order = format!("npm install -g {CLIENT_PKG}@latest");
                if let Some(term) = self.windows.get_mut(&id).and_then(|w| w.term.as_mut()) {
                    term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(order.into_bytes())));
                    if self.launch.is_err() {
                        self.awaiting_client = true;
                    }
                }
                self.focus(id)
            }
            Message::CheckClient => {
                if let Ok(launch) = resolve() {
                    self.launch = Ok(launch);
                    self.awaiting_client = false;
                    let _ = self.reload_profiles();
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
                self.switch_to(id, Pending::Attach(cid))
            }
            Message::NewConsole(id) => self.switch_to(id, Pending::New),
            Message::KillConsole(id, cid) => {
                // Si es la de esta ventana, la ventana no se cierra: PRIMERO pasa a otra consola
                // abierta (o a una nueva) y luego se mata la vieja; al revés, el cliente vería
                // terminar su consola y la ventana se cerraría.
                if self.mine(id).as_deref() == Some(cid.as_str()) {
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
                self.poll_consoles();
                self.focus(id)
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
        // Sin el cliente no hay perfiles ni enrolar: se ve deshabilitado, y la razón a la vista.
        profiles.push(Item::new(entry(t("Enrolar…", "Enroll…"), "", (!linking && self.launch.is_ok()).then_some(Message::Enroll(id)))));
        if let Err(why) = &self.launch {
            profiles.push(Item::new(note(why.clone())));
        }
        let install_label = if self.launch.is_ok() { t("Actualizar dotrino-terminal…", "Update dotrino-terminal…") } else { t("Instalar dotrino-terminal…", "Install dotrino-terminal…") };
        // Escribe la orden en la consola de esta ventana: hace falta que haya una.
        profiles.push(Item::new(entry(install_label, "", (!linking && win.term.is_some()).then_some(Message::InstallClient(id)))));
        let view_menu = Menu::new(vec![Item::new(entry(
            format!("{}{}", if win.sidebar { "✓  " } else { "     " }, t("Panel de consolas", "Consoles panel")),
            if cfg!(target_os = "macos") { "⌘B" } else { "Ctrl+Shift+B" },
            Some(Message::ToggleSidebar(id)),
        ))]);
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
                let view = keyed_column([(term.id, iced_term::TerminalView::show(term).map(Message::Terminal))])
                    .width(Length::Fill)
                    .height(Length::Fill);
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

    /// El panel lateral: un botón por cada consola abierta en el perfil de la ventana.
    fn side(&self, id: window::Id, profile: &str) -> Element<'_, Message> {
        let mine = self.mine(id);
        let list = self.consoles.get(profile).cloned().unwrap_or_default();
        let my_tag = self.windows.get(&id).map(|w| w.tag.clone()).unwrap_or_default();
        let panel_style = |theme: &Theme| container::Style { background: Some(theme.extended_palette().background.weak.color.into()), ..Default::default() };
        // Colapsado: una franja estrecha, un botón numerado por consola (el título, al pasar).
        let collapsed = self.windows.get(&id).is_some_and(|w| w.sidebar_collapsed);
        let centered = |s: String, size: u32| text(s).size(size).width(Length::Fill).align_x(iced::alignment::Horizontal::Center);
        if collapsed {
            let mut strip = column![
                button(centered("»".into(), 13)).width(30).padding([2, 0]).style(menu_button).on_press(Message::CollapseSidebar(id)),
                button(centered("+".into(), 14)).width(30).padding([2, 0]).style(menu_button).on_press(Message::NewConsole(id)),
            ]
            .spacing(4)
            .align_x(iced::Alignment::Center);
            for (n, c) in list.iter().enumerate() {
                let is_mine = mine.as_deref() == Some(c.id.as_str());
                let tip = if c.title.is_empty() { format!("{} {}", t("Consola", "Console"), n + 1) } else { c.title.clone() };
                let b = button(centered(format!("{}", n + 1), 12))
                    .width(30)
                    .padding([4, 0])
                    .style(if is_mine { side_selected } else { menu_button })
                    .on_press(Message::ShowConsole(id, c.id.clone()));
                let b = container(b).center_x(Length::Fill);
                strip = strip.push(iced::widget::tooltip(b, container(text(tip).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right));
            }
            return container(iced::widget::scrollable(strip)).width(40).height(Length::Fill).padding([4, 2]).style(panel_style).into();
        }
        let mut items = column![row![
            button(text("«").size(13)).padding([0, 6]).style(menu_button).on_press(Message::CollapseSidebar(id)),
            text(t("Consolas", "Consoles")).size(13),
            space::horizontal(),
            button(text("+").size(14)).padding([0, 8]).style(menu_button).on_press(Message::NewConsole(id)),
        ]
        .spacing(4)
        .align_y(iced::Alignment::Center)
        .padding([4, 6])]
        .spacing(2);
        for (n, c) in list.iter().enumerate() {
            let is_mine = mine.as_deref() == Some(c.id.as_str());
            let others = c.watchers.iter().filter(|w| w.tag.as_deref() != Some(my_tag.as_str())).collect::<Vec<_>>();
            let where_ = if others.iter().any(|w| w.origin == "remote") {
                t("abierta en otro aparato", "open on another device")
            } else if !others.is_empty() {
                t("abierta en otra ventana", "open in another window")
            } else if is_mine {
                t("en esta ventana", "in this window")
            } else {
                t("suelta", "detached")
            };
            // Con número: dos consolas con el mismo título (el prompt) se distinguen igual.
            let name = if c.title.is_empty() { format!("{} {}", t("Consola", "Console"), n + 1) } else { format!("{} · {}", n + 1, c.title) };
            let label = column![
                text(format!("{}{name}", if is_mine { "● " } else { "" })).size(12),
                text(where_).size(11).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.65)) }),
            ];
            let pick = button(label).width(Length::Fill).padding([4, 8]).style(if is_mine { side_selected } else { menu_button }).on_press(Message::ShowConsole(id, c.id.clone()));
            let kill = button(text("×").size(13)).padding([4, 6]).style(menu_button).on_press(Message::KillConsole(id, c.id.clone()));
            items = items.push(row![pick, kill].align_y(iced::Alignment::Center));
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

fn side_selected(theme: &Theme, status: button::Status) -> button::Style {
    let mut s = menu_button(theme, status);
    if matches!(status, button::Status::Active) {
        s.background = Some(theme.extended_palette().primary.weak.color.into());
    }
    s
}

/// Una línea de texto en un menú que no es una opción: la razón de que algo esté deshabilitado.
fn note(msg: String) -> Element<'static, Message> {
    container(text(msg).size(12).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().background.strong.color) }))
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
