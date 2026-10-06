import Foundation

/// A terminal emulator (xterm, the part real programs use): what the agent's shell writes goes in
/// through `feed`, and the screen is read back through `row`. Pure Swift, no UIKit: the view
/// draws it, the tests feed it escape sequences. The port of `Terminal.kt` (Android), line by
/// line, with the same tests.
///
/// Written for this app instead of taking an existing one: Termux's is GPLv3 (Dotrino is MIT).
///
/// What it knows: the cursor and its movements, erasing and inserting, scroll regions, the
/// alternate screen (vim, htop), 16/256/24-bit colours and the usual attributes, UTF-8 with wide
/// characters, tab stops, the line-drawing charset, the modes a shell asks for, and REFLOW when
/// the width changes (as xterm.js does). The main screen keeps a history (`scrollback` rows).
final class Terminal {
    private(set) var cols: Int
    private(set) var rows: Int
    private let scrollback: Int

    /// One line of the screen: code points and a packed style per cell. A wide character owns two cells; the second holds `wideTail`.
    final class Row {
        var cp: [Int]
        var st: [Int64]
        /// The line continues on the next one (it wrapped): for reflow and for copying text.
        var wrapped = false
        init(_ cols: Int) { cp = Array(repeating: 32, count: cols); st = Array(repeating: Style.defaultStyle, count: cols) }
        func clear(_ from: Int, _ to: Int, _ style: Int64) {
            var i = max(0, from)
            while i < min(to, cp.count) { cp[i] = 32; st[i] = style; i += 1 }
        }
        func resize(_ cols: Int) {
            if cols == cp.count { return }
            let n = min(cols, cp.count)
            cp = (0..<cols).map { $0 < n ? cp[$0] : 32 }
            st = (0..<cols).map { $0 < n ? st[$0] : Style.defaultStyle }
        }
    }

    /// A cell's colours and attributes in one Int64: fg (26 bits), bg (26 bits), flags.
    enum Style {
        static let defaultColor = 256                 // «the terminal's own» foreground or background
        static let rgb = 1 << 24                      // the 24 low bits are a colour, not an index
        static let bold = 1, dim = 2, italic = 4, underline = 8, inverse = 16, invisible = 32, strike = 64
        static func pack(_ fg: Int, _ bg: Int, _ flags: Int) -> Int64 { Int64(fg) | (Int64(bg) << 26) | (Int64(flags) << 52) }
        static func fg(_ s: Int64) -> Int { Int(s & 0x3FFFFFF) }
        static func bg(_ s: Int64) -> Int { Int((s >> 26) & 0x3FFFFFF) }
        static func flags(_ s: Int64) -> Int { Int(s >> 52) }
        static let defaultStyle = pack(defaultColor, defaultColor, 0)
    }

    static let wideTail = -1
    private static let esc = 27
    /// DEC special graphics (`ESC ( 0`): the box-drawing characters of dialogs and tmux borders.
    private static let lineDrawing: [Int] = "◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·".unicodeScalars.map { Int($0.value) }

    /// How many cells a code point takes: 0 (combining), 1, or 2 (East Asian wide, emoji).
    static func width(_ c: Int) -> Int {
        if c < 0x300 { return 1 }
        if (0x300...0x36F).contains(c) || (0x200B...0x200F).contains(c) || (0xFE00...0xFE0F).contains(c) || c == 0xFEFF
            || (0x1AB0...0x1AFF).contains(c) || (0x20D0...0x20FF).contains(c) { return 0 }
        let wide: [ClosedRange<Int>] = [0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF,
                                        0xA000...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60,
                                        0xFFE0...0xFFE6, 0x1F300...0x1F64F, 0x1F900...0x1F9FF, 0x1F680...0x1F6FF, 0x20000...0x3FFFD]
        return wide.contains { $0.contains(c) } ? 2 : 1
    }

    // MARK: what the outside hears

    /// What the terminal answers by itself (a status report): it goes back to the shell as input.
    var onReply: (String) -> Void = { _ in }
    var onTitle: (String) -> Void = { _ in }
    var onBell: () -> Void = {}

    // MARK: the two screens

    private var history: [Row] = []                   // lines that scrolled off the top of the main screen
    private var main: [Row]
    private var alt: [Row]
    private(set) var altScreen = false
    /// The screen in use. Swift arrays are values: this reads and writes the right one.
    private var screen: [Row] {
        get { altScreen ? alt : main }
        set { if altScreen { alt = newValue } else { main = newValue } }
    }

    /// Lines of history above the screen.
    var historySize: Int { altScreen ? 0 : history.count }

    /// Line `y` of the screen; negative `y` goes back into the history (`-1` is the last line that scrolled off).
    func row(_ y: Int) -> Row { y >= 0 ? screen[y] : history[history.count + y] }

    private(set) var cursorX = 0
    private(set) var cursorY = 0
    private(set) var cursorVisible = true
    /// The cursor keys send `ESC O A` instead of `ESC [ A` (vim, less).
    private(set) var appCursorKeys = false
    private(set) var appKeypad = false
    private(set) var bracketedPaste = false

    private var style = Style.defaultStyle
    private var top = 0
    private var bottom: Int
    private var autowrap = true
    private var originMode = false
    private var insertMode = false
    private var wrapPending = false                     // the cursor sits past the last column; the next character wraps
    private var tabs: [Bool]
    private var g0Graphics = false
    private var g1Graphics = false
    private var shiftOut = false
    private var lastChar = 32

    private struct Saved { let x: Int, y: Int, style: Int64, origin: Bool, g0: Bool, g1: Bool }
    private var savedMain: Saved?
    private var savedAlt: Saved?

    init(_ cols: Int, _ rows: Int, scrollback: Int = 2000) {
        self.cols = cols; self.rows = rows; self.scrollback = scrollback
        main = (0..<rows).map { _ in Row(cols) }
        alt = (0..<rows).map { _ in Row(cols) }
        bottom = rows - 1
        tabs = (0..<cols).map { $0 % 8 == 0 }
    }

    // MARK: the parser

    private enum State { case ground, escape, charset, csi, osc, oscEsc, string, stringEsc }
    private var state = State.ground
    private var charsetSlot = 0
    private var params: [Int] = []                      // -1 = not given
    private var paramOpen = false
    private var prefix = 0                              // '?', '>', '=' right after CSI
    private var intermediate = 0                        // ' ', '!', '"', '$' before the final byte
    private var osc: [Unicode.Scalar] = []

    /// What the shell wrote. A sequence cut between two calls continues in the next one.
    func feed(_ text: String) {
        for s in text.unicodeScalars { accept(Int(s.value)) }
    }

    private func ch(_ s: String) -> Int { Int(s.unicodeScalars.first!.value) }

    private func accept(_ c: Int) {
        switch state {
        case .ground: ground(c)
        case .escape: escape(c)
        case .charset:
            if charsetSlot == 0 { g0Graphics = c == ch("0") } else if charsetSlot == 1 { g1Graphics = c == ch("0") }
            state = .ground
        case .csi: csi(c)
        case .osc:
            if c == 7 { oscDone(); state = .ground }
            else if c == Self.esc { state = .oscEsc }
            else if osc.count < 4096, let u = Unicode.Scalar(c) { osc.append(u) }
        case .oscEsc:
            if c == ch("\\") { oscDone() }
            state = .ground
            if c != ch("\\") { state = .escape; escape(c) }
        // DCS, APC, PM, SOS: a string nobody here reads, up to its terminator.
        case .string: if c == Self.esc { state = .stringEsc } else if c == 7 { state = .ground }
        case .stringEsc: state = c == ch("\\") ? .ground : .string
        }
    }

    private func ground(_ c: Int) {
        switch c {
        case Self.esc: state = .escape
        case 7: onBell()
        case 8: if cursorX > 0 { cursorX -= 1 }; wrapPending = false
        case 9: tab(1)
        case 10, 11, 12: lineFeed()
        case 13: cursorX = 0; wrapPending = false
        case 14: shiftOut = true
        case 15: shiftOut = false
        default: if c >= 32 && c != 127 { put(c) }
        }
    }

    private func escape(_ c: Int) {
        state = .ground
        guard let u = Unicode.Scalar(c) else { return }
        switch Character(u) {
        case "[": params.removeAll(); paramOpen = false; prefix = 0; intermediate = 0; state = .csi
        case "]": osc.removeAll(); state = .osc
        case "P", "_", "^", "X": state = .string
        case "(": charsetSlot = 0; state = .charset
        case ")": charsetSlot = 1; state = .charset
        case "*", "+", "#", "%", " ": charsetSlot = 2; state = .charset    // one more byte follows; it changes nothing here
        case "7": saveCursor()
        case "8": restoreCursor()
        case "D": lineFeed()
        case "E": cursorX = 0; lineFeed()
        case "M": reverseIndex()
        case "H": if cursorX < cols { tabs[cursorX] = true }
        case "c": reset()
        case "=": appKeypad = true
        case ">": appKeypad = false
        default: break
        }
    }

    private func csi(_ c: Int) {
        if c >= ch("0") && c <= ch("9") {
            if !paramOpen { params.append(0); paramOpen = true }
            params[params.count - 1] = min(params[params.count - 1] * 10 + (c - ch("0")), 99999)
        } else if c == ch(";") || c == ch(":") {
            if !paramOpen { params.append(-1) }
            paramOpen = false
        } else if c == ch("?") || c == ch(">") || c == ch("=") || c == ch("<") {
            prefix = c
        } else if (0x20...0x2F).contains(c) {
            intermediate = c
        } else if (0x40...0x7E).contains(c) {
            if !paramOpen && !params.isEmpty { params.append(-1) }
            state = .ground
            command(Character(Unicode.Scalar(c)!))
        } else if c == Self.esc {
            state = .escape
        } else if c == 10 || c == 13 || c == 8 {
            ground(c)                                   // a control character in the middle of a sequence acts and the sequence goes on
        } else {
            state = .ground
        }
    }

    private func arg(_ i: Int, _ def: Int) -> Int { i < params.count && params[i] > 0 ? params[i] : def }
    private func raw(_ i: Int, _ def: Int) -> Int { i < params.count && params[i] >= 0 ? params[i] : def }

    private func command(_ f: Character) {
        if intermediate != 0 {
            // DECSTR (soft reset) is the one programs send; the rest are ignored.
            if intermediate == ch("!") && f == "p" { softReset() }
            return
        }
        if prefix == ch("?") { if f == "h" { modes(true) } else if f == "l" { modes(false) }; return }
        if prefix == ch(">") { if f == "c" { onReply("\u{1b}[>0;10;1c") }; return }
        if prefix != 0 { return }
        switch f {
        case "A": moveY(-arg(0, 1))
        case "B", "e": moveY(arg(0, 1))
        case "C", "a": cursorX = min(cols - 1, cursorX + arg(0, 1)); wrapPending = false
        case "D": cursorX = max(0, min(cursorX, cols - 1) - arg(0, 1)); wrapPending = false
        case "E": moveY(arg(0, 1)); cursorX = 0
        case "F": moveY(-arg(0, 1)); cursorX = 0
        case "G", "`": cursorX = min(max(arg(0, 1) - 1, 0), cols - 1); wrapPending = false
        case "H", "f": moveTo(arg(1, 1) - 1, arg(0, 1) - 1)
        case "d": moveTo(cursorX, arg(0, 1) - 1)
        case "I": tab(arg(0, 1))
        case "Z": backTab(arg(0, 1))
        case "J": eraseDisplay(raw(0, 0))
        case "K": eraseLine(raw(0, 0))
        case "L": insertLines(arg(0, 1))
        case "M": deleteLines(arg(0, 1))
        case "@": insertChars(arg(0, 1))
        case "P": deleteChars(arg(0, 1))
        case "X": screen[cursorY].clear(cursorX, cursorX + arg(0, 1), blank())
        case "S": for _ in 0..<arg(0, 1) { scrollUp() }
        case "T": for _ in 0..<arg(0, 1) { scrollDown() }
        case "b": for _ in 0..<min(arg(0, 1), cols * rows) { put(lastChar) }
        case "m": sgr()
        case "r":
            let t = arg(0, 1) - 1, b = arg(1, rows) - 1
            if t < b && b < rows { top = t; bottom = b; moveTo(0, 0) }
        case "s": saveCursor()
        case "u": restoreCursor()
        case "h": if raw(0, 0) == 4 { insertMode = true }
        case "l": if raw(0, 0) == 4 { insertMode = false }
        case "g":
            switch raw(0, 0) {
            case 0: if cursorX < cols { tabs[cursorX] = false }
            case 3: tabs = Array(repeating: false, count: cols)
            default: break
            }
        case "n":
            switch raw(0, 0) {
            case 5: onReply("\u{1b}[0n")
            case 6: onReply("\u{1b}[\(cursorY - (originMode ? top : 0) + 1);\(min(cursorX, cols - 1) + 1)R")
            default: break
            }
        case "c": onReply("\u{1b}[?1;2c")
        default: break
        }
    }

    private func modes(_ on: Bool) {
        for p in params {
            switch p {
            case 1: appCursorKeys = on
            case 6: originMode = on; moveTo(0, 0)
            case 7: autowrap = on
            case 25: cursorVisible = on
            case 47, 1047: useAlt(on, clear: false)
            case 1048: if on { saveCursor() } else { restoreCursor() }
            case 1049: if on { saveCursor() }; useAlt(on, clear: true); if !on { restoreCursor() }
            case 2004: bracketedPaste = on
            default: break                                // mouse reporting, focus events, blinking: not needed on a touch screen
            }
        }
    }

    private func useAlt(_ on: Bool, clear: Bool) {
        if on == altScreen { return }
        altScreen = on
        if on && clear { for r in alt { r.clear(0, cols, Style.defaultStyle); r.wrapped = false } }
        top = 0; bottom = rows - 1; wrapPending = false
    }

    private func oscDone() {
        let s = String(String.UnicodeScalarView(osc))
        guard let sep = s.firstIndex(of: ";"), sep != s.startIndex else { return }
        let code = s[..<sep]
        if code == "0" || code == "2" { onTitle(String(s[s.index(after: sep)...])) }
    }

    // MARK: writing

    private func blank() -> Int64 { Style.pack(Style.defaultColor, Style.bg(style), 0) }    // an erased cell keeps the current background

    private func put(_ code: Int) {
        var c = code
        if (shiftOut ? g1Graphics : g0Graphics) && (0x60...0x7E).contains(c) { c = Self.lineDrawing[c - 0x60] }
        let w = Self.width(c)
        if w == 0 { return }                             // combining marks are dropped rather than misplaced
        if wrapPending || cursorX + w > cols {
            if autowrap { screen[cursorY].wrapped = true; cursorX = 0; lineFeed() } else { cursorX = cols - w }
            wrapPending = false
        }
        let r = screen[cursorY]
        if insertMode { shiftRight(r, cursorX, w) }
        unwide(r, cursorX); if w == 2 { unwide(r, cursorX + 1) }
        r.cp[cursorX] = c; r.st[cursorX] = style
        if w == 2 { r.cp[cursorX + 1] = Self.wideTail; r.st[cursorX + 1] = style }
        lastChar = c
        cursorX += w
        if cursorX >= cols { cursorX = cols - 1; wrapPending = true }
    }

    /// Overwriting half of a wide character leaves the other half blank, not a broken glyph.
    private func unwide(_ r: Row, _ x: Int) {
        guard x >= 0 && x < cols else { return }
        if r.cp[x] == Self.wideTail && x > 0 { r.cp[x - 1] = 32 }
        else if x + 1 < cols && r.cp[x + 1] == Self.wideTail { r.cp[x + 1] = 32 }
    }

    private func shiftRight(_ r: Row, _ x: Int, _ n: Int) {
        var i = cols - 1
        while i >= x + n { r.cp[i] = r.cp[i - n]; r.st[i] = r.st[i - n]; i -= 1 }
        r.clear(x, x + n, blank())
    }

    private func insertChars(_ n: Int) { shiftRight(screen[cursorY], cursorX, min(n, cols - cursorX)) }

    private func deleteChars(_ count: Int) {
        let r = screen[cursorY], n = min(count, cols - cursorX)
        var i = cursorX
        while i < cols - n { r.cp[i] = r.cp[i + n]; r.st[i] = r.st[i + n]; i += 1 }
        r.clear(cols - n, cols, blank())
    }

    private func eraseLine(_ mode: Int) {
        let r = screen[cursorY], x = min(cursorX, cols - 1)
        switch mode {
        case 0: r.clear(x, cols, blank())
        case 1: r.clear(0, x + 1, blank())
        case 2: r.clear(0, cols, blank())
        default: break
        }
        if mode != 1 { r.wrapped = false }
        wrapPending = false
    }

    private func eraseDisplay(_ mode: Int) {
        switch mode {
        case 0: eraseLine(0); for y in (cursorY + 1)..<max(cursorY + 1, rows) { wipe(screen[y]) }
        case 1: eraseLine(1); for y in 0..<cursorY { wipe(screen[y]) }
        case 2: for r in screen { wipe(r) }
        case 3: history.removeAll()
        default: break
        }
    }

    private func wipe(_ r: Row) { r.clear(0, cols, blank()); r.wrapped = false }

    // MARK: moving

    private func moveTo(_ x: Int, _ y: Int) {
        let lo = originMode ? top : 0, hi = originMode ? bottom : rows - 1
        cursorX = min(max(x, 0), cols - 1)
        cursorY = min(max((originMode ? top : 0) + y, lo), hi)
        wrapPending = false
    }

    private func moveY(_ d: Int) {
        // Inside the scroll region the cursor does not leave it; outside, it stops at the screen's edge.
        let lo = cursorY >= top ? top : 0
        let hi = cursorY <= bottom ? bottom : rows - 1
        cursorY = min(max(cursorY + d, lo), hi)
        wrapPending = false
    }

    private func tab(_ n: Int) {
        for _ in 0..<n {
            var x = cursorX + 1
            while x < cols - 1 && !tabs[x] { x += 1 }
            cursorX = min(x, cols - 1)
        }
        wrapPending = false
    }

    private func backTab(_ n: Int) {
        for _ in 0..<n {
            var x = cursorX - 1
            while x > 0 && !tabs[x] { x -= 1 }
            cursorX = max(x, 0)
        }
    }

    private func lineFeed() {
        wrapPending = false
        if cursorY == bottom { scrollUp() } else if cursorY < rows - 1 { cursorY += 1 }
    }

    private func reverseIndex() {
        wrapPending = false
        if cursorY == top { scrollDown() } else if cursorY > 0 { cursorY -= 1 }
    }

    /// The region moves up one line: the top one leaves (to the history, if it is the whole main screen).
    private func scrollUp() {
        var s = screen
        let gone = s.remove(at: top)
        if !altScreen && top == 0 {
            history.append(gone)
            if history.count > scrollback { history.removeFirst() }
            let r = Row(cols); r.clear(0, cols, blank())
            s.insert(r, at: bottom)
        } else {
            wipe(gone); s.insert(gone, at: bottom)
        }
        screen = s
    }

    private func scrollDown() {
        var s = screen
        let gone = s.remove(at: bottom)
        wipe(gone); s.insert(gone, at: top)
        screen = s
    }

    private func insertLines(_ n: Int) {
        guard cursorY >= top && cursorY <= bottom else { return }
        var s = screen
        for _ in 0..<min(n, bottom - cursorY + 1) { let gone = s.remove(at: bottom); wipe(gone); s.insert(gone, at: cursorY) }
        screen = s
        cursorX = 0; wrapPending = false
    }

    private func deleteLines(_ n: Int) {
        guard cursorY >= top && cursorY <= bottom else { return }
        var s = screen
        for _ in 0..<min(n, bottom - cursorY + 1) { let gone = s.remove(at: cursorY); wipe(gone); s.insert(gone, at: bottom) }
        screen = s
        cursorX = 0; wrapPending = false
    }

    private func saveCursor() {
        let s = Saved(x: cursorX, y: cursorY, style: style, origin: originMode, g0: g0Graphics, g1: g1Graphics)
        if altScreen { savedAlt = s } else { savedMain = s }
    }

    private func restoreCursor() {
        let s = (altScreen ? savedAlt : savedMain) ?? Saved(x: 0, y: 0, style: Style.defaultStyle, origin: false, g0: false, g1: false)
        cursorX = min(max(s.x, 0), cols - 1); cursorY = min(max(s.y, 0), rows - 1)
        style = s.style; originMode = s.origin; g0Graphics = s.g0; g1Graphics = s.g1; wrapPending = false
    }

    private func softReset() {
        style = Style.defaultStyle; top = 0; bottom = rows - 1
        autowrap = true; originMode = false; insertMode = false; cursorVisible = true
        appCursorKeys = false; appKeypad = false; g0Graphics = false; g1Graphics = false; shiftOut = false
    }

    private func reset() {
        softReset()
        useAlt(false, clear: false)
        for r in main { wipe(r) }; for r in alt { wipe(r) }
        history.removeAll()
        cursorX = 0; cursorY = 0; wrapPending = false; bracketedPaste = false
        tabs = (0..<cols).map { $0 % 8 == 0 }
        savedMain = nil; savedAlt = nil
    }

    // MARK: colours

    private func sgr() {
        if params.isEmpty { style = Style.defaultStyle; return }
        var fg = Style.fg(style), bg = Style.bg(style), flags = Style.flags(style)
        var i = 0
        func at(_ k: Int) -> Int? { k < params.count ? params[k] : nil }
        while i < params.count {
            let p = max(params[i], 0)
            switch p {
            case 0: fg = Style.defaultColor; bg = Style.defaultColor; flags = 0
            case 1: flags |= Style.bold
            case 2: flags |= Style.dim
            case 3: flags |= Style.italic
            case 4: flags |= Style.underline
            case 7: flags |= Style.inverse
            case 8: flags |= Style.invisible
            case 9: flags |= Style.strike
            case 21, 22: flags &= ~(Style.bold | Style.dim)
            case 23: flags &= ~Style.italic
            case 24: flags &= ~Style.underline
            case 27: flags &= ~Style.inverse
            case 28: flags &= ~Style.invisible
            case 29: flags &= ~Style.strike
            case 30...37: fg = p - 30
            case 39: fg = Style.defaultColor
            case 40...47: bg = p - 40
            case 49: bg = Style.defaultColor
            case 90...97: fg = p - 90 + 8
            case 100...107: bg = p - 100 + 8
            case 38, 48:
                // 38;5;N (the 256 palette) · 38;2;R;G;B (24 bits) · and the same with ':' and an empty colour space.
                var color: Int?
                switch at(i + 1) {
                case 5?:
                    if let n = at(i + 2), (0...255).contains(n) { color = n }
                    i += 2
                case 2?:
                    let rest = Array(params[min(i + 2, params.count)...])
                    let skip = rest.count >= 4 && rest[0] < 0 ? 1 : 0          // 38:2::R:G:B
                    if rest.count > skip + 2 {
                        let r = rest[skip], g = rest[skip + 1], b = rest[skip + 2]
                        color = Style.rgb | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)
                    }
                    i += 4 + skip
                default: break
                }
                if let color { if p == 38 { fg = color } else { bg = color } }
            default: break
            }
            i += 1
        }
        style = Style.pack(fg, bg, flags)
    }

    // MARK: the size

    /// The screen changes size. When the WIDTH changes on the main screen, lines are REFLOWED as
    /// xterm.js does (the PWA): rows that wrapped are joined again and cut at the new width. Only
    /// the rows changing, or the alternate screen (a full-screen program redraws itself): lines are
    /// cut or padded; losing rows pushes the top ones to the history and gaining rows brings them back.
    func resize(_ newCols: Int, _ newRows: Int) {
        if newCols < 2 || newRows < 2 || (newCols == cols && newRows == rows) { return }
        if newCols != cols && !altScreen { reflow(newCols, newRows); return }
        if newRows < rows {
            // Where the main screen's cursor is (kept aside while the alternate screen is up).
            var mainY = altScreen ? (savedMain?.y ?? 0) : cursorY
            for _ in 0..<(rows - newRows) {
                // The lines below the cursor go first; then the top ones leave to the history.
                if mainY < main.count - 1 { main.removeLast() }
                else {
                    history.append(main.removeFirst()); if history.count > scrollback { history.removeFirst() }
                    mainY = max(0, mainY - 1)
                }
                alt.removeLast()
            }
            if !altScreen { cursorY = mainY }
        } else {
            for _ in 0..<(newRows - rows) {
                if !history.isEmpty { main.insert(history.removeLast(), at: 0); if !altScreen { cursorY += 1 } } else { main.append(Row(newCols)) }
                alt.append(Row(newCols))
            }
        }
        for r in main { r.resize(newCols) }; for r in alt { r.resize(newCols) }; for r in history { r.resize(newCols) }
        tabs = (0..<newCols).map { $0 < tabs.count ? tabs[$0] : $0 % 8 == 0 }
        cols = newCols; rows = newRows
        top = 0; bottom = rows - 1
        cursorX = min(max(cursorX, 0), cols - 1); cursorY = min(max(cursorY, 0), rows - 1)
        wrapPending = false
    }

    private func isBlank(_ r: Row, _ x: Int) -> Bool { r.cp[x] == 32 && r.st[x] == Style.defaultStyle }

    /// Cells of `r` up to its last one with something in it (a coloured space counts).
    private func contentLength(_ r: Row) -> Int {
        var n = r.cp.count
        while n > 0 && isBlank(r, n - 1) { n -= 1 }
        return n
    }

    /// Reflow of the main screen and its history: logical lines (rows joined while `wrapped`) cut
    /// again at the new width, a wide character never split, and the cursor kept on the same cell
    /// of its line. The screen is the last rows, with the cursor in it; what does not fit goes to the history.
    private func reflow(_ newCols: Int, _ newRows: Int) {
        let old = history + main
        let cursorAbs = history.count + cursorY
        // Blank rows below the cursor are not content: they are where the next output goes.
        var last = old.count - 1
        while last > cursorAbs && contentLength(old[last]) == 0 { last -= 1 }

        var out: [Row] = []
        var curRow = 0, curX = 0
        var i = 0
        while i <= last {
            // One logical line: its cells, and where the cursor is in it (or -1).
            var cps: [Int] = [], sts: [Int64] = []
            var cursorAt = -1
            while true {
                let r = old[i]
                if i == cursorAbs { cursorAt = cps.count + cursorX }
                let len = r.wrapped ? r.cp.count : contentLength(r)
                cps.append(contentsOf: r.cp[0..<len]); sts.append(contentsOf: r.st[0..<len])
                let more = r.wrapped && i < last
                i += 1
                if !more { break }
            }
            // The cursor past the end of the text (after a space the shell has not drawn yet).
            while cursorAt > cps.count { cps.append(32); sts.append(Style.defaultStyle) }
            var row = Row(newCols), x = 0, k = 0
            while k < cps.count {
                let w = k + 1 < cps.count && cps[k + 1] == Self.wideTail ? 2 : 1
                if cps[k] == Self.wideTail { k += 1; continue }
                if x + w > newCols { row.wrapped = true; out.append(row); row = Row(newCols); x = 0 }
                if k == cursorAt || (w == 2 && k + 1 == cursorAt) { curRow = out.count; curX = x }
                row.cp[x] = cps[k]; row.st[x] = sts[k]
                if w == 2 { row.cp[x + 1] = Self.wideTail; row.st[x + 1] = sts[k] }
                x += w; k += w
            }
            // At the end of the line: where the next character goes (the last column if it is full).
            if cursorAt == cps.count { curRow = out.count; curX = x >= newCols ? newCols - 1 : x }
            out.append(row)
        }
        if out.isEmpty { out.append(Row(newCols)) }

        let start = min(max(0, out.count - newRows), curRow)
        var screenRows = Array(out[start..<min(out.count, start + newRows)])
        while screenRows.count < newRows { screenRows.append(Row(newCols)) }
        history = Array(out[max(0, start - scrollback)..<start])
        main = screenRows

        // The alternate screen is not on (a full-screen program would redraw it): cut or padded.
        while alt.count > newRows { alt.removeLast() }
        while alt.count < newRows { alt.append(Row(newCols)) }
        for r in alt { r.resize(newCols) }

        tabs = (0..<newCols).map { $0 < tabs.count ? tabs[$0] : $0 % 8 == 0 }
        cols = newCols; rows = newRows
        top = 0; bottom = rows - 1
        cursorY = min(max(curRow - start, 0), rows - 1); cursorX = min(max(curX, 0), cols - 1)
        wrapPending = false
    }

    /// The text of line `y` (history when negative), without trailing blanks. For tests and for copying.
    func text(_ y: Int) -> String {
        var s = String.UnicodeScalarView()
        for c in row(y).cp where c != Self.wideTail { if let u = Unicode.Scalar(c) { s.append(u) } }
        var str = String(s)
        while str.last == " " { str.removeLast() }
        return str
    }
}
