#!/usr/bin/env bash
# Point this repo at your team's namespace and your GitHub repo.
#   ./scripts/setup.sh <team-name>
# The team name is the one the Radar table gave you: your namespace is
# team-<team-name> and your URL is https://<team-name>.cnh.radarhq.io.
# Adapted from skyhook-io/cnh-starter; fills __TEAM__ and OWNER/REPO in
# deploy/ (including deploy/RADAR.md) and argocd/.
set -euo pipefail

team="${1:-}"
if [[ ! "$team" =~ ^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$ ]]; then
  echo "usage: $0 <team-name>   (lowercase letters, digits and dashes, up to 20 characters)" >&2
  exit 1
fi

remote="$(git remote get-url origin 2>/dev/null || true)"
repo="$(printf '%s' "$remote" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Couldn't read your GitHub repo from 'git remote get-url origin' (got: ${remote:-nothing})." >&2
  exit 1
fi
repo_lower="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"

files=$(grep -rl -e __TEAM__ -e OWNER/REPO deploy argocd || true)
for f in $files; do
  if [ "$f" = deploy/kustomization.yaml ]; then
    # The image lines here belong to the GitHub Action, which sets them on every
    # build. Leaving them alone keeps setup from conflicting with its commits.
    sed -i.bak -e "s#__TEAM__#${team}#g" "$f"
  else
    # GHCR image names must be lowercase; the git URL keeps its case.
    sed -i.bak -e "s#ghcr.io/OWNER/REPO#ghcr.io/${repo_lower}#g" \
               -e "s#OWNER/REPO#${repo}#g" \
               -e "s#__TEAM__#${team}#g" "$f"
  fi
  rm -f "$f.bak"
done

cat <<EOF
Done. Your cluster is ${team} in Radar Cloud (the app runs in namespace team-${team} inside it),
and your URL is https://${team}.cnh.radarhq.io.

Next:
  1. Commit this on a branch and land it through a PR (main is protected; see AGENTS.md).
     The deploy Action builds the image and pushes it to ghcr.io/${repo_lower}.
  2. Once the first build finishes, check the image is public: on the repo's GitHub page, open
     Packages and the image. If it says Private: Package settings > Change visibility > Public.
  3. Create the app Secret once (deploy/RADAR.md, "Creating the app Secret").
  4. Connect your agent to Radar, once. For Claude Code:
       claude mcp add --scope user radar-cloud --transport http https://api.radarhq.io/mcp
     Then run /mcp, pick radar-cloud, Authenticate, and choose Cloud Native Hackathon.
  5. Apply argocd/application.yaml once (Radar apply_resource) to start the GitOps sync.
EOF
