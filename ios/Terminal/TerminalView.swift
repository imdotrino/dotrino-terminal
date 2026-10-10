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
    /// The selection appeared or went away (the «copy» key follows it).
    var onSelectionChanged: () -> Void = {}
    /// A sticky modifier was used up by the key that followed it.
    var onModifiersChanged: () -> Void = {}

    /// Sticky modifiers of the extra-keys row: they apply to the NEXT key and switch off.
    var ctrl = false
    var alt = false
    var shift = false

    private var fontSize: CGFloat = 12
    private var font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    private var boldFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .bold)
    private var cellW: CGFloat = 1
    private var cellH: CGFloat = 1
    /// Lines scrolled back into the history (0 = the live screen).
    private var scrollBack = 0

    /// Rows of the console that do not fit in the view (another screen has its size, or the keyboard is up).
    private func below(_ t: Terminal) -> Int { max(0, t.rows - rows) }
    /// The console line on the view's first row when nothing is scrolled. A console taller than the
    /// view FOLLOWS THE CURSOR: drawn always from the top, what was being typed stayed out of reach
    /// under the keyboard.
    private func liveTop(_ t: Terminal) -> Int { min(max(t.cursorY - rows + 1, 0), below(t)) }
    /// How far the view can go: up, the hidden rows above and then the history; down (negative), the hidden rows below.
    private func maxBack(_ t: Terminal) -> Int { t.historySize + liveTop(t) }
    private func minBack(_ t: Terminal) -> Int { liveTop(t) - below(t) }
    private func back(_ t: Terminal) -> Int { min(max(scrollBack, minBack(t)), maxBack(t)) }
    /// The console line on the view's first row (negative = history).
    private func topLine(_ t: Terminal) -> Int { liveTop(t) - back(t) }
    private var scrollRemainder: CGFloat = 0
    /// Columns panned sideways, when the console is wider than the view.
    private var panX = 0
    private var panRemainder: CGFloat = 0

    private(set) var cols = 80
    private(set) var rows = 24

    /// A cell of the buffer, by ABSOLUTE line (history first, then the screen): stable while the
    /// console scrolls and while new output pushes lines into the history.
    struct Cell: Equatable { var line: Int; var col: Int }
    /// What the finger selected (long press, then drag): the two ends, in any order. Nil = nothing.
    private(set) var selection: (a: Cell, b: Cell)? {
        didSet { if (oldValue == nil) != (selection == nil) { onSelectionChanged() } }
    }
    // The two ends carry a handle each, to adjust the selection after lifting the finger.
    private static let handleR: CGFloat = 9
    private static let handleColor = UIColor(rgb: 0x81CFFF)
    private var pressing = false
    /// While a handle is dragged: the end that stays, and where the finger grabbed it.
    private var dragFixed: Cell?
    private var grab = CGPoint.zero
    static let selectionColor = UIColor(rgb: 0x81CFFF).withAlphaComponent(0.35)
    /// The console is never asked to be narrower than this (owner, 2026-10-07: with the panel open the
    /// view got 16 columns wide and the shell reflowed everything). Narrower views pan sideways.
    static let minCols = 40
    /// How much of the bottom of the view the keyboard covers (0 when it is down). The console must
    /// fill the screen, no more and no less (owner, 2026-10-07): what fits is measured against the
    /// part the keyboard leaves uncovered, whether or not the layout above shrinks for it.
    private var keyboardOverlap: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        backgroundColor = Self.outsideBg
        setFont(fontSize)
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        nc.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
        addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
        addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:))))
        accessibilityIdentifier = "terminal"
        // One element with the screen as its value: a UI test can read what the console shows.
        isAccessibilityElement = true
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

    /// The part of the view the keyboard does not cover.
    private var visibleHeight: CGFloat { max(0, bounds.height - keyboardOverlap) }

    private func fit() {
        guard bounds.width > 0, visibleHeight > 0 else { return }
        let c = max(2, Int(bounds.width / cellW)), r = max(2, Int(visibleHeight / cellH))
        if c == cols && r == rows { return }
        cols = c; rows = r
        onResize(max(Self.minCols, c), r)
    }

    /// Say again what fits (a new terminal on screen must hear it).
    func refit() {
        guard bounds.width > 0, visibleHeight > 0 else { return }
        cols = max(2, Int(bounds.width / cellW)); rows = max(2, Int(visibleHeight / cellH))
        onResize(max(Self.minCols, cols), rows)
    }

    override func layoutSubviews() { super.layoutSubviews(); fit() }

    @objc private func keyboardChanged(_ n: Notification) {
        guard let window else { return }
        var overlap: CGFloat = 0
        if n.name != UIResponder.keyboardWillHideNotification, let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue {
            let mine = convert(bounds, to: window)
            let kb = window.convert(end, from: nil)
            overlap = max(0, mine.maxY - max(kb.minY, mine.minY))
            if kb.minY >= window.bounds.maxY { overlap = 0 }     // out of the screen: down
        }
        if overlap == keyboardOverlap { return }
        keyboardOverlap = overlap
        // The layout above may shrink the view for the keyboard as well; `fit` runs again when it does.
        fit(); setNeedsDisplay()
    }

    func showKeyboard() { _ = becomeFirstResponder() }
    func hideKeyboard() { _ = resignFirstResponder() }

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
        let top = topLine(t)
        let visibleRows = min(rows, t.rows)
        let shownCols = min(t.cols - panX, cols + 1)
        Self.defaultBg.setFill()
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(shownCols) * cellW, height: CGFloat(visibleRows) * cellH))
        ctx.saveGState()
        ctx.clip(to: CGRect(x: 0, y: 0, width: CGFloat(shownCols) * cellW, height: CGFloat(visibleRows) * cellH))
        ctx.translateBy(x: -CGFloat(panX) * cellW, y: 0)
        for y in 0..<visibleRows {
            let line = top + y
            if line >= t.rows { break }
            drawRow(ctx, t.row(line), CGFloat(y) * cellH, min(panX + cols + 1, t.cols))
        }
        if let sel = selection {
            var (a, b) = (sel.a, sel.b)
            if (b.line, b.col) < (a.line, a.col) { swap(&a, &b) }
            Self.selectionColor.setFill()
            for y in 0..<visibleRows {
                let abs = t.historySize + top + y
                guard abs >= a.line, abs <= b.line else { continue }
                let from = abs == a.line ? a.col : 0
                let to = abs == b.line ? b.col + 1 : t.cols
                if to > from { ctx.fill(CGRect(x: CGFloat(from) * cellW, y: CGFloat(y) * cellH, width: CGFloat(to - from) * cellW, height: cellH)) }
            }
        }
        let cursorRow = t.cursorY - top
        if t.cursorVisible && cursorRow >= 0 && cursorRow < visibleRows && t.cursorX < t.cols {
            let r = CGRect(x: CGFloat(t.cursorX) * cellW, y: CGFloat(cursorRow) * cellH, width: cellW, height: cellH)
            Self.cursorColor.setFill(); ctx.fill(r)
            let cp = t.row(t.cursorY).cp[t.cursorX]
            if cp > 32, let u = Unicode.Scalar(cp) {
                (String(Character(u)) as NSString).draw(at: r.origin, withAttributes: [.font: font, .foregroundColor: Self.defaultBg])
            }
        }
        ctx.restoreGState()
        // The handles go under each end, outside the clip: on the last row they hang below it.
        if let h = handles() { drawHandle(ctx, h.start); drawHandle(ctx, h.end) }
    }

    private func orderedSelection() -> (a: Cell, b: Cell)? {
        guard let sel = selection else { return nil }
        return (sel.b.line, sel.b.col) < (sel.a.line, sel.a.col) ? (sel.b, sel.a) : sel
    }

    /// Where each handle hangs in the view: under the left edge of the first cell and under the
    /// right edge of the last one. Nil with no selection, or while it is being made.
    private func handles() -> (start: CGPoint, end: CGPoint)? {
        guard let t = terminal, !pressing, let sel = orderedSelection() else { return nil }
        let top = t.historySize + topLine(t)
        func at(_ c: Cell, right: Bool) -> CGPoint {
            CGPoint(x: CGFloat(c.col + (right ? 1 : 0) - panX) * cellW, y: CGFloat(c.line - top + 1) * cellH)
        }
        return (at(sel.a, right: false), at(sel.b, right: true))
    }

    private func drawHandle(_ ctx: CGContext, _ p: CGPoint) {
        let r = Self.handleR
        guard p.y >= 0, p.y <= bounds.height, p.x >= -r, p.x <= bounds.width + r else { return }
        Self.handleColor.setFill()
        ctx.fill(CGRect(x: p.x - 1.5, y: p.y - cellH, width: 3, height: cellH))
        ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y, width: r * 2, height: r * 2))
    }

    /// A touch that lands on a handle starts dragging that end.
    private func grabHandle(_ p: CGPoint) -> Bool {
        guard let h = handles(), let sel = orderedSelection() else { return false }
        let r = Self.handleR, reach = r * 2.6
        func near(_ q: CGPoint) -> Bool { hypot(p.x - q.x, p.y - (q.y + r)) <= reach }
        let start = near(h.start), end = near(h.end)
        guard start || end else { return false }
        // Both in reach (a short selection): the closer one.
        let takeEnd = end && (!start || hypot(p.x - h.end.x, p.y - h.end.y) <= hypot(p.x - h.start.x, p.y - h.start.y))
        let q = takeEnd ? h.end : h.start
        dragFixed = takeEnd ? sel.a : sel.b
        // The finger rests under the row: the cell is the one the handle points at, not the one under it.
        grab = CGPoint(x: p.x - (q.x + (takeEnd ? -cellW / 2 : cellW / 2)), y: p.y - (q.y - cellH / 2))
        return true
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
    func onOutput() { setNeedsDisplay(); accessibilityValue = screenText() }

    // MARK: touch: scroll the history, pan, zoom the font, open the keyboard

    @objc private func tapped() { clearSelection(); _ = becomeFirstResponder() }

    /// Long press: the cell under the finger starts a selection; dragging extends it. Lifting opens
    /// nothing: the handles adjust it and the «copy» key of the key row takes it (owner,
    /// 2026-10-09). The selection stays until a tap.
    @objc private func pressed(_ g: UILongPressGestureRecognizer) {
        switch g.state {
        case .began:
            guard let c = cell(at: g.location(in: self)) else { return }
            pressing = true; selection = (c, c); setNeedsDisplay()
        case .changed:
            guard var sel = selection, let c = cell(at: g.location(in: self)) else { return }
            sel.b = c; selection = sel; setNeedsDisplay()
        case .ended:
            pressing = false; setNeedsDisplay()
        case .cancelled, .failed:
            pressing = false; clearSelection()
        default: break
        }
    }

    func clearSelection() { if selection != nil { selection = nil; setNeedsDisplay() } }
    var hasSelection: Bool { selection != nil }

    /// The buffer cell under a point of the view, or nil outside the console.
    private func cell(at p: CGPoint) -> Cell? {
        guard let t = terminal else { return nil }
        let y = Int(p.y / cellH), x = Int(p.x / cellW) + panX
        guard y >= 0, y < min(rows, t.rows), x >= 0, x < t.cols else { return nil }
        return Cell(line: t.historySize + topLine(t) + y, col: x)
    }

    /// The selected text: whole lines between the ends, the ends cut at their columns, no false
    /// line breaks where a line wrapped, and no trailing spaces.
    func selectedText() -> String {
        guard let t = terminal, let sel = selection else { return "" }
        var (a, b) = (sel.a, sel.b)
        if (b.line, b.col) < (a.line, a.col) { swap(&a, &b) }
        var out = ""
        for abs in a.line...b.line {
            let line = abs - t.historySize
            guard line >= -t.historySize, line < t.rows else { continue }
            let r = t.row(line)
            let from = abs == a.line ? a.col : 0
            let to = abs == b.line ? min(b.col + 1, r.cp.count) : r.cp.count
            var text = ""
            var i = from
            while i < to { if let u = Unicode.Scalar(r.cp[i]), r.cp[i] != Terminal.wideTail { text.unicodeScalars.append(u) }; i += 1 }
            while text.last == " " { text.removeLast() }
            out += text
            if abs != b.line && !r.wrapped { out += "\n" }
        }
        return out
    }

    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        if g.state == .changed { setFont(fontSize * g.scale); g.scale = 1; setNeedsDisplay() }
    }

    @objc private func panned(_ g: UIPanGestureRecognizer) {
        guard let t = terminal else { return }
        // A drag that starts on a handle moves that end of the selection.
        let at = g.location(in: self)
        if g.state == .began {
            let d = g.translation(in: self)
            _ = grabHandle(CGPoint(x: at.x - d.x, y: at.y - d.y))
        }
        if let fixed = dragFixed {
            if let c = cell(at: CGPoint(x: at.x - grab.x, y: at.y - grab.y)) { selection = (fixed, c); setNeedsDisplay() }
            if g.state == .ended || g.state == .cancelled || g.state == .failed { dragFixed = nil }
            return
        }
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
            if k != 0 { scrollRemainder -= CGFloat(k) * cellH; scrollBack = min(max(back(t) + k, minBack(t)), maxBack(t)); setNeedsDisplay() }
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
        let out = Keys.text(text, shift: shift, ctrl: ctrl, alt: alt)
        if ctrl || alt || shift { ctrl = false; alt = false; shift = false; onModifiersChanged() }
        scrollBack = 0
        onInput(out)
    }

    /// A named key of the extra row or of a real keyboard, as the escape sequence a shell expects.
    func key(_ name: String) {
        guard let out = Keys.named(name, shift: shift, alt: alt, app: terminal?.appCursorKeys == true) else { return }
        if ctrl || alt || shift { ctrl = false; alt = false; shift = false; onModifiersChanged() }
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
            if let named { if k.modifierFlags.contains(.shift) { shift = true }; key(named); handled = true }
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
