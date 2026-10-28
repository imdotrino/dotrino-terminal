import QuickLook
import UIKit

/// A file brought from the machine, shown on the phone: QuickLook (which also offers sharing and
/// «open in» another app), or the share sheet straight away. Native, no WebView (§16.2).
enum FileOpen {
    /// QuickLook's data source: the controller keeps it weakly, so it is kept here while shown.
    private final class Source: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(_ url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
    @MainActor private static var source: Source?

    /// False when there is nowhere to show it (the view is not on screen).
    @MainActor static func preview(_ url: URL, from view: UIView) -> Bool {
        guard let host = top(view) else { return false }
        let s = Source(url)
        source = s
        let ql = QLPreviewController()
        ql.dataSource = s
        host.present(ql, animated: true)
        return true
    }

    /// The share sheet with the file. On the iPad it hangs from the point that was tapped.
    @MainActor static func share(_ url: URL, from view: UIView, at p: CGPoint) -> Bool {
        guard let host = top(view) else { return false }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = view
        vc.popoverPresentationController?.sourceRect = CGRect(x: p.x, y: p.y, width: 1, height: 1)
        host.present(vc, animated: true)
        return true
    }

    /// What is on top now: a sheet, if one is open, presents over it.
    @MainActor private static func top(_ view: UIView) -> UIViewController? {
        var vc = view.window?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        return vc
    }
}
