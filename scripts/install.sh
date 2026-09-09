#!/usr/bin/env sh
# 把仓库 skills/ 下的全部技能装进 pi 的全局技能目录，把 extensions/ 下的用户级扩展装进全局扩展目录并
# 安装其 npm 依赖；可选建立学习目录并放入 AGENTS.md。用法：sh scripts/install.sh [学习目录]
# 全局目录取 $PI_CODING_AGENT_DIR，未设置时为 ~/.pi/agent（pi 的默认）。设 NO_EXTENSIONS=1 只装技能。
# 只管理与仓库 skills/、extensions/ 同名的目录（安装前先删除同名旧目录）；学习目录中已有的 AGENTS.md 不覆盖。
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
skills_dir="$agent_dir/skills"
mkdir -p "$skills_dir"

for src in "$root"/skills/*/; do
  src="${src%/}"
  name="$(basename "$src")"
  dst="$skills_dir/$name"
  [ -f "$src/SKILL.md" ] || { echo "找不到技能源目录：$src" >&2; exit 1; }
  rm -rf "$dst"
  cp -R "$src" "$dst"
  echo "已安装技能 $name -> $dst"
done

if [ "${NO_EXTENSIONS:-}" = "" ]; then
  ext_dir="$agent_dir/extensions"
  mkdir -p "$ext_dir"
  for src in "$root"/extensions/*/; do
    src="${src%/}"
    name="$(basename "$src")"
    dst="$ext_dir/$name"
    rm -rf "$dst"
    cp -R "$src" "$dst"
    echo "已安装扩展 $name -> $dst"
    if [ -f "$dst/package.json" ]; then
      # 扩展的 npm 依赖装在扩展目录里；失败只提示，不中断
      (cd "$dst" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1) \
        && echo "  已安装 $name 的依赖" \
        || echo "  $name 的依赖安装失败；稍后可在 $dst 手动执行 npm install" >&2
    fi
  done
fi

if [ "${1:-}" != "" ]; then
  learn="$1"
  mkdir -p "$learn/maps" "$learn/sessions" "$learn/attachments"
  if [ -f "$learn/AGENTS.md" ]; then
    echo "已存在 $learn/AGENTS.md，未覆盖"
  else
    cp "$root/AGENTS.md" "$learn/AGENTS.md"
    echo "已写入 $learn/AGENTS.md"
  fi
  echo "学习目录就绪：$learn。在该目录中运行 pi（pi 只向上查找 AGENTS.md，不要在库根启动）。"
fi

echo "完成。若 pi 正在运行，执行 /reload 使技能生效。"
