import XCTest

/// The app against the REAL demo App Review uses (`dotrino-demo-apple`): sign in with its address
/// and password, open its machine, and see the agent answer with its consoles and take a command.
/// Everything the app sends goes binary (dotrino-native ≥ 0.42.0), so this is what says the demo's
/// agent understands it — the path a reviewer walks. Simulator or phone; it adds the demo account.
///
///   TEST_RUNNER_DEMO_ADDRESS=apple@… TEST_RUNNER_DEMO_PASSWORD=… xcodebuild -project Terminal.xcodeproj \
///     -scheme Terminal -destination 'id=<udid>' -only-testing:TerminalUITests/LiveDemoUITests test
final class LiveDemoUITests: XCTestCase {
    private struct Stop: Error {}
    private let app = XCUIApplication()
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var web: XCUIElement { app.webViews.firstMatch }

    func testSignInOpenTheMachineAndType() throws {
        let address = try XCTUnwrap(env["DEMO_ADDRESS"], "set TEST_RUNNER_DEMO_ADDRESS")
        let password = try XCTUnwrap(env["DEMO_PASSWORD"], "set TEST_RUNNER_DEMO_PASSWORD")
        app.launch()

        // Profile menu → Sign in (the page of profile.dotrino.com, inside the app).
        try need(app.buttons["profile-button"], 30, "no profile button")
        app.buttons["profile-button"].tap()
        let signIn = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Sign in' OR label CONTAINS 'Iniciar sesión'")).firstMatch
        try need(signIn, 10, "no Sign in in the profile menu")
        signIn.tap()
        let addr = web.textFields.firstMatch, pass = web.secureTextFields.firstMatch
        try need(pass, 30, "the sign-in page did not show")
        addr.tap(); addr.typeText(address)
        pass.tap(); pass.typeText(password)
        let remember = web.switches.firstMatch
        if remember.exists { remember.tap() }
        web.buttons.matching(NSPredicate(format: "label IN %@", ["Sign in", "Entrar", "Iniciar sesión"])).firstMatch.tap()

        // Back on the machines: the demo's one. The app may reload on the profile change.
        let close = app.buttons["web-close"]
        if close.waitForExistence(timeout: 20) { close.tap() }
        let machine = app.buttons["machine"].firstMatch
        try need(machine, 90, "the demo machine did not show up")
        machine.tap()

        // The agent answers with its consoles: a request and its reply, both ways through the proxy.
        let console = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'console-' AND NOT (identifier IN %@)",
                                                                           ["console-new", "console-kill", "console-grip"])).firstMatch
        try need(console, 60, "the agent did not answer with its consoles")
        app.typeText("echo LIVE_DEMO_OK\n")
        sleep(3)
    }

    /// Waits for [e]; if it never shows, prints what IS on screen and stops.
    private func need(_ e: XCUIElement, _ timeout: TimeInterval, _ what: String) throws {
        if e.waitForExistence(timeout: timeout) { return }
        print("SCREEN: " + app.debugDescription.replacingOccurrences(of: "\n", with: " ¶ "))
        XCTFail(what)
        throw Stop()
    }
}
