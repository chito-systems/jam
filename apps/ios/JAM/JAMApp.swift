import AVFoundation
import SwiftUI

/// JAM on iPhone: the web workspace full screen, with the microphone allowed for talk.
/// While the page loads, a native JAM screen shows; if the server can't be reached after
/// quiet retries, a native screen asks for its address and keeps it.
@main
struct JAMApp: App {
    init() {
        // Set the session up for recording once, at launch: switching category when the mic
        // opens mid-tap is what stalls or silences the first moment of a recording.
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? s.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try? s.setActive(true)
    }

    var body: some Scene {
        WindowGroup { RootView() }
    }
}

enum Server {
    static let defaultURL = "https://computer100.tail75f6b5.ts.net"
}

struct RootView: View {
    @AppStorage("server") private var server = Server.defaultURL
    @State private var editing = false
    @State private var failure: String?
    @State private var loaded = false
    @State private var attempt = 0

    var body: some View {
        ZStack {
            Color("Paper").ignoresSafeArea()
            if let url = URL(string: server), !editing {
                JamWebView(url: url, failure: $failure, loaded: $loaded, attempt: $attempt)
                    .ignoresSafeArea()
                    .opacity(loaded ? 1 : 0)
            }
            if !loaded && failure == nil && !editing {
                Connecting(attempt: attempt)
            }
            if editing || failure != nil {
                ServerSheet(server: $server, failure: failure) {
                    failure = nil
                    editing = false
                    loaded = false
                    attempt = 0
                }
            }
        }
    }
}

/// What shows while the page loads: the wordmark, and after a few tries, why it's slow.
struct Connecting: View {
    let attempt: Int

    var body: some View {
        VStack(spacing: 10) {
            Text("JAM").font(.system(size: 40, weight: .heavy)).tracking(-1.2)
            Text(attempt < 2 ? "Connecting…" : "Waiting for Tailscale…")
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
        }
    }
}

/// Where JAM lives: shown when the server can't be reached.
struct ServerSheet: View {
    @Binding var server: String
    let failure: String?
    let done: () -> Void
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("JAM").font(.system(size: 34, weight: .heavy))
            if let failure {
                Text("Can't reach \(server)").font(.headline)
                Text(failure).font(.subheadline).foregroundStyle(.secondary)
                Text("Open the Tailscale app and check it's connected, and that the laptop is running JAM.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            Text("SERVER").font(.caption.monospaced()).foregroundStyle(.secondary)
            TextField("https://…", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .padding(12)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(.primary, lineWidth: 1))
            Button {
                let t = draft.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { server = t.contains("://") ? t : "https://\(t)" }
                done()
            } label: {
                Text(failure == nil ? "Open" : "Try again").frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(.primary)
            Spacer()
        }
        .padding(24)
        .background(Color("Paper"))
        .onAppear { draft = server }
    }
}
