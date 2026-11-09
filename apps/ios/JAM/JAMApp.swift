import AVFoundation
import SwiftUI

/// JAM on iPhone: the web workspace full screen, with the microphone allowed for hold to talk.
/// If the server can't be reached, a native screen asks for its address and keeps it.
@main
struct JAMApp: App {
    init() {
        // Recording mutes haptics by default; hold to talk wants the tap felt.
        try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)
    }

    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    @AppStorage("server") private var server = Server.defaultURL
    @State private var editing = false
    @State private var failure: String?

    var body: some View {
        ZStack {
            Color("Paper").ignoresSafeArea()
            if let url = URL(string: server), !editing {
                JamWebView(url: url, failure: $failure)
                    .ignoresSafeArea()
            }
            if editing || failure != nil {
                ServerSheet(server: $server, failure: failure) {
                    failure = nil
                    editing = false
                }
            }
        }
    }
}

enum Server {
    static let defaultURL = "https://computer100.tail75f6b5.ts.net"
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
                Text("Is the laptop running JAM, and is this phone on Tailscale or the same Wi-Fi?")
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
