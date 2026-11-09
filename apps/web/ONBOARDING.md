# Setting up JAM

Two minutes, six steps. The same checklist is in the app: press the **?** in the header, or ⌘K → "Open the setup guide". There every step shows whether it is done on your machine.

1. **Sign in.** Open JAM and enter the team code and your name. The team code is whatever your team agreed on; it must be the same on every laptop and in your agent's MCP URL, or you will be looking at a different brain. Your name is how the brain labels what you say.

2. **Install JAM as an app.** Chrome or Edge: the install icon at the right of the address bar. Safari: File → Add to Dock. An installed copy picks up each merge the next time it loads.

3. **Turn on the microphone.** Allow it when the browser asks (the guide has a button for it). It only works on https or localhost. Then hold **Talk** or ⌥Space, let go to send; Esc cancels.

4. **Say or write one thing.** Hold Talk and say what you are working on, or type it in the note box under the feed. It is done when it shows up in the feed.

5. **Connect your coding agent.** Run once per laptop, with your JAM address, team code, name and side (`frontend` or `backend`):

   ```sh
   claude mcp add hack-harness-context --scope user --transport http \
     "https://<jam-address>/mcp?team_id=<team code>&who=<your name>-agent&side=<frontend|backend>"
   ```

   URL-encode anything unusual in the team code or name; `who` can be at most 56 characters. The guide builds this command for you with Copy. Your agent can then search the brain, read recent context and decisions, add notes, and claim tasks. It counts as connected once it has added a note or claimed a task.

6. **Open a terminal here.** The Terminal tab talks to a small bridge that opens a shell on this computer only. Start it from the repo:

   ```sh
   pnpm --filter @hh/web bridge
   ```

Shortcuts: ⌘K commands, ⌥Space talk, / search the brain, j k move between tasks, Esc cancel.
