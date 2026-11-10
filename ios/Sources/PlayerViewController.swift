import UIKit
import WebKit

/// YouTube Music in a WebView, with the same page script as the Android app
/// (ad removal, SponsorBlock, no "Are you still there?", green Update button).
final class PlayerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static let home = URL(string: "https://music.youtube.com/")!
    private static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

    private var web: WKWebView!
    private let updater = Updater()
    private var isPlaying = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true

        let content = config.userContentController
        content.add(WeakMessageHandler(self), contentWorld: .page, name: "tb")
        // The page script patches the page's own JavaScript, so it must run in the page world, before YouTube's scripts.
        content.addUserScript(WKUserScript(source: Self.bridgeShim + "\n" + Self.pageScript(),
                                           injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true,
                                           in: .page))

        web = WKWebView(frame: .zero, configuration: config)
        web.customUserAgent = Self.userAgent
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // Block ad and tracking servers, then load the page.
        AdBlocker.install(into: content) { [weak self] in
            self?.web.load(URLRequest(url: Self.home))
        }

        updater.onChange = { [weak self] in self?.pushUpdateState() }
        updater.start()

        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    // MARK: - Page script

    /// The Android app talks to the page through window.TBAndroid; give the page the same API here.
    private static let bridgeShim = """
    window.TBAndroid = {
      onState: function (s) { window.webkit.messageHandlers.tb.postMessage({ type: 'state', json: s }); },
      requestSegments: function (id) { window.webkit.messageHandlers.tb.postMessage({ type: 'segments', id: id }); },
      installUpdate: function () { window.webkit.messageHandlers.tb.postMessage({ type: 'update' }); },
      updateState: function () { return window.__tbUpdateStateCache || '{}'; }
    };
    """

    private static func pageScript() -> String {
        guard let url = Bundle.main.url(forResource: "inject", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return js
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "state":
            if let json = body["json"] as? String,
               let data = json.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                isPlaying = obj["playing"] as? Bool ?? false
            }
        case "segments":
            if let id = body["id"] as? String { loadSegments(for: id) }
        case "update":
            updater.openReleasePage()
        default:
            break
        }
    }

    private func pushUpdateState() {
        let json = updater.stateJSON()
        let literal = (try? String(data: JSONSerialization.data(withJSONObject: [json], options: []), encoding: .utf8))
            .map { String($0.dropFirst().dropLast()) } ?? "'{}'"
        web.evaluateJavaScript("window.__tbUpdateStateCache = \(literal); window.__tbUpdate && window.__tbUpdate(\(json));")
    }

    // MARK: - SponsorBlock

    private func loadSegments(for videoId: String) {
        guard videoId.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil,
              let url = URL(string: "https://sponsor.ajay.app/api/skipSegments?videoID=\(videoId)&categories=%5B%22music_offtopic%22%5D")
        else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            var list = "[]"
            if (response as? HTTPURLResponse)?.statusCode == 200, let data,
               let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                let segments: [[String: Double]] = items.compactMap { item in
                    guard let seg = item["segment"] as? [Double], seg.count == 2 else { return nil }
                    return ["start": seg[0], "end": seg[1]]
                }
                if let out = try? JSONSerialization.data(withJSONObject: segments), let s = String(data: out, encoding: .utf8) {
                    list = s
                }
            }
            DispatchQueue.main.async {
                self?.web.evaluateJavaScript("window.__tbSegments && window.__tbSegments('\(videoId)', \(list));")
            }
        }.resume()
    }

    // MARK: - Background play

    /// iOS may pause web video when the app goes to the background; nudge it to keep playing.
    @objc private func didEnterBackground() {
        guard isPlaying else { return }
        for delay in [0.3, 1.0, 2.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.web.evaluateJavaScript("(function(){var v=document.querySelector('video'); if (v && v.paused) { v.play(); }})();")
            }
        }
    }

    // MARK: - Navigation

    private static func isInternal(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        let allowed = ["youtube.com", "google.com", "gstatic.com", "googleusercontent.com", "youtube-nocookie.com", "ggpht.com", "ytimg.com"]
        return allowed.contains { host == $0 || host.hasSuffix("." + $0) } || host.hasPrefix("accounts.google.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "blob" || scheme == "data" { return decisionHandler(.allow) }
        if (scheme == "https" || scheme == "http") && Self.isInternal(url) {
            // Signed in on the YouTube home page? Go back to Music.
            if url.host == "www.youtube.com" && (url.path.isEmpty || url.path == "/") {
                decisionHandler(.cancel)
                webView.load(URLRequest(url: Self.home))
                return
            }
            return decisionHandler(.allow)
        }
        if navigationAction.targetFrame?.isMainFrame ?? true, scheme == "https" || scheme == "http" {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    // Links that want a new window open in the same view (or in Safari if they leave YouTube).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if Self.isInternal(url) { webView.load(URLRequest(url: url)) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload() // iOS killed the page in the background; bring it back
    }
}

/// Avoids a retain cycle between the WebView and its message handler.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
