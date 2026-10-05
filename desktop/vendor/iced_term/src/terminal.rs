use crate::actions::Action;
use crate::backend;
use crate::bindings::{Binding, BindingAction, BindingsLayout, InputKind};
use crate::font::TermFont;
use crate::settings::{FontSettings, Settings, ThemeSettings};
use crate::theme::{ColorPalette, Theme};
use crate::AlacrittyEvent;
use iced::futures::stream::BoxStream;
use iced::futures::{SinkExt, StreamExt};
use iced::widget::canvas::Cache;
use iced::Subscription;
use std::hash::{Hash, Hasher};
use std::io::Result;
use std::sync::Arc;
use tokio::sync::mpsc::{self, Receiver};
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub enum Event {
    BackendCall(u64, backend::Command),
}

#[derive(Debug, Clone)]
pub enum Command {
    ChangeTheme(Box<ColorPalette>),
    ChangeFont(FontSettings),
    AddBindings(Vec<(Binding<InputKind>, BindingAction)>),
    ProxyToBackend(backend::Command),
}

pub struct Terminal {
    pub id: u64,
    widget_id: iced::widget::Id,
    pub(crate) font: TermFont,
    pub(crate) theme: Theme,
    pub(crate) cache: Cache,
    pub(crate) bindings: BindingsLayout,
    pub(crate) backend: backend::Backend,
    backend_event_rx: Arc<Mutex<Receiver<AlacrittyEvent>>>,
}

impl Terminal {
    pub fn new(id: u64, settings: Settings) -> Result<Self> {
        let (backend_event_tx, backend_event_rx) = mpsc::channel(100);
        let theme = Theme::new(settings.theme);
        let font = TermFont::new(settings.font);

        Ok(Self {
            id,
            widget_id: iced::widget::Id::unique(),
            font,
            theme,
            bindings: BindingsLayout::default(),
            cache: Cache::default(),
            backend: backend::Backend::new(
                id,
                backend_event_tx,
                settings.backend,
            )?,
            backend_event_rx: Arc::new(Mutex::new(backend_event_rx)),
        })
    }

    /// El texto seleccionado, para que la app lo copie desde su menú.
    /// Parche de Dotrino sobre iced_term 0.8.0 (ver desktop/vendor/README.md).
    pub fn selected_text(&self) -> String {
        self.backend.selectable_content()
    }

    /// El tamaño (en píxeles) del área que ocupa la terminal. Parche de Dotrino: para pasárselo
    /// a la terminal que la reemplaza en la misma ventana.
    pub fn layout_size(&self) -> iced::Size<f32> {
        crate::backend::layout_size(&self.backend)
    }

    /// Fija el tamaño del PTY para un área de `size` píxeles. Parche de Dotrino: el widget solo
    /// avisa del tamaño con el primer evento que le llega; una terminal que reemplaza a otra en
    /// la misma ventana se quedaba mientras tanto en el tamaño de arranque (80×50 PÍXELES: ~11×3
    /// celdas), y el programa que arranca dentro lo leía así.
    pub fn resize_to(&mut self, size: iced::Size<f32>) {
        self.backend.handle(backend::Command::Resize(Some(size), Some(self.font.measure)));
        self.redraw();
    }

    /// El tamaño de una celda, en píxeles. Parche de Dotrino: para dibujar la consola al tamaño
    /// que tiene cuando lo decide otra pantalla.
    pub fn cell_size(&self) -> iced::Size<f32> {
        crate::backend::cell_size(&self.backend)
    }

    /// Dónde está la vista: (líneas desplazadas hacia arriba, líneas de historial, líneas de
    /// pantalla). Parche de Dotrino: para dibujar una barra de desplazamiento.
    pub fn scroll_position(&self) -> (usize, usize, usize) {
        use alacritty_terminal::grid::Dimensions;
        let grid = &self.backend.renderable_content().grid;
        (grid.display_offset(), grid.history_size(), grid.screen_lines())
    }

    /// Quita la selección. Parche de Dotrino: el clic sobre una opción de un menú contextual
    /// llega también a la terminal de debajo y empieza una selección que nadie pidió.
    pub fn clear_selection(&mut self) {
        crate::backend::clear_selection(&mut self.backend);
        self.redraw();
    }

    /// Los bytes que hay que escribir para PEGAR `text`. Parche de Dotrino: si el programa pidió
    /// el pegado entre corchetes (bash, zsh, vim lo piden), va entre `ESC[200~` y `ESC[201~`, y
    /// así un texto con saltos de línea queda en el prompt en vez de ejecutarse solo. Del texto
    /// se quita cualquier `ESC[201~`, que cerraría el corchete antes de tiempo y colaría el resto
    /// como si se hubiera tecleado.
    pub fn paste_bytes(&self, text: &str) -> Vec<u8> {
        crate::backend::paste_bytes(&self.backend, text)
    }

    pub fn widget_id(&self) -> &iced::widget::Id {
        &self.widget_id
    }

    pub fn subscription(&self) -> Subscription<Event> {
        let data = TerminalSubscriptionData {
            id: self.id,
            event_receiver: self.backend_event_rx.clone(),
        };

        Subscription::run_with(data, terminal_subscription_stream)
    }

    pub fn handle(&mut self, cmd: Command) -> Action {
        let mut action = Action::default();

        match cmd {
            Command::ChangeTheme(color_pallete) => {
                self.theme = Theme::new(ThemeSettings::new(color_pallete));
            },
            Command::ChangeFont(font_settings) => {
                self.font = TermFont::new(font_settings);
            },
            Command::AddBindings(bindings) => {
                self.bindings.add_bindings(bindings);
            },
            Command::ProxyToBackend(cmd) => {
                action = self.backend.handle(cmd);
            },
        };

        self.sync_and_redraw();
        action
    }

    fn sync_and_redraw(&mut self) {
        self.sync_font();
        self.backend.sync();
        self.redraw();
    }

    fn sync_font(&mut self) {
        self.font.sync();
        self.backend
            .handle(backend::Command::Resize(None, Some(self.font.measure)));
    }

    fn redraw(&mut self) {
        self.cache.clear();
    }
}

#[derive(Clone)]
struct TerminalSubscriptionData {
    id: u64,
    event_receiver: Arc<Mutex<Receiver<AlacrittyEvent>>>,
}

impl Hash for TerminalSubscriptionData {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}

fn terminal_subscription_stream(
    data: &TerminalSubscriptionData,
) -> BoxStream<'static, Event> {
    let id = data.id;
    let event_receiver = data.event_receiver.clone();
    iced::stream::channel(1000, async move |mut output| {
        let mut shutdown = false;
        loop {
            let mut event_receiver = event_receiver.lock().await;
            match event_receiver.recv().await {
                Some(event) => {
                    if let AlacrittyEvent::Exit = event {
                        shutdown = true
                    };

                    output
                        .send(Event::BackendCall(id, backend::Command::ProcessAlacrittyEvent(event)))
                        .await
                        .unwrap_or_else(|_| {
                            panic!("iced_term stream {}: sending BackendEventReceived event is failed", id)
                        });
                },
                None => {
                    if !shutdown {
                        panic!("iced_term stream {}: terminal event channel closed unexpected", id);
                    }
                },
            }
        }
    })
    .boxed()
}
