import XCTest
@testable import Terminal

/// The emulator, fed what real programs write. The same tests as Android (`TerminalTest.kt`).
final class TerminalTests: XCTestCase {
    private let E = "\u{1b}"
    private typealias Style = Terminal.Style
    private func term(_ cols: Int = 20, _ rows: Int = 5) -> Terminal { Terminal(cols, rows) }
    private func screen(_ t: Terminal) -> String {
        var s = (0..<t.rows).map { t.text($0) }.joined(separator: "\n")
        while s.last == "\n" { s.removeLast() }
        return s
    }

    func testPlainTextAndNewlines() {
        let t = term(); t.feed("hola\r\nmundo")
        XCTAssertEqual(screen(t), "hola\nmundo"); XCTAssertEqual(t.cursorX, 5); XCTAssertEqual(t.cursorY, 1)
    }

    func testALongLineWrapsAndTheScreenScrollsIntoHistory() {
        let t = term(5, 2); t.feed("abcdefgh\r\nxy\r\nz")
        XCTAssertEqual(screen(t), "xy\nz"); XCTAssertEqual(t.historySize, 2)
        XCTAssertEqual(t.text(-2), "abcde"); XCTAssertEqual(t.text(-1), "fgh")
        XCTAssertTrue(t.row(-2).wrapped)
    }

    func testTheLastColumnDoesNotWrapUntilTheNextCharacter() {
        let t = term(3, 2); t.feed("abc")
        XCTAssertEqual(t.cursorY, 0)
        t.feed("\r\nd"); XCTAssertEqual(screen(t), "abc\nd")
    }

    func testCursorMovesAndErasing() {
        let t = term(); t.feed("0123456789")
        t.feed("\(E)[5D\(E)[K"); XCTAssertEqual(screen(t), "01234")
        t.feed("\(E)[2;3Hab\(E)[1;1HX"); XCTAssertEqual(screen(t), "X1234\n  ab")
        t.feed("\(E)[2J"); XCTAssertEqual(screen(t), "")
    }

    func testInsertAndDeleteCharactersAndLines() {
        let t = term(); t.feed("abcdef\(E)[1;3H\(E)[2@"); XCTAssertEqual(t.text(0), "ab  cdef")
        t.feed("\(E)[2P"); XCTAssertEqual(t.text(0), "abcdef")
        t.feed("\r\nline2\r\nline3\(E)[2;1H\(E)[L"); XCTAssertEqual(screen(t), "abcdef\n\nline2\nline3")
        t.feed("\(E)[M"); XCTAssertEqual(screen(t), "abcdef\nline2\nline3")
    }

    func testColoursAndAttributes() {
        let t = term(); t.feed("\(E)[1;31mR\(E)[0m \(E)[38;5;208mO\(E)[48;2;10;20;30mB\(E)[38:2::1:2:3mC")
        let r = t.row(0)
        XCTAssertEqual(Style.fg(r.st[0]), 1); XCTAssertEqual(Style.flags(r.st[0]), Style.bold)
        XCTAssertEqual(r.st[1], Style.defaultStyle)
        XCTAssertEqual(Style.fg(r.st[2]), 208)
        XCTAssertEqual(Style.bg(r.st[3]), Style.rgb | (10 << 16) | (20 << 8) | 30)
        XCTAssertEqual(Style.fg(r.st[4]), Style.rgb | (1 << 16) | (2 << 8) | 3)
    }

    func testTheAlternateScreenComesAndGoesAndLeavesTheShellAsItWas() {
        let t = term(); t.feed("prompt$ vim")
        t.feed("\(E)[?1049h\(E)[2J\(E)[Hfile contents")
        XCTAssertTrue(t.altScreen); XCTAssertEqual(t.text(0), "file contents")
        t.feed("\(E)[?1049l")
        XCTAssertFalse(t.altScreen); XCTAssertEqual(t.text(0), "prompt$ vim"); XCTAssertEqual(t.cursorX, 11)
    }

    func testAScrollRegionOnlyMovesItsOwnLines() {
        let t = term(20, 4); t.feed("top\r\na\r\nb\r\nbottom")
        t.feed("\(E)[2;3r\(E)[3;1H\nc")
        XCTAssertEqual(screen(t), "top\nb\nc\nbottom"); XCTAssertEqual(t.historySize, 0)
    }

    func testReverseIndexAtTheTopScrollsDown() {
        let t = term(20, 3); t.feed("a\r\nb\r\nc\(E)[H\(E)M")
        XCTAssertEqual(screen(t), "\na\nb")
    }

    func testWideCharactersTakeTwoCellsAndWrapWhole() {
        let t = term(4, 2); t.feed("a日本x")
        XCTAssertEqual(t.text(0), "a日"); XCTAssertEqual(t.text(1), "本x"); XCTAssertEqual(t.row(0).cp[2], Terminal.wideTail)
    }

    func testEmojiOutsideTheBasicPlane() {
        let t = term(); t.feed("ok 😀!")
        XCTAssertEqual(t.text(0), "ok 😀!"); XCTAssertEqual(t.cursorX, 6)
    }

    func testLineDrawingCharset() {
        let t = term(); t.feed("\(E)(0lqk\(E)(Blqk")
        XCTAssertEqual(t.text(0), "┌─┐lqk")
    }

    func testTabs() {
        let t = term(); t.feed("a\tb\t\tc")
        XCTAssertEqual(String(t.text(0).prefix(9)), "a       b"); XCTAssertEqual(t.cursorX, 19)
    }

    func testTitleAndReports() {
        let t = term(); var replies: [String] = []; var title = ""
        t.onReply = { replies.append($0) }; t.onTitle = { title = $0 }
        t.feed("\(E)]0;user@host: ~\u{07}\(E)]2;second\(E)\\ab\(E)[6n\(E)[c")
        XCTAssertEqual(title, "second"); XCTAssertEqual(replies, ["\(E)[1;3R", "\(E)[?1;2c"])
    }

    func testASequenceCutBetweenTwoChunksStillWorks() {
        let t = term(); t.feed("a\(E)[3"); t.feed("1mb\(E)]0;ti"); var title = ""; t.onTitle = { title = $0 }; t.feed("tle\u{07}c")
        XCTAssertEqual(t.text(0), "abc"); XCTAssertEqual(Style.fg(t.row(0).st[1]), 1); XCTAssertEqual(title, "title")
    }

    func testModesAShellAsksFor() {
        let t = term(); t.feed("\(E)[?1h\(E)[?2004h\(E)[?25l")
        XCTAssertTrue(t.appCursorKeys); XCTAssertTrue(t.bracketedPaste); XCTAssertFalse(t.cursorVisible)
        t.feed("\(E)[?1l\(E)[?2004l\(E)[?25h")
        XCTAssertFalse(t.appCursorKeys); XCTAssertFalse(t.bracketedPaste); XCTAssertTrue(t.cursorVisible)
    }

    func testResizingKeepsWhatWasOnScreen() {
        let t = term(10, 4); t.feed("1\r\n2\r\n3\r\n4")
        t.resize(10, 2)
        XCTAssertEqual(screen(t), "3\n4"); XCTAssertEqual(t.historySize, 2); XCTAssertEqual(t.cursorY, 1)
        t.resize(12, 4)
        XCTAssertEqual(screen(t), "1\n2\n3\n4"); XCTAssertEqual(t.historySize, 0); XCTAssertEqual(t.cursorY, 3)
    }

    func testEraseKeepsTheBackgroundColour() {
        let t = term(); t.feed("\(E)[44m\(E)[K")
        XCTAssertEqual(Style.bg(t.row(0).st[10]), 4)
    }

    func testHistoryIsBounded() {
        let t = Terminal(10, 2, scrollback: 5); for i in 0..<50 { t.feed("l\(i)\r\n") }
        XCTAssertEqual(t.historySize, 5); XCTAssertEqual(t.text(-1), "l48")
    }

    // MARK: reflow

    func testWiderJoinsWhatHadWrapped() {
        let t = Terminal(10, 5); t.feed("abcdefghijklmnopqrstuvwxyz\r\n$ ")
        XCTAssertEqual(t.text(0), "abcdefghij")
        t.resize(40, 5)
        XCTAssertEqual(t.text(0), "abcdefghijklmnopqrstuvwxyz"); XCTAssertEqual(t.text(1), "$")
        XCTAssertEqual(t.cursorY, 1); XCTAssertEqual(t.cursorX, 2)
    }

    func testNarrowerCutsTheLineAgainAndKeepsTheCursorAfterIt() {
        let t = Terminal(40, 6); t.feed("$ echo 0123456789abcdefghij")
        t.resize(10, 6)
        XCTAssertEqual(t.text(0), "$ echo 012"); XCTAssertEqual(t.text(1), "3456789abc"); XCTAssertEqual(t.text(2), "defghij")
        XCTAssertEqual(t.cursorY, 2); XCTAssertEqual(t.cursorX, 7)
        t.feed("K"); XCTAssertEqual(t.text(2), "defghijK")
    }

    func testWhatDoesNotFitGoesToTheHistory() {
        let t = Terminal(20, 3); t.feed("1111111111111111\r\n2222222222222222\r\n$ ")
        t.resize(8, 3)
        XCTAssertEqual(t.text(0), "22222222"); XCTAssertEqual(t.text(1), "22222222"); XCTAssertEqual(t.text(2), "$")
        XCTAssertEqual(t.historySize, 2); XCTAssertEqual(t.text(-2), "11111111")
    }

    func testAWideCharacterIsNeverSplit() {
        let t = Terminal(10, 3); t.feed("abcd日本語")
        t.resize(5, 3)
        XCTAssertEqual(t.text(0), "abcd"); XCTAssertEqual(t.text(1), "日本")
    }

    func testTheAlternateScreenIsNotReflowed() {
        let t = Terminal(10, 3); t.feed("\u{1b}[?1049h0123456789")
        t.resize(5, 3)
        XCTAssertEqual(t.text(0), "01234")
    }
}
