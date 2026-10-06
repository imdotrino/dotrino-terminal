import SwiftUI
import UIKit

/// The screen of a `Terminal`: draws its cells and turns the keyboard (the phone's or a real one)
/// into what a shell expects. A plain UIView, no WebView (CONVENCIONES §16.2). The port of
/// `TerminalView.kt`: the same keys, the same sequences, the same colours.
///
/// The emulator has the CONSOLE's size, which another screen may decide: it is drawn at that size
/// and the rest of the view is left in another colour (as the PWA does). A console wider than the
/// view is panned sideways with the finger; up and down is the history.
final class TerminalView: UIView, UIKeyInput, UIGestureRecognizerDelegate {
    var terminal: Terminal? { didSet { scrollBack = 0; panX = 0; refit(); setNeedsDisplay() } }

    /// What was typed, already as the bytes a shell reads.
    var onInput: (String) -> Void = { _ in }
    /// The columns and rows that fit changed (the view's size, the font, the keyboard).
    var onResize: (Int, Int) -> Void = { _, _ in }
    var onLongPress: () -> Void = {}
    /// A sticky modifier was used up by the key that followed it.
    var onModifiersChanged: () -> Void = {}

    /// Sticky modifiers of the extra-keys row: they apply to the NEXT key and switch off.
    var ctrl = false
    var alt = false

    private var fontSize: CGFloat = 12
    private var font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    private var boldFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .bold)
    private var cellW: CGFloat = 1
    private var cellH: CGFloat = 1
    /// Lines scrolled back into the history (0 = the live screen).
    private var scrollBack = 0
    private var scrollRemainder: CGFloat = 0
    /// Columns panned sideways, when the console is wider than the view.
    private var panX = 0
    private var panRemainder: CGFloat = 0

    private(set) var cols = 80
    private(set) var rows = 24

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        backgroundColor = Self.outsideBg
        setFont(fontSize)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
        addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
        addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:))))
        accessibilityIdentifier = "terminal"
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    // MARK: size

    private func setFont(_ size: CGFloat) {
        fontSize = min(max(size, 7), 30)
        font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        boldFont = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .bold)
        cellW = ("M" as NSString).size(withAttributes: [.font: font]).width
        cellH = ceil(font.lineHeight)
        fit()
    }

    private func fit() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let c = max(2, Int(bounds.width / cellW)), r = max(2, Int(bounds.height / cellH))
        if c == cols && r == rows { return }
        cols = c; rows = r
        onResize(c, r)
    }

    /// Say again what fits (a new terminal on screen must hear it).
    func refit() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        cols = max(2, Int(bounds.width / cellW)); rows = max(2, Int(bounds.height / cellH))
        onResize(cols, rows)
    }

    override func layoutSubviews() { super.layoutSubviews(); fit() }

    // MARK: drawing — «Cool & Cozy» dark, the same as the PWA and Android

    static let defaultFg = UIColor(rgb: 0xDFE3E6)
    static let defaultBg = UIColor(rgb: 0x0F1416)
    /// The part of the view outside the console, when the console is smaller than the screen.
    static let outsideBg = UIColor(rgb: 0x1C2022)
    static let cursorColor = UIColor(rgb: 0x81CFFF)
    private static let ansi: [UInt32] = [
        0x262A2D, 0xF87171, 0x34D399, 0xFBBF24, 0x60A5FA, 0xC084FC, 0x22D3EE, 0xD4D0EE,
        0x6B6494, 0xFCA5A5, 0x6EE7B7, 0xFDE68A, 0x93C5FD, 0xD8B4FE, 0x67E8F9, 0xFFFFFF,
    ]

    private func color(_ c: Int, _ fallback: UIColor) -> UIColor {
        typealias S = Terminal.Style
        if c == S.defaultColor { return fallback }
        if c & S.rgb != 0 { return UIColor(rgb: UInt32(c & 0xFFFFFF)) }
        if c < 16 { return UIColor(rgb: Self.ansi[c]) }
        if c < 232 {                                                // the 6×6×6 colour cube
            let n = c - 16, l: [UInt32] = [0, 95, 135, 175, 215, 255]
            return UIColor(rgb: (l[n / 36] << 16) | (l[(n / 6) % 6] << 8) | l[n % 6])
        }
        let g = UInt32(8 + (c - 232) * 10)                           // the grey ramp
        return UIColor(rgb: (g << 16) | (g << 8) | g)
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        guard let t = terminal else { Self.defaultBg.setFill(); ctx.fill(bounds); return }
        Self.outsideBg.setFill(); ctx.fill(bounds)
        panX = min(max(panX, 0), max(0, t.cols - cols))
        let back = min(scrollBack, t.historySize)
        let visibleRows = min(rows, t.rows)
        let shownCols = min(t.cols - panX, cols + 1)
        Self.defaultBg.setFill()
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(shownCols) * cellW, height: CGFloat(visibleRows) * cellH))
        ctx.saveGState()
        ctx.clip(to: CGRect(x: 0, y: 0, width: CGFloat(shownCols) * cellW, height: CGFloat(visibleRows) * cellH))
        ctx.translateBy(x: -CGFloat(panX) * cellW, y: 0)
        for y in 0..<visibleRows {
            let line = y - back
            if line >= t.rows { break }
            drawRow(ctx, t.row(line), CGFloat(y) * cellH, min(panX + cols + 1, t.cols))
        }
        if t.cursorVisible && back == 0 && t.cursorY < visibleRows && t.cursorX < t.cols {
            let r = CGRect(x: CGFloat(t.cursorX) * cellW, y: CGFloat(t.cursorY) * cellH, width: cellW, height: cellH)
            Self.cursorColor.setFill(); ctx.fill(r)
            let cp = t.row(t.cursorY).cp[t.cursorX]
            if cp > 32, let u = Unicode.Scalar(cp) {
                (String(Character(u)) as NSString).draw(at: r.origin, withAttributes: [.font: font, .foregroundColor: Self.defaultBg])
            }
        }
        ctx.restoreGState()
    }

    private func drawRow(_ ctx: CGContext, _ r: Terminal.Row, _ top: CGFloat, _ n: Int) {
        typealias S = Terminal.Style
        var x = 0
        while x < n {
            let st = r.st[x]
            // A run: neighbouring cells with the same style, drawn at once.
            var end = x + 1
            while end < n && r.st[end] == st { end += 1 }
            let flags = S.flags(st)
            var fg = color(S.fg(st), Self.defaultFg), bg = color(S.bg(st), Self.defaultBg)
            if flags & S.inverse != 0 { swap(&fg, &bg) }
            if flags & S.dim != 0 { fg = fg.withAlphaComponent(0.6) }
            if S.bg(st) != S.defaultColor || flags & S.inverse != 0 {
                bg.setFill(); ctx.fill(CGRect(x: CGFloat(x) * cellW, y: top, width: CGFloat(end - x) * cellW, height: cellH))
            }
            if flags & S.invisible == 0 {
                var attrs: [NSAttributedString.Key: Any] = [.font: flags & S.bold != 0 ? boldFont : font, .foregroundColor: fg]
                if flags & S.underline != 0 { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                if flags & S.strike != 0 { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if flags & S.italic != 0 { attrs[.obliqueness] = 0.2 }
                // Plain ASCII goes as one string (the font is monospace). Anything else goes cell by
                // cell: a glyph from a fallback font has its own width and would push the rest.
                var i = x
                while i < end {
                    let cp = r.cp[i]
                    if (33...126).contains(cp) {
                        let start = i
                        var run = ""
                        while i < end, (32...126).contains(r.cp[i]) { run.unicodeScalars.append(Unicode.Scalar(UInt8(r.cp[i]))); i += 1 }
                        (run as NSString).draw(at: CGPoint(x: CGFloat(start) * cellW, y: top), withAttributes: attrs)
                    } else {
                        if cp > 32, cp != Terminal.wideTail, let u = Unicode.Scalar(cp) {
                            (String(Character(u)) as NSString).draw(at: CGPoint(x: CGFloat(i) * cellW, y: top), withAttributes: attrs)
                        }
                        i += 1
                    }
                }
            }
            x = end
        }
    }

    /// The shell wrote something: draw it.
    func onOutput() { setNeedsDisplay() }

    // MARK: touch: scroll the history, pan, zoom the font, open the keyboard

    @objc private func tapped() { _ = becomeFirstResponder() }

    @objc private func pressed(_ g: UILongPressGestureRecognizer) { if g.state == .began { onLongPress() } }

    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        if g.state == .changed { setFont(fontSize * g.scale); g.scale = 1; setNeedsDisplay() }
    }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        guard let t = terminal else { return }
        let d = g.translation(in: self); g.setTranslation(.zero, in: self)
        if abs(d.x) > abs(d.y) {
            // Sideways only pans a console wider than the view.
            guard t.cols > cols else { return }
            panRemainder -= d.x
            let k = Int(panRemainder / cellW)
            if k != 0 { panRemainder -= CGFloat(k) * cellW; panX = min(max(panX + k, 0), t.cols - cols); setNeedsDisplay() }
        } else {
            scrollRemainder += d.y
            let k = Int(scrollRemainder / cellH)
            if k != 0 { scrollRemainder -= CGFloat(k) * cellH; scrollBack = min(max(scrollBack + k, 0), t.historySize); setNeedsDisplay() }
        }
    }

    // MARK: keyboard

    override var canBecomeFirstResponder: Bool { true }
    var hasText: Bool { true }
    // Each key arrives as typed: no prediction, correction nor capitals (the shell decides).
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
    var keyboardAppearance: UIKeyboardAppearance = .dark

    func insertText(_ text: String) { type(text.replacingOccurrences(of: "\n", with: "\r")) }
    func deleteBackward() { key("backspace") }

    /// Send what a key means, applying the sticky modifiers of the extra row to it.
    func type(_ text: String) {
        guard !text.isEmpty else { return }
        var out = text
        if ctrl, text.unicodeScalars.count == 1, let c = Self.controlOf(Character(text)) { out = String(c) }
        if alt { out = "\u{1b}" + out }
        if ctrl || alt { ctrl = false; alt = false; onModifiersChanged() }
        scrollBack = 0
        onInput(out)
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

    /// A named key of the extra row or of a real keyboard, as the escape sequence a shell expects.
    func key(_ name: String) {
        let app = terminal?.appCursorKeys == true
        let seq: String
        switch name {
        case "esc": seq = "\u{1b}"
        case "tab": seq = "\t"
        case "enter": seq = "\r"
        case "backspace": seq = "\u{7f}"
        case "up": seq = app ? "\u{1b}OA" : "\u{1b}[A"
        case "down": seq = app ? "\u{1b}OB" : "\u{1b}[B"
        case "right": seq = app ? "\u{1b}OC" : "\u{1b}[C"
        case "left": seq = app ? "\u{1b}OD" : "\u{1b}[D"
        case "home": seq = app ? "\u{1b}OH" : "\u{1b}[H"
        case "end": seq = app ? "\u{1b}OF" : "\u{1b}[F"
        case "pgup": seq = "\u{1b}[5~"
        case "pgdn": seq = "\u{1b}[6~"
        case "del": seq = "\u{1b}[3~"
        default: return
        }
        // Ctrl does not change these keys; Alt still prefixes them.
        let out = alt ? "\u{1b}" + seq : seq
        if ctrl || alt { ctrl = false; alt = false; onModifiersChanged() }
        scrollBack = 0
        onInput(out)
    }

    /// Paste: bracketed when the program asked for it, so it does not run what was pasted line by line.
    func paste(_ text: String) {
        guard !text.isEmpty else { return }
        let body = text.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r")
        scrollBack = 0
        onInput(terminal?.bracketedPaste == true ? "\u{1b}[200~\(body)\u{1b}[201~" : body)
    }

    /// What is on screen now, as text (for «copy»). Wrapped lines are joined.
    func screenText() -> String {
        guard let t = terminal else { return "" }
        var s = ""
        let back = min(scrollBack, t.historySize)
        for y in 0..<t.rows {
            let line = y - back
            s += t.text(line)
            if !t.row(line).wrapped { s += "\n" }
        }
        while s.last == "\n" { s.removeLast() }
        return s
    }

    /// A real keyboard: arrows, Escape and the rest arrive as presses, not as text.
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var handled = false
        for p in presses {
            guard let k = p.key else { continue }
            let named: String? = switch k.keyCode {
            case .keyboardUpArrow: "up"
            case .keyboardDownArrow: "down"
            case .keyboardLeftArrow: "left"
            case .keyboardRightArrow: "right"
            case .keyboardEscape: "esc"
            case .keyboardHome: "home"
            case .keyboardEnd: "end"
            case .keyboardPageUp: "pgup"
            case .keyboardPageDown: "pgdn"
            case .keyboardDeleteForward: "del"
            case .keyboardTab: "tab"
            default: nil
            }
            if let named { key(named); handled = true }
            else if k.modifierFlags.contains(.control), let c = k.charactersIgnoringModifiers.first {
                ctrl = true; type(String(c)); handled = true
            }
        }
        if !handled { super.pressesBegan(presses, with: event) }
    }
}

/// The terminal view in SwiftUI: the same `TerminalView` for the tab on screen.
struct TerminalScreen: UIViewRepresentable {
    let tab: Tab
    @Binding var view: TerminalView?

    func makeUIView(context: Context) -> TerminalView {
        let v = TerminalView(frame: .zero)
        DispatchQueue.main.async { view = v }
        return v
    }

    func updateUIView(_ v: TerminalView, context: Context) {
        guard v.terminal !== tab.terminal else { return }
        v.onInput = { [weak tab] in tab?.input($0) }
        v.onResize = { [weak tab] c, r in tab?.screen(c, r) }
        tab.onOutput = { [weak v] in v?.onOutput() }
        v.terminal = tab.terminal
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}
