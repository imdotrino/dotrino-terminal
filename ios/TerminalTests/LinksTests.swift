import XCTest
@testable import Terminal

/// The links rule against the golden vectors (`test/links.vectors.json`, the same file the PWA's
/// test reads), and a tap on the emulator's cells.
final class LinksTests: XCTestCase {
    func testEveryGoldenVector() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "links.vectors", withExtension: "json"), "links.vectors.json is in the test bundle")
        let vectors = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertEqual(vectors.count, 9)
        for v in vectors {
            let line = try XCTUnwrap(v["line"] as? String)
            let want = try XCTUnwrap(v["links"] as? [[String: Any]])
            let got = Links.find(line)
            XCTAssertEqual(got.count, want.count, line)
            for (g, w) in zip(got, want) {
                XCTAssertEqual(g.text, w["text"] as? String, line)
                XCTAssertEqual(g.kind.rawValue, w["kind"] as? String, line)
                XCTAssertEqual(g.target, w["target"] as? String, line)
                XCTAssertEqual(g.start, w["start"] as? Int, line)
                XCTAssertEqual(g.end, g.start + g.text.unicodeScalars.count, line)
            }
        }
    }

    func testLinkAtAPosition() {
        let line = "see https://dotrino.com/a and /tmp/x.pdf"
        XCTAssertNil(Links.at(line, 3))
        XCTAssertEqual(Links.at(line, 4)?.kind, .url)
        XCTAssertEqual(Links.at(line, 25)?.kind, .url)
        XCTAssertNil(Links.at(line, 26))
        XCTAssertEqual(Links.at(line, 31)?.target, "/tmp/x.pdf")
    }

    func testWhatEachLinkOpens() {
        func target(_ s: String) -> LinkTarget? { Links.find(s).first.flatMap(LinkTarget.init) }
        XCTAssertEqual(target("https://dotrino.com"), .web("https://dotrino.com"))
        XCTAssertEqual(target("mailto:a@b.com"), .web("mailto:a@b.com"))
        XCTAssertEqual(target("~/src/main.js:12:3"), .file("~/src/main.js"))
        XCTAssertEqual(target("file:///tmp/a%20b.txt"), .file("/tmp/a b.txt"))
        XCTAssertEqual(target("file://localhost/tmp/c.txt"), .file("/tmp/c.txt"))
        XCTAssertNil(target("file://host"))
        XCTAssertEqual(LinkTarget.web("x").actions, [.open, .copy])
        XCTAssertEqual(LinkTarget.file("/x").actions, [.open, .share, .copy])
    }

    func testATapOnTheEmulatorFindsTheLinkUnderTheCell() {
        let t = Terminal(10, 3)
        t.feed("ab /tmp/informe.pdf x")         // wraps: «ab /tmp/in» «forme.pdf » «x»
        XCTAssertEqual(t.link(atLine: 0, col: 4)?.target, "/tmp/informe.pdf")
        XCTAssertEqual(t.link(atLine: 1, col: 2)?.target, "/tmp/informe.pdf", "a path that wrapped is one link")
        XCTAssertNil(t.link(atLine: 0, col: 1))
        XCTAssertNil(t.link(atLine: 2, col: 0))
    }

    func testWideCharactersCountAsOnePosition() {
        let t = Terminal(20, 2)
        t.feed("文 /tmp/a.txt")                  // «文» takes two cells
        XCTAssertEqual(t.link(atLine: 0, col: 3)?.target, "/tmp/a.txt")
        XCTAssertNil(t.link(atLine: 0, col: 1))
    }
}
