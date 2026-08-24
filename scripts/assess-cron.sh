#!/usr/bin/env sh
# 定时生成复盘测试（无人值守）。作答仍由学习者在交互模式中完成（/learn 建议会列出待作答的测试）。
# crontab 示例（每周一、四 20:00）：
#   0 20 * * 1,4  cd /path/to/project && sh scripts/assess-cron.sh >> cron.log 2>&1
cd "$(dirname "$0")/.." || exit 1
node scripts/due-check.mjs || exit 0
LEARN_ROLE=assessor pi -p -a --name "assessor cron $(date +%F)" \
  "phase=generate。题数上限 8。请依据黑板上下文生成一次闭卷检索测试，并调用 bb_test_create 写入。"
