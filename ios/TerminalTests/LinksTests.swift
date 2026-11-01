import XCTest
@testable import Terminal

/// The detection rule against the golden vectors the four versions share (`test/links.vectors.json`).
final class LinksTests: XCTestCase {
    private struct Vector: Decodable {
        struct L: Decodable { let text: String, kind: String, target: String, start: Int }
        let line: String, links: [L]
    }

    func testEveryVector() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../test/links.vectors.json")
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: file))
        XCTAssertFalse(vectors.isEmpty, "no vectors read")
        for v in vectors {
            let got = Links.find(v.line)
            XCTAssertEqual(got.count, v.links.count, "count for «\(v.line)»")
            for (w, g) in zip(v.links, got) {
                XCTAssertEqual(g.text, w.text, "text for «\(v.line)»")
                XCTAssertEqual(g.kind.rawValue, w.kind, "kind for «\(v.line)»")
                XCTAssertEqual(g.target, w.target, "target for «\(v.line)»")
                XCTAssertEqual(g.start, w.start, "start for «\(v.line)»")
                XCTAssertEqual(g.end, g.start + g.text.utf16.count, "end for «\(v.line)»")
            }
        }
    }

    func testAPathCutAtTheEdgeOfTheScreenIsStillOnePath() {
        let t = Terminal(10, 4)
        t.feed("ls /tmp/abcdefghij.pdf ok")
        // The path starts on row 0 and ends on row 2; a tap on row 1 finds it whole.
        XCTAssertEqual(Links.at(t, 1, 3)?.target, "/tmp/abcdefghij.pdf")
        XCTAssertNil(Links.at(t, 0, 0))
    }

    func testAFileUrlIsAPathOfTheMachine() throws {
        XCTAssertEqual(try Links.asPath(Links.find("file:///home/me/a%20b.txt")[0]), "/home/me/a b.txt")
        XCTAssertNil(try Links.asPath(Links.find("https://dotrino.com/x")[0]))
    }

    func testAFetchedFileWithABadNameIsNotSaved() {
        for name in ["", ".", "..", "a/b", "../../x"] {
            XCTAssertThrowsError(try FetchedFiles.save(Fetched(name: name, path: "/x", bytes: Data([1]))), name)
        }
    }

    func testOnlyTheLastFetchedFileIsKept() throws {
        let a = try FetchedFiles.save(Fetched(name: "a.txt", path: "/a.txt", bytes: Data([1])))
        let b = try FetchedFiles.save(Fetched(name: "b.txt", path: "/b.txt", bytes: Data([2])))
        XCTAssertFalse(FileManager.default.fileExists(atPath: a.path))
        XCTAssertEqual(try Data(contentsOf: b), Data([2]))
    }
}
