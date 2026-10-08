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

        app.buttons["size"].firstMatch.tap()
        sleep(1)
        shot("3-size-here")

        // The writing line (✎): what is typed shows here and goes whole with ⏎.
        app.buttons["key-compose"].tap()
        let compose = app.textFields["compose-input"]
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        // A long line must not widen the row: ⏎ stays on screen.
        let screenW = app.windows.firstMatch.frame.width
        compose.typeText(String(repeating: "echo una línea muy larga que no cabe en el ancho de la pantalla ", count: 3))
        XCTAssertLessThanOrEqual(app.buttons["compose-send"].frame.maxX, screenW, "⏎ stays inside the screen with a long line")
        shot("3c0-compose-long")
        app.buttons["compose-send"].tap()
        sleep(1)
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
        // The panel lists 1, 2, 3; the last row (3) dropped on the first (1) leads.
        let row1 = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '1 ·'")).firstMatch
        let row3 = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '3 ·'")).firstMatch
        XCTAssertLessThan(row3.frame.minY, row1.frame.minY, "the last row dropped on the first takes its place in the panel")
    }
}
