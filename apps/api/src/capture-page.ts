// Bootstrap capture page: a zero-design stopgap served by the API at /c so the team can start
// capturing before apps/web ships /capture. Deleted once stream B's page is live.
// The page itself lives in capture.html (inline CSS + vanilla JS, no build step).
import { readFileSync } from "node:fs";

export const CAPTURE_PAGE_HTML: string = readFileSync(new URL("./capture.html", import.meta.url), "utf8");
