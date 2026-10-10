#!/usr/bin/env bash
# 从 profile 中卸载「AI 打工人」插件（移除 node_modules 里的包与 bundles 登记）。
#
# 用法：
#   bash uninstall.sh                        # 默认 profile：web
#   DSH_PROFILE=desktop bash uninstall.sh    # 指定 profile
#   DSH_BIN=/path/to/dsh bash uninstall.sh   # 手动指定 dsh CLI
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"

DSH_BIN="${DSH_BIN:-}"
if [ -z "$DSH_BIN" ]; then DSH_BIN="$(command -v dsh || true)"; fi
if [ -z "$DSH_BIN" ]; then
	for c in \
		"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
		"$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
	do
		if [ -x "$c" ]; then DSH_BIN="$c"; break; fi
	done
fi
if [ -z "$DSH_BIN" ]; then
	echo "找不到 dsh CLI。请用 DSH_BIN=/path/to/dsh 指定后重试。" >&2
	exit 1
fi

echo "dsh CLI : $DSH_BIN"
echo "profile : $PROFILE"
"$DSH_BIN" plugin --profile "$PROFILE" remove dsh-ai-worker
echo "卸载完成，刷新页面即可。"
