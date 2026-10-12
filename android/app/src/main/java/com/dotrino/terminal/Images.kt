package com.dotrino.terminal

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * An image of this phone, ready to go to the machine ([Consoles.Tab.sendImage]).
 *
 * A phone's photo weighs several MB and whatever runs in the console does not need that much: it
 * is reduced HERE, before it leaves. An image that is already small and of a kind the machine
 * keeps goes as it is, without recompressing (a screenshot with text reads worse recompressed).
 * The same rules as the PWA (src/image.js).
 */
object Images {
    /** The longest side of an image that had to be reduced. */
    const val MAX_SIDE = 2000
    /** Below this, an image of a kind the machine keeps goes untouched. */
    const val AS_IS_BYTES = 1024 * 1024
    /** The kinds the machine keeps (agent/uploads.js). */
    val TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
    /** Nothing bigger than this is even read: it is not a photo. */
    private const val READ_MAX = 64 * 1024 * 1024

    class NotAnImage(message: String) : Exception(message)

    fun goesAsIs(type: String?, size: Int) = type in TYPES && size <= AS_IS_BYTES

    /** What a [w]×[h] image measures so its longest side is not over [max]. Never enlarged. */
    fun fitSide(w: Int, h: Int, max: Int = MAX_SIDE): Pair<Int, Int> {
        val k = minOf(1.0, max.toDouble() / max(w, h))
        return max(1, (w * k).roundToInt()) to max(1, (h * k).roundToInt())
    }

    /** The bytes to send. Off the main thread: it reads and may decode a large photo. */
    fun prepare(resolver: ContentResolver, uri: Uri): ByteArray {
        val type = resolver.getType(uri)
        if (type != null && !type.startsWith("image/")) throw NotAnImage("not an image: $type")
        val raw = resolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf); if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > READ_MAX) throw NotAnImage("too large to be read")
            }
            out.toByteArray()
        } ?: throw NotAnImage("could not be opened")
        if (raw.isEmpty()) throw NotAnImage("empty")
        if (goesAsIs(type, raw.size)) return raw
        // ImageDecoder applies the photo's orientation by itself (a camera picture is stored sideways).
        val bitmap = try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(raw))) { decoder, info, _ ->
                val (w, h) = fitSide(info.size.width, info.size.height)
                decoder.setTargetSize(w, h)
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } catch (e: Exception) { throw NotAnImage(e.message ?: "could not be decoded") }
        // White behind: JPEG has no transparency, and without this what is transparent comes out black.
        val flat = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
        Canvas(flat).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
        val out = ByteArrayOutputStream()
        flat.compress(Bitmap.CompressFormat.JPEG, 85, out)
        bitmap.recycle(); flat.recycle()
        return out.toByteArray()
    }

    /** The path as it is typed into the console: quoted when it has something the shell would split. */
    fun typedPath(path: String): String =
        if (Regex("^[\\w@%+=:,./-]+$").matches(path)) path else "'" + path.replace("'", "'\\''") + "'"
}
