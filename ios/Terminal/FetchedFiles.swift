import QuickLook
import UIKit

/// Los archivos traídos de la máquina (un toque sobre una ruta de la consola, «Abrir» o
/// «Compartir»): se guardan en la caché de la app, en una carpeta propia, y se enseñan con la
/// vista previa del sistema o se le pasan a la app que el usuario elija en la hoja de compartir.
///
/// Solo se guarda el último: al traer otro, los anteriores se borran, así la caché no crece.
@MainActor
enum FetchedFiles {
    struct BadName: Error { let name: String }

    private static var preview: Preview?

    private final class Preview: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(_ url: URL) { self.url = url }
        func numberOfPreviewItems(in c: QLPreviewController) -> Int { 1 }
        func previewController(_ c: QLPreviewController, previewItemAt i: Int) -> QLPreviewItem { url as NSURL }
    }

    /// Saves `f` (and deletes what was there before).
    nonisolated static func save(_ f: Fetched) throws -> URL {
        let name = f.name
        if name.isEmpty || name == "." || name == ".." || name.contains("/") || name.contains("\0") { throw BadName(name: name) }
        let fm = FileManager.default
        let dir = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("fetched", isDirectory: true)
        if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try f.bytes.write(to: url, options: .atomic)
        return url
    }

    private static func top() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var c = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        while let next = c?.presentedViewController { c = next }
        return c
    }

    /// The system's preview of the file; it brings its own button to share it.
    static func open(_ url: URL) -> Bool {
        guard let from = top() else { return false }
        let source = Preview(url)
        preview = source
        let c = QLPreviewController()
        c.dataSource = source
        from.present(c, animated: true)
        return true
    }

    /// The system's sheet to send the file to another app.
    static func share(_ url: URL, from view: UIView?) -> Bool {
        guard let from = top() else { return false }
        let c = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // On an iPad the sheet needs something to hang from.
        c.popoverPresentationController?.sourceView = view ?? from.view
        c.popoverPresentationController?.sourceRect = (view ?? from.view).bounds
        from.present(c, animated: true)
        return true
    }
}
