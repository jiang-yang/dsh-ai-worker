#!/usr/bin/env bash
# 把「AI 打工人」作为标准 DSH 插件安装进指定 profile。
#
# 本包自带 cordis.patch.yml（package.json 的 dsh.bundle.patch 指向它），
# 用 DSH 官方 CLI 装包即可自动登记装载行，不需要手工改 profile 的 cordis.patch.yml。
#
# 用法：
#   bash install.sh                        # 默认 profile：web
#   DSH_PROFILE=desktop bash install.sh    # 指定 profile（桌面版 DSH 用 desktop）
#   DSH_BIN=/path/to/dsh bash install.sh   # 手动指定 dsh CLI
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
echo "安装源  : $HERE"
echo
"$DSH_BIN" plugin --profile "$PROFILE" add "$HERE"
echo
echo "安装完成。刷新 DSH Web 页面即可看到右下角的 AI 打工人；若未出现，重启 DSH 进程。"
