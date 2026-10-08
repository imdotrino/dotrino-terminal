import DotrinoNative
import DotrinoNativeUI
import SwiftUI

/// The app: your machines and, from there, their consoles — one tab per machine, with the panel
/// of its consoles. The same screens as Android (`MainActivity.kt`) and the PWA. «Back» from a
/// console returns to the machines (the consoles stay open).
struct AppView: View {
    @ObservedObject private var consoles = Consoles.shared
    @ObservedObject private var lang = DotrinoLang.shared
    @State private var problem: Problem?
    @State private var machines: [Machine]?
    @State private var machinesError: String?
    @State private var status: String?
    @State private var active: Tab?
    @State private var web: URL?

    struct Problem: Equatable { let text: String; let profileActions: Bool; let vaultAction: Bool }

    /// What the floating status says, or nil when there is nothing to say.
    private var statusText: String? {
        if let status { return status }
        if consoles.link != "online", consoles.profile != nil { return consoles.link == "connecting" ? t("link.connecting") : t("link.offline") }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            DotrinoTopbar(repo: "imdotrino/dotrino-terminal", brand: .init(name: "Terminal", image: Image("Brand")),
                          profile: consoles.profile.map { .init(name: $0.name, key: $0.avatarSeed, avatar: $0.avatar) },
                          onProfileChanged: { consoles.forget(); active = nil; boot() })
            Group {
                if let problem { ProblemView(problem: problem, open: { web = $0 }, retry: { consoles.forget(); boot() }) }
                else if let active, consoles.tabs.contains(where: { $0 === active }) {
                    ConsoleScreen(tab: active, select: { self.active = $0 }, toMachines: { self.active = nil; loadMachines() })
                } else {
                    MachinesView(machines: machines, error: machinesError, openTabs: consoles.tabs.count,
                                 backToConsoles: { active = consoles.tabs.last }, enter: enter, refresh: loadMachines, howTo: openWiki)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The status («Conectando…», «Sin conexión») FLOATS over the content, at the top. As a
            // row of the column it pushed everything down when it showed, and the console changed
            // size. Rule (owner, 2026-10-07): nothing that comes and goes may change the console's size.
            .overlay(alignment: .top) {
                if let text = statusText {
                    Text(text).font(.footnote).foregroundColor(Palette.text).padding(.horizontal, 14).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Palette.panel2))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
                        .padding(.top, 8).padding(.horizontal, 24)
                        .accessibilityIdentifier("status")
                }
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .sheet(item: Binding(get: { web.map(IdentURL.init) }, set: { web = $0?.url })) { u in
            DotrinoWebSheet(url: u.url) { web = nil; consoles.forget(); boot() }
        }
        .onAppear { if consoles.profile == nil { boot() } }
    }

    private struct IdentURL: Identifiable { let url: URL; var id: String { url.absoluteString } }

    private func boot() {
        problem = nil
        if consoles.demo { active = consoles.tabs.last; return }
        do {
            _ = try consoles.boot()
            loadMachines()
        } catch let e as Consoles.BootError {
            switch e.code {
            case "no-profile", "no-profile-keys": problem = Problem(text: t("boot.noProfile"), profileActions: true, vaultAction: false)
            case "no-vault": problem = Problem(text: t("boot.noVault"), profileActions: false, vaultAction: true)
            default: problem = Problem(text: e.message, profileActions: false, vaultAction: false)
            }
        } catch {
            problem = Problem(text: "\(error)", profileActions: false, vaultAction: false)
        }
    }

    private func loadMachines() {
        machines = nil; machinesError = nil
        Task {
            do { machines = try await consoles.machines() } catch { machines = []; machinesError = t("machines.error", ("why", "\(error)")) }
        }
    }

    private func enter(_ m: Machine) {
        status = t("machine.connecting", ("name", m.label))
        Task {
            do {
                active = try await consoles.enter(m, cols: 80, rows: 24)
                status = nil
            } catch { status = t("machine.failed", ("why", "\(error)")) }
        }
    }

    private func openWiki() {
        let base = lang.code == "en" ? "https://wiki.dotrino.com/en" : "https://wiki.dotrino.com"
        if let u = URL(string: "\(base)/herramientas/terminal/") { UIApplication.shared.open(u) }
    }
}

// MARK: problems and machines

private struct ProblemView: View {
    let problem: AppView.Problem
    let open: (URL) -> Void
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Text(problem.text).font(.body).foregroundColor(Palette.muted).multilineTextAlignment(.center)
            if problem.profileActions {
                Pill(t("boot.create"), filled: true) { open(DotrinoTopbarURLs.create) }.accessibilityIdentifier("create-profile")
                Pill(t("boot.adopt")) { open(DotrinoTopbarURLs.adopt) }.accessibilityIdentifier("adopt-profile")
            }
            if problem.vaultAction { Pill(t("boot.connectVault"), filled: true) { open(DotrinoTopbarURLs.adopt) }.accessibilityIdentifier("connect-vault") }
            Pill(t("boot.retry"), filled: !problem.profileActions && !problem.vaultAction, action: retry).accessibilityIdentifier("retry")
        }
        .padding(32)
    }
}

private struct MachinesView: View {
    let machines: [Machine]?
    let error: String?
    let openTabs: Int
    let backToConsoles: () -> Void
    let enter: (Machine) -> Void
    let refresh: () -> Void
    let howTo: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if openTabs > 0 { Pill(t("machines.open", ("n", openTabs)), filled: true, action: backToConsoles).accessibilityIdentifier("open-consoles") }
                Text(t("machines.title")).font(.title3.bold()).foregroundColor(Palette.text).padding(.top, openTabs > 0 ? 8 : 0)
                if let machines {
                    if machines.isEmpty {
                        Text(error ?? t("machines.none")).foregroundColor(Palette.muted)
                        if error == nil { Pill(t("machines.howto"), action: howTo).accessibilityIdentifier("howto") }
                    } else {
                        ForEach(machines) { m in
                            Button { enter(m) } label: {
                                HStack(spacing: 12) {
                                    Circle().fill(Palette.online).frame(width: 10, height: 10)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(m.label).font(.headline).foregroundColor(Palette.text)
                                        Text(m.keyId).font(.footnote.monospaced()).foregroundColor(Palette.muted)
                                    }
                                    Spacer()
                                    Text("›").font(.title2).foregroundColor(Palette.muted)
                                }
                                .padding(16).background(RoundedRectangle(cornerRadius: 16).fill(Palette.panel))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.line))
                            }
                            .accessibilityIdentifier("machine")
                        }
                    }
                    Pill(t("machines.refresh"), action: refresh).accessibilityIdentifier("refresh").padding(.top, 8)
                } else {
                    Text(t("machines.loading")).foregroundColor(Palette.muted)
                }
            }
            .padding(16)
        }
    }
}

struct Pill: View {
    let title: String
    let filled: Bool
    let action: () -> Void
    init(_ title: String, filled: Bool = false, action: @escaping () -> Void) { self.title = title; self.filled = filled; self.action = action }
    var body: some View {
        Button(action: action) {
            Text(title).font(.body.bold()).foregroundColor(filled ? Palette.onAccent : Palette.text)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .background(Capsule().fill(filled ? Palette.accent : Palette.panel))
                .overlay(Capsule().stroke(filled ? Color.clear : Palette.line))
        }
    }
}

// MARK: a console

/// The ⤢ icon: a double diagonal arrow, drawn (the same path as the PWA, Android and the desktop app).
struct SizeIcon: Shape {
    func path(in r: CGRect) -> Path {
        let s = min(r.width, r.height) / 16
        var p = Path()
        p.move(to: CGPoint(x: 9.5 * s, y: 2.5 * s)); p.addLine(to: CGPoint(x: 13.5 * s, y: 2.5 * s)); p.addLine(to: CGPoint(x: 13.5 * s, y: 6.5 * s))
        p.move(to: CGPoint(x: 6.5 * s, y: 13.5 * s)); p.addLine(to: CGPoint(x: 2.5 * s, y: 13.5 * s)); p.addLine(to: CGPoint(x: 2.5 * s, y: 9.5 * s))
        p.move(to: CGPoint(x: 13.5 * s, y: 2.5 * s)); p.addLine(to: CGPoint(x: 2.5 * s, y: 13.5 * s))
        return p
    }
}

private struct ConsoleScreen: View {
    @ObservedObject var tab: Tab
    @ObservedObject private var consoles = Consoles.shared
    let select: (Tab) -> Void
    let toMachines: () -> Void
    @State private var view: TerminalView?
    @State private var drawer = false
    /// Ordering the panel by dragging: the console being dragged, the one it would land on, and
    /// where each row is (in the panel's own space).
    @State private var dragId: String?
    @State private var dragOver: String?
    @State private var rowFrames: [String: CGRect] = [:]
    /// The strip number whose hold just showed the actions: lifting it is not a tap.
    @State private var actions: ConsoleInfo?
    @State private var toast: String?
    @State private var mods = (ctrl: false, alt: false)
    @State private var termMenu = false
    @State private var askingCode = false
    @State private var code = ""
    /// ✎ The writing line (remembered): over a slow connection every key travels to the machine and
    /// back before it shows; here it shows at once and goes whole, with Enter. The extra keys still
    /// go straight. Off, everything goes key by key, as full-screen programs (vim, htop) need.
    @AppStorage("compose") private var composing = false
    @State private var composeText = ""
    @State private var composeFocus = false
    /// The field itself: what is sent is read from IT, not from the state, which lagged a keystroke
    /// behind now and then (owner, 2026-10-07: «Enter sometimes works, sometimes not»).
    @State private var composeBox = ComposeField.Box()

    private static let keys = ["esc", "tab", "ctrl", "alt", "up", "down", "left", "right", "home", "end", "pgup", "pgdn", "-", "/", "|", "~"]
    private static let labels = ["esc": "Esc", "tab": "Tab", "up": "↑", "down": "↓", "left": "←", "right": "→", "home": "Home", "end": "End", "pgup": "PgUp", "pgdn": "PgDn"]

    var body: some View {
        VStack(spacing: 0) {
            tabStrip
            ZStack(alignment: .topLeading) {
                // The open panel takes the strip's place, BESIDE the console (owner, 2026-10-07): it
                // does change the console's size, on purpose — over it, it covered what was being read.
                HStack(spacing: 0) {
                    if drawer { panel } else { strip }
                    TerminalScreen(tab: tab, view: $view)
                }
                // What the tab has to say («Conectando…», «pide su clave»): a card floating OVER the
                // console. In the column it pushed the console down each time it showed.
                if let note = noteText {
                    Button { if tab.state == .lost || tab.state == .failed { tab.retry() } else if tab.state == .locked { askingCode = true } } label: {
                        Text(note).font(.subheadline).foregroundColor(Palette.text).multilineTextAlignment(.center).padding(.horizontal, 18).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 14).fill(Palette.panel2))
                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
                    }
                    .accessibilityIdentifier("tab-note")
                    .padding(.horizontal, 24).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if let toast {
                    Text(toast).font(.footnote).foregroundColor(Palette.text).padding(12)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.panel2))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom).padding(16)
                }
            }
            if composing { composeBar }
            extraKeys
        }
        .onReceive(Timer.publish(every: 2, on: .main, in: .common).autoconnect()) { _ in if tab.state != .locked { tab.list() } }
        // The machine asks for its code (`dotrino-terminal lock`, set on that machine): the dialog
        // comes up by itself each time the agent asks, and from the note.
        .onAppear { if tab.state == .locked { askingCode = true } }
        .onChange(of: tab.codeAsks) { _ in askingCode = tab.state == .locked }
        .alert(t("code.title", ("name", tab.machine.label)), isPresented: $askingCode) {
            SecureField(t("code.label"), text: $code).accessibilityIdentifier("code-input")
            Button(t("code.ok")) { let c = code; code = ""; if !c.isEmpty { tab.unlock(c) } }
            Button(t("code.cancel"), role: .cancel) { code = "" }
        } message: {
            Text(codeMessage)
        }
        // Long press on the console: paste, or copy what is on screen (the same as Android).
        .confirmationDialog(t("menu.title"), isPresented: $termMenu, titleVisibility: .visible) {
            if view?.hasSelection == true {
                Button(t("menu.copySel")) { UIPasteboard.general.string = view?.selectedText() ?? ""; view?.clearSelection(); show(t("menu.copiedSel")) }
            }
            Button(t("menu.paste")) { if let s = UIPasteboard.general.string { view?.paste(s) } }
            Button(t("menu.copy")) { UIPasteboard.general.string = view?.screenText() ?? ""; show(t("menu.copied")) }
        }
        .confirmationDialog(actions.map { "\($0.n) · " + shortTitle($0.title.isEmpty ? t("console.n", ("n", $0.n)) : $0.title) } ?? "",
                            isPresented: Binding(get: { actions != nil }, set: { if !$0 { actions = nil } }), titleVisibility: .visible) {
            if let c = actions {
                if c.id != tab.consoleId { Button(t("console.openHere")) { tab.switchTo(c.id) } }
                Button(t("console.kill"), role: .destructive) { tab.killConsole(c.id) }
            }
        }
    }

    /// What the code dialog says: why the last one was not taken, or where the code comes from.
    private var codeMessage: String {
        switch tab.codeProblem {
        case "bad-code": return t("code.wrong")
        case "wait": return t("code.wait", ("min", max(1, Int((tab.codeWaitMs + 59_999) / 60_000))))
        default: return t("code.lead")
        }
    }

    private var noteText: String? {
        switch tab.state {
        case .open: return nil
        case .locked: return t("code.note")
        case .connecting: return t("tab.connecting")
        case .lost: return t("tab.lost")
        case .exited: return tab.note == "no-console" ? t("tab.gone") : t("tab.exited")
        case .failed: return t("tab.failed", ("why", tab.note ?? "?"))
        }
    }

    // The tabs: one per machine.
    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(consoles.tabs) { tb in
                    let on = tb === tab
                    HStack(spacing: 6) {
                        Circle().fill(tb.state == .open ? Palette.online : (tb.state == .exited || tb.state == .failed ? Palette.danger : Palette.muted)).frame(width: 7, height: 7)
                        Text(String(tb.machine.label.prefix(20))).font(.caption.bold()).foregroundColor(Palette.text)
                        Button { tb.leave() } label: { Text("×").foregroundColor(Palette.muted) }.accessibilityLabel(t("tab.close")).accessibilityIdentifier("tab-close")
                    }
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 10).fill(on ? Palette.panel2 : Palette.panel))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(on ? Palette.accent : Palette.line))
                    .onTapGesture { if !on { select(tb) } }
                    .accessibilityIdentifier("tab")
                }
                Button(action: toMachines) { Text("＋").foregroundColor(Palette.text).padding(.horizontal, 10) }
                    .accessibilityLabel(t("tab.new")).accessibilityIdentifier("tab-new")
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
        }
        .background(Palette.panel)
    }

    /// `fill`: the background when it is off (the strip's subtle one); on, the accent fills the WHOLE area.
    private func sizeButton(_ size: CGFloat, height: CGFloat? = nil, fill: Color = .clear) -> some View {
        let on = tab.sizeHere, n = tab.number
        return Button { toggleSize() } label: {
            SizeIcon().stroke(on ? Palette.accent : Palette.muted, style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
                .frame(width: 16, height: 16).padding(7)
                .opacity(n == nil ? 0.3 : 1)
                .frame(width: size, height: height ?? size)
                .background(RoundedRectangle(cornerRadius: 6).fill(on ? Palette.accentSoft : fill))
        }
        .disabled(n == nil)
        .accessibilityLabel(n.map { on ? t("size.release", ("n", $0)) : t("size.use", ("n", $0)) } ?? t("size.use", ("n", "")))
        .accessibilityIdentifier("size")
        .frame(width: size, height: height ?? size)
    }

    private func toggleSize() {
        guard let n = tab.number else { return }
        let on = !tab.sizeHere
        tab.useMySize(on)
        // Said out loud: if this screen already had the size, nothing else changes on screen.
        show(on ? t("size.usedNow", ("n", n), ("cols", tab.screenCols), ("rows", tab.screenRows)) : t("size.releasedNow", ("n", n)))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { tab.list() }
    }

    private func show(_ s: String) {
        toast = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { if toast == s { toast = nil } }
    }

    /// The consoles panel, collapsed: a strip on the left (», +, ⤢ and the numbers). It scrolls with
    /// the finger: nothing is sorted here (owner, 2026-10-07; sorting is the open panel's grip).
    private var strip: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 4) {
                Button { withAnimation(.easeOut(duration: 0.15)) { drawer = true } } label: { Text("»").foregroundColor(Palette.text).frame(width: 32, height: 56).background(RoundedRectangle(cornerRadius: 6).fill(Palette.panel2)) }
                    .accessibilityLabel(t("panel.open")).accessibilityIdentifier("panel-open")
                Button { tab.switchTo(nil) } label: { Text("+").foregroundColor(Palette.text).frame(width: 32, height: 56).background(RoundedRectangle(cornerRadius: 6).fill(Palette.panel2)) }
                    .accessibilityLabel(t("console.new")).accessibilityIdentifier("console-new")
                // ALL the strip's buttons the same height (56) and each with a subtle background
                // that shows its area (owner, 2026-10-07).
                sizeButton(32, height: 56, fill: Palette.panel2)
                ForEach(tab.consoles) { c in
                    let on = c.id == tab.consoleId
                    Text("\(c.n)").font(.footnote.weight(on ? .bold : .regular)).foregroundColor(on ? Palette.onAccent : Palette.text)
                        .frame(width: 32, height: 56).background(RoundedRectangle(cornerRadius: 6).fill(on ? Palette.accent : Palette.panel2))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(actColor(c) ?? .clear, lineWidth: on ? 2 : 1))
                        .contentShape(Rectangle())
                        .onTapGesture { tab.switchTo(c.id) }
                        .onLongPressGesture { actions = c }
                        .accessibilityLabel(c.title.isEmpty ? t("console.n", ("n", c.n)) : c.title)
                        .accessibilityIdentifier("console-\(c.n)")
                }
            }
            .padding(.vertical, 4)
        }
        .frame(width: 40)
        .background(Palette.panel)
    }

    private func sizeWho(_ c: ConsoleInfo) -> String {
        if tab.sizeIsMine(c) { return t("size.here") }
        return c.sizeBy?.origin == "local" ? t("size.window") : t("size.device")
    }

    /// Where a console is, said for this screen (the same words as the PWA's panel).
    /// The status as a BORDER, the same on the strip and on the open panel, and the same as the
    /// PWA, Android and the desktop app: amber = working, green = finished and not looked at yet.
    private func actColor(_ c: ConsoleInfo) -> Color? {
        switch c.activity { case .busy: return Palette.busy; case .done: return Palette.online; case .idle: return nil }
    }

    private func whereIs(_ c: ConsoleInfo) -> String {
        let mine = c.id == tab.consoleId
        let others = c.watchers - (mine ? 1 : 0)
        var w = c.watchedLocally ? t("where.local") : others > 0 ? t("where.other") : mine ? t("where.here") : t("where.free")
        if !mine, let by = c.sizeBy, c.watchers > 1 || by.pinned { w += " · \(t("size.label")): \(sizeWho(c))" }
        switch c.activity { case .busy: w += " · " + t("act.busy"); case .done: w += " · " + t("act.done"); case .idle: break }
        return w
    }

    /// The open panel: over the console, with the titles, where each one is, and who has the size.
    private var panel: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Button { withAnimation(.easeOut(duration: 0.15)) { drawer = false } } label: { Text("«").foregroundColor(Palette.text).padding(6) }
                        .accessibilityLabel(t("panel.close")).accessibilityIdentifier("panel-close")
                    Text(t("panel.title")).font(.subheadline.bold()).foregroundColor(Palette.text)
                }
                HStack {
                    Text(t("console.new")).font(.footnote).foregroundColor(Palette.muted)
                    Spacer()
                    Button { tab.switchTo(nil) } label: { Text("+").foregroundColor(Palette.text).padding(.horizontal, 12) }.accessibilityIdentifier("drawer-new")
                }
                .padding(.leading, 6)
                if let cur = tab.current {
                    HStack {
                        // Just the size (owner, 2026-10-07): who has it is what ⤢ lights up for.
                        Text("\(cur.cols)×\(cur.rows)").font(.footnote).foregroundColor(Palette.muted).accessibilityIdentifier("drawer-size")
                        Spacer()
                        sizeButton(34)
                    }
                    .padding(.leading, 6).padding(.vertical, 4)
                }
                ForEach(tab.consoles) { c in
                    let on = c.id == tab.consoleId
                    HStack {
                        // The grip: dragging it moves the console in the panel (dropped on another, it
                        // takes its place). A grip and not the row, so the row still opens the console,
                        // long-presses for its actions and scrolls the panel.
                        Text("⠿").foregroundColor(Palette.muted).padding(.vertical, 8).padding(.trailing, 2).contentShape(Rectangle())
                            .accessibilityLabel(t("console.move")).accessibilityIdentifier("console-grip")
                            .highPriorityGesture(DragGesture(minimumDistance: 2, coordinateSpace: .named("drawer-rows"))
                                .onChanged { v in
                                    dragId = c.id
                                    // The row under the finger; above the first or below the last, that one.
                                    let rows = tab.consoles.compactMap { r in rowFrames[r.id].map { (r.id, $0) } }
                                    dragOver = (rows.first { v.location.y < $0.1.maxY } ?? rows.last)?.0
                                }
                                .onEnded { _ in
                                    if let over = dragOver, over != c.id { tab.move(c.id, over: over) }
                                    dragId = nil; dragOver = nil
                                })
                        VStack(alignment: .leading, spacing: 2) {
                            // The number and the machine (`user@host`, always first) on the first row, as
                            // the PWA's panel; the folder and the title on their OWN rows, whole: cut to
                            // «…/…/nal» they said nothing.
                            let lines = panelLines(c.title, c.cwd, c.host)
                            Text((on ? "● " : "") + "\(c.n)" + (lines.host.map { " · \($0)" } ?? ""))
                                .font(.footnote.bold()).foregroundColor(Palette.text).lineLimit(1).truncationMode(.tail)
                            // ONE line each, never wrapped (a long path would push every row down); what
                            // does not fit is cut at the START, so the end — the folder — stays.
                            ForEach([lines.dir, lines.name].compactMap { $0 }, id: \.self) { line in
                                Text(line).font(.caption).foregroundColor(Palette.text).lineLimit(1).truncationMode(.head)
                            }
                            Text(whereIs(c)).font(.caption2).foregroundColor(Palette.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture { tab.switchTo(c.id) }
                        .onLongPressGesture { actions = c }
                        Button { tab.killConsole(c.id) } label: { Text("×").foregroundColor(Palette.muted).padding(.horizontal, 8) }
                            .accessibilityLabel(t("console.kill")).accessibilityIdentifier("console-kill")
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(RoundedRectangle(cornerRadius: 8).fill(on ? Palette.accentSoft : Color.clear))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(actColor(c) ?? .clear, lineWidth: on ? 2 : 1))
                    .opacity(dragId == c.id ? 0.5 : 1)
                    // A line of the accent colour where the dragged one would land: above (in front) or below (behind).
                    .overlay(alignment: dropEdge(tab, c.id) ?? .top) { if dropEdge(tab, c.id) != nil { Rectangle().fill(Palette.accent).frame(height: 2) } }
                    .background(GeometryReader { g in Color.clear.preference(key: RowFrames.self, value: [c.id: g.frame(in: .named("drawer-rows"))]) })
                    .accessibilityIdentifier("drawer-console")
                }
            }
            .padding(8)
            .coordinateSpace(name: "drawer-rows")
            .onPreferenceChange(RowFrames.self) { rowFrames = $0 }
        }
        .frame(width: 270)
        .frame(maxHeight: .infinity)
        .background(Palette.panel)
        .accessibilityIdentifier("drawer")
    }

    /// Where the line goes on the row `id` while a console is dragged over it, or nil.
    private func dropEdge(_ tab: Tab, _ id: String) -> Alignment? {
        guard let dragId, dragOver == id, let to = dropTarget(tab.consoles.map(\.id), dragId, id) else { return nil }
        return to.before == id ? .top : .bottom
    }

    /// The writing line: the text and ⏎. Empty, ⏎ is just Enter.
    private var composeBar: some View {
        HStack(spacing: 6) {
            ComposeField(text: $composeText, placeholder: t("compose.hint"), focused: $composeFocus, box: composeBox,
                         onSend: sendCompose,
                         // Backspace on an empty line goes to the console: it is how you fix what is already there.
                         onEmptyBackspace: { view?.key("backspace") },
                         // With Ctrl or Alt lit, the next character is a key for the console (Ctrl+C), not text.
                         takesKey: { view.map { $0.ctrl || $0.alt } ?? false }, sendKey: { view?.type($0) })
                // The field takes the width that is left and never asks for more: a long line scrolls
                // INSIDE it (owner, 2026-10-07: it was pushing the row wider than the screen).
                .frame(maxWidth: .infinity, minHeight: 38, maxHeight: 38)
            Button(action: sendCompose) {
                Text("⏎").font(.title3.bold()).foregroundColor(Palette.onAccent).padding(.horizontal, 14).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Palette.accent))
            }
            .accessibilityLabel(t("compose.send")).accessibilityIdentifier("compose-send")
        }
        .padding(EdgeInsets(top: 6, leading: 6, bottom: 2, trailing: 6))
        .background(Palette.panel)
    }

    /// The line and Enter, in ONE message.
    private func sendCompose() {
        let line = composeBox.field?.text ?? composeText
        composeBox.field?.text = ""; composeText = ""
        // The text and, a moment later, Enter on its own: in ONE write a program that detects
        // pasting (Claude Code) takes the Enter as a line break inside the paste, not as «send».
        if line.isEmpty { tab.input("\r"); return }
        tab.input(line)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [tab] in tab.input("\r") }
    }

    /// ✎: the writing line on or off. The one change of size here is asked for, and remembered.
    private func toggleCompose() {
        composing.toggle()
        if composing { composeFocus = true } else { composeText = ""; composeFocus = false; view?.showKeyboard() }
    }

    /// The keys a phone keyboard lacks. Ctrl and Alt stay lit until the next key uses them.
    private var extraKeys: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Button(action: toggleCompose) {
                    Text("✎").font(.subheadline.bold()).foregroundColor(composing ? Palette.onAccent : Palette.text)
                        .frame(minWidth: 44).padding(.vertical, 9).padding(.horizontal, 6)
                        .background(RoundedRectangle(cornerRadius: 8).fill(composing ? Palette.accent : Palette.panel2))
                }
                .accessibilityLabel(t("compose.toggle")).accessibilityIdentifier("key-compose")
                ForEach(Self.keys, id: \.self) { k in
                    let lit = (k == "ctrl" && mods.ctrl) || (k == "alt" && mods.alt)
                    Button { press(k) } label: {
                        Text(Self.labels[k] ?? (k == "ctrl" ? t("key.ctrl") : k == "alt" ? t("key.alt") : k))
                            .font(.subheadline.bold()).foregroundColor(lit ? Palette.onAccent : Palette.text)
                            .frame(minWidth: 44).padding(.vertical, 9).padding(.horizontal, 6)
                            .background(RoundedRectangle(cornerRadius: 8).fill(lit ? Palette.accent : Palette.panel2))
                    }
                    .accessibilityIdentifier("key-\(k)")
                }
            }
            .padding(4)
        }
        .background(Palette.panel)
        .onAppear { wire(view) }
        .onChange(of: view) { wire($0) }
    }

    private func wire(_ v: TerminalView?) {
        v?.onModifiersChanged = { syncMods() }
        v?.onLongPress = { termMenu = true }
    }

    private func syncMods() { if let v = view { mods = (v.ctrl, v.alt) } }

    private func press(_ k: String) {
        guard let v = view else { return }
        switch k {
        case "ctrl": v.ctrl.toggle(); syncMods()
        case "alt": v.alt.toggle(); syncMods()
        case _ where Self.labels[k] != nil: v.key(k)
        // A character key (- / | ~) with the writing line on goes INTO the line, like any letter
        // (owner, 2026-10-07); off, straight to the console.
        default:
            if composing, let f = composeBox.field { f.insertText(k) } else { v.type(k) }
        }
    }
}

/// The text field of the writing line: a plain UITextField, so an empty-line backspace and a key
/// typed with Ctrl/Alt lit can be told apart from text (SwiftUI's TextField hides both).
private struct ComposeField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    @Binding var focused: Bool
    let box: Box
    let onSend: () -> Void

    /// A handle to the live field, for whoever sends from outside it (the ⏎ button).
    final class Box { weak var field: UITextField? }
    let onEmptyBackspace: () -> Void
    let takesKey: () -> Bool
    let sendKey: (String) -> Void

    final class Field: UITextField {
        var onEmptyBackspace: () -> Void = {}
        /// No intrinsic WIDTH: SwiftUI would size the row by the text and push ⏎ off the screen.
        override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: super.intrinsicContentSize.height) }
        override func deleteBackward() {
            if text?.isEmpty ?? true { onEmptyBackspace() }
            super.deleteBackward()
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: ComposeField
        init(_ p: ComposeField) { parent = p }
        func textFieldShouldReturn(_ f: UITextField) -> Bool { parent.onSend(); return false }
        func textField(_ f: UITextField, shouldChangeCharactersIn r: NSRange, replacementString s: String) -> Bool {
            if !s.isEmpty, parent.takesKey() { parent.sendKey(s); return false }
            return true
        }
        @objc func changed(_ f: UITextField) { parent.text = f.text ?? "" }
        func textFieldDidEndEditing(_ f: UITextField) { parent.focused = false }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> Field {
        let f = Field()
        box.field = f
        f.delegate = context.coordinator
        f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        f.onEmptyBackspace = onEmptyBackspace
        f.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        f.textColor = UIColor(Palette.text)
        f.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(Palette.muted)])
        f.backgroundColor = UIColor(Palette.bg)
        f.layer.cornerRadius = 10; f.layer.borderWidth = 1; f.layer.borderColor = UIColor(Palette.line).cgColor
        f.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1)); f.leftViewMode = .always
        f.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1)); f.rightViewMode = .always
        f.autocorrectionType = .no; f.autocapitalizationType = .none; f.spellCheckingType = .no
        f.smartQuotesType = .no; f.smartDashesType = .no; f.smartInsertDeleteType = .no
        f.keyboardType = .asciiCapable; f.keyboardAppearance = .dark; f.returnKeyType = .send
        f.accessibilityIdentifier = "compose-input"
        // Its text never widens the layout: the field yields, and the text scrolls inside it.
        f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        f.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return f
    }

    func updateUIView(_ f: Field, context: Context) {
        context.coordinator.parent = self
        // The field is the source of truth while it is being edited: the state is only pushed into
        // it when it is cleared (after a send) or when nobody is typing.
        if f.text != text, text.isEmpty || !f.isFirstResponder { f.text = text }
        if focused, !f.isFirstResponder { DispatchQueue.main.async { f.becomeFirstResponder() } }
    }
}

/// Where each row of the consoles panel is, so a drag knows which one it is over.
private struct RowFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}

