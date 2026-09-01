#!/usr/bin/env bash
set -euo pipefail

# One-run push to main. `git push` refuses a deployment whose release notes are
# missing, and the gate writes those notes into the working tree on its way out —
# which is why a plain push always needs a second attempt. Running the gate here
# first means the notes land in their own commit and the push goes out once.

ROOT="$(git rev-parse --show-toplevel)"
REMOTE="${1:-origin}"
GATE="${ROOT}/scripts/changelog-gate.mjs"
BRANCH="$(git -C "${ROOT}" rev-parse --abbrev-ref HEAD)"

if [ "${BRANCH}" != "main" ]; then
  echo "push: on '${BRANCH}'; the release gate only runs for main." >&2
  exit 1
fi

if ! git -C "${ROOT}" diff --quiet -- package.json CHANGELOG.md || ! git -C "${ROOT}" diff --cached --quiet -- package.json CHANGELOG.md; then
  echo "push: commit or discard your package.json and CHANGELOG.md changes first — the gate rewrites both." >&2
  exit 1
fi

git -C "${ROOT}" fetch --quiet "${REMOTE}" main || true
BASE="$(git -C "${ROOT}" rev-parse --verify --quiet "${REMOTE}/main" || echo 0000000000000000000000000000000000000000)"
HEAD_SHA="$(git -C "${ROOT}" rev-parse HEAD)"

if ! node "${GATE}" "${BASE}" "${HEAD_SHA}"; then
  if git -C "${ROOT}" diff --quiet -- package.json CHANGELOG.md; then
    echo "push: the gate blocked the push without writing release notes. Update package.json and CHANGELOG.md by hand." >&2
    exit 1
  fi
  VERSION="$(node -p "require('${ROOT}/package.json').version")"
  git -C "${ROOT}" add package.json CHANGELOG.md
  git -C "${ROOT}" commit -q -m "chore(release): ${VERSION}"
  HEAD_SHA="$(git -C "${ROOT}" rev-parse HEAD)"
  # --check re-reads the committed files without asking Claude for a second draft.
  node "${GATE}" "${BASE}" "${HEAD_SHA}" --check
fi

git -C "${ROOT}" push "${REMOTE}" main
