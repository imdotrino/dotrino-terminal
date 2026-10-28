import Foundation

/// Los enlaces y las rutas de una línea de la consola, para abrirlos con un toque. El port de
/// `src/links.js`: la MISMA regla en las cuatro versiones (web, escritorio, Android, iOS), y los
/// mismos casos de prueba (`test/links.vectors.json`, que lee `LinksTests`).
///
/// La línea se parte en trozos por los espacios, las comillas y `<>|;()[]{}`. A cada trozo se le
/// quita la puntuación del final (`.,:;!?`) y se mira qué es:
///   - un enlace: empieza por `http://`, `https://`, `ftp://`, `file://` o `mailto:`;
///   - una ruta: empieza por `/`, `~/`, `./` o `../` (o va tras un `=`: `--out=/tmp/x`), y tiene
///     al menos una letra o un número (así `//` o `/` sueltos no cuentan).
/// De una ruta, `target` quita el `:línea:columna` del final (`src/a.js:12:3`).
///
/// Las posiciones cuentan escalares Unicode: lo mismo que las unidades UTF-16 de JS en el plano
/// básico, y lo mismo que las celdas de la consola salvo los caracteres anchos (ver `Terminal.link`).
struct LinkHit: Equatable {
    enum Kind: String { case url, path }
    /// Where it starts and ends in the line (`end` not included), in scalars.
    let start: Int, end: Int
    let text: String
    let kind: Kind
    let target: String
}

enum Links {
    /// JS `\s`, exactly: the regex of `links.js` splits on these.
    private static let jsSpace: Set<UInt32> = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
    private static let separators: Set<Unicode.Scalar> = ["'", "\"", "`", "<", ">", "|", ";", "(", ")", "[", "]", "{", "}"]
    private static let trailing: Set<Unicode.Scalar> = [".", ",", ":", ";", "!", "?"]
    private static let urlStarts = ["https://", "http://", "ftp://", "file://", "mailto:"]

    static func isSeparator(_ s: Unicode.Scalar) -> Bool {
        jsSpace.contains(s.value) || (0x2000...0x200A).contains(s.value) || separators.contains(s)
    }

    /// Every link and path of `line`, in order.
    static func find(_ line: String) -> [LinkHit] { find(Array(line.unicodeScalars)) }

    static func find(_ line: [Unicode.Scalar]) -> [LinkHit] {
        var out: [LinkHit] = []
        var i = 0
        while i < line.count {
            if isSeparator(line[i]) { i += 1; continue }
            var j = i
            while j < line.count && !isSeparator(line[j]) { j += 1 }
            if case let (at, text, kind, target)? = classify(Array(line[i..<j])) {
                out.append(LinkHit(start: i + at, end: i + at + text.count, text: String(String.UnicodeScalarView(text)), kind: kind, target: target))
            }
            i = j
        }
        return out
    }

    /// The link of `line` that goes through position `col`, or nil.
    static func at(_ line: String, _ col: Int) -> LinkHit? { find(line).first { col >= $0.start && col < $0.end } }

    private static func startsWith(_ s: [Unicode.Scalar], _ prefix: String, ignoringCase: Bool = false) -> Bool {
        let p = Array(prefix.unicodeScalars)
        guard s.count >= p.count else { return false }
        for k in 0..<p.count {
            let a = s[k], b = p[k]
            if a == b { continue }
            // Only ASCII letters change case in these prefixes (the regex is /i).
            guard ignoringCase, a.isASCII, String(a).lowercased() == String(b) else { return false }
        }
        return true
    }

    private static func isPathStart(_ s: [Unicode.Scalar]) -> Bool {
        startsWith(s, "/") || startsWith(s, "~/") || startsWith(s, "./") || startsWith(s, "../")
    }

    /// `\p{L}` or `\p{N}`.
    private static func isLetterOrNumber(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    private static func classify(_ token: [Unicode.Scalar]) -> (Int, [Unicode.Scalar], LinkHit.Kind, String)? {
        var text = token
        while let last = text.last, trailing.contains(last) { text.removeLast() }
        if let start = urlStarts.first(where: { startsWith(text, $0, ignoringCase: true) }) {
            guard text.count > start.unicodeScalars.count else { return nil }
            return (0, text, .url, String(String.UnicodeScalarView(text)))
        }
        var at = 0
        if !isPathStart(text) {
            guard let eq = text.lastIndex(of: "="), isPathStart(Array(text[(eq + 1)...])) else { return nil }
            at = eq + 1
        }
        let p = Array(text[at...])
        if startsWith(p, "//") || !p.contains(where: isLetterOrNumber) { return nil }
        return (at, p, .path, stripLineColumn(String(String.UnicodeScalarView(p))))
    }

    /// `src/a.js:12:3` → `src/a.js` (JS: `/:\d+(?::\d+)?$/`, ASCII digits).
    private static func stripLineColumn(_ s: String) -> String {
        guard let r = s.range(of: #":[0-9]+(:[0-9]+)?$"#, options: .regularExpression) else { return s }
        return String(s[..<r.lowerBound])
    }
}

/// What a tap on a link opens: a web address (for the phone's browser or mail) or a file of the
/// machine (it is brought over the session). A `file://` address is a path of the machine.
enum LinkTarget: Equatable {
    case web(String)
    case file(String)

    /// Nil when the link says nothing that can be opened (`file://host` without a path).
    init?(_ l: LinkHit) {
        switch l.kind {
        case .path: self = .file(l.target)
        case .url:
            guard l.target.lowercased().hasPrefix("file://") else { self = .web(l.target); return }
            guard let path = URL(string: l.target)?.path, !path.isEmpty else { return nil }
            self = .file(path)
        }
    }

    /// The options of its menu, in order.
    var actions: [LinkAction] {
        switch self {
        case .web: return [.open, .copy]
        case .file: return [.open, .share, .copy]
        }
    }

    /// What «copy» puts on the clipboard.
    var text: String {
        switch self { case .web(let s), .file(let s): return s }
    }
}

enum LinkAction: Equatable { case open, share, copy }

extension Terminal {
    /// The link under the cell (`y`, `col`) of the screen (negative `y`: the history), or nil. The
    /// line is the whole LOGICAL line: a long path that wrapped onto the next rows is one link.
    func link(atLine y: Int, col: Int) -> LinkHit? {
        guard y >= -historySize, y < rows, col >= 0, col < cols else { return nil }
        var first = y
        while first - 1 >= -historySize && row(first - 1).wrapped { first -= 1 }
        var last = y
        while last + 1 < rows && row(last).wrapped { last += 1 }
        var line: [Unicode.Scalar] = []
        var at: Int?
        for l in first...last {
            for (x, cp) in row(l).cp.enumerated() {
                // The second half of a wide character belongs to the first.
                if l == y && x == col { at = cp == Self.wideTail ? max(0, line.count - 1) : line.count }
                if cp == Self.wideTail { continue }
                line.append(Unicode.Scalar(cp) ?? "\u{FFFD}")
            }
        }
        guard let at else { return nil }
        return Links.find(line).first { at >= $0.start && at < $0.end }
    }
}
