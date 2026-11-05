//! «Copiar sin saltos»: deshace los saltos que mete quien ajusta el texto al ancho de la pantalla
//! (Claude Code y otras TUI parten las líneas largas con saltos de verdad y una sangría, así que
//! un enlace copiado sale roto). Es la regla de `src/unwrap.js`, que manda, y la prueban los
//! mismos casos (`test/unwrap.vectors.json`).

const MIN_WRAP: usize = 40;
const MARGIN: usize = 15;
const LONG_TOKEN: usize = 30;

fn has_url(s: &str) -> bool {
    s.contains("http://") || s.contains("https://") || s.contains("www.")
}

fn url_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "%&=?/._~:+#@!$'()*,;[]-".contains(c)
}

/// Quita los huecos de 2+ espacios que caen dentro de un enlace: la sangría de la fila siguiente
/// cuando el terminal juntó las filas al copiar. Un espacio solo no se toca: ahí acaba el enlace.
fn close_url_gaps(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let starts = |i: usize| ["http://", "https://", "www."].iter().any(|p| c[i..].iter().take(p.len()).copied().eq(p.chars()));
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if !starts(i) {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let mut j = i;
        loop {
            while j < c.len() && !c[j].is_whitespace() {
                out.push(c[j]);
                j += 1;
            }
            let mut k = j;
            while k < c.len() && c[k] == ' ' {
                k += 1;
            }
            if k - j >= 2 && k < c.len() && url_char(c[k]) {
                j = k;
                continue;
            }
            break;
        }
        i = j;
    }
    out
}

fn indent(s: &str) -> usize {
    s.len() - s.trim_start().len()
}

pub fn unwrap(text: &str) -> String {
    let normalized = text.replace('\r', "");
    let lines: Vec<&str> = normalized.split('\n').map(str::trim_end).collect();
    if lines.len() < 2 {
        return close_url_gaps(text.trim());
    }
    let width = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    let common = lines[1..].iter().filter(|l| !l.is_empty()).map(|l| indent(l)).min().unwrap_or(0);
    let mut out = lines[0].trim_start().to_string();
    for i in 1..lines.len() {
        let prev = lines[i - 1];
        let cur = lines[i].trim();
        if cur.is_empty() {
            out.push('\n');
            continue;
        }
        let n = prev.chars().count();
        let last = out.split_whitespace().last().unwrap_or("").to_string();
        let in_url = has_url(&last);
        let first = cur.chars().next().unwrap();
        let sentence = !in_url && prev.ends_with(['.', ':', ';', '!', '?']) && first.is_uppercase();
        let wrapped = !prev.is_empty() && n >= MIN_WRAP && !sentence && (n + MARGIN >= width || first.is_lowercase());
        if !wrapped {
            out.push('\n');
            out.push_str(&lines[i][common.min(indent(lines[i]))..]);
        } else if in_url || last.chars().count() >= LONG_TOKEN {
            out.push_str(cur);
        } else {
            out.push(' ');
            out.push_str(cur);
        }
    }
    close_url_gaps(out.trim())
}

#[cfg(test)]
mod tests {
    #[test]
    fn follows_the_shared_vectors() {
        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../test/unwrap.vectors.json")).unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            assert_eq!(super::unwrap(v["in"].as_str().unwrap()), v["out"].as_str().unwrap(), "case {}", v["name"]);
        }
    }
}
