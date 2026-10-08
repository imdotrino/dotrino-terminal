import DotrinoNative
import Foundation

/// A machine of the account running the terminal agent, as the list shows it.
struct Machine: Hashable, Identifiable {
    let pubkey: String
    let label: String
    var id: String { pubkey }
    /// `AB12-CD34`: the id `dotrino-vault members` shows for it.
    var keyId: String { (try? Delegation.keyLabel(pubkey)) ?? "" }
}

/// Who has a console's size: the screen that chose it with ⤢, or else the last one that attached.
struct SizeBy: Equatable {
    let origin: String?, device: String?, tag: String?, pinned: Bool
}

/// A console open on a machine (the agent's `consoles` list): the same fields the PWA reads.
struct ConsoleInfo: Equatable, Identifiable {
    let id: String
    let n: Int
    let title: String
    let origin: String?
    let cols: Int, rows: Int
    let viewers: Int, watchers: Int
    /// A window of the machine itself is showing it.
    let watchedLocally: Bool
    let sizeBy: SizeBy?
    let lastActive: Int64
    /// The folder its shell is in now (agent ≥ 0.22, Linux); nil when the machine does not say.
    var cwd: String? = nil
    /// `user@host` of the machine it runs on, as a shell's prompt says it (agent ≥ 0.24).
    var host: String? = nil
    /// Something is working in it now (the agent says it, ≥ 0.17).
    var busy = false
    /// It finished and nobody has looked at it yet.
    var doneAt: Int64? = nil

    enum Activity { case idle, busy, done }
    var activity: Activity { busy ? .busy : doneAt != nil ? .done : .idle }
}

/// What a `Tab` needs from its session. A protocol so the protocol can be tested without a network.
protocol Channel: AnyObject {
    func send(_ payload: JSON) throws
    @discardableResult func onMessage(_ l: @escaping (JSON) -> Void) -> () -> Void
    @discardableResult func onError(_ l: @escaping (Error) -> Void) -> () -> Void
    func close()
}

extension RemoteAgent.Session: Channel {
    func onError(_ l: @escaping (Error) -> Void) -> () -> Void { onError { (e: RemoteAgent.RemoteAgentError) in l(e) } }
}

/// Reads one console of the agent's list (or of `attached` / `meta`).
func consoleOf(_ o: JSON) -> ConsoleInfo? {
    guard let id = o["id"]?.string else { return nil }
    let by = o["sizeBy"]?.objectValue.map { SizeBy(origin: $0["origin"]?.string, device: $0["device"]?.string, tag: $0["tag"]?.string, pinned: $0["pinned"]?.bool == true) }
    let watchers = o["watchers"]?.array ?? []
    func int(_ k: String) -> Int { Int(o[k]?.int ?? 0) }
    return ConsoleInfo(id: id, n: int("n"), title: o["title"]?.string ?? "", origin: o["origin"]?.string, cols: int("cols"), rows: int("rows"),
                       viewers: int("viewers"), watchers: watchers.count, watchedLocally: watchers.contains { $0["origin"]?.string == "local" },
                       sizeBy: by, lastActive: o["lastActive"]?.int ?? 0, cwd: o["cwd"]?.string, host: o["host"]?.string,
                       busy: o["activity"]?.string == "busy", doneAt: o["doneAt"]?.int)
}

/// Where a console dragged in the panel goes when dropped on another: it takes THAT one's place.
/// Upwards it lands in front of it; downwards, behind it (in front of the next one, or at the end:
/// `before` nil). nil when nothing moves. The same as the PWA's `dropTarget`.
func dropTarget(_ ids: [String], _ id: String, _ over: String) -> (before: String?, ())? {
    guard let from = ids.firstIndex(of: id), let to = ids.firstIndex(of: over), from != to else { return nil }
    return (to < from ? over : (to + 1 < ids.count ? ids[to + 1] : nil), ())
}

/// What the open panel says of a console, each thing on ITS line: the machine (`user@host`) ALWAYS
/// and first (owner, 2026-10-07: hidden when it was the console's own, the panel no longer said
/// whose each console was), the folder, and the title the program set. A shell titles itself
/// «user@host: folder»: that machine is shown, so after an `ssh` where it went shows. When the title
/// has none (Claude names its session), the console's machine, which the agent gives. The same
/// split as the PWA, the desktop and Android. `machine`: `user@host` of the console's machine (agent ≥ 0.24).
func panelLines(_ title: String, _ cwd: String?, _ machine: String? = nil) -> (host: String?, dir: String?, name: String?) {
    let title = title.trimmingCharacters(in: .whitespaces)
    var host: String? = nil
    var rest = title
    if let r = title.range(of: #"^[^\s:]+@[^\s:]+:"#, options: .regularExpression) {
        host = String(title[title.startIndex..<title.index(before: r.upperBound)])
        rest = title[r.upperBound...].trimmingCharacters(in: .whitespaces)
    }
    // Without the machine's folder (an older agent, or macOS), a shell's is what follows the host.
    var dir = cwd?.trimmingCharacters(in: .whitespaces)
    if dir?.isEmpty ?? true { dir = host != nil && !rest.isEmpty ? rest : nil }
    return (host ?? machine, dir, rest.isEmpty || rest == dir ? nil : rest)
}

/// The title of a console for the panel. The shell sets it as «user@host: path»; what matters is
/// the last folder, so «user@host:» goes (the machine is known) and the path is cut ON THE LEFT,
/// by whole folders, down to `max` characters. The same as the PWA and Android (`shortTitle`).
func shortTitle(_ title: String, max: Int = 24) -> String {
    var text = title
    if let r = title.range(of: #"^[^\s:]+@[^\s:]+:\s*(.+)$"#, options: .regularExpression) {
        let s = String(title[r]); if let c = s.firstIndex(of: ":") { text = String(s[s.index(after: c)...]).trimmingCharacters(in: .whitespaces) }
    }
    if text.count <= max { return text }
    var parts = text.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    var out = parts.removeLast()
    while let prev = parts.last, out.count + prev.count + 1 <= max - 1 { out = parts.removeLast() + "/" + out }
    return "…/" + (out.count > max - 2 ? "…" + String(out.suffix(max - 3)) : out)
}

/// The terminal of this process: ONE per app, not per screen. The phone's profile, one connection
/// to the proxy identified as it, and the open tabs (one per machine). The same protocol as the
/// PWA (`src/agentClient.js`) and Android (`Consoles.kt`), inside a `RemoteAgent.Session`.
@MainActor
final class Consoles: ObservableObject {
    static let shared = Consoles()
    static let kind = "terminal-agent"
    static let defaultProxy = "wss://proxy.dotrino.com"

    struct BootError: Error { let message: String, code: String }

    @Published private(set) var profile: Profile?
    @Published private(set) var tabs: [Tab] = []
    /// The connection to the proxy: `online`, `connecting`, `offline`.
    @Published private(set) var link = "connecting"
    /// DEBUG demo: a tab fed by a scripted agent, with no profile nor network.
    private(set) var demo = false

    private var conn: ProxyConnection?
    private var connecting: Task<ProxyConnection, Error>?

    /// The phone's profile. Throws `BootError`: `no-profile`, `no-profile-keys`, `no-vault`.
    func boot() throws -> Profile {
        if let profile { return profile }
        let p: Profile
        do { p = try Profile.fromPhone() } catch let e as Profile.ProfileError { throw BootError(message: e.description, code: e.code) }
        // Without a vault there is no record that names other machines: nothing to connect to.
        if p.vault == nil { throw BootError(message: "this profile is not linked to a vault", code: "no-vault") }
        profile = p
        return p
    }

    /// The profile changed (another account): start over.
    func forget() {
        for t in tabs { t.release() }
        tabs = []; profile = nil
        conn?.close(); conn = nil
    }

    /// The connection, identified as the profile. One at a time: two callers wait for the same.
    private func connection() async throws -> ProxyConnection {
        if let conn { return conn }
        if let connecting { return try await connecting.value }
        guard let p = profile else { throw BootError(message: "no profile", code: "no-profile") }
        let task = Task<ProxyConnection, Error> { @MainActor in
            link = "connecting"
            let c = try ProxyConnection(p.vault?.proxy ?? Self.defaultProxy, app: "terminal")
            do {
                _ = try await c.connect()
                try await c.identifyAs(p.publickey) { try p.signData($0) }
            } catch { c.close(); link = "offline"; throw error }
            link = "online"
            // When it drops, every session over it is gone: the tabs come back by themselves.
            Task { @MainActor in
                _ = await c.awaitClosed()
                if self.conn === c { self.conn = nil }
                self.link = "offline"
                for t in self.tabs { t.lost() }
                await self.reconnect()
            }
            return c
        }
        connecting = task
        defer { connecting = nil }
        let c = try await task.value
        conn = c
        return c
    }

    private func reconnect() async {
        var wait: UInt64 = 1_000_000_000
        while profile != nil && tabs.contains(where: { $0.state != .exited }) {
            do { _ = try await connection(); break } catch { try? await Task.sleep(nanoseconds: wait); wait = min(wait * 2, 30_000_000_000) }
        }
        for t in tabs where t.state == .lost { Task { await resume(t) } }
    }

    /// The machines of the account that are ON and run the terminal agent.
    func machines() async throws -> [Machine] {
        guard let p = profile else { throw BootError(message: "no profile", code: "no-profile") }
        let candidates = RemoteAgent.candidates(p)
        let found = try await RemoteAgent.probe(try await connection(), candidates.map(\.0))
        return candidates.filter { (found[$0.0] ?? nil) == Self.kind }
            .map { Machine(pubkey: $0.0, label: ($0.1?.isEmpty == false ? $0.1! : (try? Delegation.keyLabel($0.0)) ?? "")) }
            .sorted { $0.label.lowercased() < $1.label.lowercased() }
    }

    /// A session with `machine`. If its paper names a record newer than the phone's (the vault
    /// changed it), the phone catches up from the vault once and keeps it for every app.
    private func openSession(_ p: Profile, _ machine: Machine) async throws -> RemoteAgent.Session {
        let c = try await connection()
        return try await RemoteAgent.open(p, c, machine.pubkey, catchUp: { @MainActor in
            let next = try await ActaSync.catchUp(p, c)
            self.profile = next
            return next
        })
    }

    /// The tab of `machine`: one per machine, as in the PWA. If it is already open, that one; if
    /// not, a new one that attaches to a free console (or opens one when none is free).
    func enter(_ machine: Machine, cols: Int, rows: Int) async throws -> Tab {
        if let t = tabs.first(where: { $0.machine == machine }) { return t }
        guard let p = profile else { throw BootError(message: "no profile", code: "no-profile") }
        let session = try await openSession(p, machine)
        let tab = Tab(machine: machine, myDevice: p.publickey)
        tab.onDrop = { [weak self, weak tab] in self?.tabs.removeAll { $0 === tab } }
        tab.onLost = { [weak self, weak tab] in guard let self, let tab else { return }; Task { await self.resume(tab) } }
        tabs.append(tab)
        tab.bind(session, cols: cols, rows: rows, resume: nil)
        return tab
    }

    /// Over a new session, the tab comes back to the console it had (the screen is replayed).
    func resume(_ tab: Tab) async {
        guard let p = profile else { return }
        do { tab.bind(try await openSession(p, tab.machine), cols: tab.screenCols, rows: tab.screenRows, resume: tab.consoleId) }
        catch { tab.lostWith("\(error)", retry: false) }
    }

    /// DEBUG: a tab fed by a scripted agent (`DemoAgent`), with no profile and no network.
    func demoTab(_ machine: Machine, me: String, _ ch: Channel) {
        demo = true; link = "online"
        let tab = Tab(machine: machine, myDevice: me)
        tab.onDrop = { [weak self, weak tab] in self?.tabs.removeAll { $0 === tab } }
        tabs.append(tab)
        tab.bind(ch, cols: 80, rows: 24, resume: nil)
    }
}

/// A machine on screen: its session, the console it shows (`consoleId`) and the machine's
/// consoles (`consoles`, for the panel). The same rules as the PWA and Android:
///  · switching to another console goes over the same session (`attach` / `open`);
///  · the emulator has the CONSOLE's size: whoever has the size decides it (⤢, or the last one
///    that attached), and this screen shows it at that size;
///  · the screen's size is said with `resize`, and the agent applies it only if it is ours.
@MainActor
final class Tab: ObservableObject, Identifiable {
    /// `locked`: the machine asks for its code (`dotrino-terminal lock`) and it has not been typed on this session.
    enum State { case connecting, open, locked, lost, exited, failed }

    /// The code of each machine that asks for one, by the machine's key. In MEMORY only: it lasts
    /// while the app lives, so coming back after a dropped connection does not ask again.
    static var codes: [String: String] = [:]

    let machine: Machine
    private let myDevice: String?
    let terminal = Terminal(80, 24)
    @Published private(set) var state = State.connecting
    /// The console on screen.
    @Published private(set) var consoleId: String?
    /// The machine's consoles, in the panel's order: the machine's (by number until someone moves one).
    @Published private(set) var consoles: [ConsoleInfo] = []
    /// Why it failed, or the exit code as text.
    @Published private(set) var note: String?
    /// The columns and rows that fit on this screen (not the console's).
    private(set) var screenCols = 80, screenRows = 24
    /// Redraw the emulator.
    var onOutput: () -> Void = {}
    var onBell: () -> Void = {}
    var onDrop: () -> Void = {}
    var onLost: () -> Void = {}

    private var channel: Channel?
    private var offs: [() -> Void] = []
    private var fresh = true                      // the next replay starts a clean screen
    private var choosing = false                  // waiting for the list to pick a free console
    private var trying: String?                   // the code sent, waiting for the agent's answer
    private var triedKept = false                 // the remembered code was already sent on this lock
    /// While locked: why the last code was not taken (`bad-code`, `wait`), or nil if none was tried.
    @Published private(set) var codeProblem: String?
    /// With `wait`: how long the machine makes everyone wait, in ms.
    private(set) var codeWaitMs: Int64 = 0
    /// Goes up every time the screen has to ask for the code (the dialog comes up by itself).
    @Published private(set) var codeAsks = 0

    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }

    init(machine: Machine, myDevice: String?) {
        self.machine = machine; self.myDevice = myDevice
        // What the emulator answers by itself (a cursor report) goes back as typed input.
        terminal.onReply = { [weak self] s in Task { @MainActor in self?.input(s) } }
        terminal.onBell = { [weak self] in self?.onBell() }
    }

    /// The console on screen, as the agent last described it.
    var current: ConsoleInfo? { consoles.first { $0.id == consoleId } }
    /// Its number (fixed while it lives), or nil.
    var number: Int? { current.flatMap { $0.n > 0 ? $0.n : nil } }

    func bind(_ ch: Channel, cols: Int, rows: Int, resume: String?) {
        release()
        channel = ch; fresh = true; state = .connecting; note = nil
        screenCols = cols; screenRows = rows
        offs.append(ch.onMessage { [weak self] m in DispatchQueue.main.async { self?.handle(m) } })
        offs.append(ch.onError { [weak self] e in
            DispatchQueue.main.async { if let s = self, s.state == .open || s.state == .connecting { s.lostWith("\(e)", retry: true) } }
        })
        if let resume { send("attach", resume) } else { choosing = true; list() }
    }

    private func send(_ type: String, _ id: String?) {
        fresh = true
        var o: [String: JSON] = ["type": .string(type), "cols": .int(Int64(screenCols)), "rows": .int(Int64(screenRows))]
        if let id { o["id"] = .string(id) }
        try? channel?.send(.object(o))
    }

    /// Ask the agent for the machine's consoles (the panel).
    func list() { try? channel?.send(["type": "list"]) }

    func handle(_ m: JSON) {
        switch m["type"]?.string {
        case "consoles":
            // In the panel's order: the machine's (by number until someone moves one).
            consoles = (m["list"]?.array ?? []).compactMap(consoleOf)
            if choosing {
                choosing = false
                // One that ALREADY exists: first one nobody watches; if all are watched, the first
                // anyway. A NEW one only when the machine has none (owner, 2026-10-07).
                if let pick = consoles.first(where: { $0.watchers == 0 }) ?? consoles.first { send("attach", pick.id) } else { send("open", nil) }
            }
            if let c = current { follow(c) }
        // The screen as the agent keeps it, in pieces: a clean emulator first, then the pieces.
        case "replay":
            if fresh { terminal.feed("\u{1b}c"); fresh = false }
            feed(m)
        case "out": feed(m)
        case "attached":
            consoleId = m["id"]?.string
            if let c = m["console"].flatMap(consoleOf) { upsert(c); follow(c) }
            state = .open; note = nil
            list()
        case "meta":
            guard let c = m["console"].flatMap(consoleOf) else { return }
            upsert(c)
            if c.id == consoleId { follow(c) }
        case "exit": state = .exited; note = m["code"].map { $0.text }; list()
        // The machine's code was right: it is remembered while the app lives, and the tab goes on.
        case "unlocked":
            if let c = trying { Self.codes[machine.pubkey] = c }
            trying = nil; triedKept = false; codeProblem = nil; codeWaitMs = 0
            state = .connecting
            if let id = consoleId { send("attach", id) } else { choosing = true; list() }
        case "fail":
            let code = m["code"]?.string
            // The machine asks for its code. The one typed before (if any) is tried once by itself;
            // if there is none or it no longer works, the screen asks.
            if code == "locked" {
                if state != .locked { state = .locked; codeProblem = nil; if Self.codes[machine.pubkey] == nil { codeAsks += 1 } }
                if let kept = Self.codes[machine.pubkey], !triedKept, trying == nil { triedKept = true; unlock(kept) }
                return
            }
            if code == "bad-code" || code == "wait" {
                Self.codes[machine.pubkey] = nil; trying = nil
                state = .locked; codeProblem = code
                codeWaitMs = m["retryMs"]?.int ?? 0
                codeAsks += 1
                return
            }
            // The console is gone on the machine (it was closed there, or the agent restarted).
            if code == "no-console" { state = .exited; note = code } else { state = .failed; note = m["message"]?.string ?? code }
            list()
        default: break
        }
    }

    /// In its place (the order is the machine's); one not seen yet goes last until the next list.
    private func upsert(_ c: ConsoleInfo) {
        if let i = consoles.firstIndex(where: { $0.id == c.id }) { consoles[i] = c } else { consoles.append(c) }
    }

    /// The emulator takes the console's size: if another screen has it, this one shows it at that size.
    private func follow(_ c: ConsoleInfo) {
        guard c.cols > 0, c.rows > 0 else { return }
        if c.cols != terminal.cols || c.rows != terminal.rows { terminal.resize(c.cols, c.rows); onOutput() }
    }

    private func feed(_ m: JSON) {
        guard let data = m["data"]?.string else { return }
        terminal.feed(data); onOutput()
    }

    /// Type the machine's code. The agent answers `unlocked`, or says why not (`codeProblem`).
    func unlock(_ code: String) {
        trying = code
        do { try channel?.send(["type": "unlock", "code": .string(code)]) } catch { trying = nil }
    }

    func input(_ text: String) {
        guard state == .open else { return }
        try? channel?.send(["type": "input", "data": .string(text)])
    }

    /// What fits on this screen changed. The agent applies it only if the size is ours.
    func screen(_ cols: Int, _ rows: Int) {
        if cols == screenCols && rows == screenRows { return }
        screenCols = cols; screenRows = rows
        guard state == .open else { return }
        try? channel?.send(["type": "resize", "cols": .int(Int64(cols)), "rows": .int(Int64(rows))])
    }

    /// Another console of the machine (or a new one, with nil) on this screen, over the same session.
    func switchTo(_ id: String?) {
        if let id, id == consoleId, state == .open { return }
        state = .connecting; note = nil
        send(id != nil ? "attach" : "open", id)
    }

    /// ⤢ Does the console on screen use THIS screen's size, on purpose?
    var sizeHere: Bool { current?.sizeBy.map { $0.pinned && Delegation.samePubkey($0.device, myDevice) } ?? false }

    /// Does this screen have the console's size now (chosen, or because it arrived last)?
    func sizeIsMine(_ c: ConsoleInfo?) -> Bool { c?.sizeBy.map { Delegation.samePubkey($0.device, myDevice) } ?? false }

    /// ⤢: the console on screen uses this screen's size (on), or stops (off).
    func useMySize(_ on: Bool) {
        guard state == .open else { return }
        if on { try? channel?.send(["type": "resize", "cols": .int(Int64(screenCols)), "rows": .int(Int64(screenRows))]) }
        try? channel?.send(["type": "pin", "on": .bool(on)])
    }

    /// Close a console on the machine. If it is the one on screen, first move to another free one (or a new one).
    func killConsole(_ id: String) {
        // To a console that ALREADY exists: first one nobody watches; if all are watched, the first
        // anyway. A NEW one only when the machine has none left (owner, 2026-10-07: every remote client).
        if id == consoleId {
            let rest = consoles.filter { $0.id != id }
            switchTo((rest.first { $0.watchers == 0 } ?? rest.first)?.id)
        }
        try? channel?.send(["type": "kill", "id": .string(id)])
        list()
    }

    /// The panel's order, by dragging: `id` takes the place of `over`. The order is the machine's
    /// (agent ≥ 0.26), so every screen sees it; it is shown here at once and the machine's answer
    /// (the list, in order) confirms it.
    func move(_ id: String, over: String) {
        guard let to = dropTarget(consoles.map(\.id), id, over), let from = consoles.firstIndex(where: { $0.id == id }) else { return }
        let moved = consoles.remove(at: from)
        consoles.insert(moved, at: to.before.flatMap { b in consoles.firstIndex { $0.id == b } } ?? consoles.count)
        var o: [String: JSON] = ["type": "move", "id": .string(id)]
        if let b = to.before { o["before"] = .string(b) }
        try? channel?.send(.object(o))
    }

    /// The tab's ×: LEAVES the console (it stays alive on the machine; owner, 2026-10-07: closing the
    /// tab must never close the console) and drops the tab. A console is closed from the panel.
    func leave() {
        if state == .open { try? channel?.send(["type": "detach"]) }
        release(); onDrop()
    }

    func release() {
        for off in offs { off() }
        offs = []
        channel?.close(); channel = nil
    }

    /// The connection dropped under this tab: it comes back by itself.
    func lost() { if state == .open || state == .connecting { release(); state = .lost } }

    func lostWith(_ why: String?, retry: Bool) {
        release(); state = .lost; note = why
        if retry { onLost() }
    }

    /// Try again by hand, from the tab's note.
    func retry() { onLost() }
}
