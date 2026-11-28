#!/usr/bin/env bash
# 印出 package.json 的版本號;帶 git ref(例如 HEAD^1)時讀那個版本的檔案。
# 給 CI 的「版本說明」檢查與 Release workflow 共用。
set -euo pipefail

ref="${1:-}"
if [ -n "$ref" ]; then
  content="$(git show "$ref:package.json")"
else
  content="$(cat package.json)"
fi
version="$(printf '%s' "$content" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "package.json 的 version 不是語意化版本(x.y.z):'$version'" >&2
  exit 1
fi
printf '%s\n' "$version"
