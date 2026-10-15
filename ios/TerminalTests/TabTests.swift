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

    private func console(_ id: String, _ n: Int, _ cols: Int, _ rows: Int, watchers: Int = 0, by: String? = nil) -> JSON {
        var o: [String: JSON] = ["id": .string(id), "n": .int(Int64(n)), "title": "", "cols": .int(Int64(cols)), "rows": .int(Int64(rows)),
                                 "viewers": .int(Int64(watchers)), "watchers": .array(Array(repeating: ["origin": "remote"], count: watchers))]
        if let by { o["sizeBy"] = ["origin": "remote", "device": .string(by)] }
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

    func testPicksAFreeConsoleAndOpensOneOnlyWhenThereIsNone() {
        let (t1, ch) = tab(); _ = t1
        XCTAssertEqual(ch.types, ["list"])
        t1.handle(consoles(console("a", 1, 80, 24, watchers: 1), console("b", 2, 80, 24)))
        XCTAssertEqual(ch.last("attach")?["id"]?.string, "b")
        XCTAssertEqual(ch.last("attach")?["cols"]?.int, 50)
        let (t2, ch2) = tab()
        t2.handle(consoles(console("a", 1, 80, 24, watchers: 1)))
        XCTAssertEqual(ch2.last("attach")?["id"]?.string, "a")     // none free, but one exists: that one, not a new one
        XCTAssertFalse(ch2.types.contains("open"))
        let (t3, ch3) = tab()
        t3.handle(consoles())
        XCTAssertTrue(ch3.types.contains("open"))                  // the machine has none: a new one
    }

    func testAConsolePutOnScreenSaysItsSizeAndNothingIsChosen() {
        let (t, ch) = tab()
        t.handle(consoles(console("a", 1, 80, 24), console("b", 2, 80, 24)))
        XCTAssertNil(ch.last("attach")?["keep"], "opening or switching takes the size: no `keep`")
        t.handle(attached(console("a", 1, 50, 20, watchers: 1, by: me)))
        XCTAssertFalse(ch.types.contains("take"), "nothing is chosen on purpose")
        t.switchTo("b")
        XCTAssertNil(ch.last("attach")?["keep"])
        ch.sent.removeAll()
        t.screen(50, 11)                                   // the keyboard came up before the agent answered
        XCTAssertNil(ch.last("resize"), "nothing is said while attaching")
        t.handle(attached(console("b", 2, 50, 20, watchers: 1, by: me)))
        XCTAssertEqual(ch.last("resize")?["rows"]?.int, 11, "the size it has NOW")
    }

    func testWhatTheConsoleJustLeftStillSendsIsNotPainted() {
        let (t, ch) = tab()
        t.handle(consoles(console("a", 1, 50, 20), console("b", 2, 50, 20)))
        t.handle(attached(console("a", 1, 50, 20, watchers: 1, by: me)))
        t.handle(["type": "replay", "id": "a", "data": "AAA"])
        t.switchTo("b")
        // Its history arrives late, in pieces, and starts with a reset: it must not touch the screen.
        t.handle(["type": "replay", "id": "a", "data": "\u{1b}cLATE-A"])
        t.handle(attached(console("b", 2, 50, 20, watchers: 1, by: me)))
        t.handle(["type": "replay", "id": "b", "data": "BBB"])
        t.handle(["type": "out", "id": "a", "data": "MORE-A"])
        t.handle(["type": "out", "id": "b", "data": "-b"])
        // An older agent puts no id: that passes.
        t.handle(["type": "out", "data": "!"])
        XCTAssertEqual(t.terminal.text(0).trimmingCharacters(in: .whitespaces), "BBB-b!")
        // Opening a NEW one: nothing more of the one left, whatever the new one's id turns out to be.
        t.switchTo(nil)
        t.handle(["type": "out", "id": "b", "data": "LATE-B"])
        t.handle(["type": "replay", "id": "c", "data": "CCC"])
        XCTAssertEqual(t.terminal.text(0).trimmingCharacters(in: .whitespaces), "CCC")
        _ = ch
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

    func testTheSizeButtonTakesTheSizeNow() {
        let (t, ch) = tab()
        t.handle(consoles())
        t.handle(attached(console("a", 1, 50, 20, watchers: 2, by: other)))
        XCTAssertFalse(t.sizeIsMine(t.current))
        t.useMySize()
        XCTAssertEqual(Array(ch.types.suffix(2)), ["resize", "take"])
        t.handle(meta(console("a", 1, 50, 20, watchers: 2, by: me)))
        XCTAssertTrue(t.sizeIsMine(t.current))
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

    private func fail(_ code: String, retryMs: Int64? = nil) -> JSON {
        var o: [String: JSON] = ["type": "fail", "code": .string(code)]
        if let retryMs { o["retryMs"] = .int(retryMs) }
        return .object(o)
    }

    func testAMachineWithACodeAsksForItAndGoesOnOnceTyped() {
        Tab.codes = [:]
        let (t, ch) = tab()
        t.handle(fail("locked"))                                   // the first `list` was refused
        XCTAssertEqual(t.state, .locked)
        XCTAssertNil(ch.last("unlock"))                            // nothing remembered: the screen asks
        XCTAssertEqual(t.codeAsks, 1)
        t.unlock("0000")
        t.handle(fail("bad-code"))
        XCTAssertEqual(t.state, .locked); XCTAssertEqual(t.codeProblem, "bad-code"); XCTAssertEqual(t.codeAsks, 2)
        t.unlock("4821")
        t.handle(["type": "unlocked"])
        XCTAssertEqual(t.state, .connecting)
        XCTAssertEqual(ch.types.last, "list")                      // it goes on where it was: picking a console
        XCTAssertEqual(Tab.codes[other], "4821")
    }

    func testTheRememberedCodeIsTriedOnceByItselfAndForgottenIfWrong() {
        Tab.codes = [other: "4821"]
        let (t, ch) = tab()
        t.handle(fail("locked"))
        XCTAssertEqual(ch.last("unlock")?["code"]?.string, "4821")
        XCTAssertEqual(t.codeAsks, 0)                              // the screen did not ask
        let sent = ch.sent.count
        t.handle(fail("locked"))                                   // another refusal meanwhile: not sent again
        XCTAssertEqual(ch.sent.count, sent)
        t.handle(fail("wait", retryMs: 90_000))
        XCTAssertEqual(t.codeProblem, "wait"); XCTAssertEqual(t.codeWaitMs, 90_000)
        XCTAssertNil(Tab.codes[other])
        Tab.codes = [:]
    }

    func testClosingTheConsoleOnScreenGoesToAnExistingOneAndOpensOneOnlyIfItWasTheLast() {
        let (t, ch) = tab()
        let a = console("a", 1, 50, 20, watchers: 1)                 // watched somewhere else
        let c = console("c", 3, 50, 20, watchers: 1, by: me)
        t.handle(consoles(a, c)); t.handle(attached(c)); t.handle(consoles(a, c))
        let opens = ch.types.filter { $0 == "open" }.count
        t.killConsole("c")
        XCTAssertEqual(ch.last("attach")?["id"]?.string, "a")
        XCTAssertEqual(ch.types.filter { $0 == "open" }.count, opens)

        let (t2, ch2) = tab()
        let only = console("x", 1, 50, 20, watchers: 1, by: me)
        t2.handle(consoles()); t2.handle(attached(only)); t2.handle(consoles(only))
        let opens2 = ch2.types.filter { $0 == "open" }.count
        t2.killConsole("x")
        XCTAssertEqual(ch2.types.filter { $0 == "open" }.count, opens2 + 1)   // it was the last one
    }

    func testThePanelGivesTheMachineTheFolderAndTheTitleALineEachTheMachineAlwaysFirst() {
        let me = "seyacat@loca"
        func same(_ l: (host: String?, dir: String?, name: String?), _ host: String?, _ dir: String?, _ name: String?, line: UInt = #line) {
            XCTAssertEqual(l.host, host, line: line); XCTAssertEqual(l.dir, dir, line: line); XCTAssertEqual(l.name, name, line: line)
        }
        // Local: the machine leads (the title's, or the console's when the title names a program).
        same(panelLines("seyacat@loca: ~", "~", me), me, "~", nil)
        same(panelLines("seyacat@loca: ~/p/dotrino", nil, me), me, "~/p/dotrino", nil)                 // an older agent
        same(panelLines("✳ Sefjr improvement", "/mnt/sda1/Dotrino", me), me, "/mnt/sda1/Dotrino", "✳ Sefjr improvement")
        same(panelLines("vim: notas.txt", "~", me), me, "~", "vim: notas.txt")
        // After an ssh the title names ANOTHER machine: that is shown.
        same(panelLines("dotrino@proxy1: /var/www", "~", me), "dotrino@proxy1", "~", "/var/www")
        same(panelLines("dotrino@proxy1: ~", nil, me), "dotrino@proxy1", "~", nil)
        // Without knowing the machine's name, a host in the title is shown.
        same(panelLines("seyacat@loca: ~", "~", nil), "seyacat@loca", "~", nil)
        same(panelLines("", "~", nil), nil, "~", nil)
        same(panelLines("", nil, nil), nil, nil, nil)
    }

    func testAConsoleDroppedOnAnotherTakesItsPlace() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(dropTarget(ids, "c", "a")?.before, "a")       // up: in front of it
        XCTAssertEqual(dropTarget(ids, "a", "c")?.before, "d")       // down: behind it
        XCTAssertNotNil(dropTarget(ids, "a", "d")); XCTAssertNil(dropTarget(ids, "a", "d")?.before)   // to the last: the end
        XCTAssertNil(dropTarget(ids, "b", "b"))
        XCTAssertNil(dropTarget(ids, "x", "b"))
    }

    private func with(_ c: JSON, note: String? = nil, task: String? = nil) -> JSON {
        var o = c.object ?? [:]
        if let note { o["note"] = .string(note) }
        if let task { o["task"] = .string(task) }
        return .object(o)
    }

    func testTheNoteIsThePersonsAndTheTaskIsTheProgramsEachInItsField() {
        let (t1, ch) = tab()
        let c = with(console("a", 1, 80, 24), note: "llamar a Ana", task: "migrando\nfalta: probar")
        t1.handle(consoles(c)); t1.handle(attached(c))
        XCTAssertEqual(t1.current?.note, "llamar a Ana")
        XCTAssertEqual(t1.current?.aboutLine, "migrando", "the panel shows the task's first line")

        t1.setNote("llamar a Luis")
        XCTAssertEqual(ch.last("note")?["text"]?.string, "llamar a Luis")
        XCTAssertNil(ch.last("note")?["task"], "the task is not sent with it")
        XCTAssertEqual(t1.current?.note, "llamar a Luis", "shown at once")
        XCTAssertEqual(t1.current?.task, "migrando\nfalta: probar", "and the task stays")

        t1.clearTask()
        XCTAssertEqual(ch.last("note")?["task"]?.string, "")
        XCTAssertNil(ch.last("note")?["text"], "removing the task does not send the note")
        XCTAssertEqual(t1.current?.aboutLine, "llamar a Luis", "with no task, the panel shows the note")

        t1.handle(["type": "noted", "console": with(console("a", 1, 80, 24), note: "de la máquina", task: "")])
        XCTAssertEqual(t1.current?.note, "de la máquina", "the machine's answer is what stays")
    }

    func testAMachineThatKeepsNoNotesSaysNothingOfThem() {
        let (t1, _) = tab()
        let c = console("a", 1, 80, 24)
        t1.handle(consoles(c)); t1.handle(attached(c))
        XCTAssertNil(t1.current?.note); XCTAssertNil(t1.current?.task); XCTAssertNil(t1.current?.aboutLine)
    }

    func testAConsoleThatFinishesIsSaidOnceAndOneAlreadyFinishedIsNot() {
        func done(_ c: JSON, _ at: Int64?) -> JSON {
            guard case .object(var o) = c else { return c }
            o["doneAt"] = at.map { .int($0) } ?? .null
            return .object(o)
        }
        let (t, _) = tab()
        var rang = 0
        t.onDone = { rang += 1 }
        let a = console("a", 1, 80, 24, watchers: 1), b = console("b", 2, 80, 24)
        // Opening: «a» was already finished. Not news.
        t.handle(consoles(done(a, 10), b)); XCTAssertEqual(rang, 0)
        // «b» finishes while the app is open: once, however many times the list comes.
        t.handle(consoles(done(a, 10), done(b, 20))); XCTAssertEqual(rang, 1)
        t.handle(consoles(done(a, 10), done(b, 20))); XCTAssertEqual(rang, 1)
        // Attended and finished again, told by the machine's push of that console.
        t.handle(consoles(done(a, 10), done(b, nil))); XCTAssertEqual(rang, 1)
        t.handle(meta(done(b, 30))); XCTAssertEqual(rang, 2)
    }

    // ---------- An image for whatever runs in the console ----------

    private func openTab() -> (Tab, FakeChannel) {
        let (t, ch) = tab()
        t.handle(consoles(console("a", 1, 80, 24)))
        t.handle(attached(console("a", 1, 50, 20, watchers: 1, by: me)))
        ch.sent = []
        return (t, ch)
    }
    private func filed(_ m: JSON, path: String? = nil) -> JSON {
        var o: [String: JSON] = ["type": "filed", "up": m["up"]!, "seq": m["seq"]!]
        if let path { o["path"] = .string(path) }
        return .object(o)
    }

    func testAnImageGoesInPiecesEachOneAcknowledgedAndTheLastSaysWhereItWasKept() {
        let (t, ch) = openTab()
        var got: (String?, String?)?
        t.onImage = { got = ($0, $1) }
        let bytes = Data((0..<(fileChunk * 2 + 10)).map { UInt8($0 % 251) })
        XCTAssertTrue(t.sendImage(bytes))
        XCTAssertTrue(t.sendingImage)
        XCTAssertFalse(t.sendImage(bytes))                           // one at a time
        XCTAssertEqual(ch.sent.count, 1)                             // the next piece waits for the acknowledgement
        XCTAssertEqual(ch.sent[0]["type"]?.string, "file")
        XCTAssertEqual(ch.sent[0]["seq"]?.int, 0)
        XCTAssertNil(ch.sent[0]["last"])
        t.handle(filed(ch.sent[0])); t.handle(filed(ch.sent[0]))     // a repeated acknowledgement moves nothing
        XCTAssertEqual(ch.sent.count, 2)
        t.handle(filed(ch.sent[1]))
        XCTAssertEqual(ch.sent.count, 3)
        XCTAssertEqual(ch.sent[2]["last"], .bool(true))
        var whole = Data()
        for m in ch.sent { whole.append(Data(base64Encoded: m["data"]!.string!)!) }
        XCTAssertEqual(whole, bytes)                                 // arrives whole
        XCTAssertNil(got)
        t.handle(filed(ch.sent[2], path: "/home/me/uploads/img-1.jpg"))
        XCTAssertEqual(got?.0, "/home/me/uploads/img-1.jpg")
        XCTAssertNil(got?.1)
        XCTAssertFalse(t.sendingImage)
    }

    func testWhatTheMachineRejectsIsSaidAndTheConsoleGoesOn() {
        let (t, _) = openTab()
        var got: (String?, String?)?
        t.onImage = { got = ($0, $1) }
        XCTAssertTrue(t.sendImage(Data(count: 10)))
        t.handle(["type": "fail", "code": "not-image", "message": "file: that is not an image"])
        XCTAssertEqual(got?.1, "not-image")
        XCTAssertEqual(t.state, .open)                               // the tab did not fail
        XCTAssertFalse(t.sendingImage)
    }

    func testAMachineThatNeverAnswersIsAnOlderTerminal() {
        let (t, _) = openTab()
        var got: [String?] = []
        t.onImage = { _, problem in got.append(problem) }
        XCTAssertTrue(t.sendImage(Data(count: 10)))
        t.imageStalled(); t.imageStalled()
        XCTAssertEqual(got, ["timeout"])                             // only once
    }

    func testWithoutAConsoleOnScreenNoImageStarts() {
        let (t, ch) = tab()
        XCTAssertFalse(t.sendImage(Data(count: 10)))
        XCTAssertFalse(ch.types.contains("file"))
    }

    func testWhatGoesAsItIsAndWhatIsReduced() {
        let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) + Data(count: 100)
        XCTAssertTrue(Images.goesAsIs(png))
        XCTAssertFalse(Images.goesAsIs(Data([0xff, 0xd8, 0xff]) + Data(count: 5_000_000)))   // a phone's photo is reduced
        XCTAssertFalse(Images.goesAsIs(Data("ftypheic........".utf8)))                       // a kind the machine does not keep is converted
        XCTAssertTrue(Images.fitSide(4000, 3000) == (Images.maxSide, 1500))
        XCTAssertTrue(Images.fitSide(800, 600) == (800, 600))                                // never enlarged
        XCTAssertEqual(Images.typedPath("/home/me/img-1.jpg"), "/home/me/img-1.jpg")
        XCTAssertEqual(Images.typedPath("/home/my user/img.jpg"), "'/home/my user/img.jpg'")
        XCTAssertThrowsError(try Images.prepare(Data("not an image".utf8)))
    }
}
