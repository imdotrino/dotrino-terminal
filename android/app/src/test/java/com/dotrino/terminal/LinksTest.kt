package com.dotrino.terminal

import com.dotrino.terminal.term.Links
import com.dotrino.terminal.term.Terminal
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The detection rule against the golden vectors the four versions share (`test/links.vectors.json`). */
class LinksTest {
    // Gradle runs the unit tests from the module folder (android/app).
    private val vectors: JsonArray = Json.parseToJsonElement(File("../../test/links.vectors.json").readText()) as JsonArray

    @Test fun everyVector() {
        assertTrue("no vectors read", vectors.isNotEmpty())
        for (v in vectors) {
            v as JsonObject
            val line = v.getValue("line").jsonPrimitive.content
            val want = (v.getValue("links") as JsonArray).map { it as JsonObject }
            val got = Links.find(line)
            assertEquals("count for «$line»", want.size, got.size)
            for ((w, g) in want.zip(got)) {
                assertEquals("text for «$line»", w.getValue("text").jsonPrimitive.content, g.text)
                assertEquals("kind for «$line»", w.getValue("kind").jsonPrimitive.content, g.kind.name.lowercase())
                assertEquals("target for «$line»", w.getValue("target").jsonPrimitive.content, g.target)
                assertEquals("start for «$line»", w.getValue("start").jsonPrimitive.int, g.start)
                assertEquals("end for «$line»", g.start + g.text.length, g.end)
            }
        }
    }

    @Test fun aPathCutAtTheEdgeOfTheScreenIsStillOnePath() {
        val t = Terminal(10, 4)
        t.feed("ls /tmp/abcdefghij.pdf ok")
        // The path starts on row 0 and ends on row 2; a tap on row 1 finds it whole.
        val l = Links.at(t, 1, 3)
        assertEquals("/tmp/abcdefghij.pdf", l?.target)
        assertNull(Links.at(t, 0, 0))
    }

    @Test fun aFileUrlIsAPathOfTheMachine() {
        val l = Links.find("file:///home/me/a%20b.txt").single()
        assertEquals("/home/me/a b.txt", Links.asPath(l))
        assertNull(Links.asPath(Links.find("https://dotrino.com/x").single()))
    }

    @Test fun mime() {
        assertEquals("application/pdf", Links.mimeOf("a.PDF"))
        assertEquals("application/octet-stream", Links.mimeOf("Makefile"))
    }
}
