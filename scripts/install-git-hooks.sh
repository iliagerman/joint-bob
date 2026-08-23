#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
git_dir="$(git -C "${ROOT}" rev-parse --git-dir)"
[ "${git_dir#/}" != "${git_dir}" ] || git_dir="${ROOT}/${git_dir}"
source_hook="${ROOT}/scripts/hooks/pre-push"
target_hook="${git_dir}/hooks/pre-push"
mkdir -p "$(dirname "${target_hook}")"
if [ -e "${target_hook}" ] && ! cmp -s "${source_hook}" "${target_hook}"; then
  cp "${target_hook}" "${target_hook}.pre-joint-bob"
fi
cp "${source_hook}" "${target_hook}"
chmod 755 "${target_hook}"
printf 'Installed %s\n' "${target_hook}"
