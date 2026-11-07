#!/usr/bin/env bash
# Deploy the Apps Script backend, stamping the current git commit as its revision.
# Reuses the same web-app deployment so its URL never changes.
#
# First time: run `npx clasp deploy` once by hand, then save the deployment ID
# it prints in a file called .deployment-id (git-ignored) in the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."

REV=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain backend)" ]; then REV="${REV}-dirty"; fi

printf "// Stamped with the git commit by scripts/deploy-backend.sh at deploy time.\nconst BACKEND_REV = '%s';\n" "$REV" > backend/Version.js
trap 'git checkout -- backend/Version.js' EXIT

npx clasp push --force

if [ -f .deployment-id ]; then
  npx clasp deploy --deploymentId "$(cat .deployment-id)" --description "$REV"
else
  echo "No .deployment-id found: creating a new deployment."
  npx clasp deploy --description "$REV"
fi
echo "Backend deployed at revision $REV"
