#if DEBUG
import DotrinoNative
import Foundation

/// DEBUG ONLY: a scripted agent for the consoles screen, with no profile and no network. To look
/// at the panel, ⤢ and the console drawn at its own size on a simulator: launch with `-demo`.
/// The port of Android's `DemoConsolesActivity`: console 1 is free; 2 is shown by a window of the
/// machine that CHOSE its size (120×40, wider than a phone); 3 has a long path as its title.
final class DemoAgent: Channel {
    private static let me = #"{"kty":"EC","crv":"P-256","x":"demo-phone","y":"1"}"#
    private static let window = #"{"kty":"EC","crv":"P-256","x":"demo-machine","y":"1"}"#

    @MainActor static func install() {
        Consoles.shared.demoTab(Machine(pubkey: window, label: "TerminalLocal"), me: me, DemoAgent())
    }

    private final class C {
        let id: String, n: Int, title: String, window: Bool
        var cols: Int, rows: Int, chosenBy: String?, holder: String?
        init(_ id: String, _ n: Int, _ title: String, _ cols: Int, _ rows: Int, _ window: Bool, _ chosenBy: String?, _ holder: String?) {
            self.id = id; self.n = n; self.title = title; self.cols = cols; self.rows = rows; self.window = window; self.chosenBy = chosenBy; self.holder = holder
        }
    }

    private var listeners: [UUID: (JSON) -> Void] = [:]
    private var consoles = [
        C("c1", 1, "seyacat@loca: ~", 80, 24, false, nil, nil),
        C("c2", 2, "seyacat@loca: ~/proyectos/dotrino", 120, 40, true, "window", "window"),
        C("c3", 3, "seyacat@loca: /mnt/sda1/Dotrino/dotrino-terminal/desktop/vendor", 80, 24, false, nil, nil),
    ]
    private var current: C?
    private var cols = 80, rows = 24

    func onMessage(_ l: @escaping (JSON) -> Void) -> () -> Void { let id = UUID(); listeners[id] = l; return { [weak self] in self?.listeners[id] = nil } }
    func onError(_ l: @escaping (Error) -> Void) -> () -> Void { {} }
    func close() {}

    private func reply(_ m: JSON) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { for l in self.listeners.values { l(m) } }
    }

    private func decider(_ c: C) -> String? { c.chosenBy ?? c.holder }

    private func info(_ c: C) -> JSON {
        var watchers: [JSON] = []
        if c.window { watchers.append(["origin": "local", "tag": "desktop-1"]) }
        if current === c { watchers.append(["origin": "remote", "device": .string(Self.me)]) }
        var o: [String: JSON] = ["id": .string(c.id), "n": .int(Int64(c.n)), "title": .string(c.title), "origin": "local",
                                 "cols": .int(Int64(c.cols)), "rows": .int(Int64(c.rows)), "lastActive": .int(nowMs()),
                                 "viewers": .int(Int64(watchers.count)), "watchers": .array(watchers)]
        if let who = decider(c) {
            o["sizeBy"] = who == "phone" ? ["origin": "remote", "device": .string(Self.me), "pinned": .bool(c.chosenBy == who)]
                                         : ["origin": "local", "tag": "desktop-1", "pinned": .bool(c.chosenBy == who)]
        }
        return .object(o)
    }

    private func list() { reply(["type": "consoles", "list": .array(consoles.sorted { $0.n < $1.n }.map(info))]) }
    private func meta(_ c: C) { reply(["type": "meta", "console": info(c)]) }
    /// The phone's size applies only if the phone decides.
    private func applySize(_ c: C) { if decider(c) == "phone" { c.cols = cols; c.rows = rows } }

    private func attach(_ c: C) {
        if let prev = current, prev.holder == "phone" { prev.holder = prev.window ? "window" : nil; if prev.window { prev.cols = 120; prev.rows = 40 } }
        current = c; c.holder = "phone"; applySize(c)
        reply(["type": "attached", "id": .string(c.id), "console": info(c)])
        reply(["type": "replay", "data": .string(sample(c))])
    }

    private func sample(_ c: C) -> String {
        let e = "\u{1b}"
        let path = c.title.components(separatedBy: ": ").last ?? "~"
        let wide = c.cols > 100 ? "\(e)[2m" + String(repeating: "·", count: c.cols - 1) + "\(e)[0m\r\n" : ""
        return "\(e)[1;32mseyacat@loca\(e)[0m:\(e)[1;34m\(path)\(e)[0m$ ls\r\n\(e)[1;34msrc\(e)[0m  \(e)[1;34mdocs\(e)[0m  \(e)[1;32mrun.sh\(e)[0m  README.md\r\n" + wide + "Consola \(c.n) · \(c.cols)×\(c.rows)\r\n$ "
    }

    func send(_ p: JSON) throws {
        func int(_ k: String) -> Int? { p[k]?.int.map(Int.init) }
        switch p["type"]?.string {
        case "list": list()
        case "open":
            cols = int("cols") ?? cols; rows = int("rows") ?? rows
            let n = (1...99).first { k in !consoles.contains { $0.n == k } }!
            let c = C("c\(n)-\(nowMs())", n, "seyacat@loca: ~", cols, rows, false, nil, nil)
            consoles.append(c); attach(c)
        case "attach":
            cols = int("cols") ?? cols; rows = int("rows") ?? rows
            if let c = consoles.first(where: { $0.id == p["id"]?.string }) { attach(c) } else { reply(["type": "fail", "code": "no-console"]) }
        case "resize":
            cols = int("cols") ?? cols; rows = int("rows") ?? rows
            if let c = current { let b = (c.cols, c.rows); applySize(c); if b != (c.cols, c.rows) { meta(c) } }
        case "pin":
            if let c = current {
                if p["on"]?.bool == true { c.chosenBy = "phone" } else if c.chosenBy == "phone" { c.chosenBy = nil }
                applySize(c); meta(c)
            }
        case "input": reply(["type": "out", "data": .string((p["data"]?.string ?? "").replacingOccurrences(of: "\r", with: "\r\n$ "))])
        case "kill": consoles.removeAll { $0.id == p["id"]?.string }; list()
        case "close": if let c = current { consoles.removeAll { $0 === c } }; current = nil
        default: break
        }
    }
}
#endif
