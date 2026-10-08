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

        // Ordering by dragging in the STRIP: the number itself drags (there is no grip there).
        app.staticTexts["console-3"].press(forDuration: 0.2, thenDragTo: app.staticTexts["console-1"])
        sleep(1)
        shot("3b-strip-reordered")
        XCTAssertLessThan(app.staticTexts["console-3"].frame.minY, app.staticTexts["console-1"].frame.minY, "3 dropped on 1 takes its place in the strip")

        // ▲/▼ when the strip overflows: open consoles until it does, ▼ shows, and at the bottom ▲ shows.
        for _ in 0..<12 { app.buttons["console-new"].tap() }
        sleep(1)
        shot("3a-strip-overflow")
        XCTAssertTrue(app.buttons["strip-down"].waitForExistence(timeout: 5), "▼ shows when the strip overflows")
        XCTAssertFalse(app.buttons["strip-up"].exists, "at the top there is no ▲")
        app.buttons["strip-down"].tap(); app.buttons["strip-down"].tap(); app.buttons["strip-down"].tap()
        sleep(1)
        shot("3a2-strip-scrolled")
        XCTAssertTrue(app.buttons["strip-up"].waitForExistence(timeout: 5), "scrolled down, ▲ shows")
        app.staticTexts["console-1"].tap()

        // The writing line (✎): what is typed shows here and goes whole with ⏎.
        app.buttons["key-compose"].tap()
        let compose = app.textFields["compose-input"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        compose.typeText("ls")
        app.buttons["compose-send"].tap()
        sleep(1)
        shot("3c-compose")
        // Empty, a text field's value is its placeholder.
        XCTAssertNotEqual(compose.value as? String ?? "", "ls", "sent, the line is empty again")
        app.buttons["key-compose"].tap()
        XCTAssertFalse(compose.exists, "✎ again hides the line")

        app.buttons["panel-open"].tap()
        XCTAssertTrue(app.buttons["panel-close"].waitForExistence(timeout: 5))
        // The open panel takes the strip's place: the strip's » button is gone while it is open.
        XCTAssertFalse(app.buttons["panel-open"].exists, "the open panel takes the strip's place")
        shot("4-panel")

        // Ordering by dragging: the third console's grip, dropped on the first, takes its place.
        // By its label: the row's identifier («drawer-console») covers its children's.
        let grips = app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", ["Mover la consola", "Move the console"]))
        XCTAssertGreaterThanOrEqual(grips.count, 3)
        grips.element(boundBy: 2).press(forDuration: 0.2, thenDragTo: grips.element(boundBy: 0))
        sleep(1)
        shot("5-reordered")
        // After the strip's move the panel lists 3, 1, 2; the last row (2) dropped on the first (3) leads.
        let row2 = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '● 2'")).firstMatch
        let row3 = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '3 ·'")).firstMatch
        XCTAssertLessThan(row2.frame.minY, row3.frame.minY, "the last row dropped on the first takes its place in the panel")
    }
}
