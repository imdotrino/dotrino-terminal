import DotrinoNative
import DotrinoNativeUI
import SwiftUI

@main
struct TerminalApp: App {
    init() {
        // Before touching any key or store: the Dotrino apps of the phone share keychain and files
        // (dotrino-native/docs/DISENO.md §2.1). Without the groups in the entitlements it stops
        // here with its error, instead of going on as another device.
        do {
            try SharedStorage.share(keychainAccessGroup: "P7G853375S.com.dotrino.shared", appGroup: "group.com.dotrino")
        } catch {
            fatalError("shared storage: \(error)")
        }
        DotrinoPalette.use(.init(bg: Palette.panel, card: Palette.panel2, fg: Palette.text, muted: Palette.muted, accent: Palette.accent))
        #if DEBUG
        // `-demo`: the consoles screen fed by a scripted agent (DemoAgent), with no profile nor network.
        if ProcessInfo.processInfo.arguments.contains("-demo") { DemoAgent.install() }
        #endif
    }

    var body: some Scene {
        WindowGroup { AppView().preferredColorScheme(.dark) }
    }
}

/// «Cool & Cozy», dark: the same colours as the PWA (src/style.css :root) and Android (colors.xml).
enum Palette {
    static let bg = Color(hex: 0x0F1416)          // surface
    static let panel = Color(hex: 0x1C2022)       // surface-container
    static let panel2 = Color(hex: 0x262A2D)      // surface-container-high
    static let line = Color(hex: 0x3F484E)        // outline-variant
    static let text = Color(hex: 0xDFE3E6)        // on-surface
    static let muted = Color(hex: 0xBFC8CF)       // on-surface-variant
    static let accent = Color(hex: 0x81CFFF)      // primary
    static let accentSoft = Color(hex: 0x004C6B)  // primary-container
    static let onAccent = Color(hex: 0x003549)    // on-primary
    static let online = Color(hex: 0x7AD7C2)      // secondary
    static let busy = Color(hex: 0xF5C26B)        // working (the PWA's amber)
    static let danger = Color(hex: 0xFFB4AB)      // error
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
