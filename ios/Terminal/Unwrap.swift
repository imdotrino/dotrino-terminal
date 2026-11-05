import Foundation

/// «Copiar sin saltos»: deshace los saltos que mete quien ajusta el texto al ancho de la pantalla
/// (Claude Code y otras TUI parten las líneas largas con saltos de verdad y una sangría, así que un
/// enlace copiado sale roto). Es el puerto de `src/unwrap.js`, que manda: la misma regla en las
/// cuatro versiones y los mismos casos (`test/unwrap.vectors.json`, UnwrapTests).
enum Unwrap {
    private static let minWrap = 40
    private static let margin = 15
    private static let longToken = 30

    private static func hasURL(_ s: String) -> Bool { s.contains("http://") || s.contains("https://") || s.contains("www.") }
    private static func indent(_ s: String) -> Int { s.prefix(while: { $0 == " " || $0 == "\t" }).count }
    private static func trimEnd(_ s: String) -> String {
        var s = s
        while let c = s.last, c == " " || c == "\t" { s.removeLast() }
        return s
    }

    static func unwrap(_ text: String) -> String {
        let lines = text.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n").map(trimEnd)
        if lines.count < 2 { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        let width = lines.map { $0.unicodeScalars.count }.max() ?? 0
        let common = lines.dropFirst().filter { !$0.isEmpty }.map(indent).min() ?? 0
        var out = String(lines[0].drop(while: { $0 == " " || $0 == "\t" }))
        for i in 1..<lines.count {
            let prev = lines[i - 1]
            let cur = lines[i].trimmingCharacters(in: .whitespaces)
            if cur.isEmpty { out += "\n"; continue }
            let n = prev.unicodeScalars.count
            let last = out.split(whereSeparator: { $0.isWhitespace }).last.map(String.init) ?? ""
            let inURL = hasURL(last)
            let first = cur.first!
            let sentence = !inURL && prev.last.map { ".:;!?".contains($0) } == true && first.isUppercase
            let wrapped = !prev.isEmpty && n >= minWrap && !sentence && (n >= width - margin || first.isLowercase)
            if !wrapped {
                out += "\n" + String(lines[i].dropFirst(min(common, indent(lines[i]))))
            } else if inURL || last.unicodeScalars.count >= longToken {
                out += cur
            } else {
                out += " " + cur
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
