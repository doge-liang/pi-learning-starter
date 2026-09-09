#!/usr/bin/env sh
# 把 teach-cn 与 fact-check-cn 装进 pi 的全局技能目录；可选建立学习目录并放入 AGENTS.md。
# 用法：sh scripts/install.sh [学习目录]
# 全局技能目录取 $PI_CODING_AGENT_DIR/skills，未设置时为 ~/.pi/agent/skills（pi 的默认）。
# 只管理 teach-cn 与 fact-check-cn 两个目录（安装前先删除同名旧目录）；学习目录中已有的 AGENTS.md 不覆盖。
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
skills_dir="$agent_dir/skills"
mkdir -p "$skills_dir"

for name in teach-cn fact-check-cn; do
  src="$root/skills/$name"
  dst="$skills_dir/$name"
  [ -f "$src/SKILL.md" ] || { echo "找不到技能源目录：$src" >&2; exit 1; }
  rm -rf "$dst"
  cp -R "$src" "$dst"
  echo "已安装技能 $name -> $dst"
done

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
