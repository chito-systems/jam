# JAM web app

The JAM interface: Vite + React. In the cluster the API (`apps/api`) serves this build from `apps/web/dist`.

## Run it locally

From the repo root, in two terminals:

```sh
STORE=memory pnpm dev:api            # the API on :3000, no credentials needed
pnpm --filter @hh/web dev            # the app on http://localhost:5173 (proxies /api, /mcp, /c to :3000)
```

Add `VITE_SEED=true` to the second command to load the labelled sample workspace.

## Install it as an app

Open https://jam.cnh.radarhq.io (installing needs HTTPS or localhost), then:

- **Chrome or Edge:** the install icon at the right of the address bar, or menu → Cast, save and share → Install page as app (Edge: Apps → Install this site as an app).
- **Safari (macOS 14+):** File → Add to Dock.

JAM then opens in its own window with its own Dock icon.

## Updates

There is no service worker and nothing is cached offline: merge to `main` → the cluster deploys → an installed copy shows the new build the next time it loads (reopen it, or Cmd+R).

## Icons

`public/` holds the manifest and icons: the `jam` mark from `src/ade/Mark.tsx`, pink ink on paper.
