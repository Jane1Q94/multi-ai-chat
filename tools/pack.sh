#!/bin/sh
# 打出可以直接「加载已解压的扩展程序」或上传应用商店的制品。
# 只装运行时要的东西：manifest + src。调试脚本、截图、制品自己都不进包。
set -e
cd "$(dirname "$0")/.."

version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' manifest.json)
[ -n "$version" ] || { echo "manifest.json 里读不到 version" >&2; exit 1; }

out="dist/multi-ai-chat-$version.zip"
mkdir -p dist
rm -f "$out"
zip -rq "$out" manifest.json src -x '*.DS_Store'
echo "$out"
