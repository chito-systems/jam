# JAM desktop

A native macOS app for JAM: an Electron window around the hosted web app (`https://jam.cnh.radarhq.io`), so the UI updates with every deploy. `Cmd+R` reloads.

- `npm install && npm start`: run it. `JAM_URL=http://localhost:3000 npm start` points it at a local server.
- `npm run package`: builds `out/JAM-darwin-arm64/JAM.app` (bundle id `dev.jam.desktop`).
- Microphone: allowed for the JAM origin only. The first launch shows the macOS prompt, so click Allow.
- Terminal tab: when the app runs from a clone (or `JAM_REPO` is set), it starts `pnpm --filter @hh/web bridge` on `127.0.0.1:4317` and stops it on quit. If a bridge is already running, it leaves that one alone.
- Links to other sites open in your default browser.

This folder has its own npm lockfile and sits outside the pnpm workspace, so CI never installs Electron.
