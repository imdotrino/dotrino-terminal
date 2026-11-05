package com.dotrino.terminal

import com.dotrino.terminal.term.Unwrap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** «Copiar sin saltos» against the golden vectors the four versions share (`test/unwrap.vectors.json`). */
class UnwrapTest {
    // Gradle runs the unit tests from the module folder (android/app).
    private val vectors: JsonArray = Json.parseToJsonElement(File("../../test/unwrap.vectors.json").readText()) as JsonArray

    @Test
    fun everyVector() {
        assertTrue(vectors.isNotEmpty())
        for (v in vectors) {
            val o = v as JsonObject
            assertEquals(o["name"]!!.jsonPrimitive.content, o["out"]!!.jsonPrimitive.content, Unwrap.unwrap(o["in"]!!.jsonPrimitive.content))
        }
    }
}
