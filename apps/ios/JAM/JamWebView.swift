import SwiftUI
import WebKit

struct JamWebView: UIViewRepresentable {
    let url: URL
    @Binding var failure: String?
    @Binding var loaded: Bool
    @Binding var attempt: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()  // keeps team code and name between launches
        let web = WKWebView(frame: .zero, configuration: config)
        config.userContentController.add(context.coordinator, name: "jam")
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "Paper")
        web.scrollView.backgroundColor = UIColor(named: "Paper")
        // The page lays itself out around the notch and home bar with env(safe-area-inset-*).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        #if DEBUG
        web.isInspectable = true
        #endif
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.reload(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
        web.load(URLRequest(url: url, timeoutInterval: 8))
        context.coordinator.web = web
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if web.url?.host != url.host { web.load(URLRequest(url: url)) }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let parent: JamWebView
        weak var web: WKWebView?
        init(_ parent: JamWebView) { self.parent = parent }

        // The page posts {haptic: <chime name>} from chime.ts; each chime is also felt.
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let name = body["haptic"] as? String else { return }
            switch name {
            case "start": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "cancel": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case "sent", "done": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            default: break
            }
        }

        @objc func reload(_ sender: UIRefreshControl) {
            web?.reload()
            sender.endRefreshing()
        }

        // Hold to talk: the page asks for the mic; the app's own permission prompt already covers it.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(type == .microphone ? .grant : .deny)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.failure = nil
            parent.loaded = true
            parent.attempt = 0
        }

        /// Tailscale on iOS often needs a few seconds to come back after the app opens, so a
        /// failed load retries quietly (about 20 s) before the app says it can't reach the server.
        private func fail(_ error: Error) {
            let e = error as NSError
            if e.code == NSURLErrorCancelled { return }
            if parent.attempt < 10 {
                parent.attempt += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self, let web = self.web else { return }
                    web.load(URLRequest(url: self.parent.url, timeoutInterval: 8))
                }
                return
            }
            parent.failure = e.localizedDescription
        }

        // The web content process can be killed in the background (memory); reload instead of a blank page.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // Links that leave JAM open in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let u = action.request.url, action.navigationType == .linkActivated, u.host != parent.url.host {
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
