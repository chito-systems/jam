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

`public/` holds the manifest and icons. They are drawn from the `jam` mark in `src/ade/Mark.tsx`. To redraw them:

```sh
node apps/web/scripts/icons.mjs /tmp/jam-icons
cp /tmp/jam-icons/favicon.svg apps/web/public/
sips -s format png -z 512 512 /tmp/jam-icons/icon.svg --out apps/web/public/icon-512.png
sips -s format png -z 192 192 /tmp/jam-icons/icon.svg --out apps/web/public/icon-192.png
sips -s format png -z 512 512 /tmp/jam-icons/icon-maskable.svg --out apps/web/public/icon-maskable-512.png
sips -s format png -z 180 180 /tmp/jam-icons/apple-touch-icon.svg --out apps/web/public/apple-touch-icon.png
```
