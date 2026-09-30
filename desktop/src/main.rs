//! Dotrino Terminal — la app de escritorio (Linux y macOS).
//!
//! Cada ventana es una terminal nativa (`iced` + `iced_term`, sobre `alacritty_terminal`)
//! que ejecuta `dotrino-terminal`, el cliente TTY del paquete `@dotrino/terminal-agent`.
//! La shell no vive aquí: vive en el agente del PERFIL de la ventana, así que lo que se abre
//! aquí también se puede abrir desde los otros aparatos de esa cuenta. Esta app no habla el
//! protocolo del agente; solo pone la ventana y elige el perfil. La lógica de las consolas
//! está en un solo sitio.
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
use iced::widget::{button, column, container, row, rule, space, text};
use iced::{Border, Color, Element, Event, Length, Size, Subscription, Task, Theme, window};
use iced_aw::menu::{Item, Menu, MenuBar};
use serde::Deserialize;

const CLIENT: &str = "dotrino-terminal";
const DEFAULT_PROFILE: &str = "default";
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
}

impl std::fmt::Display for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.id, self.linked) {
            (Some(id), true) => write!(f, "{}  ·  {id}", self.name),
            _ => write!(f, "{}  ·  {}", self.name, t("solo esta máquina", "this machine only")),
        }
    }
}

/// Qué corre en la TTY de la ventana.
enum Mode {
    /// Una consola del agente de `Win::profile`.
    Console,
    /// `dotrino-terminal link`: al terminar se mira qué perfil quedó enlazado.
    Linking { linked_before: Vec<String> },
}

struct Win {
    profile: String,
    mode: Mode,
    term: Option<iced_term::Terminal>,
    title: String,
    error: Option<String>,
}

struct App {
    launch: Result<Launch, String>,
    profiles: Vec<Profile>,
    windows: BTreeMap<window::Id, Win>,
    by_term: HashMap<u64, window::Id>,
    next_term: u64,
}

#[derive(Debug, Clone)]
enum Message {
    /// Otra ventana, con el perfil de la ventana desde la que se pidió.
    NewWindow(Option<window::Id>),
    Opened(window::Id),
    /// La ventana pidió cerrarse (la X, Alt+F4).
    Close(window::Id),
    SwitchProfile(window::Id, String),
    Enroll(window::Id),
    Copy(window::Id),
    Paste(window::Id),
    Pasted(window::Id, Option<String>),
    Help,
    /// El título de un menú de la barra: abrirlo lo hace el propio menú, no hay nada que hacer.
    MenuRoot,
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

/// El PATH de una shell de inicio de sesión del usuario. Una app abierta desde el menú del
/// escritorio (y en macOS, siempre) no hereda el PATH de la terminal, y ahí es donde viven
/// `node` y `dotrino-terminal` (nvm, Homebrew, npm global).
fn login_path() -> Result<String, String> {
    let shell = std::env::var("SHELL").map_err(|_| t("no está definida la variable SHELL", "the SHELL variable is not set"))?;
    let out = Command::new(&shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .output()
        .map_err(|e| format!("{shell}: {e}"))?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || path.is_empty() {
        return Err(t(&format!("{shell} -l no devolvió el PATH"), &format!("{shell} -l did not return the PATH")));
    }
    Ok(path)
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
/// de inicio de sesión. Si no aparece, se dice y la ventana lo enseña: no se abre otra shell
/// en su lugar, porque esa no se vería desde los otros aparatos y nadie se enteraría.
fn resolve() -> Result<Launch, String> {
    let path = login_path()?;
    let program = match std::env::var_os("DOTRINO_TERMINAL_BIN") {
        Some(p) => PathBuf::from(p),
        None => find_in(&path, CLIENT).ok_or_else(|| {
            t(
                "No encuentro «dotrino-terminal».\n\nInstálalo con:\n\n    npm install -g @dotrino/terminal-agent\n\ny vuelve a abrir esta ventana.",
                "Can't find \"dotrino-terminal\".\n\nInstall it with:\n\n    npm install -g @dotrino/terminal-agent\n\nand open this window again.",
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
    serde_json::from_slice(&out.stdout).map_err(|e| format!("dotrino-terminal profiles: {e}"))
}

fn linked_names(profiles: &[Profile]) -> Vec<String> {
    profiles.iter().filter(|p| p.linked).map(|p| p.name.clone()).collect()
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let launch = resolve();
        let mut app = App { launch, profiles: Vec::new(), windows: BTreeMap::new(), by_term: HashMap::new(), next_term: 0 };
        let first = app.reload_profiles().err();
        // Perfil de la primera ventana: `--name <n>` en la línea de órdenes; si no, el único
        // enlazado, o `default`. Con varios enlazados y sin `--name`, se abre `default` y el
        // selector de arriba deja elegir: no se adivina cuál quería.
        let args: Vec<String> = std::env::args().skip(1).collect();
        let profile = args
            .iter()
            .position(|a| a == "--name")
            .and_then(|i| args.get(i + 1).cloned())
            .unwrap_or_else(|| match linked_names(&app.profiles).as_slice() {
                [only] => only.clone(),
                _ => DEFAULT_PROFILE.to_string(),
            });
        let (id, task) = app.open_window(profile);
        if let (Some(e), Some(win)) = (first, app.windows.get_mut(&id)) {
            win.error.get_or_insert(e);
        }
        (app, task)
    }

    fn reload_profiles(&mut self) -> Result<(), String> {
        let launch = self.launch.as_ref().map_err(Clone::clone)?;
        self.profiles = load_profiles(launch)?;
        Ok(())
    }

    fn open_window(&mut self, profile: String) -> (window::Id, Task<Message>) {
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
        self.windows.insert(id, Win { profile, mode: Mode::Console, term: None, title: String::new(), error: None });
        self.start(id, Mode::Console);
        (id, task.map(Message::Opened))
    }

    /// Pone en la ventana una TTY nueva. La anterior se suelta: su PTY se cierra, el cliente
    /// recibe SIGHUP y el agente mata la consola que esa TTY había abierto.
    fn start(&mut self, id: window::Id, mode: Mode) {
        let term_id = self.next_term;
        self.next_term += 1;
        let Some(win) = self.windows.get_mut(&id) else { return };
        if let Some(old) = win.term.take() {
            self.by_term.remove(&old.id);
        }
        win.error = None;
        win.title = String::new();
        let launch = match &self.launch {
            Ok(l) => l,
            Err(e) => {
                win.error = Some(e.clone());
                return;
            }
        };
        let args = match &mode {
            Mode::Console => vec!["--name".to_string(), win.profile.clone()],
            Mode::Linking { .. } => vec!["link".to_string()],
        };
        win.mode = mode;
        let env = HashMap::from([
            ("PATH".to_string(), launch.path.clone()),
            ("TERM".to_string(), "xterm-256color".to_string()),
            // Si el cliente falla, que espere una tecla: la ventana se cierra cuando sale.
            ("DOTRINO_TERMINAL_HOLD".to_string(), "1".to_string()),
        ]);
        let settings = iced_term::settings::Settings {
            backend: iced_term::settings::BackendSettings {
                program: launch.program.to_string_lossy().into_owned(),
                args,
                env,
                working_directory: std::env::var_os("HOME").map(PathBuf::from),
            },
            ..Default::default()
        };
        match iced_term::Terminal::new(term_id, settings) {
            Ok(term) => {
                self.by_term.insert(term_id, id);
                win.term = Some(term);
            }
            Err(e) => win.error = Some(format!("{}: {e}", launch.program.display())),
        }
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
            Mode::Console => self.close(id),
            // Terminó el enlace: si quedó un perfil enlazado nuevo, la ventana pasa a él; si
            // no (se canceló, falló), vuelve al que tenía.
            Mode::Linking { linked_before } => {
                let before = linked_before.clone();
                let reloaded = self.reload_profiles();
                let fresh = linked_names(&self.profiles).into_iter().find(|n| !before.contains(n));
                if let Some(win) = self.windows.get_mut(&id) {
                    if let Some(name) = fresh {
                        win.profile = name;
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
                let profile = from
                    .and_then(|id| self.windows.get(&id))
                    .map(|w| w.profile.clone())
                    .unwrap_or_else(|| DEFAULT_PROFILE.to_string());
                let _ = self.reload_profiles();
                self.open_window(profile).1
            }
            Message::Opened(id) => self.focus(id),
            Message::Close(id) => self.close(id),
            Message::SwitchProfile(id, name) => {
                let Some(win) = self.windows.get_mut(&id) else { return Task::none() };
                if win.profile == name && matches!(win.mode, Mode::Console) {
                    return self.focus(id);
                }
                win.profile = name;
                self.start(id, Mode::Console);
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
            Message::Paste(id) => iced::clipboard::read().map(move |c| Message::Pasted(id, c)),
            Message::Pasted(id, content) => {
                if let (Some(data), Some(term)) = (content, self.windows.get_mut(&id).and_then(|w| w.term.as_mut())) {
                    term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(data.into_bytes())));
                }
                self.focus(id)
            }
            Message::MenuRoot => Task::none(),
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
        let mut profiles: Vec<_> = self
            .profiles
            .iter()
            .map(|p| {
                let mark = if p.name == win.profile && !linking { "●  " } else { "     " };
                Item::new(entry(format!("{mark}{p}"), "", Some(Message::SwitchProfile(id, p.name.clone()))))
            })
            .collect();
        profiles.push(Item::new(separator()));
        profiles.push(Item::new(entry(t("Enrolar…", "Enroll…"), "", (!linking).then_some(Message::Enroll(id)))));
        let help = Menu::new(vec![
            Item::new(entry(t("Cómo se usa", "How to use it"), "", Some(Message::Help))),
            Item::new(entry(format!("Dotrino Terminal {VERSION}"), "", None)),
        ]);
        let root = |label: String, menu: Menu<'static, Message, Theme, iced::Renderer>| Item::with_menu(top(label), menu.width(300.0).offset(2.0).padding(4));
        let bar = MenuBar::new(vec![
            root(t("Archivo", "File"), file),
            root(t("Editar", "Edit"), edit),
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
            (Some(term), None) => iced_term::TerminalView::show(term).map(Message::Terminal),
            (_, Some(err)) => column![text("Dotrino Terminal").size(22), text(err.clone()).font(iced::Font::MONOSPACE)]
                .spacing(16)
                .padding(24)
                .into(),
            (None, None) => text("").into(),
        };
        let menu = if self.launch.is_ok() { self.menu(id, win) } else { space().into() };
        column![menu, container(body).width(Length::Fill).height(Length::Fill)].into()
    }

    fn title(&self, id: window::Id) -> String {
        let Some(win) = self.windows.get(&id) else { return String::new() };
        let what = match win.mode {
            Mode::Linking { .. } => t("Enrolar", "Enroll"),
            Mode::Console if win.title.is_empty() => "Dotrino Terminal".to_string(),
            Mode::Console => win.title.clone(),
        };
        format!("{what} — {}", win.profile)
    }

    fn subscription(&self) -> Subscription<Message> {
        let terms = self.windows.values().filter_map(|w| w.term.as_ref()).map(|term| term.subscription().map(Message::Terminal));
        Subscription::batch(terms.chain([window::close_requests().map(Message::Close), iced::event::listen_with(shortcut)]))
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
