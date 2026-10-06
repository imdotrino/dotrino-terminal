import XCTest

/// The consoles screen with the demo agent (`-demo`): switch to the console another screen sized
/// (120×40, wider than the phone), take its size with ⤢, and open the panel over the strip.
/// `DOTRINO_SHOTS=<dir>` (TEST_RUNNER_DOTRINO_SHOTS) keeps a screenshot of each step there.
final class ConsolesUITests: XCTestCase {
    private func shot(_ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["DOTRINO_SHOTS"] else { return }
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    func testSwitchSizeAndPanel() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo"]
        app.launch()
        XCTAssertTrue(app.buttons["console-new"].waitForExistence(timeout: 10))
        shot("1-console1")

        app.staticTexts["console-2"].tap()
        sleep(1)
        shot("2-console2-wider")

        app.buttons["size"].firstMatch.tap()
        sleep(1)
        shot("3-size-here")

        app.buttons["panel-open"].tap()
        XCTAssertTrue(app.buttons["panel-close"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["panel-open"].isHittable, "the open panel covers the strip")
        shot("4-panel")
    }
}
