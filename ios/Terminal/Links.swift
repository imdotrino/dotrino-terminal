import Foundation

/// Los enlaces y las rutas de una línea de la consola, para abrirlos con un toque. Es el puerto de
/// `src/links.js`: la MISMA regla en las cuatro versiones (web, escritorio, Android, iOS) y los
/// mismos casos de prueba (`test/links.vectors.json`, LinksTests). Si una reconoce algo que otra no,
/// el usuario ve dos terminales distintas: un cambio aquí va también allí.
///
/// Las posiciones son en unidades UTF-16, como en JavaScript.
enum Links {
    enum Kind: String { case url, path }

    /// `start`/`end`: positions in the line (`end` excluded).
    struct Link: Equatable, Identifiable {
        let start: Int, end: Int, text: String, kind: Kind, target: String
        var id: String { "\(start):\(text)" }
    }

    /// A `file://` link whose escapes do not decode.
    struct BadLink: Error { let text: String }

    // `\s` de JavaScript (Unicode), más las comillas y `<>|;()[]{}`.
    private static let sep = Set(" \t\n\u{0B}\u{0C}\r\u{A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}'\"`<>|;()[]{}".utf16)

    private static func first(_ s: String, _ pattern: String, _ options: String.CompareOptions = []) -> Range<String.Index>? {
        s.range(of: pattern, options: options.union(.regularExpression))
    }

    static func find(_ line: String) -> [Link] {
        let u = Array(line.utf16)
        var out: [Link] = []
        var i = 0
        while i < u.count {
            if sep.contains(u[i]) { i += 1; continue }
            var j = i
            while j < u.count, !sep.contains(u[j]) { j += 1 }
            if let (at, text, kind, target) = classify(String(decoding: u[i..<j], as: UTF16.self)) {
                out.append(Link(start: i + at, end: i + at + text.utf16.count, text: text, kind: kind, target: target))
            }
            i = j
        }
        return out
    }

    /// The link of `line` that covers position `col`, or nil.
    static func at(_ line: String, _ col: Int) -> Link? { find(line).first { col >= $0.start && col < $0.end } }

    private static func classify(_ token: String) -> (Int, String, Kind, String)? {
        var text = token
        if let r = first(text, "[.,:;!?]+$") { text.removeSubrange(r) }
        if let r = first(text, "^(?:(?:https?|ftp|file)://|mailto:)", .caseInsensitive) {
            return r.upperBound < text.endIndex ? (0, text, .url, text) : nil
        }
        let pathStart = "^(?:/|~/|\\.\\.?/)"
        var at = 0
        var p = text
        if first(text, pathStart) == nil {
            guard let eq = text.range(of: "=", options: .backwards) else { return nil }
            p = String(text[eq.upperBound...])
            guard first(p, pathStart) != nil else { return nil }
            at = text[..<eq.upperBound].utf16.count
        }
        if p.hasPrefix("//") || first(p, "[\\p{L}\\p{N}]") == nil { return nil }
        var target = p
        if let r = first(target, ":\\d+(?::\\d+)?$") { target.removeSubrange(r) }
        return (at, p, .path, target)
    }

    /// A `file://` link is a path of the machine; a path is itself; any other link is not a path (nil).
    static func asPath(_ l: Link) throws -> String? {
        if l.kind == .path { return l.target }
        guard l.target.lowercased().hasPrefix("file://") else { return nil }
        var raw = l.target
        if let r = first(raw, "^file://[^/]*", .caseInsensitive) { raw.removeSubrange(r) }
        guard let decoded = raw.removingPercentEncoding else { throw BadLink(text: l.target) }
        return decoded
    }

    /// The link under a cell of `t`: `line` as `Terminal.row` counts it (negative = history), `col`
    /// the column. The row is read whole with the rows it wrapped into, so a long path cut at the
    /// edge of the screen is still one path.
    static func at(_ t: Terminal, _ line: Int, _ col: Int) -> Link? {
        guard line >= -t.historySize, line < t.rows else { return nil }
        var first = line
        while first - 1 >= -t.historySize, t.row(first - 1).wrapped { first -= 1 }
        var last = line
        while last + 1 < t.rows, t.row(last).wrapped { last += 1 }
        var units: [UInt16] = []
        var pos = -1
        for y in first...last {
            let r = t.row(y)
            for x in r.cp.indices {
                let cp = r.cp[x]
                if cp == Terminal.wideTail { if y == line && x == col { pos = max(0, units.count - 1) }; continue }
                if y == line && x == col { pos = units.count }
                if cp < 32 { units.append(32) }
                else if let u = Unicode.Scalar(cp) { units.append(contentsOf: String(Character(u)).utf16) }
            }
        }
        if pos < 0 { return nil }
        return at(String(decoding: units, as: UTF16.self), pos)
    }
}
