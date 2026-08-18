# pi 学习工作流（starter）

设计稿「五个 Agent 与一块黑板」在 pi 上的最小实现。黑板是 `blackboard/` 目录，五个角色是五段系统提示加各自的工具白名单，规则写在 `.pi/extensions/learning/` 的 bb_* 工具里，角色会话的隔离靠 pi 的会话机制。完整的设计说明见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 安装

```
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # 或 curl -fsSL https://pi.dev/install.sh | sh
export ANTHROPIC_API_KEY=...                                        # 或在 pi 里 /login
cd pi-learning-starter
pi
```

首次进入会询问是否信任本项目（加载 `.pi/extensions`）；选择信任，或运行 `/trust` 保存决定。启动后会看到「学习工作流已加载」的提示；`/learn` 查看黑板。

角色使用的模型在 `.pi/learning.json` 中配置（`provider/modelId`），未配置则沿用当前模型；用 `pi --list-models` 查看可用模型。

## 三十分钟上手

1. 编辑 `blackboard/domain.json`。
2. `/plan` → 领域专家读取黑板并调用 `bb_plan_propose` 写提案 → 打开 `blackboard/proposals/plan-*.json` 审阅、按需修改 → `/accept`。
3. `/sources` → 资料管理员为每个单元匹配资料 → 核对 → `/accept` → 亲自打开每份资料，确认后把 `sources.json` 中对应的 `verified` 改为 `true`。
4. `/read` → 进入当前单元的陪读会话：老师给预问题；你去读资料，卡住了直接提问（默认最小提示，`/explain` 切换讲解）；读完 `/answer` 闭卷作答并给信心；`/gloss <概念id>` 写术语表并请老师核对；`/done` 结束，老师调用 `bb_evidence`，掌握度最多推进到 learned。
5. 做完练习或代码后放进 `blackboard/artifacts/`，`/review <文件> <单元id>`。
6. `/assess` 生成测试 → `/take` 闭卷作答并给信心 → 老师调用 `bb_grade`：升级、降级、校准、复盘提纲 → 在 `blackboard/reflections/` 里亲笔写复盘。
7. `/events` 看黑板事件，`/dispatch` 处理第一条。

每个流程命令会开一个新的 pi 会话并以角色命名，`/resume` 可以回到任一会话继续。当前会话尚无消息时则原地进入角色。

`/accept` 不带参数时取最近一份尚未接受的提案（按修改时间），接受后文件改名为 `*.accepted.json`，不会被重复合并；要接受某一份指定提案，`/accept blackboard/proposals/<文件>`。

## 无人值守出题

作答仍由学习者在交互模式中用 `/take` 完成；脚本只在满足条件时出题（有 3 个以上到期概念、有待处理的 `unit_complete` / `errors_threshold` 事件、或距上次测试超过 7 天；没有 learned 及以上的概念或已有待作答的测试时跳过）。

```
sh scripts/assess-cron.sh          # Unix：cron
node scripts/assess-cron.mjs       # 任意平台：先 due-check，再 LEARN_ROLE=assessor pi -p -a
node scripts/due-check.mjs         # 只看判定，不出题
```

crontab 示例：`0 20 * * 1,4  cd /path/to/project && sh scripts/assess-cron.sh >> cron.log 2>&1`。

Windows 任务计划程序示例（每周一、四 20:00）：

```
schtasks /Create /SC WEEKLY /D MON,THU /ST 20:00 /TN "pi-learning assess" /TR "cmd /c cd /d D:\path\to\project && node scripts\assess-cron.mjs >> cron.log 2>&1"
```

`assess-cron.mjs` 依次尝试环境变量 `PI_BIN`、项目内安装的 pi（见下节）、PATH 上的 `pi`；`--force` 跳过判定直接出题，`--max <n>` 设题数上限。生成后下次 `/learn` 会提示待作答的测试。

## 开发与验证

扩展由 pi 用 jiti 直接加载 TypeScript，运行不需要构建。仓库附带类型检查与测试，用于修改扩展后自检：

```
npm install --ignore-scripts    # 安装 pi 及其类型定义（devDependencies）
npm run check                   # tsc --strict + node --test
```

测试（`tests/`）不调用模型：`workflow.test.ts` 用伪造的 ExtensionAPI 跑通五个流程（规划提案与接受、资料提案与接受、陪读会话的预问题、闭卷作答、术语表、证据与状态迁移、评审、出题、作答、批改与升降级、校准、事件分发、增量重规划、会话切换交接与恢复、护栏），断言黑板文件与状态；`load.test.ts` 用 pi 自己的加载器加载扩展；`scripts.test.ts` 检验定时出题的判定。改动扩展后在 pi 里 `/reload` 即可生效；也可以直接让 pi 修改它自己的扩展（无角色时 pi 是普通编码助手）。

## 目录

```
AGENTS.md                         每个会话都会加载的项目说明与规则
IMPLEMENTATION-PLAN.md            设计与实现方案
.pi/learning.json                 角色 → 模型
.pi/extensions/learning/
  index.ts                        入口：会话生命周期、系统提示与上下文注入、工具护栏
  state.ts                        会话级状态、持久化、会话切换交接
  roles.ts                        五个角色的提示、工具白名单、上下文装配、开场语
  tools.ts                        bb_* 工具（模型改写黑板的唯一入口）
  blackboard.ts                   黑板 I/O、状态机、复习调度、事件、错误日志
  commands.ts                     斜杠命令与学习者侧对话框
blackboard/                       黑板
scripts/                          定时出题脚本（sh 与 node 两版）
tests/                            伪造 ExtensionAPI 的全流程测试、加载测试、脚本测试
```
