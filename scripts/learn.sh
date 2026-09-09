#!/usr/bin/env sh
# 在学习目录里启动 pi，只带本套件的四个技能。用法：sh scripts/learn.sh [学习目录] [pi 参数…]
# 学习目录：第一个参数若是目录则用它，否则取 $PI_LEARN_DIR，再没有则用当前目录；目录里必须已有 AGENTS.md。
# 例：alias learn='sh <本仓库路径>/scripts/learn.sh'，然后 learn 或 learn -c。
set -eu

dir="${PI_LEARN_DIR:-$PWD}"
if [ "${1:-}" != "" ] && [ -d "$1" ]; then
  dir="$1"
  shift
fi
[ -f "$dir/AGENTS.md" ] || { echo "学习目录 $dir 里没有 AGENTS.md：先运行 scripts/install.sh <目录>，或设置 PI_LEARN_DIR" >&2; exit 1; }

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
set -- --no-skills "$@"
for name in teach-cn quiz-cn viz-cn fact-check-cn; do
  p="$agent_dir/skills/$name"
  if [ -f "$p/SKILL.md" ]; then
    set -- "$@" --skill "$p"
  else
    echo "未安装技能 $name（先运行 scripts/install.sh）" >&2
  fi
done

cd "$dir" && exec pi "$@"
