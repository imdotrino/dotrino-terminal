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
    @State private var actions: ConsoleInfo?
    @State private var toast: String?
    @State private var mods = (ctrl: false, alt: false)
    @State private var termMenu = false
    @State private var askingCode = false
    @State private var code = ""

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
                        Button { tb.kill() } label: { Text("×").foregroundColor(Palette.muted) }.accessibilityLabel(t("tab.close")).accessibilityIdentifier("tab-close")
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

    private func sizeButton(_ size: CGFloat) -> some View {
        let on = tab.sizeHere, n = tab.number
        return Button { toggleSize() } label: {
            SizeIcon().stroke(on ? Palette.accent : Palette.muted, style: StrokeStyle(lineWidth: 1.7, lineCap: .round, lineJoin: .round))
                .frame(width: 16, height: 16).padding(7)
                .background(RoundedRectangle(cornerRadius: 6).fill(on ? Palette.accentSoft : Color.clear))
                .opacity(n == nil ? 0.3 : 1)
        }
        .disabled(n == nil)
        .accessibilityLabel(n.map { on ? t("size.release", ("n", $0)) : t("size.use", ("n", $0)) } ?? t("size.use", ("n", "")))
        .accessibilityIdentifier("size")
        .frame(width: size, height: size)
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

    /// The consoles panel, collapsed: a strip on the left (», +, ⤢ and the numbers).
    private var strip: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 4) {
                Button { withAnimation(.easeOut(duration: 0.15)) { drawer = true } } label: { Text("»").foregroundColor(Palette.text).frame(width: 32, height: 30) }
                    .accessibilityLabel(t("panel.open")).accessibilityIdentifier("panel-open")
                Button { tab.switchTo(nil) } label: { Text("+").foregroundColor(Palette.text).frame(width: 32, height: 30) }
                    .accessibilityLabel(t("console.new")).accessibilityIdentifier("console-new")
                sizeButton(32)
                ForEach(tab.consoles) { c in
                    let on = c.id == tab.consoleId
                    Text("\(c.n)").font(.footnote.weight(on ? .bold : .regular)).foregroundColor(on ? Palette.onAccent : Palette.text)
                        .frame(width: 30, height: 28).background(RoundedRectangle(cornerRadius: 6).fill(on ? Palette.accent : Color.clear))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(actColor(c) ?? .clear, lineWidth: on ? 2 : 1))
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
                        VStack(alignment: .leading, spacing: 2) {
                            // The number, and the title on its OWN row, whole: cut to «…/…/nal» it said nothing.
                            Text((on ? "● " : "") + "\(c.n)").font(.footnote.bold()).foregroundColor(Palette.text)
                            // ONE line each, never wrapped (a long path would push every row down); what
                            // does not fit is cut at the START, so the end — the folder — stays.
                            let lines = panelLines(c.title, c.cwd, c.host)
                            ForEach([lines.host, lines.dir, lines.name].compactMap { $0 }, id: \.self) { line in
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
                    .accessibilityIdentifier("drawer-console")
                }
            }
            .padding(8)
        }
        .frame(width: 270)
        .frame(maxHeight: .infinity)
        .background(Palette.panel)
        .accessibilityIdentifier("drawer")
    }

    /// The keys a phone keyboard lacks. Ctrl and Alt stay lit until the next key uses them.
    private var extraKeys: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
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
        default: v.type(k)
        }
    }
}
