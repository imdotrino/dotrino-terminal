import XCTest
@testable import Terminal

/// What the extra key row sends, with its sticky modifiers (the same tests as Android, `KeysTest.kt`).
final class KeysTests: XCTestCase {
    private let esc = "\u{1b}"

    func testShiftTabIsBackTab() {
        XCTAssertEqual(Keys.named("tab", shift: false, alt: false, app: false), "\t")
        XCTAssertEqual(Keys.named("tab", shift: true, alt: false, app: false), esc + "[Z")
    }

    func testShiftedArrowsCarryTheModifierAlsoInApplicationMode() {
        XCTAssertEqual(Keys.named("up", shift: false, alt: false, app: false), esc + "[A")
        XCTAssertEqual(Keys.named("up", shift: false, alt: false, app: true), esc + "OA")
        XCTAssertEqual(Keys.named("up", shift: true, alt: false, app: true), esc + "[1;2A")
        XCTAssertEqual(Keys.named("left", shift: true, alt: false, app: false), esc + "[1;2D")
        XCTAssertEqual(Keys.named("pgup", shift: true, alt: false, app: false), esc + "[5;2~")
    }

    func testAltPrefixesAndUnknownKeysSendNothing() {
        XCTAssertEqual(Keys.named("tab", shift: true, alt: true, app: false), esc + esc + "[Z")
        XCTAssertNil(Keys.named("nope", shift: false, alt: false, app: false))
        XCTAssertNil(Keys.named("nope", shift: true, alt: false, app: false))
    }

    func testTypedTextTakesTheModifiers() {
        XCTAssertEqual(Keys.text("a", shift: true, ctrl: false, alt: false), "A")
        XCTAssertEqual(Keys.text("c", shift: false, ctrl: true, alt: false), "\u{03}")
        XCTAssertEqual(Keys.text("x", shift: false, ctrl: false, alt: true), esc + "x")
    }
}
