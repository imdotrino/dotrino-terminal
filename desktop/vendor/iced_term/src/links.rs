//! Parche de Dotrino: los enlaces y las rutas de una línea de la consola.
//!
//! La MISMA regla que `src/links.js` de la web (y que Android e iOS), con los mismos casos de
//! prueba (`test/links.vectors.json`, que prueba la app de escritorio). La línea se parte en
//! trozos por los espacios, las comillas y `<>|;()[]{}`; a cada trozo se le quita la puntuación
//! del final (`.,:;!?`) y se mira si es un enlace (`http://`, `https://`, `ftp://`, `file://`,
//! `mailto:`) o una ruta (empieza por `/`, `~/`, `./` o `../`, o va tras un `=`, y tiene al menos
//! una letra o un número). De una ruta, `target` quita el `:línea:columna` del final.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Url,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Posición en caracteres dentro de la línea (`end` sin incluir).
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub kind: LinkKind,
    pub target: String,
}

fn is_sep(c: char) -> bool {
    c.is_whitespace() || "'\"`<>|;()[]{}".contains(c)
}

const URL_STARTS: [&str; 5] = ["http://", "https://", "ftp://", "file://", "mailto:"];

fn url_start(s: &str) -> Option<usize> {
    URL_STARTS.iter().find(|p| s.get(..p.len()).is_some_and(|h| h.eq_ignore_ascii_case(p))).map(|p| p.len())
}

fn path_start(s: &str) -> bool {
    s.starts_with('/') || s.starts_with("~/") || s.starts_with("./") || s.starts_with("../")
}

/// `a:12` → `a`; si lo que sigue a los dos puntos no son todo cifras, nada.
fn strip_num(s: &str) -> Option<&str> {
    let (head, tail) = s.rsplit_once(':')?;
    (!tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit())).then_some(head)
}

fn classify(token: &[char]) -> Option<(usize, String, LinkKind, String)> {
    let mut end = token.len();
    while end > 0 && ".,:;!?".contains(token[end - 1]) {
        end -= 1;
    }
    let text: String = token[..end].iter().collect();
    if let Some(n) = url_start(&text) {
        return (text.len() > n).then(|| (0, text.clone(), LinkKind::Url, text.clone()));
    }
    let mut at = 0;
    let mut p = text.as_str();
    if !path_start(p) {
        let eq = text.rfind('=')?;
        if !path_start(&text[eq + 1..]) {
            return None;
        }
        at = text[..eq + 1].chars().count();
        p = &text[eq + 1..];
    }
    if p.starts_with("//") || !p.chars().any(char::is_alphanumeric) {
        return None;
    }
    let target = match strip_num(p) {
        Some(a) => strip_num(a).unwrap_or(a),
        None => p,
    };
    Some((at, p.to_string(), LinkKind::Path, target.to_string()))
}

/// Los enlaces de una línea, dada como sus caracteres.
pub fn find_links(line: &[char]) -> Vec<Link> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < line.len() {
        if is_sep(line[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < line.len() && !is_sep(line[j]) {
            j += 1;
        }
        if let Some((at, text, kind, target)) = classify(&line[i..j]) {
            let start = i + at;
            out.push(Link { start, end: start + text.chars().count(), text, kind, target });
        }
        i = j;
    }
    out
}

/// Lo mismo, desde un texto.
pub fn find_links_in(line: &str) -> Vec<Link> {
    find_links(&line.chars().collect::<Vec<_>>())
}
