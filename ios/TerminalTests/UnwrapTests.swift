import XCTest
@testable import Terminal

/// «Copiar sin saltos» against the golden vectors the four versions share (`test/unwrap.vectors.json`).
final class UnwrapTests: XCTestCase {
    private struct Vector: Decodable { let name: String, `in`: String, out: String }

    func testEveryVector() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../test/unwrap.vectors.json")
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: file))
        XCTAssertFalse(vectors.isEmpty, "no vectors read")
        for v in vectors { XCTAssertEqual(Unwrap.unwrap(v.in), v.out, v.name) }
    }
}
