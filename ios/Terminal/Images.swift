import UIKit

/// An image of this phone, ready to go to the machine (`Tab.sendImage`).
///
/// A phone's photo weighs several MB and whatever runs in the console does not need that much: it
/// is reduced HERE, before it leaves. An image that is already small and of a kind the machine
/// keeps goes as it is, without recompressing (a screenshot with text reads worse recompressed).
/// The same rules as the PWA (src/image.js) and Android (`Images.kt`).
enum Images {
    /// The longest side of an image that had to be reduced.
    static let maxSide = 2000
    /// Below this, an image of a kind the machine keeps goes untouched.
    static let asIsBytes = 1024 * 1024

    struct NotAnImage: Error {}

    /// The kind of an image by its first bytes, if it is one the machine keeps (agent/uploads.js).
    static func kept(_ d: Data) -> String? {
        let b = [UInt8](d.prefix(12))
        if b.count >= 8, Array(b[0..<8]) == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] { return "png" }
        if b.count >= 3, b[0] == 0xff, b[1] == 0xd8, b[2] == 0xff { return "jpg" }
        if b.count >= 6, let s = String(bytes: b[0..<6], encoding: .ascii), s == "GIF87a" || s == "GIF89a" { return "gif" }
        if b.count >= 12, String(bytes: b[0..<4], encoding: .ascii) == "RIFF", String(bytes: b[8..<12], encoding: .ascii) == "WEBP" { return "webp" }
        return nil
    }

    static func goesAsIs(_ d: Data) -> Bool { kept(d) != nil && d.count <= asIsBytes }

    /// What a `w`×`h` image measures so its longest side is not over `max`. Never enlarged.
    static func fitSide(_ w: Int, _ h: Int, max side: Int = maxSide) -> (w: Int, h: Int) {
        let k = min(1.0, Double(side) / Double(max(w, h)))
        return (max(1, Int((Double(w) * k).rounded())), max(1, Int((Double(h) * k).rounded())))
    }

    /// The bytes to send.
    static func prepare(_ d: Data) throws -> Data {
        if d.isEmpty { throw NotAnImage() }
        if goesAsIs(d) { return d }
        guard let image = UIImage(data: d), image.size.width > 0, image.size.height > 0 else { throw NotAnImage() }
        // In pixels: `size` is in points of the image's own scale.
        let fit = fitSide(Int(image.size.width * image.scale), Int(image.size.height * image.scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        // Opaque, white behind: JPEG has no transparency. Drawing also applies the photo's orientation.
        format.opaque = true
        let size = CGSize(width: fit.w, height: fit.h)
        let flat = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let out = flat.jpegData(compressionQuality: 0.85) else { throw NotAnImage() }
        return out
    }

    /// The path as it is typed into the console: quoted when it has something the shell would split.
    static func typedPath(_ path: String) -> String {
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-")
        if !path.isEmpty, path.unicodeScalars.allSatisfy({ safe.contains($0) }) { return path }
        return "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
