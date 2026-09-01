#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
git_dir="$(git -C "${ROOT}" rev-parse --git-dir)"
[ "${git_dir#/}" != "${git_dir}" ] || git_dir="${ROOT}/${git_dir}"
for hook_name in pre-commit pre-push; do
  source_hook="${ROOT}/scripts/hooks/${hook_name}"
  target_hook="${git_dir}/hooks/${hook_name}"
  mkdir -p "$(dirname "${target_hook}")"
  if [ -e "${target_hook}" ] && ! cmp -s "${source_hook}" "${target_hook}"; then
    cp "${target_hook}" "${target_hook}.pre-joint-bob"
  fi
  cp "${source_hook}" "${target_hook}"
  chmod 755 "${target_hook}"
  printf 'Installed %s\n' "${target_hook}"
done
