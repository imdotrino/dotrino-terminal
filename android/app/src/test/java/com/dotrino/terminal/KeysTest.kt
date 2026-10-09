package com.dotrino.terminal

import com.dotrino.terminal.term.Keys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the extra key row sends, with its sticky modifiers. */
class KeysTest {
    private val esc = "\u001b"

    @Test fun shiftTabIsBackTab() {
        assertEquals("\t", Keys.named("tab", shift = false, alt = false, app = false))
        assertEquals("$esc[Z", Keys.named("tab", shift = true, alt = false, app = false))
    }

    @Test fun shiftedArrowsCarryTheModifierAlsoInApplicationMode() {
        assertEquals("$esc[A", Keys.named("up", shift = false, alt = false, app = false))
        assertEquals("${esc}OA", Keys.named("up", shift = false, alt = false, app = true))
        assertEquals("$esc[1;2A", Keys.named("up", shift = true, alt = false, app = true))
        assertEquals("$esc[1;2D", Keys.named("left", shift = true, alt = false, app = false))
        assertEquals("$esc[5;2~", Keys.named("pgup", shift = true, alt = false, app = false))
    }

    @Test fun altPrefixesAndUnknownOrUnshiftableKeysSendNothing() {
        assertEquals("$esc$esc[Z", Keys.named("tab", shift = true, alt = true, app = false))
        assertNull(Keys.named("f1", shift = true, alt = false, app = false))
        assertNull(Keys.named("nope", shift = false, alt = false, app = false))
    }

    @Test fun typedTextTakesTheModifiers() {
        assertEquals("A", Keys.text("a", shift = true, ctrl = false, alt = false))
        assertEquals("\u0003", Keys.text("c", shift = false, ctrl = true, alt = false))
        assertEquals("${esc}x", Keys.text("x", shift = false, ctrl = false, alt = true))
    }
}
