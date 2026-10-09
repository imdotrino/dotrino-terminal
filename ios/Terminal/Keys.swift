import Foundation

/// What a key sends to the shell, given the sticky modifiers. No view here, so it can be tested.
enum Keys {
    /// Typed text with the modifiers applied: Shift uppercases, Ctrl makes a control character, Alt prefixes ESC.
    static func text(_ text: String, shift: Bool, ctrl: Bool, alt: Bool) -> String {
        var out = shift ? text.uppercased() : text
        if ctrl, text.unicodeScalars.count == 1, let c = controlOf(Character(text)) { out = String(c) }
        return alt ? "\u{1b}" + out : out
    }

    private static func controlOf(_ c: Character) -> Character? {
        guard let a = c.asciiValue else { return nil }
        switch c {
        case "a"..."z": return Character(Unicode.Scalar(a - 96))
        case "A"..."Z": return Character(Unicode.Scalar(a - 64))
        case " ", "2", "@": return Character(Unicode.Scalar(0))
        case "[", "3": return Character(Unicode.Scalar(27))
        case "\\", "4": return Character(Unicode.Scalar(28))
        case "]", "5": return Character(Unicode.Scalar(29))
        case "^", "6": return Character(Unicode.Scalar(30))
        case "_", "7", "/": return Character(Unicode.Scalar(31))
        case "?", "8": return Character(Unicode.Scalar(127))
        default: return nil
        }
    }

    /// A named key as the escape sequence a shell expects, or nil when it sends nothing (an unknown
    /// name, or Shift with a key that has no shifted form). `app`: the program asked for application
    /// cursor keys. Ctrl does not change these keys; Alt prefixes them.
    static func named(_ name: String, shift: Bool, alt: Bool, app: Bool) -> String? {
        guard let seq = shift ? shifted[name] : plain(name, app: app) else { return nil }
        return alt ? "\u{1b}" + seq : seq
    }

    private static func plain(_ name: String, app: Bool) -> String? {
        switch name {
        case "esc": return "\u{1b}"
        case "tab": return "\t"
        case "enter": return "\r"
        case "backspace": return "\u{7f}"
        case "up": return app ? "\u{1b}OA" : "\u{1b}[A"
        case "down": return app ? "\u{1b}OB" : "\u{1b}[B"
        case "right": return app ? "\u{1b}OC" : "\u{1b}[C"
        case "left": return app ? "\u{1b}OD" : "\u{1b}[D"
        case "home": return app ? "\u{1b}OH" : "\u{1b}[H"
        case "end": return app ? "\u{1b}OF" : "\u{1b}[F"
        case "pgup": return "\u{1b}[5~"
        case "pgdn": return "\u{1b}[6~"
        case "del": return "\u{1b}[3~"
        default: return nil
        }
    }

    /// With Shift, as xterm sends it: Shift+Tab is `CSI Z`, the rest carry the modifier `2`.
    private static let shifted: [String: String] = [
        "tab": "\u{1b}[Z",
        "up": "\u{1b}[1;2A", "down": "\u{1b}[1;2B", "right": "\u{1b}[1;2C", "left": "\u{1b}[1;2D",
        "home": "\u{1b}[1;2H", "end": "\u{1b}[1;2F",
        "pgup": "\u{1b}[5;2~", "pgdn": "\u{1b}[6;2~", "del": "\u{1b}[3;2~",
        "esc": "\u{1b}", "enter": "\r", "backspace": "\u{7f}",
    ]
}
