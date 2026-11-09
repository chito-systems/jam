# JAM for iPhone

The phone companion (`apps/web`, phone width) in a native shell. It opens https://jam.cnh.radarhq.io, grants the page the microphone, turns chimes into haptics, and transcribes recordings on the phone so you can read them before you send.

## Install on your iPhone

You need a Mac with Xcode, any Apple ID signed in under Xcode → Settings → Accounts (a free one works), and the phone plugged in with Developer Mode on (Settings → Privacy & Security).

```sh
brew install xcodegen                 # once
cd apps/ios
xcodegen                              # writes JAM.xcodeproj from project.yml
open JAM.xcodeproj
```

In Xcode: select the **JAM** target → **Signing & Capabilities** → pick your own **Team**. If Xcode says the bundle id is taken, change it to something like `com.<you>.jam`. Choose your phone at the top and press **Run**. The first time, the phone asks you to trust the developer: Settings → General → VPN & Device Management.

From the command line, with your team ID (shown in Xcode → Settings → Accounts):

```sh
xcodebuild -project JAM.xcodeproj -scheme JAM -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your team id> PRODUCT_BUNDLE_IDENTIFIER=com.<you>.jam build
```

## Without Xcode

Open https://jam.cnh.radarhq.io in Safari → Share → **Add to Home Screen**. You get the same companion. The only difference is that a recording is read back as audio rather than as text, because on-phone transcription needs the app.

## Use it

Sign in with team code `hh` and your name as the brain knows it. Tap to talk, tap again to stop, read it back, then **Send**.
