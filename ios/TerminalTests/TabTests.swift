import DotrinoNative
import XCTest
@testable import Terminal

/// The tab of a machine against a scripted agent: the same rules and the same tests as Android
/// (`TabTest.kt`) — pick a free console, switch over the same session, the emulator follows the
/// CONSOLE's size, ⤢, closing the console on screen first moves to another one.
@MainActor
final class TabTests: XCTestCase {
    private let me = #"{"kty":"EC","crv":"P-256","x":"AAA","y":"BBB"}"#
    private let other = #"{"kty":"EC","crv":"P-256","x":"CCC","y":"DDD"}"#

    /// A channel that keeps what the tab sends and lets the test answer as the agent.
    private final class FakeChannel: Channel {
        var sent: [JSON] = []
        private var listeners: [(JSON) -> Void] = []
        func send(_ payload: JSON) throws { sent.append(payload) }
        func onMessage(_ l: @escaping (JSON) -> Void) -> () -> Void { listeners.append(l); return {} }
        func onError(_ l: @escaping (Error) -> Void) -> () -> Void { {} }
        func close() {}
        func agent(_ m: JSON) { for l in listeners { l(m) } }
        func last(_ type: String) -> JSON? { sent.last { $0["type"]?.string == type } }
        var types: [String] { sent.compactMap { $0["type"]?.string } }
    }

    private func console(_ id: String, _ n: Int, _ cols: Int, _ rows: Int, watchers: Int = 0, by: String? = nil, pinned: Bool = false) -> JSON {
        var o: [String: JSON] = ["id": .string(id), "n": .int(Int64(n)), "title": "", "cols": .int(Int64(cols)), "rows": .int(Int64(rows)),
                                 "viewers": .int(Int64(watchers)), "watchers": .array(Array(repeating: ["origin": "remote"], count: watchers))]
        if let by { o["sizeBy"] = ["origin": "remote", "device": .string(by), "pinned": .bool(pinned)] }
        return .object(o)
    }
    private func consoles(_ list: JSON...) -> JSON { ["type": "consoles", "list": .array(list)] }
    private func attached(_ c: JSON) -> JSON { ["type": "attached", "id": c["id"]!, "console": c] }
    private func meta(_ c: JSON) -> JSON { ["type": "meta", "console": c] }

    private func tab() -> (Tab, FakeChannel) {
        let t = Tab(machine: Machine(pubkey: other, label: "PC"), myDevice: me)
        let ch = FakeChannel()
        t.bind(ch, cols: 50, rows: 20, resume: nil)
        return (t, ch)
    }

    func testPicksAFreeConsoleAndOpensOneWhenNoneIsFree() {
        let (t1, ch) = tab(); _ = t1
        XCTAssertEqual(ch.types, ["list"])
        t1.handle(consoles(console("a", 1, 80, 24, watchers: 1), console("b", 2, 80, 24)))
        XCTAssertEqual(ch.last("attach")?["id"]?.string, "b")
        XCTAssertEqual(ch.last("attach")?["cols"]?.int, 50)
        let (t2, ch2) = tab()
        t2.handle(consoles(console("a", 1, 80, 24, watchers: 1)))
        XCTAssertTrue(ch2.types.contains("open"))
    }

    func testTheEmulatorFollowsTheConsoleSizeNotTheScreen() {
        let (t, ch) = tab()
        t.handle(consoles())
        t.handle(attached(console("a", 1, 120, 40, watchers: 2, by: other)))
        XCTAssertEqual(t.state, .open)
        XCTAssertEqual(t.terminal.cols, 120); XCTAssertEqual(t.terminal.rows, 40)
        t.handle(meta(console("a", 1, 90, 30, watchers: 2, by: other)))
        XCTAssertEqual(t.terminal.cols, 90)
        t.screen(60, 22)
        XCTAssertEqual(ch.last("resize")?["cols"]?.int, 60)
        XCTAssertEqual(t.terminal.cols, 90, "the emulator does not take it by itself")
    }

    func testSwitchingGoesOverTheSameSessionAndCleansTheScreen() {
        let (t, ch) = tab()
        t.handle(consoles(console("a", 1, 50, 20), console("b", 2, 50, 20)))
        t.handle(attached(console("a", 1, 50, 20, watchers: 1, by: me)))
        t.handle(["type": "replay", "data": "AAA"])
        t.switchTo("b")
        XCTAssertEqual(ch.last("attach")?["id"]?.string, "b")
        t.handle(attached(console("b", 2, 50, 20, watchers: 1, by: me)))
        t.handle(["type": "replay", "data": "BBB"])
        XCTAssertEqual(t.consoleId, "b"); XCTAssertEqual(t.number, 2)
        XCTAssertTrue(t.terminal.text(0).hasPrefix("BBB"))
    }

    func testSizeHereOnlyWhenThisDeviceChoseIt() {
        let (t, ch) = tab()
        t.handle(consoles())
        t.handle(attached(console("a", 1, 50, 20, watchers: 2, by: me)))
        XCTAssertFalse(t.sizeHere); XCTAssertTrue(t.sizeIsMine(t.current))
        t.useMySize(true)
        XCTAssertEqual(Array(ch.types.suffix(2)), ["resize", "pin"])
        t.handle(meta(console("a", 1, 50, 20, watchers: 2, by: me, pinned: true)))
        XCTAssertTrue(t.sizeHere)
        t.handle(meta(console("a", 1, 50, 20, watchers: 2, by: other, pinned: true)))
        XCTAssertFalse(t.sizeHere)
    }

    func testClosingTheConsoleOnScreenFirstMovesToAnother() {
        let (t, ch) = tab()
        t.handle(consoles(console("a", 1, 50, 20), console("b", 2, 50, 20)))
        t.handle(attached(console("a", 1, 50, 20, watchers: 1, by: me)))
        t.killConsole("a")
        XCTAssertEqual(Array(ch.types.suffix(3)), ["attach", "kill", "list"])
        XCTAssertEqual(ch.last("attach")?["id"]?.string, "b")
        XCTAssertEqual(ch.last("kill")?["id"]?.string, "a")
    }

    func testTitlesAreCutOnTheLeftKeepingTheLastFolder() {
        XCTAssertEqual(shortTitle("seyacat@loca: ~"), "~")
        XCTAssertEqual(shortTitle("seyacat@loca: /mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor"), "…/desktop/vendor")
        XCTAssertEqual(shortTitle("seyacat@loca: /mnt/sda1/Dotrino"), "/mnt/sda1/Dotrino")
        XCTAssertEqual(shortTitle("vim main.rs"), "vim main.rs")
    }

    func testBothLanguagesSayTheSameThings() { XCTAssertEqual(I18n.missing(), []) }
}
