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
/// El primer cliente (y agente) que sabe de las OTRAS máquinas de la cuenta (`--machine`, `machines`).
const FAR_CLIENT: (u32, u32, u32) = (0, 38, 0);
/// Cada cuántas lecturas del panel se pregunta por las otras máquinas (va a la red: más despacio).
const FAR_EVERY: u32 = 3;
/// Cuánto vale un ⤢ recién pulsado antes de que mande la lista (ver `Window::took_size`).
const TOOK_SIZE_FOR: std::time::Duration = std::time::Duration::from_secs(20);
/// Un agente que no contesta por las otras máquinas (anterior a la 0.38, aún sin reiniciar) se
/// vuelve a preguntar solo cada tantas lecturas: cada pregunta sin respuesta para la ventana un instante.
const FAR_SILENT_EVERY: u32 = 20;
/// El primer cliente con `dotrino-terminal vscode`.
const VSCODE_CLIENT: (u32, u32, u32) = (0, 20, 0);
/// El primer cliente con `dotrino-terminal claude`.
const CLAUDE_CLIENT: (u32, u32, u32) = (0, 44, 0);
/// El primer cliente con `agents` y `restart`: dice qué versión corre cada agente y lo reinicia.
const AGENTS_CLIENT: (u32, u32, u32) = (0, 45, 0);
/// El primer cliente con `network`: el uso de red del agente.
const NET_CLIENT: (u32, u32, u32) = (0, 46, 0);

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
    #[serde(default)]
    title: String,
    /// La carpeta en la que está AHORA (agente ≥ 0.22, solo donde hay /proc); con `~`.
    #[serde(default)]
    cwd: Option<String>,
    /// `usuario@máquina` de la máquina en la que corre (agente ≥ 0.24).
    #[serde(default)]
    host: Option<String>,
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
    /// De qué va la consola: la nota que escribe la persona o el programa de dentro
    /// (`dotrino-terminal note`). `None`: el agente es anterior a la 0.36 y no las tiene.
    #[serde(default)]
    note: Option<String>,
    /// La tarea en curso, que pone el programa de dentro (`dotrino-terminal note --task`): aparte de
    /// la nota. Aquí se lee y se quita, no se edita (agente ≥ 0.37).
    #[serde(default)]
    task: Option<String>,
}

/// Otra máquina de la cuenta con Dotrino Terminal encendido, tal como la cuenta el agente de
/// esta (`machines`, agent/far.js). `consoles` es `None` si pide su clave o no contesta.
#[derive(Debug, Clone, Deserialize)]
struct Machine {
    /// `AB12-CD34`, como sale en `dotrino-vault members`: con eso se la nombra (`--machine`).
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    consoles: Option<Vec<ConsoleInfo>>,
}

impl Machine {
    fn label(&self) -> String {
        if self.name.is_empty() { self.id.clone() } else { self.name.clone() }
    }
}

/// Bajo qué clave se guardan las consolas que ve una ventana: las del perfil en esta máquina,
/// o las de ese perfil en OTRA máquina.
fn scope_key(profile: &str, machine: Option<&str>) -> String {
    match machine {
        Some(m) => format!("{profile}\u{1f}{m}"),
        None => profile.to_string(),
    }
}

/// Lo que el panel dice de una consola, cada cosa en SU línea: la máquina (`usuario@máquina`)
/// solo si es OTRA, la carpeta, y el título que puso el programa. Una shell titula
/// «usuario@máquina: carpeta»: en local le queda la carpeta; un programa que se nombra solo
/// (Claude: su sesión) muestra la carpeta y su título.
fn panel_lines(title: &str, cwd: Option<&str>, machine: Option<&str>) -> (Option<String>, Option<String>, Option<String>) {
    let title = title.trim();
    let (host, rest) = match title.split_once(':') {
        Some((h, r)) if h.contains('@') && !h.contains(char::is_whitespace) => (Some(h), r.trim()),
        _ => (None, title),
    };
    let cwd = cwd.map(str::trim).filter(|d| !d.is_empty());
    // Sin carpeta del agente (uno viejo, o macOS), la de una shell es lo que sigue a la máquina.
    let dir = cwd.or(host.map(|_| rest).filter(|r| !r.is_empty()));
    let name = Some(rest).filter(|r| !r.is_empty() && Some(*r) != dir);
    // La máquina SIEMPRE y primero (dueño, 2026-10-07: callada cuando era la propia, el panel no decía
    // de quién es cada consola): la del título, y si no la trae, la de la consola (la dice el agente).
    (host.or(machine).map(String::from), dir.map(String::from), name.map(String::from))
}

/// `usuario@máquina` de ESTA máquina, como lo pone el prompt de una shell (`\u@\h`: el nombre
/// hasta el primer punto). Para saber si el título de una consola habla de otra.
fn user_at_host() -> Option<String> {
    static ME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    ME.get_or_init(|| {
        let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).ok().filter(|u| !u.is_empty())?;
        let mut buf = [0u8; 256];
        // SAFETY: `buf` vive toda la llamada y se le pasa su tamaño; se lee hasta el primer NUL.
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0)?;
        let host = String::from_utf8_lossy(&buf[..end]);
        let host = host.split('.').next().filter(|h| !h.is_empty())?;
        Some(format!("{user}@{host}"))
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::{drop_target, panel_lines};

    #[test]
    fn the_green_dot_blinks_only_for_a_console_a_window_of_the_app_shows() {
        let c = |watchers: &str| -> super::ConsoleInfo { serde_json::from_str(&format!(r#"{{"id":"a","watchers":{watchers}}}"#)).unwrap() };
        assert!(c(r#"[{"origin":"local","tag":"desktop-1-1"}]"#).in_an_app_window());
        // La terminal de VS Code o un `attach` suelto: atendida (lleva el punto), pero sin ventana
        // de la app que la dé por vista: no parpadea.
        assert!(c(r#"[{"origin":"local"}]"#).open_in_a_window());
        assert!(!c(r#"[{"origin":"local"}]"#).in_an_app_window());
        assert!(!c(r#"[{"origin":"local","tag":"vscode"}]"#).in_an_app_window());
        assert!(!c(r#"[{"origin":"remote","device":"phone","tag":"desktop-1-1"}]"#).in_an_app_window());
        assert!(!c("[]").in_an_app_window());
        // Una consola de OTRA máquina que una ventana de aquí muestra: allí es «remote», con la
        // etiqueta de este proceso. La de un proceso que no existe (otra máquina) no cuenta.
        let mine = format!(r#"[{{"origin":"remote","device":"me","tag":"desktop-{}-1"}}]"#, std::process::id());
        assert!(c(&mine).attended_from_here());
        assert!(!c(r#"[{"origin":"remote","device":"other","tag":"desktop-4294967295-1"}]"#).attended_from_here());
        assert!(!c(r#"[{"origin":"remote","device":"phone"}]"#).attended_from_here());
        assert!(!c(r#"[{"origin":"local","tag":"desktop-1-1"}]"#).attended_from_here());
    }

    #[test]
    fn a_new_window_takes_a_console_no_window_of_this_machine_shows_before_making_one() {
        let c = |id: &str, watchers: &str| -> super::ConsoleInfo { serde_json::from_str(&format!(r#"{{"id":"{id}","watchers":{watchers}}}"#)).unwrap() };
        let local = r#"[{"origin":"local","tag":"desktop-1-1"}]"#;
        let remote = r#"[{"origin":"remote","device":"phone"}]"#;
        // La que solo mira el teléfono cuenta como libre aquí; antes se creaba una nueva.
        assert_eq!(super::unattended(&[c("a", local), c("b", remote)]), Some("b".into()));
        // Pero una que no mira nadie va primero.
        assert_eq!(super::unattended(&[c("a", remote), c("b", "[]")]), Some("b".into()));
        // Todas en alguna ventana de esta máquina: ninguna, y entonces sí se crea.
        assert_eq!(super::unattended(&[c("a", local)]), None);
    }

    #[test]
    fn the_ring_sounds_a_minute_after_a_console_finished_if_nobody_attended_it() {
        let c = |id: &str, done: &str| -> super::ConsoleInfo { serde_json::from_str(&format!(r#"{{"id":"{id}","n":1,"title":"t","doneAt":{done}}}"#)).unwrap() };
        let lists = |v: Vec<super::ConsoleInfo>| -> std::collections::HashMap<String, Vec<super::ConsoleInfo>> { [("p".to_string(), v)].into_iter().collect() };
        let mut rung = std::collections::HashMap::new();
        let done_at = 1_000_000u64;
        let list = lists(vec![c("a", "1000000")]);
        // Al pasar a verde no suena, ni a los 59 s.
        assert!(super::due_rings(&list, &rung, done_at).is_empty());
        assert!(super::due_rings(&list, &rung, done_at + 59_000).is_empty());
        // Al minuto, sí; y por ese mismo «terminó» no vuelve a sonar.
        assert_eq!(super::due_rings(&list, &rung, done_at + 60_000), vec![("a".to_string(), done_at)]);
        rung.insert("a".to_string(), done_at);
        assert!(super::due_rings(&list, &rung, done_at + 61_500).is_empty());
        // Otro «terminó» de la misma consola: otra vez, a SU minuto.
        let again = lists(vec![c("a", "1100000")]);
        assert!(super::due_rings(&again, &rung, 1_100_000 + 10_000).is_empty());
        assert_eq!(super::due_rings(&again, &rung, 1_100_000 + 60_000), vec![("a".to_string(), 1_100_000)]);
        // Atendida antes del minuto (sin `doneAt`): nada.
        assert!(super::due_rings(&lists(vec![c("a", "null")]), &std::collections::HashMap::new(), done_at + 60_000).is_empty());
        // Ya llevaba mucho terminada cuando se abrió la app: no es una noticia.
        assert!(super::due_rings(&list, &std::collections::HashMap::new(), done_at + 600_000).is_empty());
        // El reloj de la otra máquina va adelantado: no revienta ni suena.
        assert!(super::due_rings(&list, &std::collections::HashMap::new(), done_at - 5_000).is_empty());
    }

    #[test]
    fn only_one_process_rings_for_the_same_finish() {
        let dir = std::env::temp_dir().join(format!("dotrino-rung-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(super::claim_ring(&dir, "a/b", 10));
        assert!(!super::claim_ring(&dir, "a/b", 10));
        assert!(super::claim_ring(&dir, "a/b", 11));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A mano, en una máquina con altavoces: `cargo test -- --ignored the_ring_sounds`.
    #[test]
    #[ignore]
    fn the_ring_sounds_on_this_machine() {
        super::ring_now().unwrap();
    }

    #[test]
    fn the_ring_is_a_sound_the_player_can_read() {
        for sound in [super::RING_LOW, super::RING_STANDARD, super::RING_HIGH] {
            assert!(rodio::Decoder::new(std::io::Cursor::new(sound)).is_ok());
        }
    }

    #[test]
    fn what_one_window_saw_is_added_to_what_the_others_saw() {
        let file = std::env::temp_dir().join(format!("dotrino-seen-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&file);
        super::write_seen(&file, &[("a".to_string(), 10u64)].into_iter().collect());
        // Otro proceso: vio otra consola, y de «a» sabe menos. Nada de lo anterior se pierde.
        super::write_seen(&file, &[("b".to_string(), 20u64), ("a".to_string(), 5u64)].into_iter().collect());
        let all = super::read_seen(&file);
        assert_eq!(all.get("a"), Some(&10));
        assert_eq!(all.get("b"), Some(&20));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_console_open_in_a_local_window_is_marked_and_a_remote_one_is_not() {
        let c = |watchers: &str| serde_json::from_str::<super::ConsoleInfo>(&format!(r#"{{"id":"a","watchers":{watchers}}}"#)).unwrap();
        assert!(!c("[]").open_in_a_window());
        assert!(!c(r#"[{"origin":"remote"}]"#).open_in_a_window());
        assert!(c(r#"[{"origin":"local","tag":"me"}]"#).open_in_a_window());
        assert!(c(r#"[{"origin":"remote"},{"origin":"local","tag":"other"}]"#).open_in_a_window());
    }

    #[test]
    fn a_window_left_without_its_console_takes_the_first_one_nobody_has_open() {
        let list: Vec<super::ConsoleInfo> = serde_json::from_str(r#"[{"id":"a","watchers":[{"origin":"local","tag":"w2"}]},{"id":"b","watchers":[{"origin":"remote"}]},{"id":"c","watchers":[]}]"#).unwrap();
        assert_eq!(super::next_console(&list).as_deref(), Some("c"));
        // Sin ninguna libre del todo: la que solo mira otro aparato, antes que la de otra ventana de aquí.
        assert_eq!(super::next_console(&list[..2]).as_deref(), Some("b"), "watched only from another device: still unattended here");
        assert_eq!(super::next_console(&list[..1]).as_deref(), Some("a"), "all in a window of this machine: the first");
        assert_eq!(super::next_console(&[]), None);
    }

    #[test]
    fn a_console_dropped_on_another_takes_its_place() {
        let ids = ["a", "b", "c", "d"];
        assert_eq!(drop_target(&ids, "c", "a"), Some(Some("a".to_string()))); // up: in front of it
        assert_eq!(drop_target(&ids, "a", "c"), Some(Some("d".to_string()))); // down: behind it
        assert_eq!(drop_target(&ids, "a", "d"), Some(None)); // down to the last: the end
        assert_eq!(drop_target(&ids, "b", "b"), None);
        assert_eq!(drop_target(&ids, "x", "b"), None);
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn the_panel_gives_host_folder_and_title_a_line_each() {
        let me = Some("seyacat@loca");
        // Local: the machine leads (the title's, or the console's when the title names a program).
        assert_eq!(panel_lines("seyacat@loca: ~", Some("~"), me), (s("seyacat@loca"), s("~"), None));
        assert_eq!(panel_lines("seyacat@loca: ~/p/dotrino", None, me), (s("seyacat@loca"), s("~/p/dotrino"), None)); // an older agent
        assert_eq!(panel_lines("✳ Sefjr improvement", Some("/mnt/sda1/Dotrino"), me), (s("seyacat@loca"), s("/mnt/sda1/Dotrino"), s("✳ Sefjr improvement")));
        assert_eq!(panel_lines("vim: notas.txt", Some("~"), me), (s("seyacat@loca"), s("~"), s("vim: notas.txt")));
        // After an ssh the title names ANOTHER machine: that is shown. The agent's folder is the
        // local ssh process's, so the remote one stays as the title.
        assert_eq!(panel_lines("dotrino@proxy1: /var/www", Some("~"), me), (s("dotrino@proxy1"), s("~"), s("/var/www")));
        assert_eq!(panel_lines("dotrino@proxy1: ~", None, me), (s("dotrino@proxy1"), s("~"), None));
        // Without knowing this machine's name, a host in the title is shown.
        assert_eq!(panel_lines("seyacat@loca: ~", Some("~"), None), (s("seyacat@loca"), s("~"), None));
        assert_eq!(panel_lines("", None, None), (None, None, None));
    }
}

/// Una consola a medio arrastrar en el panel de una ventana, y la fila sobre la que caería.
struct Drag {
    win: window::Id,
    id: String,
    over: String,
}

/// A dónde va una consola que se suelta sobre otra al arrastrarla: toma el SITIO de esa. Hacia
/// arriba queda delante de ella; hacia abajo, detrás (delante de la siguiente, o al final: `None`
/// dentro). `None` fuera: no se mueve. Igual que `dropTarget` de la PWA.
fn drop_target(ids: &[&str], id: &str, over: &str) -> Option<Option<String>> {
    let from = ids.iter().position(|x| *x == id)?;
    let to = ids.iter().position(|x| *x == over)?;
    if from == to {
        return None;
    }
    Some(if to < from { Some(over.to_string()) } else { ids.get(to + 1).map(|x| x.to_string()) })
}

/// A qué consola pasa una ventana que se quedó sin la suya: una desatendida EN ESTA MÁQUINA (ver
/// `unattended`: que la mire otro aparato no cuenta) y, si todas están en alguna ventana de aquí,
/// la primera. `None` = no queda ninguna (la ventana queda sin consola).
fn next_console(list: &[ConsoleInfo]) -> Option<String> {
    unattended(list).or_else(|| list.first().map(|c| c.id.clone()))
}

/// La consola a la que se engancha una ventana NUEVA en vez de crear otra: una que nadie mira y, si
/// no hay, una que no esté en ninguna ventana de ESTA máquina. Que la tenga abierta el teléfono o el
/// navegador no la hace atendida aquí: antes eso bastaba para ignorarla y crear una consola nueva.
/// `None` = todas están en alguna ventana de esta máquina.
fn unattended(list: &[ConsoleInfo]) -> Option<String> {
    list.iter().find(|c| c.watchers.is_empty()).or_else(|| list.iter().find(|c| !c.open_in_a_window())).map(|c| c.id.clone())
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

/// Verde = atendida: abierta en una ventana de ESTA máquina (de la app, o la terminal de VS Code).
const OPEN_COLOR: Color = Color::from_rgb(0.298, 0.851, 0.392);
/// Azul = atendida solo fuera de la app (la terminal de VS Code): se distingue de las que tienen
/// ventana de la app, a la que se puede ir (dueño, 2026-10-13).
const OUTSIDE_COLOR: Color = Color::from_rgb(0.310, 0.620, 1.0);

impl ConsoleInfo {
    /// ¿La muestra alguna ventana de esta máquina (esta incluida)? Lo abierto en otro aparato no cuenta.
    fn open_in_a_window(&self) -> bool {
        self.watchers.iter().any(|w| w.origin == "local")
    }

    /// ¿La muestra una ventana de la APP (esta u otra abierta en esta máquina)? Solo ahí PARPADEA el
    /// punto: el parpadeo se apaga cuando esa ventana tiene el foco. Una consola atendida por la
    /// terminal de VS Code (espectador local sin etiqueta de la app) lleva el punto verde, fijo:
    /// está atendida (dueño, 2026-10-13), pero ninguna ventana de la app puede darla por vista, y
    /// parpadearía para siempre.
    fn in_an_app_window(&self) -> bool {
        self.watchers.iter().any(|w| w.origin == "local" && w.tag.as_deref().is_some_and(|t| t.starts_with("desktop-")))
    }

    /// Lo mismo para una consola de OTRA máquina: allí una ventana de aquí es «otro aparato»
    /// (`remote`), y se la reconoce por su etiqueta, que lleva el proceso de la app que la abrió.
    /// Que la consola viva lejos no cambia nada: el punto dice que una ventana de ESTA máquina la
    /// muestra (dueño, 2026-10-13).
    fn attended_from_here(&self) -> bool {
        self.watchers.iter().any(|w| w.origin == "remote" && w.tag.as_deref().is_some_and(window_of_this_machine))
    }
}

/// ¿Es `tag` (`desktop-<pid>-<n>`) de una ventana de la app que corre en ESTA máquina? La de este
/// proceso, o la de otro proceso de la app que siga vivo (cada lanzamiento es un proceso).
fn window_of_this_machine(tag: &str) -> bool {
    let Some(pid) = tag.strip_prefix("desktop-").and_then(|r| r.split('-').next()).and_then(|p| p.parse::<u32>().ok()) else { return false };
    if pid == std::process::id() {
        return true;
    }
    // El nombre del proceso, cortado a 15 letras por el núcleo. Sin /proc (macOS), solo este proceso.
    std::fs::read_to_string(format!("/proc/{pid}/comm")).is_ok_and(|name| name.trim_end().starts_with("dotrino-termina"))
}

/// El cuadrito de una consola con un punto verde en su esquina superior derecha cuando `on`.
/// `faint`: el medio ciclo apagado del parpadeo (terminó y nadie la ha atendido).
/// El punto no recibe el ratón: los clics llegan al botón de debajo.
fn dotted<'a>(under: Element<'a, Message>, on: bool, faint: bool, color: Color) -> Element<'a, Message> {
    if !on {
        return under;
    }
    // 5 px, a 3 del borde: en la esquina, sin tocar el borde ni montarse sobre el número.
    let dot = container(space()).width(5).height(5).style(move |_: &Theme| container::Style { background: Some(color.scale_alpha(if faint { 0.15 } else { 1.0 }).into()), border: Border::default().rounded(2.5), ..Default::default() });
    iced::widget::stack![under, container(dot).width(Length::Fill).align_x(iced::alignment::Horizontal::Right).padding(3)].into()
}

/// Lo que la flecha de la consola activa sobresale del borde del panel.
const ARROW_W: f32 = 6.0;
const ARROW: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 12"><path d="M0 0l6 6-6 6z" fill="black"/></svg>"#;

/// La flecha de la consola activa: un triángulo que sale del borde del panel, a la altura de su
/// consola, y apunta a la terminal. Se pinta sobre la fila, pegado a su derecha, en la franja
/// de `ARROW_W` que el panel deja libre junto a la terminal.
fn arrowed<'a>(under: Element<'a, Message>, on: bool) -> Element<'a, Message> {
    let under = container(under).padding(iced::Padding { right: ARROW_W, ..Default::default() });
    if !on {
        return under.into();
    }
    let arrow = iced::widget::svg(iced::widget::svg::Handle::from_memory(ARROW)).width(ARROW_W).height(ARROW_W * 2.0).style(|theme: &Theme, _| iced::widget::svg::Style { color: Some(theme.palette().primary) });
    iced::widget::stack![under, container(arrow).width(Length::Fill).height(Length::Fill).align_x(iced::alignment::Horizontal::Right).align_y(iced::alignment::Vertical::Center)].into()
}

/// El panel con su franja para la flecha: el fondo del panel a su ancho y, al lado, `ARROW_W` con
/// el fondo de la terminal; encima, el contenido, que se desplaza con la flecha dentro.
fn with_arrow_gutter<'a>(content: Element<'a, Message>, width: f32, pad: iced::Padding, term_bg: Color) -> Element<'a, Message> {
    let back = row![
        container(space()).width(width).height(Length::Fill).style(|theme: &Theme| container::Style { background: Some(theme.extended_palette().background.weak.color.into()), ..Default::default() }),
        container(space()).width(ARROW_W).height(Length::Fill).style(move |_: &Theme| container::Style { background: Some(term_bg.into()), ..Default::default() }),
    ];
    iced::widget::stack![back, container(iced::widget::scrollable(content)).width(width + ARROW_W).height(Length::Fill).padding(pad)].into()
}

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

/// Una orden sobre una consola de OTRA máquina que aún no se ve cumplida: va por la red y la lista
/// de esa máquina tarda en confirmarla. Mientras, la ventana enseña un aviso flotante («Aplicando…»)
/// para que se sepa que hay que esperar (dueño, 2026-10-13).
struct Applying {
    what: String,
    since: std::time::Instant,
    until: Applied,
}

/// Cuándo se da por cumplida.
enum Applied {
    /// La consola ya no está en la lista.
    Gone(String),
    /// El tamaño de la consola ya es de la ventana con esa etiqueta.
    SizeOf(String, String),
}

/// Lo más que se enseña el aviso: si para entonces no se confirmó, deja de estorbar.
const APPLYING_MAX: std::time::Duration = std::time::Duration::from_secs(20);

/// Lo que la ventana hace cuando su cliente termine de soltar la consola actual.
#[derive(Debug, Clone)]
enum Pending {
    /// Engancharse a esta consola.
    Attach(String),
    /// Abrir una nueva.
    New,
    /// El agente se va a reiniciar (se cierran todas sus consolas): cuando el cliente caiga, la
    /// ventana sigue, con una consola nueva en el agente que arranca.
    Reopen,
    /// Cerrar la ventana en cuanto el cliente haya soltado su consola (una de segundo plano: si
    /// la ventana la abrió, cerrarla sin soltarla la mataría).
    Close,
    /// Actualizar el cliente en esta misma ventana: la consola se suelta (sigue viva en el
    /// agente), corre `script` en una TTY nueva, y al acabar la ventana vuelve a `back`.
    Update { script: String, back: Option<String>, what: String },
    /// Pasar a una consola de OTRA máquina (o volver a esta, `machine: None`) en esta misma
    /// ventana: el cliente habla con una sola máquina, así que suelta la consola, sale, y la
    /// ventana arranca otro contra `machine`, enganchado a `attach` (o con una consola nueva).
    Far { machine: Option<String>, attach: Option<String> },
}

/// Lo que la app le dice a la persona en un aviso sobre la ventana.
#[derive(Clone, Debug)]
enum Notice {
    /// Hay versión nueva: qué, en una línea por pieza.
    Offer(Vec<String>),
    /// La app se actualizó en el disco: la que corre sigue siendo la anterior.
    Restart,
    /// dotrino-terminal se actualizó y hay agentes que siguen con la versión anterior: para usar
    /// la nueva hay que pararlos, y eso cierra todas sus terminales.
    Agents(Stale),
}

/// Los agentes de esta máquina que corren con una versión que ya no es la instalada.
#[derive(Clone, Debug, PartialEq)]
struct Stale {
    /// La versión instalada, que es la que usarían al reiniciarse.
    installed: String,
    /// Cuántas consolas tienen abiertas entre todos.
    consoles: u64,
    /// Por qué no se pudieron parar, si ya se intentó.
    failed: Option<String>,
}

/// Pregunta al cliente si algún agente va por detrás de lo instalado. `None`: ninguno, o no se
/// pudo saber (queda en el registro).
fn check_agents(launch: Launch) -> Option<Stale> {
    if !launch.version.is_some_and(|v| v >= AGENTS_CLIENT) {
        return None;
    }
    let out = std::process::Command::new(&launch.program).args(["agents", "--json"]).env("PATH", &launch.path).stdin(std::process::Stdio::null()).output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            log(&format!("agents: the client could not say (exit {:?}): {}", o.status.code(), String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("")));
            return None;
        }
        Err(e) => {
            log(&format!("agents: could not run the client: {e}"));
            return None;
        }
    };
    let v: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(e) => {
            log(&format!("agents: unreadable answer: {e}"));
            return None;
        }
    };
    let stale: Vec<&serde_json::Value> = v["agents"].as_array()?.iter().filter(|a| a["stale"].as_bool() == Some(true)).collect();
    if stale.is_empty() {
        return None;
    }
    log(&format!("agents: {} behind the installed {}", stale.len(), v["installed"].as_str().unwrap_or("?")));
    Some(Stale { installed: v["installed"].as_str()?.to_string(), consoles: stale.iter().filter_map(|a| a["consoles"].as_u64()).sum(), failed: None })
}

/// Para los agentes que van por detrás (cierra sus consolas). `Err`: por qué no se pudo.
fn restart_agents(launch: Launch) -> Result<(), String> {
    let out = std::process::Command::new(&launch.program)
        .args(["restart", "--stale", "--yes"])
        .env("PATH", &launch.path)
        .env_remove("DOTRINO_TERMINAL_PROFILE_DIR")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).lines().next().unwrap_or("").to_string();
    log(&format!("agents: restart failed (exit {:?}): {why}", out.status.code()));
    Err(why)
}

/// El binario de esta app en el disco (Linux lo nombra «… (deleted)» si ya lo cambiaron).
fn exe_path() -> Option<PathBuf> {
    let p = std::env::current_exe().ok()?;
    Some(PathBuf::from(p.to_string_lossy().trim_end_matches(" (deleted)").to_string()))
}

fn exe_stamp() -> Option<(u64, std::time::SystemTime)> {
    let m = std::fs::metadata(exe_path()?).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// Pregunta al cliente qué versiones nuevas hay (la app no tiene red). `None`: no se pudo saber
/// (sin cliente, uno anterior a `updates`, sin red); queda en el registro y no se inventa nada.
fn check_updates(launch: Launch) -> Option<Vec<String>> {
    let out = std::process::Command::new(&launch.program)
        .args(["updates", "--json", "--desktop", VERSION])
        .env("PATH", &launch.path)
        .stdin(std::process::Stdio::null())
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            log(&format!("updates: the client could not say (exit {:?}): {}", o.status.code(), String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("")));
            return None;
        }
        Err(e) => {
            log(&format!("updates: could not run the client: {e}"));
            return None;
        }
    };
    let v: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(e) => {
            log(&format!("updates: unreadable answer: {e}"));
            return None;
        }
    };
    let mut lines = Vec::new();
    for (key, name) in [("agent", "dotrino-terminal".to_string()), ("desktop", t("La app", "The app"))] {
        let x = &v[key];
        if let Some(e) = x["error"].as_str() {
            log(&format!("updates: {key} could not be checked: {e}"));
        }
        if x["newer"].as_bool() == Some(true) {
            lines.push(format!("{name}: {} → {}", x["current"].as_str().unwrap_or("?"), x["latest"].as_str().unwrap_or("?")));
        }
    }
    Some(lines)
}

/// Qué corre en la TTY de la ventana.
enum Mode {
    /// Con perfil, una consola del agente de `Win::profile`; sin perfil, la shell del usuario.
    Console,
    /// `dotrino-terminal link`: al terminar se mira qué perfil quedó enlazado.
    Linking { linked_before: Vec<String> },
    /// «Actualizar dotrino-terminal…»: `script` corre en la TTY de esta ventana y, al acabar, la
    /// ventana vuelve a la consola que tenía (`back`) o abre una.
    /// `what` es el título de la ventana mientras dura.
    Updating { script: String, back: Option<String>, what: String },
}

struct Win {
    /// `None`: sin perfil, una terminal más.
    profile: Option<String>,
    /// La ventana mira las consolas de OTRA máquina de la cuenta (su id); `None`: las de esta.
    machine: Option<String>,
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
    /// Esta ventana espera a que su cliente caiga por el reinicio del agente (`RestartAgents`).
    reopening: bool,
    /// ⤢ recién pulsado: la consola (id) cuyo tamaño tomó esta ventana, y cuándo. Durante
    /// `TOOK_SIZE_FOR` la ventana se comporta ya como dueña del tamaño, sin esperar a que la lista
    /// lo confirme: la de otra máquina tarda varios segundos en llegar y parecía que no hacía nada.
    took_size: Option<(String, std::time::Instant)>,
    /// La consola recién elegida en el panel, marcada YA, antes de que la próxima lectura de la
    /// lista lo confirme (si no, durante un momento salían dos marcadas, o ninguna).
    showing: Option<String>,
    /// ¿Se ve el panel lateral de consolas en ESTA ventana? (cada ventana el suyo)
    sidebar: bool,
    /// Panel colapsado: una franja con un botón numerado por consola, para que ocupe poco.
    sidebar_collapsed: bool,
    /// La nota que se está editando en la tarjeta «de qué va»: de qué consola y el texto.
    note_edit: Option<(String, iced::widget::text_editor::Content)>,
    /// La tarea y la nota tal como se leen en la tarjeta (el texto y su editor de solo lectura,
    /// para poder seleccionarlo y copiarlo).
    task_read: Option<(String, iced::widget::text_editor::Content)>,
    note_read: Option<(String, iced::widget::text_editor::Content)>,
}

impl Win {
    /// La clave de las consolas que ve esta ventana (ver `scope_key`).
    fn scope(&self) -> Option<String> {
        self.profile.as_deref().map(|p| scope_key(p, self.machine.as_deref()))
    }
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
    /// Las consolas abiertas, por perfil (y máquina, ver `scope_key`), leídas del socket de su agente cada poco.
    consoles: HashMap<String, Vec<ConsoleInfo>>,
    /// Las otras máquinas de la cuenta, por perfil: lo último que contestó el agente.
    far: HashMap<String, Vec<Machine>>,
    /// Lecturas del panel hechas (para preguntar por las otras máquinas solo cada `FAR_EVERY`).
    polls: u32,
    /// Perfiles cuyo agente no contestó por las otras máquinas, y cuántas veces seguidas.
    far_silent: HashMap<String, u32>,
    /// Por qué no se ven las otras máquinas de un perfil, cuando hay un motivo que decir.
    far_why: HashMap<String, String>,
    /// El aviso que flota sobre las ventanas: hay versión nueva, o la app ya se actualizó.
    notice: Option<Notice>,
    /// Agentes que van por detrás de lo instalado: se ofrece cerrarlos cuando no hay otro aviso
    /// delante (primero actualizar, después reiniciar la app, y al final esto).
    stale: Option<Stale>,
    /// Hay un menú de clic secundario abierto: los hints del panel no se pintan encima.
    menu_open: bool,
    /// Cómo era el binario de la app al arrancar: si cambia tras actualizar, hay versión nueva
    /// instalada y se ofrece reiniciar.
    exe_stamp: Option<(u64, std::time::SystemTime)>,
    /// Reiniciar la app: las ventanas que se vuelven a abrir (perfil y carpeta) cuando la
    /// última de ahora se cierre.
    respawn: Option<Vec<(Option<String>, PathBuf)>>,
    /// La fila del panel bajo el puntero (ventana, consola): de ahí arranca un arrastre.
    hover: Option<(window::Id, String)>,
    /// La consola que se está arrastrando en el panel para cambiarla de sitio.
    drag: Option<Drag>,
    /// Consolas que se mandaron CERRAR y el agente aún no confirma: fuera del panel y sin poder
    /// elegirse. Entre pedir el cierre y que ocurra hay un instante (la ventana pasa antes a otra
    /// consola); volver a entrar en ella en ese hueco hacía que el cierre se llevara la ventana.
    dying: std::collections::HashSet<String>,
    next_tag: u64,
    /// El medio ciclo apagado del punto que parpadea (consola que terminó y nadie ha atendido).
    blink_off: bool,
    /// Las órdenes sobre consolas de otra máquina que aún no se ven cumplidas, por ventana.
    applying: HashMap<window::Id, Applying>,
    /// Por qué «terminó» ya sonó el trino en este proceso: consola (id) → su `doneAt`.
    rung: HashMap<String, u64>,
    /// La ventana que tiene el foco.
    focused: Option<window::Id>,
    /// Lo que ya se vio: la consola (id) y el `doneAt` que tenía cuando su ventana tuvo el foco.
    /// Ese «terminó» ya no parpadea; uno nuevo (otro `doneAt`) sí.
    seen: HashMap<String, u64>,
    /// La tarjeta «de qué va», plegada a un botón (en todas las ventanas; se recuerda).
    about_folded: bool,
}

/// Qué texto de la tarjeta «de qué va»: la tarea del programa o la nota del dueño.
#[derive(Debug, Clone, Copy)]
enum Part {
    Task,
    Note,
}

#[derive(Debug, Clone)]
enum Message {
    /// Otra ventana, con el perfil de la ventana desde la que se pidió. Se engancha a una consola
    /// que no esté abierta en ninguna ventana, si la hay; si no, abre una nueva.
    NewWindow(Option<window::Id>),
    /// Otra ventana con una consola nueva, siempre.
    NewWindowFresh(Option<window::Id>),
    /// Panel (clic derecho): dejar una consola en segundo plano, o quitarla de ahí.
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
    /// Poner (`true`) o quitar (`false`) Dotrino Terminal como terminal embebida de VS Code y
    /// sus variantes, con el perfil de la ventana.
    Vscode(window::Id, bool),
    /// Poner (o quitar) en Claude Code el skill y los hooks que mantienen la tarjeta de la consola.
    Claude(window::Id, bool),
    /// Escribe en la consola de la ventana la orden que instala (o actualiza) el cliente.
    InstallClient(window::Id),
    /// Lo que contestó el cliente al arrancar sobre versiones nuevas (`None`: no se supo).
    UpdatesChecked(Option<Vec<String>>),
    /// El aviso: «Después».
    NoticeLater,
    /// El aviso: actualizar ahora, en esta ventana.
    NoticeUpdate(window::Id),
    /// El aviso tras actualizar: reiniciar la app con la versión nueva.
    RestartApp,
    /// Lo que contestó el cliente sobre los agentes que van por detrás de lo instalado.
    AgentsChecked(Option<Stale>),
    /// El aviso: cerrar todas las terminales para que el agente arranque con la versión nueva.
    RestartAgents,
    AgentsRestarted(Result<(), String>),
    /// Las ventanas cuyo cliente no cayó con el reinicio dejan de esperarlo.
    ReopenExpired,
    /// Se abrió un menú de clic secundario (lo cierra el siguiente clic).
    MenuOpen,
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
    Blink,
    Focused(window::Id),
    /// Devolver el teclado a la terminal de la ventana (salvo que se esté editando la nota).
    Refocus(window::Id),
    Unfocused(window::Id),
    /// Panel lateral: ver esta consola en la ventana.
    ShowConsole(window::Id, String),
    /// Panel lateral: abrir una consola nueva en la ventana.
    NewConsole(window::Id),
    /// Panel lateral: cerrar esa consola.
    KillConsole(window::Id, String),
    /// El puntero entra en (o sale de) la fila de una consola del panel.
    RowEnter(window::Id, String),
    RowExit(window::Id, String),
    /// El botón del ratón baja o sube en una ventana: empieza o termina un arrastre del panel.
    MouseDown(window::Id),
    MouseUp,
    /// Panel lateral (clic derecho): abrir esa consola en una ventana nueva.
    /// Abrir en otra ventana la consola `cid` de `machine` (`None`: esta máquina).
    OpenInNewWindow(window::Id, Option<String>, String),
    /// Panel lateral: ir a una consola (o abrir una nueva, `None`) de una máquina (`None`: esta),
    /// en esta misma ventana.
    Go(window::Id, Option<String>, Option<String>),
    /// Panel lateral: cerrar una consola de una máquina (`None`: esta).
    KillAt(window::Id, Option<String>, String),
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
    /// La tarjeta «de qué va»: plegarla o abrirla.
    AboutFold,
    /// Empezar a editar la nota de la consola de la ventana.
    NoteEdit(window::Id),
    NoteAction(window::Id, iced::widget::text_editor::Action),
    NoteSave(window::Id),
    NoteCancel(window::Id),
    /// Clic derecho en el editor de la nota: copiar, cortar y pegar.
    NoteCopy(window::Id),
    NoteCut(window::Id),
    NotePaste(window::Id),
    NotePasted(window::Id, Option<String>),
    /// Lo que se lee en la tarjeta (tarea o nota): seleccionar y copiar, sin editar.
    ReadAction(window::Id, Part, iced::widget::text_editor::Action),
    ReadCopy(window::Id, Part),
    ReadSelectAll(window::Id, Part),
    NoteSelectAll(window::Id),
    /// Quitar la tarea que puso el programa en la consola de la ventana.
    TaskClear(window::Id),
    /// Borrar la nota propia de la consola de la ventana.
    NoteClear(window::Id),
    /// Ayuda → el uso de red del agente, en otra TTY de esta ventana.
    Network(window::Id),
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
    let family = installed_monospace(&family);
    iced_term::settings::FontSettings {
        size: points * 96.0 / 72.0,
        // Interlineado: con DejaVu 9 pt, XFCE Terminal deja 15 px por línea (12 × 1,25).
        // iced_term traía 1,3.
        scale_factor: 1.25,
        // iced pide un nombre `'static`: se crea una vez por proceso.
        font_type: iced::Font::with_name(Box::leak(family.into_boxed_str())),
    }
}

/// La familia que de verdad se va a pintar. El escritorio suele decir «Monospace», que es un alias
/// de fontconfig y no una familia: pasado tal cual, el motor de texto no lo encuentra y pinta una
/// fuente proporcional en la rejilla de la terminal (letras con huecos entre ellas). Lo mismo si la
/// familia pedida no está instalada. Se pregunta a fontconfig, como hace la terminal del sistema:
/// la familia pedida si existe y es monoespaciada y, si no, la monoespaciada del sistema.
/// Sin `fc-match` (macOS) se deja el nombre como vino.
fn installed_monospace(family: &str) -> String {
    let ask = |pattern: &str| -> Option<(String, bool)> {
        let out = Command::new("fc-match").args(["-f", "%{family[0]}|%{spacing}", pattern]).output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let (name, spacing) = s.split_once('|')?;
        // 90 = dual, 100 = mono, 110 = celda: todas valen para una rejilla.
        (out.status.success() && !name.is_empty()).then(|| (name.to_string(), spacing.parse::<u32>().is_ok_and(|n| n >= 90)))
    };
    match ask(family) {
        Some((name, true)) => name,
        Some(_) => match ask("monospace") {
            Some((name, _)) => {
                log(&format!("font: {family:?} is not an installed monospace family, using {name:?}"));
                name
            }
            None => family.to_string(),
        },
        None => family.to_string(),
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

/// EL TRINO: el sonido de todos los avisos de Dotrino (`sound/trinos/trino-01a.wav` en la raíz del
/// ecosistema, el original). El mismo que tocan la web (`@dotrino/notifications/ring`) y las apps
/// del teléfono (`DotrinoRing`).
///
/// Tres versiones del mismo trino (dueño, 2026-10-13): `high` es el original, `standard` va 8 dB
/// por debajo y `low` 16. La app toca la `low`: el original sonaba fortísimo junto a una terminal.
/// `DOTRINO_TERMINAL_RING=low|standard|high` elige otra.
const RING_LOW: &[u8] = include_bytes!("../assets/trino-low.wav");
const RING_STANDARD: &[u8] = include_bytes!("../assets/trino-standard.wav");
const RING_HIGH: &[u8] = include_bytes!("../assets/trino-high.wav");
const RING_VOLUME: f32 = 0.6;

/// El trino que toca esta app.
fn ring_sound() -> &'static [u8] {
    match std::env::var("DOTRINO_TERMINAL_RING").as_deref() {
        Ok("high") => RING_HIGH,
        Ok("standard") => RING_STANDARD,
        _ => RING_LOW,
    }
}

/// Cuánto lleva una consola terminada (en verde) cuando suena el trino. Al terminar NO suena: ahí
/// solo cambia de color. Suena si pasado este tiempo nadie la ha atendido (dueño, 2026-10-13).
const RING_AFTER_MS: u64 = 60_000;
/// Hasta cuándo se da por «acaba de cumplir el minuto». Lo que ya llevaba más que esto terminado
/// cuando se vio por primera vez (al abrir la app) no es una noticia.
const RING_WINDOW_MS: u64 = 60_000;

/// Las consolas a las que les toca sonar AHORA: siguen terminadas con el mismo `doneAt`, ese
/// `doneAt` cumplió `RING_AFTER_MS`, y por él todavía no se sonó (`rung`: consola → `doneAt`).
fn due_rings(lists: &HashMap<String, Vec<ConsoleInfo>>, rung: &HashMap<String, u64>, now_ms: u64) -> Vec<(String, u64)> {
    lists
        .values()
        .flatten()
        .filter_map(|c| {
            let at = c.done_at?;
            let age = now_ms.checked_sub(at)?;
            (age >= RING_AFTER_MS && age < RING_AFTER_MS + RING_WINDOW_MS && rung.get(&c.id) != Some(&at)).then(|| (c.id.clone(), at))
        })
        .collect()
}

/// ¿Le toca a ESTE proceso tocar el trino por ese «terminó»? Cada lanzamiento de la app es un
/// proceso aparte y todos ven la misma lista: sin esto sonaría una vez por ventana abierta. El
/// primero que crea el archivo (`create_new` es atómico) lo toca; los demás callan.
fn claim_ring(dir: &Path, id: &str, at: u64) -> bool {
    if let Err(e) = std::fs::create_dir_all(dir) {
        // Sin dónde anotarlo no hay con qué ponerse de acuerdo: suena en cada proceso, y se dice.
        eprintln!("dotrino-terminal-desktop: ring: cannot share who rings ({e}), every window will");
        return true;
    }
    // Lo de hace más de una hora ya no lo disputa nadie.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for f in entries.flatten() {
            let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok()).is_some_and(|d| d.as_secs() > 3600);
            if old {
                let _ = std::fs::remove_file(f.path());
            }
        }
    }
    let name: String = format!("{id}-{at}").chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(name)) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(e) => {
            eprintln!("dotrino-terminal-desktop: ring: cannot share who rings ({e}), every window will");
            true
        }
    }
}

fn ring_dir() -> Option<PathBuf> {
    Some(last_profile_file()?.with_file_name("rung"))
}

/// Toca el trino, en un hilo aparte: abrir la salida de sonido tarda y la ventana no espera por eso.
/// Una máquina sin salida de sonido lo dice en el registro y sigue: el punto que parpadea ya avisa.
fn play_ring() {
    std::thread::spawn(|| {
        if let Err(e) = ring_now() {
            eprintln!("dotrino-terminal-desktop: ring: could not play ({e})");
        }
    });
}

/// Abre la salida de sonido, toca el trino y espera a que acabe.
fn ring_now() -> Result<(), Box<dyn std::error::Error>> {
    let mut out = rodio::DeviceSinkBuilder::open_default_sink()?;
    out.log_on_drop(false);
    // La salida recién abierta se come el principio de lo que se le dé, y al soltarla se corta lo
    // que aún no salió de su búfer: el trino se oía recortado. Un respiro antes y otro después.
    std::thread::sleep(std::time::Duration::from_millis(150));
    let player = rodio::play(out.mixer(), std::io::Cursor::new(ring_sound()))?;
    player.set_volume(RING_VOLUME);
    player.sleep_until_end();
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}

/// Lo que ya se vio (consola → el `doneAt` que tenía), COMPARTIDO entre las ventanas de la app:
/// cada lanzamiento es un proceso aparte, y sin esto una consola que terminó dejaba de parpadear
/// solo en las ventanas del proceso que la miró; las demás seguían hasta que alguien tecleaba.
fn seen_file() -> Option<PathBuf> {
    Some(last_profile_file()?.with_file_name("seen.json"))
}

fn load_seen() -> HashMap<String, u64> {
    seen_file().map(|f| read_seen(&f)).unwrap_or_default()
}

fn read_seen(file: &Path) -> HashMap<String, u64> {
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Suma lo de este proceso a lo que haya (otro pudo escribir entre medias) y lo deja de una vez
/// (archivo temporal + renombrar). Si no se puede guardar, solo deja de compartirse: es una pista visual.
fn save_seen(mine: &HashMap<String, u64>) {
    if let Some(file) = seen_file() {
        write_seen(&file, mine);
    }
}

fn write_seen(file: &Path, mine: &HashMap<String, u64>) {
    let mut all = read_seen(file);
    for (id, at) in mine {
        let e = all.entry(id.clone()).or_insert(*at);
        *e = (*e).max(*at);
    }
    // Las consolas que ya no existen se quedarían para siempre: se guardan solo las últimas.
    if all.len() > 200 {
        let mut by_time: Vec<(String, u64)> = all.into_iter().collect();
        by_time.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
        by_time.truncate(200);
        all = by_time.into_iter().collect();
    }
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string(&all).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(tmp, file);
    }
}

/// ¿Está plegada la tarjeta «de qué va»? Una preferencia, junto al último perfil.
fn about_folded_file() -> Option<PathBuf> {
    Some(last_profile_file()?.with_file_name("about-folded"))
}

fn about_folded() -> bool {
    about_folded_file().is_some_and(|f| f.exists())
}

fn save_about_folded(folded: bool) {
    let Some(file) = about_folded_file() else { return };
    if folded {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, "1");
    } else {
        let _ = std::fs::remove_file(file);
    }
}

fn linked_names(profiles: &[Profile]) -> Vec<String> {
    profiles.iter().filter(|p| p.linked).map(|p| p.name.clone()).collect()
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let launch = resolve();
        let mut app = App { launch, profiles: Vec::new(), windows: BTreeMap::new(), by_term: HashMap::new(), next_term: 0, awaiting_client: false, font: terminal_font(), palette: terminal_palette(), consoles: HashMap::new(), far: HashMap::new(), polls: 0, far_silent: HashMap::new(), far_why: HashMap::new(), notice: None, stale: None, menu_open: false, exe_stamp: exe_stamp(), respawn: None, hover: None, drag: None, dying: Default::default(), next_tag: 0, blink_off: false, applying: HashMap::new(), rung: HashMap::new(), focused: None, seen: HashMap::new(), about_folded: about_folded() };
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
        // AL ARRANCAR se mira si hay versión nueva (del cliente y de la app) y, si la hay, se
        // ofrece actualizar ahora o después (dueño, 2026-10-10). Por detrás: no retrasa la ventana.
        // Una orden de `-x`/`-e` no es una sesión de la persona: ahí no se pregunta.
        let check = match (&app.launch, &cli.command) {
            (Ok(launch), None) => {
                let launch = launch.clone();
                let again = launch.clone();
                Task::batch([
                    Task::perform(async move { tokio::task::spawn_blocking(move || check_updates(launch)).await.ok().flatten() }, Message::UpdatesChecked),
                    Self::ask_agents(again),
                ])
            }
            _ => Task::none(),
        };
        (app, Task::batch([task, check]))
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
        self.open_window_with(profile, cwd, command, None, None)
    }

    /// Abre una ventana; con `attach`, nace enganchada a esa consola (sin abrir otra antes).
    /// Con `machine`, la ventana mira las consolas de esa otra máquina de la cuenta.
    fn open_window_with(&mut self, profile: Option<String>, cwd: PathBuf, command: Option<Vec<String>>, attach: Option<String>, machine: Option<String>) -> (window::Id, Task<Message>) {
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
        self.windows.insert(id, Win { profile, machine, cwd, command, mode: Mode::Console, term: None, took_size: None, title: String::new(), error: None, tag, attach: attach.clone(), pending: None, reopening: false, showing: attach, sidebar: true, sidebar_collapsed: true, note_edit: None, task_read: None, note_read: None });
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
        let spawn = if let Mode::Updating { script, .. } = &mode {
            Ok(("/bin/sh".to_string(), vec!["-c".to_string(), script.clone()], HashMap::from([("TERM".to_string(), "xterm-256color".to_string())])))
        } else if let (true, Some(cmd)) = (plain, win.command.clone()) {
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
                    Mode::Updating { .. } => Vec::new(),   // ya resuelto arriba: no llega aquí
                    // Engancharse a una consola que ya existe (panel lateral) o abrir una nueva.
                    Mode::Console => {
                        let mut a = match (win.attach.take(), &win.machine) {
                            (Some(cid), _) => vec!["attach".to_string(), cid],
                            // En otra máquina la carpeta de aquí no existe: abre en la suya de inicio.
                            (None, Some(_)) => Vec::new(),
                            (None, None) => vec!["--cwd".to_string(), win.cwd.to_string_lossy().into_owned()],
                        };
                        if let Some(m) = &win.machine {
                            a.extend(["--machine".to_string(), m.clone()]);
                        }
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

    /// Corre `script` en ESTA ventana, en otra TTY, y al acabar la ventana vuelve a su consola.
    /// Con una consola del agente a la vista se le pide al cliente que la suelte (Ctrl+] d) y,
    /// cuando sale, `ended` arranca el script: así no se pierde.
    /// Por detrás: ¿algún agente sigue con una versión anterior a la instalada?
    fn ask_agents(launch: Launch) -> Task<Message> {
        Task::perform(async move { tokio::task::spawn_blocking(move || check_agents(launch)).await.ok().flatten() }, Message::AgentsChecked)
    }

    fn run_aside(&mut self, id: window::Id, script: String, what: String) -> Task<Message> {
        let back = self.mine(id);
        let Some(win) = self.windows.get_mut(&id) else { return Task::none() };
        let in_console = matches!(win.mode, Mode::Console) && win.profile.is_some() && win.term.is_some();
        if in_console {
            win.pending = Some(Pending::Update { script, back, what });
            if let Some(term) = win.term.as_mut() {
                term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(b"\x1dd".to_vec())));
            }
            return self.focus(id);
        }
        // Sin consola del agente (sin perfil, o con un error a la vista): directo.
        self.start(id, Mode::Updating { script, back: None, what });
        self.focus(id)
    }

    fn pin_ready(&self) -> bool {
        self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= PIN_CLIENT)
    }

    /// ¿Tiene ESTA ventana fijado el tamaño de la consola que muestra?
    fn pinned_here(&self, id: window::Id) -> bool {
        let (Some(win), Some(cid)) = (self.windows.get(&id), self.mine(id)) else { return false };
        let Some(c) = win.scope().and_then(|s| self.consoles.get(&s)).and_then(|l| l.iter().find(|c| c.id == cid)) else { return false };
        c.size_by.as_ref().is_some_and(|b| b.pinned && b.tag.as_deref() == Some(win.tag.as_str()))
    }

    /// El tamaño (columnas, filas) de la consola de esta ventana cuando lo decide OTRA pantalla.
    /// `None` si lo tiene esta ventana o todavía no se sabe: entonces ocupa toda la ventana.
    fn followed_size(&self, id: window::Id) -> Option<(u32, u32)> {
        let (win, cid) = (self.windows.get(&id)?, self.mine(id)?);
        let c = self.consoles.get(&win.scope()?)?.iter().find(|c| c.id == cid)?;
        let b = c.size_by.as_ref()?;
        if b.tag.as_deref() == Some(win.tag.as_str()) || c.cols == 0 || c.rows == 0 {
            return None;
        }
        // ⤢ recién pulsado aquí: ya es de esta ventana, aunque la lista todavía diga lo de antes.
        if win.took_size.as_ref().is_some_and(|(taken, at)| *taken == cid && at.elapsed() < TOOK_SIZE_FOR) {
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

    /// Una consola del perfil que no esté abierta en ninguna ventana:
    /// la que se reutiliza al abrir una ventana, en vez de crear otra. Se pregunta al agente en el
    /// momento, no a la lista guardada, que puede tener hasta 1,5 s.
    fn free_console(&self, profile: &str) -> Option<String> {
        if !self.panel_ready() {
            return None;
        }
        let dir = self.profile_dir(profile)?;
        // Si el agente no contesta a la primera (va justo de tiempo), se pregunta otra vez antes de
        // darlo por sin consolas: equivocarse aquí es crear una consola de más.
        let list = agent_list(&dir).or_else(|| agent_list(&dir))?;
        let alive: Vec<ConsoleInfo> = list.into_iter().filter(|c| !self.dying.contains(&c.id)).collect();
        unattended(&alive)
    }

    /// Abre una ventana enganchada a `attach` (si hay) o con una consola nueva.
    fn open_window_on(&mut self, profile: Option<String>, cwd: PathBuf, attach: Option<String>) -> (window::Id, Task<Message>) {
        self.open_window_with(profile, cwd, None, attach, None)
    }

    /// Lo que el panel dice cuando no hay otras máquinas que enseñar, y si es un problema (hay
    /// algo que arreglar) o solo un estado (no hay ninguna encendida).
    fn far_notice(&self, profile: &str) -> Option<(String, bool)> {
        if self.launch.is_ok() && !self.far_ready() {
            return Some((t("Para ver las consolas de tus otras máquinas hace falta dotrino-terminal 0.38.0 o más reciente: actualízalo en Perfil → Actualizar dotrino-terminal y la app…", "Seeing the consoles of your other machines needs dotrino-terminal 0.38.0 or newer: update it in Profile → Update dotrino-terminal and the app…"), true));
        }
        if let Some(why) = self.far_why.get(profile) {
            return Some((why.clone(), true));
        }
        match self.far.get(profile) {
            Some(l) if l.is_empty() => Some((t("No hay otras máquinas encendidas con Dotrino Terminal.", "No other machines are on with Dotrino Terminal."), false)),
            _ => None,
        }
    }

    /// ¿Sabe el cliente instalado de las otras máquinas de la cuenta?
    fn far_ready(&self) -> bool {
        self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= FAR_CLIENT)
    }

    /// Una orden para el agente sobre una consola de la ventana: al de aquí o, si la ventana mira
    /// otra máquina, a aquella (el agente de aquí la reenvía).
    fn tell(&self, id: window::Id, msg: serde_json::Value) {
        let Some(win) = self.windows.get(&id) else { return };
        let Some(dir) = win.profile.as_deref().and_then(|p| self.profile_dir(p)) else { return };
        let msg = match &win.machine {
            Some(m) => serde_json::json!({ "type": "far", "machine": m, "msg": msg }),
            None => msg,
        };
        agent_send(&dir, &msg);
    }

    /// Las consolas que ve la ventana, AHORA. Las de esta máquina se le preguntan al agente en
    /// el momento; las de otra, lo último que se supo (preguntar sale a la red).
    fn live_list(&self, id: window::Id) -> Option<Vec<ConsoleInfo>> {
        let win = self.windows.get(&id)?;
        if win.machine.is_some() {
            return self.consoles.get(&win.scope()?).cloned();
        }
        let p = win.profile.as_deref()?;
        self.profile_dir(p).and_then(|d| agent_list(&d)).or_else(|| self.consoles.get(p).cloned())
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
        // LAS OTRAS MÁQUINAS de la cuenta: lo sabe el agente de aquí, que les pregunta por detrás.
        // Va a la red, así que se pregunta más despacio; entre medias vale lo último que dijo.
        self.polls = self.polls.wrapping_add(1);
        if self.far_ready() {
            let profiles: Vec<String> = fresh.keys().cloned().collect();
            for p in &profiles {
                let silent = self.far_silent.get(p).copied().unwrap_or(0);
                // Con una orden pendiente de confirmar se pregunta en cada lectura.
                let every = if !self.applying.is_empty() { 1 } else if silent >= 2 { FAR_SILENT_EVERY } else { FAR_EVERY };
                if self.polls % every != 1 % every {
                    continue;
                }
                match self.profile_dir(p).map(|dir| agent_machines(&dir)) {
                    Some(Far::List(list)) => {
                        self.far.insert(p.clone(), list);
                        self.far_silent.remove(p);
                        self.far_why.remove(p);
                    }
                    // Sin enlazar, o el agente dijo por qué no: no hay otras máquinas que enseñar,
                    // y el motivo se enseña en el panel (callarlo se ve igual que «no hay ninguna»).
                    Some(Far::No(code, message)) => {
                        self.far.remove(p);
                        self.far_silent.remove(p);
                        let why = match code.as_str() {
                            "not-linked" => t("Este perfil no está enlazado con tu bóveda, así que no ve tus otras máquinas. Enlázalo en Perfil → Enrolar…", "This profile is not linked to your vault, so it cannot see your other machines. Link it in Profile → Enroll…"),
                            "no-acta" => t("No se pudo preguntar a tu bóveda qué máquinas tienes. Comprueba que esté encendida y que esta máquina tenga conexión.", "Could not ask your vault which machines you have. Check that it is on and that this machine is online."),
                            _ => format!("{}: {message} ({code})", t("No se pudieron ver tus otras máquinas", "Could not see your other machines")),
                        };
                        self.far_why.insert(p.clone(), why);
                    }
                    // No contestó a tiempo: se deja lo que había (la primera vez tarda, sale a la red).
                    // Si sigue callado y nunca dijo nada, es un agente anterior a la 0.38 aún corriendo.
                    Some(Far::Silent) => {
                        let n = self.far_silent.entry(p.clone()).or_insert(0);
                        *n += 1;
                        if *n >= 2 && !self.far.contains_key(p) {
                            self.far_why.insert(p.clone(), t("El agente de esta máquina no contesta por tus otras máquinas. Si actualizaste dotrino-terminal, el agente sigue con la versión anterior hasta que se reinicie: cierra sus consolas y reinícialo.", "This machine's agent does not answer about your other machines. If you updated dotrino-terminal, the agent keeps the old version until it restarts: close its consoles and restart it."));
                        }
                    }
                    None => {}
                }
            }
            self.far.retain(|p, _| profiles.contains(p));
            self.far_why.retain(|p, _| profiles.contains(p));
            // Lo que se mandó cerrar no vuelve al panel aunque la otra máquina aún lo liste.
            for machines in self.far.values_mut() {
                for m in machines.iter_mut() {
                    if let Some(list) = m.consoles.as_mut() {
                        list.retain(|c| !self.dying.contains(&c.id));
                    }
                }
            }
            for (p, machines) in &self.far {
                for m in machines {
                    if let Some(list) = &m.consoles {
                        fresh.insert(scope_key(p, Some(&m.id)), list.clone());
                    }
                }
            }
        }
        // Lo que se mandó cerrar no vuelve al panel; y cuando el agente ya no lo tiene, se olvida.
        let alive_now: std::collections::HashSet<String> = fresh.values().flatten().map(|c| c.id.clone()).collect();
        self.dying.retain(|id| alive_now.contains(id));
        for list in fresh.values_mut() {
            list.retain(|c| !self.dying.contains(&c.id));
        }
        // Una consola que lleva un minuto terminada sin atender suena con el trino: una vez, por
        // muchas que lo cumplan a la vez y por muchas ventanas que haya.
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let done = due_rings(&fresh, &self.rung, now_ms);
        self.rung.extend(done.iter().cloned());
        // La que ya se miró (su ventana tuvo el foco desde que terminó) está atendida: no suena.
        let done: Vec<(String, u64)> = done.into_iter().filter(|(id, at)| self.seen.get(id) != Some(at)).collect();
        if !done.is_empty() {
            let mine = match ring_dir() {
                Some(dir) => done.iter().filter(|(id, at)| claim_ring(&dir, id, *at)).count() > 0,
                None => true,
            };
            if mine {
                play_ring();
            }
        }
        self.consoles = fresh;
        // Las órdenes pendientes que ya se ven cumplidas (o que llevan demasiado) dejan de avisar.
        let all: Vec<&ConsoleInfo> = self.consoles.values().flatten().collect();
        self.applying.retain(|_, a| {
            let done = match &a.until {
                Applied::Gone(cid) => !all.iter().any(|c| &c.id == cid),
                Applied::SizeOf(cid, tag) => all.iter().any(|c| &c.id == cid && c.size_by.as_ref().and_then(|b| b.tag.as_deref()) == Some(tag.as_str())),
            };
            !done && a.since.elapsed() < APPLYING_MAX
        });
        // Lo que vio OTRA ventana de la app (cada lanzamiento es un proceso aparte): también cuenta.
        for (id, at) in load_seen() {
            self.seen.entry(id).and_modify(|mine| *mine = (*mine).max(at)).or_insert(at);
        }
        self.seen.retain(|id, _| alive_now.contains(id));
        self.mark_seen();
        // Lo marcado a mano se suelta en cuanto la lista lo dice (o la consola ya no está).
        let tags: Vec<(window::Id, String, Option<String>, Option<String>, bool)> =
            self.windows.iter().map(|(id, w)| (*id, w.tag.clone(), w.scope(), w.showing.clone(), w.machine.is_some())).collect();
        for (id, tag, scope, showing, is_far) in tags {
            let Some(want) = showing else { continue };
            // De otra máquina todavía no se sabe nada (su lista tarda en llegar): se deja marcada.
            if is_far && !scope.as_ref().is_some_and(|s| self.consoles.contains_key(s)) {
                continue;
            }
            let list = scope.and_then(|p| self.consoles.get(&p).cloned()).unwrap_or_default();
            let confirmed = list.iter().any(|c| c.id == want && c.watchers.iter().any(|w| w.tag.as_deref() == Some(tag.as_str())));
            if confirmed || !list.iter().any(|c| c.id == want) {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.showing = None;
                }
            }
        }
    }

    /// La consola de la ventana con el foco, si terminó, queda vista: su punto deja de parpadear.
    fn mark_seen(&mut self) {
        let Some(cid) = self.focused.and_then(|id| self.mine(id)) else { return };
        let done = self.consoles.values().flatten().find(|c| c.id == cid).and_then(|c| c.done_at);
        if let Some(at) = done {
            if self.seen.insert(cid, at) != Some(at) {
                save_seen(&self.seen);
            }
        }
    }

    /// ¿Debe parpadear su punto? Terminó, y ninguna ventana con el foco la ha mostrado desde entonces.
    fn blinks(&self, c: &ConsoleInfo) -> bool {
        c.act() == Act::Done && self.seen.get(&c.id) != c.done_at.as_ref()
    }

    /// La consola que muestra la ventana: la que la tiene entre quienes miran, por su etiqueta.
    fn mine(&self, id: window::Id) -> Option<String> {
        let win = self.windows.get(&id)?;
        if let Some(s) = &win.showing {
            return Some(s.clone());
        }
        let list = self.consoles.get(&win.scope()?)?;
        list.iter().find(|c| c.watchers.iter().any(|w| w.tag.as_deref() == Some(win.tag.as_str()))).map(|c| c.id.clone())
    }

    /// La consola que muestra la ventana, tal como la cuenta el agente.
    fn my_console(&self, id: window::Id) -> Option<&ConsoleInfo> {
        let mine = self.mine(id)?;
        let win = self.windows.get(&id)?;
        self.consoles.get(&win.scope()?)?.iter().find(|c| c.id == mine)
    }

    /// «De qué va»: una tarjeta translúcida, arriba a la derecha de la consola, con su título y su
    /// nota (la tarea en curso). La misma que la PWA. Plegada, un botón.
    fn about<'a>(&'a self, id: window::Id, win: &'a Win) -> Option<Element<'a, Message>> {
        let c = self.my_console(id)?;
        let place = |e: Element<'a, Message>| -> Element<'a, Message> {
            container(e).width(Length::Fill).height(Length::Fill).align_x(iced::alignment::Horizontal::Right).padding(iced::Padding { top: 8.0, right: 20.0, ..Default::default() }).into()
        };
        let round = |theme: &Theme, status: button::Status| {
            let mut s = menu_button(theme, status);
            s.border = Border::default().rounded(11.0).width(1.0).color(theme.extended_palette().background.strong.color);
            if s.background.is_none() {
                s.background = Some(theme.extended_palette().background.weak.color.into());
            }
            s
        };
        let tip = t("De qué va esta consola", "What this console is about");
        if self.about_folded {
            let b = button(text("i").size(12).font(iced::Font { style: iced::font::Style::Italic, weight: iced::font::Weight::Bold, ..iced::Font::DEFAULT })).padding([2, 8]).style(round).on_press(Message::AboutFold);
            return Some(place(iced::widget::tooltip(b, container(text(tip).size(12)).padding(6).style(container::rounded_box), iced::widget::tooltip::Position::Left).into()));
        }
        let dim = |theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.6)) };
        let n = c.n.map(|n| n.to_string()).unwrap_or_default();
        let badge = container(text(n).size(12)).padding([0, 5]).style(|theme: &Theme| {
            let p = theme.extended_palette();
            container::Style { background: Some(p.primary.base.color.into()), text_color: Some(p.primary.base.text), border: Border::default().rounded(4.0), ..Default::default() }
        });
        let title = if c.title.is_empty() { t("Sin título", "Untitled") } else { c.title.clone() };
        // Debajo del título, lo mismo que la barra de la ventana añade al suyo: si la consola está
        // abierta desde otro aparato, y el perfil.
        let remote = c.watchers.iter().filter(|w| w.origin == "remote").count();
        let mark = match remote {
            0 => None,
            1 => Some(format!("● {}", t("abierta desde otro aparato", "open on another device"))),
            n => Some(format!("● {} ×{n}", t("abierta desde otro aparato", "open on another device"))),
        };
        let second = [mark, win.profile.clone()].into_iter().flatten().collect::<Vec<_>>().join(" — ");
        let mut titles = column![text(title).size(12).width(Length::Fill)].width(Length::Fill);
        if !second.is_empty() {
            titles = titles.push(text(second).size(11).style(dim));
        }
        let head = row![badge, titles, button(text("–").size(12)).padding([0, 7]).style(round).on_press(Message::AboutFold)].spacing(6);
        let act = |label: String, msg: Option<Message>| button(text(label).size(12)).padding([2, 10]).style(round).on_press_maybe(msg);
        let editing = win.note_edit.as_ref().filter(|(cid, _)| *cid == c.id);
        let mut card = column![head, rule::horizontal(1)].spacing(6);
        // La tarea: del programa. Se ve y se quita; no entra en el editor.
        if let Some(task) = c.task.as_deref().filter(|t| !t.is_empty()) {
            let del = iced::widget::tooltip(
                button(text("×").size(12)).padding([0, 7]).style(round).on_press(Message::TaskClear(id)),
                container(text(t("Quitar la tarea", "Remove the task")).size(12)).padding(6).style(container::rounded_box),
                iced::widget::tooltip::Position::Left,
            );
            let body: Element<'_, Message> = match &win.task_read {
                Some((_, content)) => reading(id, Part::Task, content, 160.0),
                None => text(task.to_string()).size(12).width(Length::Fill).into(),
            };
            card = card.push(row![body, del].spacing(6)).push(rule::horizontal(1));
        }
        if let Some((_, content)) = editing {
            let editor = iced::widget::text_editor(content)
                .id(note_editor_id(id))
                .size(12)
                .height(120)
                .placeholder(t("Tus notas sobre esta consola…", "Your notes about this console…"))
                .on_action(move |a| Message::NoteAction(id, a))
                // Ctrl+Enter guarda, Esc cancela; lo demás, lo de siempre.
                .key_binding(move |k| {
                    use iced::widget::text_editor::Binding;
                    match k.key.as_ref() {
                        Key::Named(keyboard::key::Named::Escape) => Some(Binding::Custom(Message::NoteCancel(id))),
                        Key::Named(keyboard::key::Named::Enter) if k.modifiers.command() => Some(Binding::Custom(Message::NoteSave(id))),
                        _ => Binding::from_key_press(k),
                    }
                });
            // Clic derecho: lo mismo que Ctrl+X, Ctrl+C, Ctrl+V y Ctrl+A.
            let has_selection = content.selection().is_some_and(|s| !s.is_empty());
            let editor = ContextMenu::new(editor, move || {
                let (cut_key, copy_key, paste_key, all_key) = if cfg!(target_os = "macos") { ("⌘X", "⌘C", "⌘V", "⌘A") } else { ("Ctrl+X", "Ctrl+C", "Ctrl+V", "Ctrl+A") };
                container(
                    column![
                        entry(t("Cortar", "Cut"), cut_key, has_selection.then_some(Message::NoteCut(id))),
                        entry(t("Copiar", "Copy"), copy_key, has_selection.then_some(Message::NoteCopy(id))),
                        entry(t("Pegar", "Paste"), paste_key, Some(Message::NotePaste(id))),
                        separator(),
                        entry(t("Seleccionar todo", "Select all"), all_key, Some(Message::NoteSelectAll(id))),
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
            });
            card = card.push(editor).push(
                row![space::horizontal(), act(t("Cancelar", "Cancel"), Some(Message::NoteCancel(id))), act(t("Guardar", "Save"), Some(Message::NoteSave(id)))].spacing(6),
            );
        } else {
            match c.note.as_deref() {
                // Agente viejo: el botón se ve, apagado, y se dice por qué.
                None => {
                    card = card
                        .push(text(t("Actualiza dotrino-terminal (Perfil → Actualizar) para tener notas", "Update dotrino-terminal (Profile → Update) to have notes")).size(12).style(dim))
                        .push(row![space::horizontal(), act(t("Agregar nota", "Add a note"), None)]);
                }
                Some("") => {
                    card = card.push(text(t("Sin notas.", "No notes.")).size(12).style(dim)).push(row![space::horizontal(), act(t("Agregar nota", "Add a note"), Some(Message::NoteEdit(id)))]);
                }
                Some(note) => {
                    let body: Element<'_, Message> = match &win.note_read {
                        Some((_, content)) => reading(id, Part::Note, content, 220.0),
                        None => text(note.to_string()).size(12).width(Length::Fill).into(),
                    };
                    // Como la tarea: una × la borra de una vez, sin pasar por el editor.
                    let del = iced::widget::tooltip(
                        button(text("×").size(12)).padding([0, 7]).style(round).on_press(Message::NoteClear(id)),
                        container(text(t("Borrar la nota", "Delete the note")).size(12)).padding(6).style(container::rounded_box),
                        iced::widget::tooltip::Position::Left,
                    );
                    card = card
                        .push(row![body, del].spacing(6))
                        .push(row![space::horizontal(), act(t("Editar", "Edit"), Some(Message::NoteEdit(id)))]);
                }
            }
        }
        let alpha = if editing.is_some() { 0.96 } else { 0.78 };
        let card = container(card).width(300).padding(10).style(move |theme: &Theme| {
            let p = theme.extended_palette();
            container::Style {
                background: Some(p.background.weak.color.scale_alpha(alpha).into()),
                border: Border::default().rounded(10.0).width(1.0).color(p.primary.base.color.scale_alpha(0.35)),
                ..Default::default()
            }
        });
        // Con interacción propia, el clic sobre la tarjeta no llega a la terminal de debajo (no
        // empieza una selección ni le deja el teclado mientras se escribe la nota).
        Some(place(iced::widget::mouse_area(card).interaction(iced::mouse::Interaction::Idle).into()))
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
            Pending::New | Pending::Reopen => "\x1dn".to_string(),
            Pending::Close | Pending::Update { .. } | Pending::Far { .. } => "\x1dd".to_string(),
        };
        win.showing = match &next {
            Pending::Attach(cid) => Some(cid.clone()),
            Pending::Far { attach, .. } => attach.clone(),
            Pending::New | Pending::Reopen | Pending::Close | Pending::Update { .. } => None,
        };
        match win.term.as_mut() {
            Some(term) => {
                // Cambiar de máquina hace salir al cliente: lo que toca después lo recoge `ended`.
                if matches!(next, Pending::Far { .. }) {
                    win.pending = Some(next);
                }
                term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(keys.into_bytes())))
            }
            // Sin TTY (un error a la vista): se arranca directamente.
            None => {
                win.pending = Some(next);
                return self.ended(id);
            }
        };
        // La lista, enseguida y otra vez al poco (lo que tarda el agente en repintar).
        Task::batch([later(150, Message::Poll), later(700, Message::Poll), self.focus(id)])
    }

    fn reading_mut(&mut self, id: window::Id, part: Part) -> Option<&mut (String, iced::widget::text_editor::Content)> {
        let w = self.windows.get_mut(&id)?;
        match part {
            Part::Task => w.task_read.as_mut(),
            Part::Note => w.note_read.as_mut(),
        }
    }

    /// Copiar (o cortar) lo seleccionado en el editor de la nota.
    fn note_copy(&mut self, id: window::Id, cut: bool) -> Task<Message> {
        use iced::widget::text_editor::{Action, Edit};
        let back = iced::widget::operation::focus(note_editor_id(id));
        let Some((_, content)) = self.windows.get_mut(&id).and_then(|w| w.note_edit.as_mut()) else { return Task::none() };
        let Some(selected) = content.selection().filter(|s| !s.is_empty()) else { return back };
        if cut {
            content.perform(Action::Edit(Edit::Delete));
        }
        iced::clipboard::write(selected).chain(back)
    }

    fn focus(&self, id: window::Id) -> Task<Message> {
        match self.windows.get(&id).and_then(|w| w.term.as_ref()) {
            Some(term) => iced_term::TerminalView::focus(term.widget_id().clone()),
            None => Task::none(),
        }
    }

    /// El teclado a la terminal, ahora y otra vez al poco. Al arrancar un cliente la terminal es un
    /// componente NUEVO: si el foco se pide antes de que esté en pantalla, o un clic en el panel se
    /// lo quita justo después, quedaba sorda hasta hacerle clic. Se notaba cuando el cliente pide
    /// la clave de otra máquina nada más arrancar (dueño, 2026-10-13).
    fn focus_soon(&self, id: window::Id) -> Task<Message> {
        Task::batch([self.focus(id), later(250, Message::Refocus(id)), later(1000, Message::Refocus(id))])
    }

    /// Cerrar una ventana NUNCA cierra una consola (dueño, 2026-10-08): la ventana SUELTA la que
    /// muestra (Ctrl+] d) y se va; la consola sigue viva en el agente. Una consola se cierra desde
    /// el panel («×» o «Cerrar consola»), o saliendo de su shell.
    fn request_close(&mut self, id: window::Id) -> Task<Message> {
        if self.panel_ready() {
            if let Some(win) = self.windows.get_mut(&id) {
                if let (Some(term), Mode::Console) = (win.term.as_mut(), &win.mode) {
                    win.pending = Some(Pending::Close);
                    term.handle(iced_term::Command::ProxyToBackend(iced_term::BackendCommand::Write(b"\x1dd".to_vec())));
                    // Si el cliente no contesta (colgado), la ventana se cierra igual al rato.
                    return later(3000, Message::ForceClose(id));
                }
            }
        }
        self.close(id)
    }

    fn close(&mut self, id: window::Id) -> Task<Message> {
        if let Some(win) = self.windows.remove(&id) {
            if let Some(term) = win.term {
                self.by_term.remove(&term.id);
            }
        }
        let close = window::close(id);
        if !self.windows.is_empty() {
            return close;
        }
        // Reiniciar: ya no queda ninguna ventana (todas soltaron su consola). Se abre la app
        // nueva, una por cada ventana que había, y esta termina.
        if let (Some(again), Some(exe)) = (self.respawn.take(), exe_path()) {
            for (profile, cwd) in again {
                let mut cmd = std::process::Command::new(&exe);
                if let Some(p) = profile {
                    cmd.args(["--name", &p]);
                }
                if cwd.is_dir() {
                    cmd.current_dir(&cwd);
                }
                match cmd.stdin(std::process::Stdio::null()).spawn() {
                    Ok(_) => log(&format!("restart: started {}", exe.display())),
                    Err(e) => log(&format!("restart: could not start {}: {e}", exe.display())),
                }
            }
        }
        close.chain(iced::exit())
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
            Mode::Console if matches!(win.pending, Some(Pending::Close)) => self.close(id),
            Mode::Console if win.pending.is_some() => {
                let win = self.windows.get_mut(&id).expect("window");
                match win.pending.take() {
                    // La consola ya está suelta: ahora sí, la actualización en esta ventana.
                    Some(Pending::Update { script, back, what }) => {
                        self.start(id, Mode::Updating { script, back, what });
                        return self.focus(id);
                    }
                    Some(Pending::Attach(cid)) => win.attach = Some(cid),
                    // La consola de aquí ya está suelta: la ventana pasa a la otra máquina.
                    Some(Pending::Far { machine, attach }) => {
                        win.machine = machine;
                        win.showing = attach.clone();
                        win.attach = attach;
                    }
                    _ => {
                        win.attach = None;
                        win.showing = None;
                    }
                }
                self.start(id, Mode::Console);
                self.focus_soon(id)
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
                        self.focus_soon(id)
                    }
                    None => self.close(id),
                }
            }
            // Terminó la actualización: la ventana vuelve a su consola (o abre una).
            Mode::Updating { back, .. } => {
                let back = back.clone();
                if let Some(win) = self.windows.get_mut(&id) {
                    win.showing = back.clone();
                    win.attach = back;
                }
                // La app cambió en el disco: la que corre es la anterior. Se ofrece reiniciar.
                let now = exe_stamp();
                if now.is_some() && now != self.exe_stamp {
                    self.exe_stamp = now;
                    self.notice = Some(Notice::Restart);
                }
                // Y el cliente pudo cambiar: si el agente que corre quedó atrás, se ofrece
                // cerrar sus terminales (después de lo de reiniciar la app, si toca).
                let ask = match resolve() {
                    Ok(launch) => {
                        self.launch = Ok(launch.clone());
                        Self::ask_agents(launch)
                    }
                    Err(_) => Task::none(),
                };
                self.start(id, Mode::Console);
                Task::batch([self.focus_soon(id), ask])
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
        let task = self.handle(message);
        self.sync_reading();
        task
    }

    /// La tarea y la nota que se LEEN en la tarjeta van en un editor de solo lectura (el texto
    /// normal de la ventana no se puede seleccionar): aquí se ponen al día con lo que dice la consola.
    fn sync_reading(&mut self) {
        fn sync(slot: &mut Option<(String, iced::widget::text_editor::Content)>, text: Option<&str>) {
            match text.filter(|t| !t.is_empty()) {
                None => *slot = None,
                Some(t) if slot.as_ref().is_some_and(|(shown, _)| shown == t) => {}
                Some(t) => *slot = Some((t.to_string(), iced::widget::text_editor::Content::with_text(t))),
            }
        }
        let ids: Vec<window::Id> = self.windows.keys().copied().collect();
        for id in ids {
            let (task, note) = match self.my_console(id) {
                Some(c) => (c.task.clone(), c.note.clone()),
                None => (None, None),
            };
            if let Some(w) = self.windows.get_mut(&id) {
                sync(&mut w.task_read, task.as_deref());
                sync(&mut w.note_read, note.as_deref());
            }
        }
    }

    fn handle(&mut self, message: Message) -> Task<Message> {
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
            Message::Opened(id) => self.focus_soon(id),
            Message::Close(id) => self.request_close(id),
            Message::ForceClose(id) => {
                if self.windows.contains_key(&id) { self.close(id) } else { Task::none() }
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
                win.profile = name.clone();
                // Como una ventana nueva: a una consola que nadie tiene abierta, si la hay.
                let free = name.as_deref().and_then(|p| self.free_console(p));
                if let Some(win) = self.windows.get_mut(&id) {
                    win.showing = free.clone();
                    win.attach = free;
                }
                self.start(id, Mode::Console);
                self.focus_soon(id)
            }
            Message::InstallClient(id) => {
                // En ESTA ventana, en otra TTY (dueño, 2026-10-07): la consola se suelta sin cerrarla,
                // la salida queda a la vista hasta Enter, y al acabar la ventana vuelve a su consola.
                // Con el PATH de inicio de sesión: ahí está el npm de nvm o Homebrew.
                let path = match login_path() {
                    Ok(p) => p,
                    Err(e) => {
                        if let Some(w) = self.windows.get_mut(&id) {
                            w.error = Some(e);
                        }
                        return Task::none();
                    }
                };
                let ok = t("Listo: dotrino-terminal está al día. El agente que ya corría sigue con la versión anterior hasta que se reinicie: al volver a tu consola, la app te ofrece hacerlo.", "Done: dotrino-terminal is up to date. An agent that was already running keeps the old version until it restarts: back in your console, the app offers to do it.");
                let fail = t("No se pudo. Si dice EACCES, tu npm instala en una carpeta del sistema: usa nvm, o instálalo con sudo.", "It failed. If it says EACCES, your npm installs into a system folder: use nvm, or install it with sudo.");
                let no_npm = t("No encuentro npm: instala Node 20 o más reciente (https://nodejs.org).", "Can't find npm: install Node 20 or newer (https://nodejs.org).");
                let close = t("Pulsa Enter para volver a tu consola.", "Press Enter to go back to your console.");
                // Y DESPUÉS LA APP, en la misma pasada (dueño, 2026-10-10: una sola acción). La baja,
                // la verifica y la instala el cliente recién puesto; un paquete del sistema pide ahí
                // la contraseña de sudo. Sin cliente no hay con qué, y se dice.
                // Tras una actualización anterior sin reiniciar, Linux nombra el binario «… (deleted)».
                let exe = std::env::current_exe().map(|p| p.to_string_lossy().trim_end_matches(" (deleted)").to_string()).unwrap_or_default();
                let no_client = t("La app no se actualizó: hace falta dotrino-terminal para bajarla y comprobarla.", "The app was not updated: dotrino-terminal is needed to download and check it.");
                let script = format!(
                    "PATH={}; export PATH; if command -v npm >/dev/null; then echo '$ npm install -g {CLIENT_PKG}@latest'; npm install -g {CLIENT_PKG}@latest && echo && echo {} || {{ echo; echo {}; }}; else echo {}; fi; echo; if command -v dotrino-terminal >/dev/null; then echo '$ dotrino-terminal desktop update'; dotrino-terminal desktop update --current {VERSION} --exe {}; else echo {}; fi; echo; echo {}; read _",
                    sh_quote(&path), sh_quote(&ok), sh_quote(&fail), sh_quote(&no_npm), sh_quote(&exe), sh_quote(&no_client), sh_quote(&close)
                );
                self.awaiting_client = true;
                self.run_aside(id, script, t("Actualizar", "Update"))
            }
            Message::UpdatesChecked(found) => {
                if let Some(lines) = found.filter(|l| !l.is_empty()) {
                    log(&format!("updates: {}", lines.join(" · ")));
                    self.notice = Some(Notice::Offer(lines));
                }
                Task::none()
            }
            Message::NoticeLater => {
                // Lo que se deja para después es el aviso a la vista; detrás puede esperar el
                // de los agentes, que va el último.
                if matches!(self.notice, Some(Notice::Agents(_))) {
                    self.stale = None;
                }
                self.notice = self.stale.clone().map(Notice::Agents);
                Task::none()
            }
            Message::AgentsChecked(found) => {
                self.stale = found;
                match (&self.notice, &self.stale) {
                    (None, Some(st)) => self.notice = Some(Notice::Agents(st.clone())),
                    // Ya no hay ninguno atrás (se reiniciaron por otro lado): el aviso sobra.
                    (Some(Notice::Agents(_)), None) => self.notice = None,
                    _ => {}
                }
                Task::none()
            }
            Message::RestartAgents => {
                self.notice = None;
                let Ok(launch) = self.launch.clone() else { return Task::none() };
                // Las ventanas no se cierran: al caer su cliente abren una consola nueva, que es
                // la que levanta el agente con la versión instalada.
                let ids: Vec<window::Id> = self.windows.keys().copied().collect();
                for id in ids {
                    let mine = self.mine(id);
                    let Some(win) = self.windows.get_mut(&id) else { continue };
                    if matches!(win.mode, Mode::Console) && win.profile.is_some() && win.term.is_some() && win.pending.is_none() {
                        // La consola de OTRA máquina no se cierra (su agente no se toca): la
                        // ventana vuelve a ella en cuanto el agente de aquí arranque.
                        win.pending = Some(match win.machine.clone() {
                            Some(m) => Pending::Far { machine: Some(m), attach: mine },
                            None => Pending::Reopen,
                        });
                        win.reopening = true;
                    }
                }
                Task::perform(async move { tokio::task::spawn_blocking(move || restart_agents(launch)).await.unwrap_or_else(|e| Err(e.to_string())) }, Message::AgentsRestarted)
            }
            Message::AgentsRestarted(done) => {
                match done {
                    // Una ventana de un perfil cuyo agente no se tocó sigue en su consola: pasado
                    // un rato, lo que quedó esperando se olvida.
                    Ok(()) => {
                        self.stale = None;
                        later(15_000, Message::ReopenExpired)
                    }
                    // No se paró nada: las ventanas siguen en su consola, y se dice por qué.
                    Err(why) => {
                        if let Some(st) = self.stale.as_mut() {
                            st.failed = Some(why);
                        }
                        self.notice = self.stale.clone().map(Notice::Agents);
                        self.handle(Message::ReopenExpired)
                    }
                }
            }
            Message::MenuOpen => {
                self.menu_open = true;
                Task::none()
            }
            Message::ReopenExpired => {
                for win in self.windows.values_mut() {
                    if std::mem::take(&mut win.reopening) {
                        win.pending = None;
                    }
                }
                Task::none()
            }
            Message::NoticeUpdate(id) => {
                self.notice = None;
                self.handle(Message::InstallClient(id))
            }
            Message::RestartApp => {
                self.notice = None;
                // Cada ventana suelta su consola (sigue viva en el agente) y se cierra; al irse
                // la última, `close` abre la app nueva. Las ventanas nuevas se enganchan a las
                // consolas que quedaron sueltas.
                self.respawn = Some(self.windows.values().filter(|w| w.command.is_none()).map(|w| (w.profile.clone(), w.cwd.clone())).collect());
                let ids: Vec<window::Id> = self.windows.keys().copied().collect();
                Task::batch(ids.into_iter().map(|id| self.request_close(id)))
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
            Message::Vscode(id, set) => {
                // Como «Actualizar»: en ESTA ventana y en otra TTY, con la salida a la vista hasta
                // Enter. Quitarlo no depende del perfil.
                let Ok(launch) = self.launch.clone() else { return Task::none() };
                let profile = self.windows.get(&id).and_then(|w| w.profile.clone());
                let args = match (set, profile) {
                    (true, Some(p)) => format!("vscode --name {}", sh_quote(&p)),
                    (true, None) => "vscode".to_string(),
                    (false, _) => "vscode --off".to_string(),
                };
                let close = t("Pulsa Enter para volver a tu consola.", "Press Enter to go back to your console.");
                let script = format!(
                    "PATH={}; export PATH; echo \"\\$ dotrino-terminal {args}\"; {} {args}; echo; echo {}; read _",
                    sh_quote(&launch.path), sh_quote(&launch.program.to_string_lossy()), sh_quote(&close)
                );
                self.run_aside(id, script, "VS Code".to_string())
            }
            Message::Claude(id, set) => {
                // Como VS Code: en ESTA ventana y en otra TTY, con la salida a la vista hasta Enter.
                let Ok(launch) = self.launch.clone() else { return Task::none() };
                let args = if set { "claude" } else { "claude --off" };
                let close = t("Pulsa Enter para volver a tu consola.", "Press Enter to go back to your console.");
                let script = format!(
                    "PATH={}; export PATH; echo \"\\$ dotrino-terminal {args}\"; {} {args}; echo; echo {}; read _",
                    sh_quote(&launch.path), sh_quote(&launch.program.to_string_lossy()), sh_quote(&close)
                );
                self.run_aside(id, script, "Claude Code".to_string())
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
                if let Some(term) = self.windows.get_mut(&id).and_then(|w| w.term.as_mut()) {
                    let bytes = match content.filter(|d| !d.is_empty()) {
                        // Entre corchetes si la shell lo pidió: lo pegado no se ejecuta solo.
                        Some(data) => term.paste_bytes(&data),
                        // Sin texto en el portapapeles (una imagen): se manda Ctrl+V, como hace la
                        // tecla, y el programa que la sepa leer (Claude Code) la toma él.
                        None => vec![0x16],
                    };
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
                let mine = self.mine(id);
                if let Some(w) = self.windows.get_mut(&id) {
                    w.took_size = if pinned { None } else { mine.clone().map(|cid| (cid, std::time::Instant::now())) };
                    // En otra máquina tarda en verse: se avisa mientras.
                    if let (false, true, Some(cid)) = (pinned, w.machine.is_some(), mine) {
                        let tag = w.tag.clone();
                        self.applying.insert(id, Applying { what: t("Aplicando el tamaño…", "Applying the size…"), since: std::time::Instant::now(), until: Applied::SizeOf(cid, tag) });
                    }
                }
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
                // La ventana pasó a otra consola a media edición: esa nota ya no es la que se ve.
                let ids: Vec<window::Id> = self.windows.keys().copied().collect();
                for id in ids {
                    let mine = self.mine(id);
                    if let Some(w) = self.windows.get_mut(&id) {
                        if w.note_edit.as_ref().is_some_and(|(cid, _)| mine.as_deref() != Some(cid.as_str())) {
                            w.note_edit = None;
                        }
                    }
                }
                Task::none()
            }
            Message::AboutFold => {
                self.about_folded = !self.about_folded;
                save_about_folded(self.about_folded);
                Task::none()
            }
            Message::NoteEdit(id) => {
                let Some(c) = self.my_console(id) else { return Task::none() };
                let content = iced::widget::text_editor::Content::with_text(c.note.as_deref().unwrap_or(""));
                let cid = c.id.clone();
                if let Some(w) = self.windows.get_mut(&id) {
                    w.note_edit = Some((cid, content));
                }
                iced::widget::operation::focus(note_editor_id(id))
            }
            Message::NoteAction(id, action) => {
                if let Some((_, content)) = self.windows.get_mut(&id).and_then(|w| w.note_edit.as_mut()) {
                    content.perform(action);
                }
                Task::none()
            }
            // Las del menú devuelven el teclado al editor: el clic en el menú no se lo quita.
            Message::NoteSelectAll(id) => {
                if let Some((_, content)) = self.windows.get_mut(&id).and_then(|w| w.note_edit.as_mut()) {
                    content.perform(iced::widget::text_editor::Action::SelectAll);
                }
                iced::widget::operation::focus(note_editor_id(id))
            }
            Message::ReadAction(id, part, action) => {
                // Solo lectura: se selecciona y se desplaza, no se escribe.
                if !matches!(action, iced::widget::text_editor::Action::Edit(_)) {
                    if let Some((_, content)) = self.reading_mut(id, part) {
                        content.perform(action);
                    }
                }
                Task::none()
            }
            Message::ReadSelectAll(id, part) => {
                if let Some((_, content)) = self.reading_mut(id, part) {
                    content.perform(iced::widget::text_editor::Action::SelectAll);
                }
                Task::none()
            }
            Message::ReadCopy(id, part) => match self.reading_mut(id, part).and_then(|(_, content)| content.selection()).filter(|s| !s.is_empty()) {
                Some(selected) => iced::clipboard::write(selected),
                None => Task::none(),
            },
            Message::NoteCopy(id) => self.note_copy(id, false),
            Message::NoteCut(id) => self.note_copy(id, true),
            Message::NotePaste(id) => iced::clipboard::read().map(move |c| Message::NotePasted(id, c)),
            Message::NotePasted(id, pasted) => {
                use iced::widget::text_editor::{Action, Edit};
                if let (Some((_, content)), Some(pasted)) = (self.windows.get_mut(&id).and_then(|w| w.note_edit.as_mut()), pasted.filter(|p| !p.is_empty())) {
                    content.perform(Action::Edit(Edit::Paste(std::sync::Arc::new(pasted))));
                }
                iced::widget::operation::focus(note_editor_id(id))
            }
            Message::NoteCancel(id) => {
                if let Some(w) = self.windows.get_mut(&id) {
                    w.note_edit = None;
                }
                self.focus(id)
            }
            Message::TaskClear(id) => {
                let Some(cid) = self.my_console(id).map(|c| c.id.clone()) else { return Task::none() };
                self.tell(id, serde_json::json!({ "type": "note", "id": cid, "task": "" }));
                if let Some(scope) = self.windows.get(&id).and_then(|w| w.scope()) {
                    if let Some(c) = self.consoles.get_mut(&scope).and_then(|l| l.iter_mut().find(|c| c.id == cid)) {
                        c.task = Some(String::new());
                    }
                }
                Task::batch([later(300, Message::Poll), self.focus(id)])
            }
            Message::NoteClear(id) => {
                let Some(cid) = self.my_console(id).map(|c| c.id.clone()) else { return Task::none() };
                self.tell(id, serde_json::json!({ "type": "note", "id": cid, "text": "" }));
                if let Some(scope) = self.windows.get(&id).and_then(|w| w.scope()) {
                    if let Some(c) = self.consoles.get_mut(&scope).and_then(|l| l.iter_mut().find(|c| c.id == cid)) {
                        c.note = Some(String::new());
                    }
                }
                if let Some(w) = self.windows.get_mut(&id) {
                    w.note_read = None;
                }
                Task::batch([later(300, Message::Poll), self.focus(id)])
            }
            Message::Network(id) => {
                // Como VS Code: en ESTA ventana y en otra TTY, con la salida a la vista hasta Enter.
                let Ok(launch) = self.launch.clone() else { return Task::none() };
                let args = match self.windows.get(&id).and_then(|w| w.profile.clone()) {
                    Some(p) => format!("network --name {}", sh_quote(&p)),
                    None => "network".to_string(),
                };
                let close = t("Pulsa Enter para volver a tu consola.", "Press Enter to go back to your console.");
                let script = format!(
                    "PATH={}; export PATH; echo \"\\$ dotrino-terminal {args}\"; {} {args}; echo; echo {}; read _",
                    sh_quote(&launch.path), sh_quote(&launch.program.to_string_lossy()), sh_quote(&close)
                );
                self.run_aside(id, script, t("Red", "Network"))
            }
            Message::NoteSave(id) => {
                let Some((cid, content)) = self.windows.get_mut(&id).and_then(|w| w.note_edit.take()) else { return Task::none() };
                let note = content.text().trim_end().to_string();
                self.tell(id, serde_json::json!({ "type": "note", "id": cid, "text": note }));
                // Se ve ya, sin esperar a la próxima lectura de la lista.
                if let Some(scope) = self.windows.get(&id).and_then(|w| w.scope()) {
                    if let Some(c) = self.consoles.get_mut(&scope).and_then(|l| l.iter_mut().find(|c| c.id == cid)) {
                        c.note = Some(note);
                    }
                }
                Task::batch([later(300, Message::Poll), self.focus(id)])
            }
            Message::Focused(id) => {
                self.focused = Some(id);
                self.mark_seen();
                // La ventana vuelve a tener el foco: el teclado va a su terminal.
                self.handle(Message::Refocus(id))
            }
            Message::Refocus(id) => {
                if self.windows.get(&id).is_some_and(|w| w.note_edit.is_some()) {
                    return Task::none();
                }
                self.focus(id)
            }
            Message::Unfocused(id) => {
                if self.focused == Some(id) {
                    self.focused = None;
                }
                Task::none()
            }
            Message::Blink => {
                self.blink_off = !self.blink_off;
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
                let exists = self.live_list(id).is_some_and(|l| l.iter().any(|c| c.id == cid));
                if !exists {
                    log(&format!("show-console: {cid} is gone; panel refreshed"));
                    self.poll_consoles();
                    return self.focus(id);
                }
                self.switch_to(id, Pending::Attach(cid))
            }
            Message::NewConsole(id) => self.switch_to(id, Pending::New),
            Message::OpenInNewWindow(id, machine, cid) => {
                let Some(win) = self.windows.get(&id) else { return Task::none() };
                let (profile, cwd) = (win.profile.clone(), win.cwd.clone());
                // La ventana nueva nace ya enganchada a esa consola, en la máquina donde vive.
                self.open_window_with(profile, cwd, None, Some(cid), machine).1
            }
            // El panel: ir a una consola (`cid`) o abrir una nueva (`None`) en `machine` (`None`:
            // esta máquina), SIEMPRE en esta ventana. En la máquina que la ventana ya mira es el
            // cambio de siempre; en otra, la ventana suelta su consola y pasa a aquella.
            Message::Go(id, machine, cid) => {
                let Some(win) = self.windows.get(&id) else { return Task::none() };
                if win.machine == machine {
                    return match cid {
                        Some(cid) => self.handle(Message::ShowConsole(id, cid)),
                        None => self.handle(Message::NewConsole(id)),
                    };
                }
                self.switch_to(id, Pending::Far { machine, attach: cid })
            }
            // Cerrar desde el panel una consola de `machine` (`None`: esta máquina).
            Message::KillAt(id, machine, cid) => {
                let Some(win) = self.windows.get(&id) else { return Task::none() };
                if machine.is_some() {
                    self.applying.insert(id, Applying { what: t("Cerrando la consola…", "Closing the console…"), since: std::time::Instant::now(), until: Applied::Gone(cid.clone()) });
                }
                if win.machine == machine {
                    return self.handle(Message::KillConsole(id, cid));
                }
                // No es la máquina que mira la ventana: la orden va directa, sin tocar su consola.
                let Some(dir) = win.profile.as_deref().and_then(|p| self.profile_dir(p)) else { return Task::none() };
                let kill = serde_json::json!({ "type": "kill", "id": cid });
                let msg = match &machine {
                    Some(m) => serde_json::json!({ "type": "far", "machine": m, "msg": kill }),
                    None => kill,
                };
                agent_send(&dir, &msg);
                if let Some(key) = win.profile.as_deref().map(|p| scope_key(p, machine.as_deref())) {
                    if let Some(list) = self.consoles.get_mut(&key) {
                        list.retain(|c| c.id != cid);
                    }
                }
                // Tampoco en la lista de su máquina, que es de donde la pinta el panel.
                self.dying.insert(cid.clone());
                for m in self.far.values_mut().flatten() {
                    if let Some(list) = m.consoles.as_mut() {
                        list.retain(|c| c.id != cid);
                    }
                }
                Task::batch([later(300, Message::Poll), later(1500, Message::Poll), self.focus(id)])
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
                // y luego se mata la vieja; al revés, el cliente vería terminar su consola y la
                // ventana se cerraría. Si no queda NINGUNA, la ventana sigue, SIN consola y con su
                // panel (el cliente ≥ 0.33 se queda esperando): aquí nunca se crea una consola
                // (solo el «+», o una ventana nueva sin ninguna libre).
                if is_mine {
                    // La primera que NO esté abierta en otra pantalla; solo si todas lo están, la
                    // primera que haya (la misma regla del cliente cuando se la cierra otra pantalla).
                    // Preguntado al agente en el momento: la lista guardada puede tener 1,5 s.
                    let list: Vec<ConsoleInfo> = self
                        .live_list(id)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|c| !self.dying.contains(&c.id))
                        .collect();
                    let Some(other) = next_console(&list) else {
                        return self.handle(Message::KillNow(id, cid));
                    };
                    let switch = self.switch_to(id, Pending::Attach(other));
                    return switch.chain(later(400, Message::KillNow(id, cid)));
                }
                self.handle(Message::KillNow(id, cid))
            }
            Message::RowEnter(id, cid) => {
                if let Some(d) = self.drag.as_mut().filter(|d| d.win == id) {
                    d.over = cid.clone();
                }
                self.hover = Some((id, cid));
                Task::none()
            }
            Message::RowExit(id, cid) => {
                if self.hover.as_ref() == Some(&(id, cid)) {
                    self.hover = None;
                }
                Task::none()
            }
            Message::MouseDown(id) => {
                self.menu_open = false;
                self.drag = self.hover.clone().filter(|(w, _)| *w == id).map(|(win, cid)| Drag { win, over: cid.clone(), id: cid });
                Task::none()
            }
            Message::MouseUp => {
                // Soltada sobre OTRA fila: toma su sitio. El orden es de la máquina (lo ven igual
                // las demás ventanas y aparatos); aquí se adelanta para que no salte al releer.
                let Some(d) = self.drag.take() else { return Task::none() };
                let Some(scope) = self.windows.get(&d.win).and_then(|w| w.scope()) else { return Task::none() };
                let Some(list) = self.consoles.get_mut(&scope) else { return Task::none() };
                let ids: Vec<&str> = list.iter().map(|c| c.id.as_str()).collect();
                let Some(before) = drop_target(&ids, &d.id, &d.over) else { return Task::none() };
                let from = list.iter().position(|c| c.id == d.id).expect("drop_target found it");
                let moved = list.remove(from);
                let at = before.as_ref().and_then(|b| list.iter().position(|c| &c.id == b)).unwrap_or(list.len());
                list.insert(at, moved);
                self.tell(d.win, serde_json::json!({ "type": "move", "id": d.id, "before": before }));
                Task::none()
            }
            Message::KillNow(id, cid) => {
                self.tell(id, serde_json::json!({ "type": "kill", "id": cid }));
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
        let linking = matches!(win.mode, Mode::Linking { .. } | Mode::Updating { .. });
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
        // La terminal embebida de VS Code (y variantes) abre consolas de este perfil.
        let vscode_ready = self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= VSCODE_CLIENT);
        let can_vscode = !linking && vscode_ready;
        profiles.push(Item::new(entry(t("Usar en la terminal de VS Code", "Use in VS Code's terminal"), "", can_vscode.then_some(Message::Vscode(id, true)))));
        profiles.push(Item::new(entry(t("Quitar de la terminal de VS Code", "Remove from VS Code's terminal"), "", can_vscode.then_some(Message::Vscode(id, false)))));
        if self.launch.is_ok() && !vscode_ready {
            profiles.push(Item::new(note(t("Para VS Code hace falta dotrino-terminal 0.20.0 o más reciente: actualízalo aquí abajo.", "VS Code needs dotrino-terminal 0.20.0 or newer: update it just below."))));
        }
        // Claude Code mantiene la tarjeta «de qué va» de la consola en la que corre.
        let claude_ready = self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= CLAUDE_CLIENT);
        let can_claude = !linking && claude_ready;
        profiles.push(Item::new(entry(t("Notas con Claude Code: instalar", "Notes with Claude Code: install"), "", can_claude.then_some(Message::Claude(id, true)))));
        profiles.push(Item::new(entry(t("Notas con Claude Code: quitar", "Notes with Claude Code: remove"), "", can_claude.then_some(Message::Claude(id, false)))));
        if self.launch.is_ok() && !claude_ready {
            profiles.push(Item::new(note(t("Para las notas con Claude Code hace falta dotrino-terminal 0.44.0 o más reciente: actualízalo aquí abajo.", "Notes with Claude Code need dotrino-terminal 0.44.0 or newer: update it just below."))));
        }
        // Sin el cliente no hay perfiles ni enrolar: se ve deshabilitado, y la razón a la vista.
        profiles.push(Item::new(entry(t("Enrolar…", "Enroll…"), "", (!linking && self.launch.is_ok()).then_some(Message::Enroll(id)))));
        if let Err(why) = &self.launch {
            profiles.push(Item::new(note(why.clone())));
        }
        // Una sola acción: el cliente y, después, la app.
        let install_label = if self.launch.is_ok() { t("Actualizar dotrino-terminal y la app…", "Update dotrino-terminal and the app…") } else { t("Instalar dotrino-terminal…", "Install dotrino-terminal…") };
        // Corre en una ventana aparte.
        profiles.push(Item::new(entry(install_label, "", (!linking).then_some(Message::InstallClient(id)))));
        let view_menu = Menu::new(vec![
            Item::new(entry(
                format!("{}{}", if win.sidebar { "✓  " } else { "     " }, t("Panel de consolas", "Consoles panel")),
                if cfg!(target_os = "macos") { "⌘B" } else { "Ctrl+Shift+B" },
                Some(Message::ToggleSidebar(id)),
            )),
            // ⤢ Quién manda en el tamaño: esta ventana, si se marca (con un cliente ≥ 0.14).
            Item::new(entry(
                format!("     {}", t("Usar el tamaño de esta ventana", "Use this window's size")),
                "",
                (self.pin_ready() && win.profile.is_some() && matches!(win.mode, Mode::Console) && win.term.is_some()).then_some(Message::TogglePin(id)),
            )),
        ]);
        let net_ready = self.launch.as_ref().ok().and_then(|l| l.version).is_some_and(|v| v >= NET_CLIENT) && win.profile.is_some();
        let help = Menu::new(vec![
            Item::new(entry(t("Cómo se usa", "How to use it"), "", Some(Message::Help))),
            // Por dónde va cada conexión con los otros aparatos (cliente ≥ 0.46.0).
            Item::new(entry(t("Uso de red…", "Network use…"), "", net_ready.then_some(Message::Network(id)))),
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
        .padding([2, 4])
        // La barra de iced_aw mide lo que sus entradas y pinta su propio fondo redondeado: se veía
        // como una pastilla que acababa en «Ayuda». Con el fondo del contenedor y sin borde, la
        // franja ocupa todo el ancho de la ventana.
        .style(|theme: &Theme, status| {
            let base = iced_aw::style::menu_bar::primary(theme, status);
            iced_aw::style::menu_bar::Style {
                bar_background: theme.extended_palette().background.weak.color.into(),
                bar_border: iced::Border::default(),
                bar_shadow: iced::Shadow::default(),
                ..base
            }
        });
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
        let body: Element<'_, Message> = container(body).width(Length::Fill).height(Length::Fill).into();
        // La tarjeta «de qué va» flota sobre la consola (solo si hay consola que mostrar).
        let body: Element<'_, Message> = match (win.term.is_some() && win.error.is_none()).then(|| self.about(id, win)).flatten() {
            Some(card) => iced::widget::stack![body, card].into(),
            None => body,
        };
        let main: Element<'_, Message> = match (win.sidebar, &win.profile) {
            (true, Some(profile)) => row![self.side(id, profile), body].into(),
            _ => body,
        };
        let all: Element<'_, Message> = column![self.menu(id, win), main].into();
        // El aviso (versión nueva, o reiniciar) flota centrado sobre la ventana.
        // Una orden sobre otra máquina que aún no se confirma: un aviso pequeño, abajo y centrado.
        let all: Element<'_, Message> = match self.applying.get(&id) {
            Some(a) => {
                let chip = container(text(a.what.clone()).size(12)).padding([6, 12]).style(|theme: &Theme| container::Style {
                    background: Some(theme.extended_palette().background.weak.color.into()),
                    border: Border { color: theme.palette().primary, width: 1.0, radius: 12.0.into() },
                    ..Default::default()
                });
                let over = container(chip).width(Length::Fill).height(Length::Fill).align_x(iced::alignment::Horizontal::Center).align_y(iced::alignment::Vertical::Bottom).padding(16);
                iced::widget::stack![all, over].into()
            }
            None => all,
        };
        match &self.notice {
            Some(n) => iced::widget::stack![all, self.notice_card(id, n)].into(),
            None => all,
        }
    }

    /// Clic derecho sobre una consola del panel (colapsado o no): lo que se puede hacer con ella.
    /// El menú de clic secundario de una consola del panel. `machine`: dónde vive (`None`: esta
    /// máquina). Vale igual para las de aquí y las de otra máquina, mire la ventana la que mire.
    fn console_menu<'a>(&self, id: window::Id, machine: Option<String>, cid: String, is_mine: bool, under: Element<'a, Message>) -> Element<'a, Message> {
        let ready = self.panel_ready();
        let pin_label = if self.pinned_here(id) { t("Soltar el tamaño", "Release the size") } else { t("Usar el tamaño de esta ventana", "Use this window's size") };
        let can_pin = is_mine && self.pin_ready();
        ContextMenu::new(under, move || {
            let here = (!is_mine && ready).then(|| Message::Go(id, machine.clone(), Some(cid.clone())));
            container(
                column![
                    entry(t("Abrir aquí", "Open here"), "", here),
                    entry(t("Abrir en otra ventana", "Open in another window"), "", Some(Message::OpenInNewWindow(id, machine.clone(), cid.clone()))),
                    entry(pin_label.clone(), "", can_pin.then_some(Message::TogglePin(id))),
                    separator(),
                    entry(t("Cerrar consola", "Close console"), "", Some(Message::KillAt(id, machine.clone(), cid.clone()))),
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

    /// El aviso sobre la ventana: qué pasa y dos botones (hacerlo ahora, o después).
    fn notice_card<'a>(&'a self, id: window::Id, notice: &Notice) -> Element<'a, Message> {
        let (title, lines, go, go_msg) = match notice {
            Notice::Offer(lines) => (
                t("Hay una versión nueva", "There is a new version"),
                lines.clone(),
                t("Actualizar ahora", "Update now"),
                Message::NoticeUpdate(id),
            ),
            Notice::Restart => (
                t("La app se actualizó", "The app was updated"),
                vec![t("Esta ventana sigue con la versión anterior. Al reiniciar, tus consolas no se cierran.", "This window keeps the old version. Restarting does not close your consoles.")],
                t("Reiniciar la app", "Restart the app"),
                Message::RestartApp,
            ),
            Notice::Agents(st) => {
                let mut lines = vec![
                    t(&format!("El agente de esta máquina sigue con la versión anterior. Para usar la {} hay que cerrar todas sus terminales.", st.installed), &format!("This machine's agent keeps the old version. Using {} means closing all its terminals.", st.installed)),
                    match st.consoles {
                        0 => t("Ahora no tiene ninguna abierta.", "It has none open right now."),
                        n => t(&format!("Se cierran {n}, con lo que esté corriendo en ellas: las de estas ventanas, las de tu editor y las que miran tus otros aparatos."), &format!("{n} will be closed, with whatever runs in them: the ones in these windows, in your editor and the ones your other devices are looking at.")),
                    },
                ];
                if let Some(why) = &st.failed {
                    lines.push(format!("{}: {why}", t("No se pudo", "It failed")));
                }
                (t("dotrino-terminal se actualizó", "dotrino-terminal was updated"), lines, t("Cerrar todas las terminales", "Close all terminals"), Message::RestartAgents)
            }
        };
        let mut body = column![text(title).size(16)].spacing(6);
        for l in lines {
            body = body.push(text(l).size(13));
        }
        let buttons = row![
            button(text(t("Después", "Later")).size(13)).padding([6, 12]).style(menu_button).on_press(Message::NoticeLater),
            button(text(go).size(13)).padding([6, 12]).on_press(go_msg),
        ]
        .spacing(8);
        let card = container(column![body, container(buttons).width(Length::Fill).align_x(iced::alignment::Horizontal::Right)].spacing(14))
            .padding(16)
            .max_width(420)
            .style(|theme: &Theme| container::Style {
                background: Some(theme.extended_palette().background.weak.color.into()),
                border: Border { color: theme.extended_palette().background.strong.color, width: 1.0, radius: 8.0.into() },
                ..Default::default()
            });
        container(card).width(Length::Fill).height(Length::Fill).align_x(iced::alignment::Horizontal::Center).align_y(iced::alignment::Vertical::Center).into()
    }

    /// El panel lateral: un botón por cada consola abierta en el perfil de la ventana.
    fn side<'a>(&'a self, id: window::Id, profile: &str) -> Element<'a, Message> {
        let mine = self.mine(id);
        let here = self.windows.get(&id).and_then(|w| w.machine.clone());
        // El panel es EL MISMO mire la ventana la máquina que mire: primero las consolas de esta
        // máquina y después las de las otras. La consola de la ventana se marca donde esté.
        let list = self.consoles.get(&scope_key(profile, None)).cloned().unwrap_or_default();
        let others: Vec<&Machine> = self.far.get(profile).map(|l| l.iter().collect()).unwrap_or_default();
        // ¿Mira la ventana una consola de ESTA máquina? Ordenar arrastrando y el menú de una
        // consola hablan con la máquina de la ventana: solo se ofrecen sobre sus consolas.
        let local = here.is_none();
        // Las consolas de la máquina que mira la ventana (para el tamaño y ⤢).
        let shown = self.consoles.get(&scope_key(profile, here.as_deref())).cloned().unwrap_or_default();
        let my_tag = self.windows.get(&id).map(|w| w.tag.clone()).unwrap_or_default();
        let panel_style = |theme: &Theme| container::Style { background: Some(theme.extended_palette().background.weak.color.into()), ..Default::default() };
        // Colapsado: una franja estrecha, un botón numerado por consola (el título, al pasar).
        let collapsed = self.windows.get(&id).is_some_and(|w| w.sidebar_collapsed);
        // La franja de la flecha lleva el fondo de la terminal: se lee como parte de ella.
        let term_bg = {
            let h = self.palette.background.trim_start_matches('#');
            let part = |i: usize| h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(0);
            Color::from_rgb8(part(0), part(2), part(4))
        };
        // Con un cliente viejo, nada de lo que cambia de consola funciona: deshabilitado, y por qué.
        let ready = self.panel_ready();
        let why = t("Actualiza dotrino-terminal (Perfil → Actualizar) para usar el panel", "Update dotrino-terminal (Profile → Update) to use the panel");
        let act = |m: Message| ready.then_some(m);
        let centered = |s: String, size: u32| text(s).size(size).width(Length::Fill).align_x(iced::alignment::Horizontal::Center);
        // ⤢ actúa sobre la consola de ESTA ventana: fija su tamaño a esta ventana, o lo suelta.
        let cur = shown.iter().enumerate().find(|(_, c)| mine.as_deref() == Some(c.id.as_str())).map(|(i, c)| (c.n.map(|n| n as usize).unwrap_or(i + 1), c));
        let pin_on = self.pinned_here(id);
        // Basta con que la ventana tenga una consola: la orden va a su cliente. Esperar a verla en
        // la lista dejaba el botón apagado en una máquina con clave (su lista no se puede leer) y
        // mientras la de otra máquina tarda en llegar.
        let can_pin = self.pin_ready() && self.windows.get(&id).is_some_and(|w| matches!(w.mode, Mode::Console) && w.profile.is_some() && w.term.is_some());
        let pin_tip = match cur {
            _ if !self.pin_ready() => t("Actualiza dotrino-terminal (Perfil → Actualizar) para elegir el tamaño", "Update dotrino-terminal (Profile → Update) to choose the size"),
            Some((n, _)) if pin_on => format!("{} {n} {}", t("Soltar: la consola", "Release: console"), t("deja de usar el tamaño de esta ventana", "stops using this window's size")),
            Some((n, _)) => format!("{} {n}", t("Usar el tamaño de esta ventana en la consola", "Use this window's size for console")),
            None => t("Usar el tamaño de esta ventana", "Use this window's size"),
        };
        // `here`: ¿es este el botón de la máquina donde está la consola de la ventana? Cada máquina
        // tiene el suyo; los de las demás se ven deshabilitados.
        let pin_btn = |w: f32, here: bool| -> Element<'_, Message> {
            let (pin_on, can_pin) = (pin_on && here, can_pin && here);
            let icon = iced::widget::svg(iced::widget::svg::Handle::from_memory(ICON_SIZE)).width(14).height(14).style(move |theme: &Theme, _| iced::widget::svg::Style { color: Some(if pin_on { theme.palette().primary } else { theme.extended_palette().background.base.text.scale_alpha(0.7) }) });
            let b = button(container(icon).center_x(Length::Fill)).width(w).padding([4, 0]).style(if pin_on { side_selected } else { menu_button }).on_press_maybe(can_pin.then_some(Message::TogglePin(id)));
            iced::widget::tooltip(b, container(text(pin_tip.clone()).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right).into()
        };
        // ORDENAR ARRASTRANDO: la fila sobre la que caería la que se lleva se marca con una raya,
        // encima (va delante) o debajo (va detrás).
        let ids: Vec<&str> = list.iter().map(|c| c.id.as_str()).collect();
        let drop = self.drag.as_ref().filter(|d| d.win == id).and_then(|d| {
            let before = drop_target(&ids, &d.id, &d.over)?;
            Some((d.over.clone(), before.as_deref() == Some(d.over.as_str())))
        });
        let mark = |w: Length| -> Element<'_, Message> { container(space()).width(w).height(2).style(|theme: &Theme| container::Style { background: Some(theme.palette().primary.into()), ..Default::default() }).into() };
        let draggable = |cid: &str, e: Element<'a, Message>, w: Length| -> Element<'a, Message> {
            let e: Element<'a, Message> = iced::widget::mouse_area(e).on_enter(Message::RowEnter(id, cid.to_string())).on_exit(Message::RowExit(id, cid.to_string())).into();
            match drop.as_ref().filter(|(over, _)| over == cid) {
                Some((_, true)) => column![mark(w), e].into(),
                Some((_, false)) => column![e, mark(w)].into(),
                None => e,
            }
        };
        if collapsed {
            let mut strip = column![
                button(centered("»".into(), 13)).width(24).padding([2, 0]).style(menu_button).on_press(Message::CollapseSidebar(id)),
                button(centered("+".into(), 14)).width(24).padding([2, 0]).style(menu_button).on_press_maybe(act(Message::Go(id, None, None))),
                pin_btn(24.0, local),
            ]
            .spacing(4);
            for (i, c) in list.iter().enumerate() {
                let n = c.n.map(|n| n as usize).unwrap_or(i + 1);
                let is_mine = local && mine.as_deref() == Some(c.id.as_str());
                let (host, dir, name) = panel_lines(&c.title, c.cwd.as_deref(), c.host.as_deref().or(user_at_host().as_deref()));
                let tip = [host, dir, name].into_iter().flatten().collect::<Vec<_>>().join("\n");
                let tip = if tip.is_empty() { format!("{} {}", t("Consola", "Console"), n) } else { tip };
                let b = button(centered(format!("{n}"), 12))
                    .width(24)
                    .padding([4, 0])
                    .style(console_button(is_mine, c.act()))
                    .on_press_maybe(act(Message::Go(id, None, Some(c.id.clone()))));
                // El punto verde: una consola atendida en ESTA máquina (una ventana de la app, o la
                // terminal de VS Code). Parpadea solo si la muestra una ventana de la app.
                let open = is_mine || c.open_in_a_window();
                let b: Element<'_, Message> = container(dotted(b.into(), open, self.blink_off && self.blinks(c) && c.in_an_app_window(), if is_mine || c.in_an_app_window() { OPEN_COLOR } else { OUTSIDE_COLOR })).center_x(Length::Fill).into();
                let tip = match c.act() {
                    Act::Busy => format!("{tip} · {}", t("trabajando", "working")),
                    Act::Done => format!("{tip} · {}", t("terminó", "finished")),
                    Act::Idle => tip,
                };
                let tip = if c.watchers.iter().any(|w| w.origin == "local" && w.tag.as_deref() != Some(my_tag.as_str())) { format!("{tip} · {}", t("abierta en otra ventana", "open in another window")) } else { tip };
                let tip = if ready { tip } else { format!("{tip}\n{why}") };
                // El menú va POR FUERA del hint: con el menú abierto el hint se quita sin que el
                // menú pierda su estado.
                let tipped: Element<'_, Message> = if self.menu_open { b } else { iced::widget::tooltip(b, container(text(tip).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right).into() };
                let tipped = self.console_menu(id, None, c.id.clone(), is_mine, tipped);
                strip = strip.push(arrowed(if local { draggable(&c.id, tipped, Length::Fixed(24.0)) } else { tipped }, is_mine));
            }
            // Las otras máquinas: sus iniciales (de dónde son las consolas; no es un botón), un «+»
            // explícito para abrir una consola allí (dueño, 2026-10-13) y un botón por consola.
            // Abren en ESTA ventana, como las de aquí (dueño, 2026-10-10).
            for m in &others {
                let label = m.label();
                let state = if m.locked { Some(t("pide su clave", "asks for its code")) } else if m.consoles.is_none() { Some(t("no contesta", "not answering")) } else { None };
                let head = centered(label.chars().take(2).collect::<String>(), 11);
                let about = match state { Some(s) => format!("{label} · {}\n{s}", m.id), None => format!("{label} · {}", m.id) };
                let head: Element<'_, Message> = iced::widget::tooltip(container(head).width(24).padding([3, 0]), container(text(about).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right).into();
                // Con clave, el «+» es por donde se escribe (la pide la terminal al pasar allí).
                let (sign, what) = if m.locked { (">", t("Escribir la clave de", "Type the code of")) } else { ("+", t("Consola nueva en", "New console on")) };
                let plus = button(centered(sign.into(), 14)).width(24).padding([2, 0]).style(menu_button).on_press_maybe(act(Message::Go(id, Some(m.id.clone()), None)));
                let plus: Element<'_, Message> = iced::widget::tooltip(plus, container(text(format!("{what} {label}")).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right).into();
                strip = strip.push(container(separator()).width(24));
                strip = strip.push(container(head).padding(iced::Padding { right: ARROW_W, ..Default::default() }));
                strip = strip.push(container(plus).padding(iced::Padding { right: ARROW_W, ..Default::default() }));
                strip = strip.push(container(pin_btn(24.0, here.as_deref() == Some(m.id.as_str()))).padding(iced::Padding { right: ARROW_W, ..Default::default() }));
                for (i, c) in m.consoles.iter().flatten().enumerate() {
                    let n = c.n.map(|n| n as usize).unwrap_or(i + 1);
                    let (host, dir, name) = panel_lines(&c.title, c.cwd.as_deref(), c.host.as_deref());
                    let tip = std::iter::once(label.clone()).chain([host, dir, name].into_iter().flatten()).collect::<Vec<_>>().join("\n");
                    let is_mine = here.as_deref() == Some(m.id.as_str()) && mine.as_deref() == Some(c.id.as_str());
                    let b = button(centered(format!("{n}"), 12)).width(24).padding([4, 0]).style(console_button(is_mine, c.act())).on_press_maybe(act(Message::Go(id, Some(m.id.clone()), Some(c.id.clone()))));
                    let b: Element<'_, Message> = container(dotted(b.into(), is_mine || c.attended_from_here(), self.blink_off && self.blinks(c), OPEN_COLOR)).center_x(Length::Fill).into();
                    let b: Element<'_, Message> = if self.menu_open { b } else { iced::widget::tooltip(b, container(text(tip).size(12)).padding(6).style(panel_style), iced::widget::tooltip::Position::Right).into() };
                    let b = self.console_menu(id, Some(m.id.clone()), c.id.clone(), is_mine, b);
                    strip = strip.push(arrowed(b, is_mine));
                }
            }
            // Sin otras máquinas por un motivo que se arregla: una «!» que lo dice al pasar.
            if let Some((why, true)) = self.far_notice(profile) {
                let mark = text("!").size(13).width(Length::Fill).align_x(iced::alignment::Horizontal::Center).style(|theme: &Theme| text::Style { color: Some(theme.palette().primary) });
                let b = button(mark).width(24).padding([3, 0]).style(menu_button);
                let b: Element<'_, Message> = iced::widget::tooltip(b, container(text(why).size(12)).padding(6).max_width(320).style(panel_style), iced::widget::tooltip::Position::Right).into();
                strip = strip.push(container(separator()).width(24));
                strip = strip.push(container(b).padding(iced::Padding { right: ARROW_W, ..Default::default() }));
            }
            // Lo justo para dos dígitos («00»): 24 px de botón en 30 de franja.
            return with_arrow_gutter(strip.into(), 30.0, iced::Padding { top: 4.0, bottom: 4.0, left: 3.0, right: 0.0 }, term_bg);
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
                button(text("+").size(14)).padding([2, 6]).style(menu_button).on_press_maybe(act(Message::Go(id, None, None))),
            ]
            .align_y(iced::Alignment::Center)
            .padding(iced::Padding { left: 8.0, ..Default::default() }),
        ]
        .spacing(2);
        // Solo el tamaño (dueño, 2026-10-07): quién lo tiene ya lo dice el ⤢ encendido y su aviso.
        if let Some((_, c)) = cur.filter(|_| local) {
            items = items.push(
                row![text(format!("{}×{}", c.cols, c.rows)).size(12).width(Length::Fill), pin_btn(28.0, true)]
                    .align_y(iced::Alignment::Center)
                    .padding(iced::Padding { left: 8.0, ..Default::default() }),
            );
        }
        if !ready {
            items = items.push(note(why.clone()));
        }
        // Lo de arriba no llega a la franja de la flecha; las filas de las consolas sí.
        let mut items = column![container(items).padding(iced::Padding { right: 4.0 + ARROW_W, ..Default::default() })].spacing(2);
        for (i, c) in list.iter().enumerate() {
            let n = c.n.map(|n| n as usize).unwrap_or(i + 1);
            let is_mine = local && mine.as_deref() == Some(c.id.as_str());
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
            let dim = |theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.65)) };
            let (host, dir, name) = panel_lines(&c.title, c.cwd.as_deref(), user_at_host().as_deref());
            let mut lines = [host, dir, name].into_iter().flatten();
            let first = lines.next().map(|l| format!("{n} · {l}")).unwrap_or_else(|| format!("{} {}", t("Consola", "Console"), n));
            let mut label = column![text(format!("{}{first}", if is_mine { "● " } else { "" })).size(12)];
            for l in lines {
                label = label.push(text(l).size(12));
            }
            // De qué va: la primera línea de su nota.
            if let Some(line) = [c.task.as_deref(), c.note.as_deref()].into_iter().flatten().flat_map(str::lines).map(str::trim).find(|l| !l.is_empty()) {
                label = label.push(text(line.to_string()).size(12).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().primary.base.color) }));
            }
            let label = label.push(text(where_).size(11).style(dim));
            let pick = button(label).width(Length::Fill).padding([4, 8]).style(console_button(is_mine, c.act())).on_press_maybe(act(Message::Go(id, None, Some(c.id.clone()))));
            let kill = button(text("×").size(13)).padding([4, 6]).style(menu_button).on_press(Message::KillAt(id, None, c.id.clone()));
            let pick = dotted(pick.into(), is_mine || c.open_in_a_window(), self.blink_off && self.blinks(c) && c.in_an_app_window(), if is_mine || c.in_an_app_window() { OPEN_COLOR } else { OUTSIDE_COLOR });
            let entry_row: Element<'_, Message> = row![pick, kill].align_y(iced::Alignment::Center).into();
            let entry_row = self.console_menu(id, None, c.id.clone(), is_mine, entry_row);
            let entry_row = if local { draggable(&c.id, entry_row, Length::Fill) } else { entry_row };
            let entry = container(entry_row).padding(iced::Padding { right: 4.0, ..Default::default() });
            items = items.push(arrowed(entry.into(), is_mine));
        }
        // LAS OTRAS MÁQUINAS de la cuenta: su nombre (un título: dice de dónde son las consolas),
        // debajo «Nueva consola +» en su propia fila, como la de aquí (dueño, 2026-10-13), y sus consolas.
        // Abren en ESTA ventana y se cierran con su «×», como las de aquí (dueño, 2026-10-10).
        for m in &others {
            let dim = |theme: &Theme| text::Style { color: Some(theme.extended_palette().background.base.text.scale_alpha(0.65)) };
            let state = if m.locked { Some(t("pide su clave", "asks for its code")) } else if m.consoles.is_none() { Some(t("no contesta", "not answering")) } else { None };
            let mut head = column![text(m.label()).size(13)];
            head = head.push(text(match state { Some(s) => format!("{} · {s}", m.id), None => m.id.clone() }).size(11).style(dim));
            items = items.push(container(separator()).padding(iced::Padding { top: 6.0, right: ARROW_W, ..Default::default() }));
            items = items.push(container(head).padding(iced::Padding { left: 8.0, top: 6.0, right: 4.0 + ARROW_W, bottom: 0.0 }));
            // Con clave, en vez de «Nueva consola»: la clave se teclea en la terminal de esta ventana
            // (la pide el cliente al pasar a esa máquina) y vale hasta que el agente de aquí se reinicie.
            let (what, sign) = if m.locked { (t("Escribir la clave", "Type its code"), ">") } else { (t("Nueva consola", "New console"), "+") };
            items = items.push(
                row![
                    text(what).size(12).width(Length::Fill),
                    button(text(sign).size(14)).padding([2, 6]).style(menu_button).on_press_maybe(act(Message::Go(id, Some(m.id.clone()), None))),
                ]
                .align_y(iced::Alignment::Center)
                .padding(iced::Padding { left: 8.0, top: 0.0, right: 4.0 + ARROW_W, bottom: 0.0 }),
            );
            // El tamaño, bajo el «+» de CADA máquina (dueño, 2026-10-13): el de la consola de esta
            // ventana si está en esa máquina; si no, el botón se ve deshabilitado.
            let on_it = here.as_deref() == Some(m.id.as_str());
            let size = match cur.filter(|_| on_it) {
                Some((_, c)) => format!("{}×{}", c.cols, c.rows),
                None => t("Tamaño", "Size"),
            };
            items = items.push(
                row![text(size).size(12).width(Length::Fill), pin_btn(28.0, on_it)]
                    .align_y(iced::Alignment::Center)
                    .padding(iced::Padding { left: 8.0, top: 0.0, right: 4.0 + ARROW_W, bottom: 0.0 }),
            );
            for (i, c) in m.consoles.iter().flatten().enumerate() {
                let n = c.n.map(|n| n as usize).unwrap_or(i + 1);
                let (host, dir, name) = panel_lines(&c.title, c.cwd.as_deref(), c.host.as_deref());
                let mut lines = [host, dir, name].into_iter().flatten();
                let first = lines.next().map(|l| format!("{n} · {l}")).unwrap_or_else(|| format!("{} {}", t("Consola", "Console"), n));
                let is_mine = here.as_deref() == Some(m.id.as_str()) && mine.as_deref() == Some(c.id.as_str());
                let mut label = column![text(format!("{}{first}", if is_mine { "● " } else { "" })).size(12)];
                for l in lines {
                    label = label.push(text(l).size(12));
                }
                if let Some(line) = [c.task.as_deref(), c.note.as_deref()].into_iter().flatten().flat_map(str::lines).map(str::trim).find(|l| !l.is_empty()) {
                    label = label.push(text(line.to_string()).size(12).style(|theme: &Theme| text::Style { color: Some(theme.extended_palette().primary.base.color) }));
                }
                let where_ = if is_mine { t("en esta ventana", "in this window") } else if c.watchers.is_empty() { t("suelta", "detached") } else { t("abierta", "open") };
                let where_ = match c.act() {
                    Act::Busy => format!("{where_} · {}", t("trabajando", "working")),
                    Act::Done => format!("{where_} · {}", t("terminó", "finished")),
                    Act::Idle => where_,
                };
                let label = label.push(text(where_).size(11).style(dim));
                let pick = button(label).width(Length::Fill).padding([4, 8]).style(console_button(is_mine, c.act())).on_press_maybe(act(Message::Go(id, Some(m.id.clone()), Some(c.id.clone()))));
                let kill = button(text("×").size(13)).padding([4, 6]).style(menu_button).on_press(Message::KillAt(id, Some(m.id.clone()), c.id.clone()));
                let pick = dotted(pick.into(), is_mine || c.attended_from_here(), self.blink_off && self.blinks(c), OPEN_COLOR);
                let entry_row: Element<'_, Message> = row![pick, kill].align_y(iced::Alignment::Center).into();
                let entry_row = self.console_menu(id, Some(m.id.clone()), c.id.clone(), is_mine, entry_row);
                items = items.push(arrowed(container(entry_row).padding(iced::Padding { right: 4.0, ..Default::default() }).into(), is_mine));
            }
        }
        // Ninguna otra máquina a la vista: se dice por qué, en vez de dejar el panel igual que si
        // no existieran.
        if let Some((why, problem)) = self.far_notice(profile) {
            let tone = move |theme: &Theme| text::Style { color: Some(if problem { theme.extended_palette().background.base.text } else { theme.extended_palette().background.base.text.scale_alpha(0.65) }) };
            items = items.push(container(separator()).padding(iced::Padding { top: 6.0, right: ARROW_W, ..Default::default() }));
            items = items.push(container(column![text(t("Otras máquinas", "Other machines")).size(13), text(why).size(11).style(tone)].spacing(2)).padding(iced::Padding { left: 8.0, top: 6.0, right: 4.0 + ARROW_W, bottom: 0.0 }));
        }
        with_arrow_gutter(items.into(), 210.0, iced::Padding { top: 4.0, bottom: 4.0, left: 4.0, right: 0.0 }, term_bg)
    }

    fn title(&self, id: window::Id) -> String {
        let Some(win) = self.windows.get(&id) else { return String::new() };
        let what = match &win.mode {
            Mode::Linking { .. } => t("Enrolar", "Enroll"),
            Mode::Updating { what, .. } => what.clone(),
            Mode::Console if win.title.is_empty() => "Dotrino Terminal".to_string(),
            Mode::Console => win.title.clone(),
        };
        match (&win.profile, &win.machine) {
            (Some(p), Some(m)) => format!("{what} — {} — {p}", self.machine_label(p, m)),
            (Some(p), None) => format!("{what} — {p}"),
            (None, _) => format!("{what} — {}", t("sin perfil", "no profile")),
        }
    }

    /// El nombre de otra máquina (el que le puso el dueño al enlazarla), o su id si no se sabe.
    fn machine_label(&self, profile: &str, machine: &str) -> String {
        self.far.get(profile).and_then(|l| l.iter().find(|m| m.id == machine)).map(Machine::label).unwrap_or_else(|| machine.to_string())
    }

    fn subscription(&self) -> Subscription<Message> {
        let terms = self.windows.values().filter_map(|w| w.term.as_ref()).map(|term| term.subscription().map(Message::Terminal));
        // Tras «Instalar dotrino-terminal…», se mira cada poco si ya está.
        let waiting = self.awaiting_client.then(|| iced::time::every(std::time::Duration::from_secs(3)).map(|_| Message::CheckClient));
        // El panel lateral: las consolas abiertas se releen cada poco mientras se ve.
        let polling = self.windows.values().any(|w| w.sidebar && w.profile.is_some())
            .then(|| iced::time::every(std::time::Duration::from_millis(1500)).map(|_| Message::Poll));
        // El punto parpadea solo mientras haya alguno que deba: sin eso, nada se repinta de más.
        let blinking = (polling.is_some() && self.consoles.values().flatten().any(|c| self.blinks(c) && c.in_an_app_window())
            || self.far.values().flatten().flat_map(|m| m.consoles.iter().flatten()).any(|c| self.blinks(c) && c.attended_from_here()))
            .then(|| iced::time::every(std::time::Duration::from_millis(500)).map(|_| Message::Blink));
        Subscription::batch(terms.chain([window::close_requests().map(Message::Close), iced::event::listen_with(shortcut)]).chain(waiting).chain(polling).chain(blinking))
    }
}

/// El ratón para el arrastre del panel, y los atajos del menú Archivo: Ctrl+Shift+N / Ctrl+Shift+W (Cmd+N / Cmd+W en macOS).
/// Copiar y pegar ya los atiende la propia terminal.
fn shortcut(event: Event, _status: iced::event::Status, id: window::Id) -> Option<Message> {
    // El arrastre del panel: el botón del ratón, lo atienda quien lo atienda (un botón de la
    // fila captura el clic, y aun así es donde empieza el arrastre).
    match event {
        Event::Mouse(iced::mouse::Event::ButtonPressed(iced::mouse::Button::Left)) => return Some(Message::MouseDown(id)),
        Event::Mouse(iced::mouse::Event::ButtonReleased(iced::mouse::Button::Left)) => return Some(Message::MouseUp),
        // El clic secundario abre un menú: mientras está abierto, los hints del panel no salen.
        Event::Mouse(iced::mouse::Event::ButtonPressed(iced::mouse::Button::Right)) => return Some(Message::MenuOpen),
        Event::Window(window::Event::Focused) => return Some(Message::Focused(id)),
        Event::Window(window::Event::Unfocused) => return Some(Message::Unfocused(id)),
        _ => {}
    }
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

/// Un texto de la tarjeta que se lee: se ve como texto, pero se puede seleccionar y copiar
/// (arrastrando y Ctrl+C, o con el clic derecho).
fn reading<'a>(id: window::Id, part: Part, content: &'a iced::widget::text_editor::Content, max_height: f32) -> Element<'a, Message> {
    let editor = iced::widget::text_editor(content)
        .size(12)
        .padding(0)
        .height(Length::Shrink)
        .max_height(max_height)
        .on_action(move |a| Message::ReadAction(id, part, a))
        .style(|theme: &Theme, _| {
            let p = theme.extended_palette();
            iced::widget::text_editor::Style {
                background: Color::TRANSPARENT.into(),
                border: Border::default(),
                placeholder: p.background.strong.color,
                value: p.background.base.text,
                selection: p.primary.weak.color,
            }
        });
    let has_selection = content.selection().is_some_and(|s| !s.is_empty());
    ContextMenu::new(editor, move || {
        let (copy_key, all_key) = if cfg!(target_os = "macos") { ("⌘C", "⌘A") } else { ("Ctrl+C", "Ctrl+A") };
        container(
            column![
                entry(t("Copiar", "Copy"), copy_key, has_selection.then_some(Message::ReadCopy(id, part))),
                entry(t("Seleccionar todo", "Select all"), all_key, Some(Message::ReadSelectAll(id, part))),
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

/// Un mensaje dentro de `ms` milisegundos.
/// El editor de la nota de una ventana, para darle el teclado al abrirlo.
fn note_editor_id(id: window::Id) -> iced::widget::Id {
    iced::widget::Id::from(format!("note-{id:?}"))
}

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

/// Lo que contestó el agente al preguntarle por las otras máquinas de la cuenta.
enum Far {
    List(Vec<Machine>),
    /// Dijo que no (sin enlazar con la bóveda, p. ej.), con su código y su motivo.
    No(String, String),
    /// No contestó a tiempo: aún está preguntando a la red, o es anterior a la 0.38.
    Silent,
}

/// Las otras máquinas de la cuenta, según el agente de este perfil. Contesta de memoria (él les
/// pregunta por detrás), así que se le espera poco: si aún no lo sabe, la próxima vez.
#[cfg(unix)]
fn agent_machines(dir: &Path) -> Far {
    use std::io::{BufRead, BufReader, Write};
    let Ok(mut sock) = std::os::unix::net::UnixStream::connect(dir.join("terminal.sock")) else { return Far::Silent };
    if sock.set_read_timeout(Some(std::time::Duration::from_millis(250))).is_err() || sock.write_all(b"{\"type\":\"machines\"}\n").is_err() {
        return Far::Silent;
    }
    let mut reader = BufReader::new(sock);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(n) if n > 0 => {}
            _ => return Far::Silent,
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { return Far::Silent };
        if v["type"] == "machines" {
            return serde_json::from_value(v["list"].clone()).map(Far::List).unwrap_or(Far::Silent);
        }
        if v["type"] == "fail" {
            return Far::No(v["code"].as_str().unwrap_or("far-error").to_string(), v["message"].as_str().unwrap_or("").to_string());
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
