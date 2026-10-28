package com.dotrino.terminal

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import com.dotrino.terminal.term.Links
import java.io.File
import java.io.FileNotFoundException

/**
 * Los archivos traídos de la máquina (un toque sobre una ruta de la consola, «Abrir» o
 * «Compartir»): se guardan en la caché de la app, en una carpeta propia, y se le pasan a la app
 * que el usuario elija por este proveedor, que solo enseña esa carpeta y solo para leer.
 *
 * Un proveedor propio y no el FileProvider de androidx: la app no trae androidx (CONVENCIONES
 * §16.2), y lo que hace falta son cuarenta líneas.
 *
 * Solo se guarda el último: al traer otro, los anteriores se borran, así la caché no crece.
 */
object FetchedFiles {
    private const val DIR = "fetched"

    fun authority(context: Context) = "${context.packageName}.files"

    fun dir(context: Context) = File(context.cacheDir, DIR)

    /** Saves [f] (and deletes what was there before). Blocking: call it off the main thread. */
    fun save(context: Context, f: Fetched): Uri {
        val name = f.name
        if (name.isEmpty() || name == "." || name == ".." || name.contains('/') || name.contains('\u0000')) {
            throw IllegalArgumentException("bad-name: the machine sent a file name that cannot be saved: $name")
        }
        val dir = dir(context)
        dir.listFiles()?.forEach { it.deleteRecursively() }
        if (!dir.isDirectory && !dir.mkdirs()) throw java.io.IOException("could not create ${dir.path}")
        File(dir, name).writeBytes(f.bytes)
        return Uri.Builder().scheme("content").authority(authority(context)).appendPath(name).build()
    }

    /** The file of [uri], only if it is inside the folder. */
    internal fun fileOf(context: Context, uri: Uri): File {
        val name = uri.lastPathSegment ?: throw FileNotFoundException("no file in $uri")
        val dir = dir(context).canonicalFile
        val file = File(dir, name).canonicalFile
        if (file.parentFile != dir || !file.isFile) throw FileNotFoundException("not a fetched file: $uri")
        return file
    }
}

/** Gives the apps the user picks read access to [FetchedFiles], and nothing else. */
class FetchedFilesProvider : ContentProvider() {
    override fun onCreate() = true

    private fun ctx(): Context = context ?: throw IllegalStateException("provider without a context")

    override fun getType(uri: Uri): String = Links.mimeOf(uri.lastPathSegment.orEmpty())

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("fetched files are read-only (asked: $mode)")
        return ParcelFileDescriptor.open(FetchedFiles.fileOf(ctx(), uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val file = FetchedFiles.fileOf(ctx(), uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val row = cols.map { when (it) { OpenableColumns.DISPLAY_NAME -> file.name; OpenableColumns.SIZE -> file.length(); else -> null } }
        return MatrixCursor(cols, 1).apply { addRow(row) }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("read-only")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("read-only")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("read-only")
}
