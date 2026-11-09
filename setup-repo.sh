#!/usr/bin/env bash
# Run ONCE from inside your fresh clone of the repo (created from skyhook-io/cnh-starter template),
# after copying these scaffold files in. Requires `gh auth login`.
# Protects main, enables merge queue, adds Jake, creates labels and the pinned Board issue.
# Install the Gitar GitHub App manually in the browser after this runs.
set -euo pipefail

JAKE="${1:?usage: ./setup-repo.sh <jake-github-username>}"
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)

echo "→ committing scaffold"
git add -A
git commit -m "chore: scaffolding — AGENTS.md, PROJECT.md, SPEC.md, NOW.md, Gitar review instructions, templates (no product code)" || true
git push

echo "→ adding $JAKE as admin"
gh api -X PUT "repos/$OWNER/$REPO/collaborators/$JAKE" -f permission=admin

echo "→ labels"
for l in "stream:A-brain:1d76db" "stream:B-ui:a371f7" "stream:C-platform:0e8a16" "stream:D-mcp:fbca04"; do
  name="${l%:*}"; color="${l##*:}"
  gh label create "$name" --color "$color" --force
done

echo "→ Board issue"
BOARD_URL=$(gh issue create --title "Board" --body "$(cat <<'EOF'
Team channel. Agents and humans post here.

Format: `<Stream>: <what landed> in #<pr>. Next: <one line>. Blocked: <none|what>`
Tag humans with @. Read every 30 minutes. Posts are ingested into the brain.
EOF
)")
BOARD_NUM="${BOARD_URL##*/}"
gh issue pin "$BOARD_NUM" || echo "   (pin manually: issue #$BOARD_NUM)"
echo "   Board is issue #$BOARD_NUM"

echo "→ branch protection + merge queue on main"
gh api -X PUT "repos/$OWNER/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": [] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true
}
JSON
# Merge queue via repository ruleset (branch protection API doesn't expose it)
gh api -X POST "repos/$OWNER/$REPO/rulesets" --input - <<'JSON'
{
  "name": "main merge queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "merge_queue", "parameters": {
        "merge_method": "SQUASH", "max_entries_to_build": 5, "min_entries_to_merge": 1,
        "max_entries_to_merge": 5, "min_entries_to_merge_wait_minutes": 0,
        "grouping_strategy": "ALLGREEN", "check_response_timeout_minutes": 30 } }
  ]
}
JSON

echo "→ CLAUDE.md → AGENTS.md"
[ -e CLAUDE.md ] && [ ! -L CLAUDE.md ] && mv CLAUDE.md CLAUDE.starter.md
ln -sf AGENTS.md CLAUDE.md
git add -A && git commit -m "chore: CLAUDE.md -> AGENTS.md" && git push

echo
echo "Done. Now:"
echo "  1. Install the Gitar GitHub App on $OWNER/$REPO (browser)."
echo "  2. After CI exists, add its check name to required_status_checks.contexts."
echo "  3. Jake: clone, gh auth login, push a test branch."
echo "  4. Fill NOW.md links. Start PR #1 (types.ts + Elastic indices + /ingest text + /search)."
