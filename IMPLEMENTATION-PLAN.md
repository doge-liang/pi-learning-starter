# 基于 pi 的学习工作流实现方案

本方案把设计稿「五个 Agent 与一块黑板」落到 pi（earendil-works/pi，`@earendil-works/pi-coding-agent`）之上。原则不变：黑板是文件，判断在模型、规则在代码，生成权在人，帮助者不做认证者。变化的只是承载方式：不再自写 CLI 与 API 封装，而是让 pi 提供模型接入、会话、TUI、工具循环，我们只写一个项目级扩展。

## 1. 为什么 pi 适合这个设计

pi 的三个特性与设计稿的三个需求恰好对应。其一，pi 只有约一千 token 的系统提示和四个内置工具，其余一切通过 TypeScript 扩展加入；扩展可以注册模型可调用的工具、拦截工具调用、替换系统提示、注入上下文消息、注册斜杠命令并弹出对话框。这意味着「五个角色 = 五段系统提示 + 各自的工具白名单」可以直接表达，而「规则在代码」可以落实为工具的实现，模型除了调用工具没有别的办法改写黑板。其二，pi 的会话是文件，可以命名、恢复、分支；每个角色跑在自己的会话里，天然满足「复盘老师看不到陪读老师的对话」。其三，pi 有交互、print、RPC、SDK 四种模式；定时出题用 `pi -p` 无人值守运行，作答仍在交互模式中完成。

pi 也有两处需要绕开的地方。它没有内置调度，因此定时触发交给 cron 加 print 模式；它的默认输入框适合短消息，闭卷长文作答用扩展提供的 `ctx.ui.editor` 多行编辑器与 `ctx.ui.select` 选择器完成。

## 2. 设计稿到 pi 原语的映射

| 设计稿元素 | pi 原语 | 落点 |
| --- | --- | --- |
| 黑板 | 项目目录里的 `blackboard/`（JSON、JSONL、Markdown） | `blackboard.ts` |
| 五个学习角色（加前台、水平测试官、提案评审员，共八个） | 系统提示片段（`before_agent_start` 追加）+ `pi.setActiveTools` 白名单；新会话默认进入前台 | `roles.ts`、`index.ts` |
| 判断在模型、规则在代码 | `pi.registerTool` 注册的 bb_* 工具，规则在 `execute` 内 | `tools.ts` |
| 流程路由（下一步去哪） | 前台角色 + 代码算出的建议（`nextSteps`）+ `bb_route_ask` 选择框；选定后经 `pi.sendUserMessage(..., { expandPromptTemplates: true })` 派发内部命令 `/go`，在命令上下文中获得会话切换能力 | `route.ts`、`tools.ts`、`commands.ts` |
| 事件条目 | `blackboard/events.jsonl`；`nextSteps` 把未处理事件译成下一步建议 | `blackboard.ts`、`route.ts` |
| 角色会话隔离 | `ctx.newSession` 切换会话，目标角色经交接文件传递；`--name` 命名会话 | `state.ts`、`commands.ts` |
| 学习者交互（画像对话、水平测试、闭卷作答、术语表、资料核验、产出物、复盘） | 与前台对话 + 对话框收口（`bb_route_ask`、提交类工具的尾部询问、收集 / 核验 / 编辑器流程）；命令只剩 `/learn` 与内部 `/go`；对话框内容由代码拼装，模型只掌握触发时机 | `actions.ts`、`commands.ts`、`tools.ts` |
| 陪读老师的模式标记 | `input` 事件为学习者消息加前缀 `[mode: hint]` | `index.ts` |
| 禁止读原始对话、禁止直接写文件 | `tool_call` 事件返回 `{ block: true }` | `index.ts` |
| 定时触发 | `LEARN_ROLE=assessor pi -p -a "..."` + cron | `scripts/` |
| 项目级说明 | `AGENTS.md`（每次会话加载） | 项目根 |
| 角色的模型偏好 | `.pi/learning.json` → `pi.setModel(ctx.modelRegistry.find(provider, id))` | `index.ts` |

## 3. 目录结构

```
my-learning/
  AGENTS.md
  .pi/
    learning.json                     角色 → 模型
    extensions/learning/
      index.ts  state.ts  roles.ts  route.ts  actions.ts  tools.ts  blackboard.ts  commands.ts
      config.ts  library.ts  zotero.ts  remote.ts
  blackboard/
    domain.json concepts.json path.json sources.json glossary.md errors.jsonl events.jsonl
    evidence/  artifacts/{reviews/}  assessments/  reflections/  proposals/  library/
  scripts/
    assess-cron.sh  assess-cron.mjs  due-check.mjs
  tests/                              伪造 ExtensionAPI 的全流程测试、加载测试、脚本测试
  package.json  tsconfig.json         仅供本地类型检查与测试（devDependencies），运行时不需要
```

扩展放在 `.pi/extensions/learning/`（项目本地，pi 自动发现，`/reload` 热重载），不需要构建步骤：pi 用 jiti 直接加载 TypeScript。扩展只依赖 pi 自带的包（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 的 `StringEnum`、`@earendil-works/pi-tui` 的 `Text`、`typebox`）与 Node 内置模块，运行时不需要安装任何东西；`package.json` 只为 `npm run check`（`tsc --strict` 与 `node --test`）而存在。

## 4. 扩展设计

### 4.1 状态与角色切换（state.ts、index.ts）

会话级状态只有一个对象：当前角色、单元、模式、陪读老师登记的预问题、`bb_collect_answers` 收集的作答、作答路由收集的复盘作答与所属测试文件、评审对象路径、路由询问里选过「稍后」的建议、明确退出学习模式的标记。每次变化用 `pi.appendEntry("learning-state", state)` 写入会话文件；`session_start` 时扫描条目恢复最后一份，因此 `/resume` 回到某个会话时角色、工具、模式一并恢复。

新会话默认进入前台（黑板存在且未明确退出时）。进入角色的路由（`/go plan`、`/go read` 等，通常由 `bb_route_ask` 或提交类工具的尾部询问派发）执行时，若当前会话还没有任何消息，就原地进入；否则调用 `ctx.newSession` 切到新会话。会话切换只存在于命令上下文（pi 对 `newSession` 的约束），工具经 `pi.sendUserMessage("/go …", { expandPromptTemplates: true })` 派发命令来跨越这道边界。会话切换后 pi 会重建扩展实例，旧实例的 `pi` 与 `ctx` 失效，因此目标角色与附带状态通过 `.pi/learning-handoff.json` 交接：旧实例写文件并发起切换，新实例在 `session_start(reason="new")` 中读取并删除，然后在 `withSession` 回调里发送开场消息。非交互模式用环境变量 `LEARN_ROLE` 指定角色。

进入角色时做四件事：`pi.setActiveTools([read, grep, find, ls, ...角色的 bb_* 工具])`；按 `.pi/learning.json` 切换模型；`pi.setSessionName` 命名会话；`ctx.ui.setStatus` 在状态栏显示角色、单元与模式。退出学习模式（路由 `none`）恢复全部工具，并在会话状态里记住退出，恢复该会话时不再自动回到前台。

### 4.2 系统提示与黑板上下文（before_agent_start）

每一轮开始前，扩展把角色提示追加到 pi 的系统提示之后（保留 pi 对工具的说明），并从黑板装配一段角色所需的结构化上下文：前台得到概览、代码算出的下一步建议（含已搁置项）、待接受提案的摘要与评审结论、馆藏缺口；陪读老师得到当前单元、资料、相关概念与掌握度、学习者已写的术语表、未解决错误、本会话预问题；复盘老师得到到期概念、全部概念、近期错误、会话证据摘要、术语表、待批改的测试；规划者得到现有结构、错误与测评结果；馆员得到单元、含获取状态的馆藏与覆盖缺口；评审员得到产出物路径与相关概念。上下文作为一条 `customType: "learning-context"` 的消息注入，只在其哈希变化时重新注入，避免每轮重复占用上下文并保留提示缓存。

### 4.3 护栏（tool_call、input）

角色会话中，`write`、`edit`、`bash` 不在白名单里；`tool_call` 再拦一层，任何对它们的调用都被 `{ block: true }` 拒绝，理由文本告诉模型只能用 bb_* 工具。对 `read`/`grep`/`find`/`ls`，若路径落在 `~/.pi/agent/sessions/` 下则拒绝，防止任何角色读原始对话。陪读会话中，`input` 事件把学习者输入改写为 `[mode: hint] …`；模式只在学习者要求时由 `bb_mode_set` 经确认框切换。

### 4.4 bb_* 工具与规则（tools.ts、blackboard.ts）

| 工具 | 角色 | 写入 | 规则 |
| --- | --- | --- | --- |
| `bb_status` | 全部 | 无 | 概览 |
| `bb_route_ask` | 前台及多数角色 | 会话状态（搁置列表） | 路由询问：模型提交路由串，选择框文字由 `renderRoute` 从黑板拼装；选定后派发 `/go`；选「稍后」记入搁置列表，不再主动重提 |
| `bb_collect` | 前台 | `sources.json`（台账）、`library/` | 收集流程入口：下载、登记路径、入 Zotero、入网盘，每一步经确认框 |
| `bb_verify` | 前台 | `sources.json` | 核验入口：确认框写明「还没打开就取消」；模型不能代确认 |
| `bb_library_report` | 前台、资料管理员 | 无 | 馆藏概览与缺口，全文展示给学习者 |
| `bb_learner_edit` | 前台 | `artifacts/`、`exemplars/`、`reflections/` | 打开亲笔编辑器（产出物 / 范例 / 复盘），内容由学习者填写 |
| `bb_domain_set` | 水平测试官 | `domain.json` | 画像对话整理后提交；经 `ctx.ui.confirm` 确认才写入；按字段合并，未提交的保留；非交互一律不通过 |
| `bb_placement_create` | 水平测试官 | `placement/pending-*.json` | 按领域与难度阶梯出题；题目领域须在 areas 中；尾部询问「现在闭卷作答？」 |
| `bb_placement_grade` | 水平测试官 | `placement/*-result.json`、`domain.json.placement` | 按领域聚合得分（代码）、层级判断与建议（模型）；算校准偏差；不动掌握度；尾部询问「进入规划？」 |
| `bb_plan_propose` | 领域专家 | `proposals/plan-*.json` | 校验前置引用与成环；尾部询问「送评审 / 接受 / 稍后」；学习者接受后才生效 |
| `bb_proposal_review` | 提案评审员 | `proposals/*.review.json` / `.md` | 独立审查提案：逐条发现（blocking / major / minor）与结论；blocking 存在时结论必须为 revise；不改提案；尾部询问「接受 / 请提案者修改」 |
| `bb_sources_propose` | 资料管理员 | `proposals/sources-*.json` | 除定位外还提交获取等级、获取途径与题录元数据；接受后合并；`verified` 一律 false，`acquisition` 台账不被提案覆盖；合并后仍有缺口则发 `sources_gap` |
| `bb_sources_curate` | 资料管理员 | `proposals/curate-*.json` | 整理提案：合并、下线、单元内排序、标签、缺口；接受后只改索引，不动本地副本 |
| `bb_check_link` | 资料管理员 | 无 | HEAD/GET 可达性检查 |
| `bb_prequestions` | 陪读老师 | 会话状态 | 登记预问题，供 `bb_collect_answers` 使用 |
| `bb_collect_answers` | 陪读老师 | 会话状态 | 学习者要作答时收集闭卷作答：逐题编辑器（学习者亲笔）与信心（不给模型）；作答全文返回给老师批改 |
| `bb_gloss_edit` | 陪读老师 | `glossary.md` | 学习者要写术语表时打开编辑器；条目返回给老师核对，不代写 |
| `bb_mode_set` | 陪读老师 | 会话状态 | 学习者要求换模式时经确认框切换 hint / explain |
| `bb_evidence` | 陪读老师 | `evidence/*.json`、`concepts.json`、`errors.jsonl`、`events.jsonl` | 掌握度上限 learned；附上学习者的作答与信心；退出标准满足时经 `ctx.ui.confirm` 才标记单元完成并发 `unit_complete`；资料请求发 `resource_request`；错误达阈值发 `errors_threshold` |
| `bb_review` | 评审员 | `artifacts/reviews/*`、`errors.jsonl` | 只记录发现，误解与缺口入错误日志 |
| `bb_test_create` | 复盘老师 | `assessments/pending-*.json` | 记录到期概念；标记 `unit_complete`/`errors_threshold` 已处理；尾部询问「现在作答？」 |
| `bb_grade` | 复盘老师 | `assessments/*-result.json`、`calibration.jsonl`、`concepts.json`、`reflections/*-outline.md`、`events.jsonl` | 按概念聚合得分：≥0.75 通过并前进一档间隔（1、3、7、14、30、60 天，连续三次即 consolidated），<0.5 降一级，介于其间两天后复测；通过的概念解决其错误；校准偏差 = 归一化信心 − 得分；结构性缺口发 `replan_request`；尾部询问「写复盘？」 |

每个工具先校验当前角色，防止串角色调用；都以 `executionMode: "sequential"` 注册，避免并行写黑板。接受提案（`/go accept`）是纯代码：确认框里显示代码拼装的摘要与评审结论，合并时保留已有概念的掌握度与复习状态、已有单元的状态与资料。所有闸门在非交互模式下一律不通过——写入照常，裁决缺席时不代替学习者选择。

### 4.5 命令与路由（commands.ts、route.ts、actions.ts）

学习者可见的命令只有 `/learn`：输出黑板概览与代码算出的下一步建议（含已搁置标记），并弹出选择框，选中即执行。其余全部是路由——内部命令 `/go <动作> [参数]` 的执行面，由 `bb_route_ask` 与提交类工具的尾部询问派发，一般不手动输入。

路由动作分两类。进入角色类（`placement`、`plan [replan|revise]`、`critique`、`sources`、`curate`、`read`、`review`、`assess`）需要会话切换能力，因此必须落在命令上下文里执行；学习者裁决类在 `actions.ts` 中实现、`/go` 与前台工具共用：`accept`（确认框显示代码拼装的提案摘要与评审结论，接受后改名 `*.accepted.json`）、`take`（逐题多行编辑器与 1 到 5 的信心选择，然后以 `[grade]` / `[grade-placement]` 交给相应角色，必要时先切会话）、`collect`（开放获取直链经确认下载到 `library/`，否则登记学习者自备的路径或记为 `unavailable`；随后可选送 Zotero 与网盘）、`verify`（学习者亲自核验后置位 `verified`，唯一路径）、`library`（馆藏概览）、`reflect` / `artifact` / `exemplar` / `gloss`（亲笔编辑器）、`none`（退出学习模式）。

三条不变式在迁移后原样保留：黑板写入只经 bb_* 工具；每个闸门都是模型无法替答的对话框，且对话框内容由代码从黑板拼装（接受摘要来自 `summarizeProposal`，路由选项文字来自 `renderRoute`）；亲笔产出只经编辑器。防疲劳规则写进工具与提示两层：一轮至多一次路由询问、永远有「稍后再说」、选过稍后的建议不再主动重提（`/learn` 仍列出）。

### 4.6 五个流程在 pi 中的时序

A 启动与规划：新会话即前台，学习者说「开始」→ 路由询问 → 水平测试官先做画像对话（`bb_domain_set` 确认后写 `domain.json`），再出诊断题 → 尾部询问「现在作答？」→ 闭卷作答（`/go take`）→ `bb_placement_grade`（按领域聚合，结论写入 `domain.json.placement`）→ 尾部询问「进入规划？」→ 规划者会话（上下文含 domain、水平测试结果、范例）→ `bb_plan_propose` → 尾部询问「送评审 / 接受 / 稍后」→ 评审员会话 → `bb_proposal_review` → 尾部询问「接受 / 请提案者修改」→ 如需修改 `/go plan revise` → 规划者按意见重新提交 → 接受（确认框）→ 写入并发 `structure_ready` → 建议译成「请馆员选材」→ 馆员会话 → `bb_sources_propose` → 接受 → 前台收集流程获取与入库 → 学习者亲自打开后核验；馆藏概览看缺口，整理经 `bb_sources_curate` 与接受落到索引。

B 阅读会话：路由 `read u01` → 陪读会话，开场语 `[begin-session]` → `bb_prequestions` → 学习者读资料并提问（消息自动带 `[mode: hint]`）→ 学习者说要作答 → `bb_collect_answers` → 老师批改 → 学习者要写术语表 → `bb_gloss_edit` → 老师核对 → 学习者说结束 → `bb_evidence`（上限 learned；确认后单元完成并发事件）。

C 产出与评审：学习者独立完成产出物（前台编辑器或直接放入 `artifacts/`）→ 路由 `review 文件 单元` → 评审员会话读文件 → `bb_review` → 学习者修订后再评审。

D 定期复盘：cron 运行 `scripts/assess-cron.sh`（`due-check.mjs` 判断是否该出题；是则 `LEARN_ROLE=assessor pi -p -a` 让考评官调用 `bb_test_create`，非交互下尾部询问静默跳过）→ 学习者进入 pi，前台建议里出现待作答测试 → 闭卷作答并给信心 → `[grade]` 消息 → `bb_grade` 更新掌握度、校准、提纲、事件 → 尾部询问「写复盘？」→ 学习者亲笔写复盘。

E 调整路径：`replan_request` 事件 → 建议译成「增量重规划」→ 规划者会话（上下文含测评结果与错误）→ 增量提案 → 接受 → `structure_ready` → 馆员补资料；补料或整理后若仍有单元、概念没有在架资料，发 `sources_gap`，建议再把它交回馆员（整段单元缺料走补料，只是概念未覆盖走整理）。

## 5. 安装与首次运行

安装 pi（`npm install -g --ignore-scripts @earendil-works/pi-coding-agent` 或 `curl -fsSL https://pi.dev/install.sh | sh`），设置 `ANTHROPIC_API_KEY` 或在 pi 里 `/login`。解压 starter 到一个目录，进入后运行 `pi`；首次会询问是否信任项目，选择信任（或 `/trust` 保存）。看到「学习工作流已加载」后直接对前台说想做什么；`/learn` 查看黑板与建议。角色模型在 `.pi/learning.json` 中配置，形如 `"planner": "anthropic/claude-opus-5"`；未配置则沿用当前模型。改动扩展后 `/reload`（维护本项目先说「退出学习模式」恢复普通编码助手）。

非交互与定时：`LEARN_ROLE=assessor pi -p -a "..."`；`-a` 让 print 模式信任项目本地扩展。cron 只做出题，作答仍在交互模式完成。Unix 用 `scripts/assess-cron.sh`；Windows 任务计划程序或任何有 node 的环境用 `scripts/assess-cron.mjs`，它把提示词经 stdin 交给 pi 的 print 模式，避开 shell 对中文与引号的改写。两者都先经 `due-check.mjs` 判定：没有 learned 及以上的概念、或已有待作答的测试时跳过。

## 6. 已完成的验证与尚未验证之处

已完成（均可用 `npm run check` 复现，见 `tests/`）：扩展针对 pi 0.84.2 的类型定义通过 `tsc --strict` 检查；用 pi 自己的扩展加载器（jiti）实际加载扩展，确认注册了 22 个 bb_* 工具、2 个命令、4 个事件处理器与 1 个条目渲染器；用伪造的 ExtensionAPI 与上下文跑通全流程（前台默认进入与路由询问、尾部询问的派发、水平测试、规划提案与接受、独立评审、资料提案与核验、收集台账与馆藏整理、陪读会话、证据与状态迁移、评审、出题、作答、批改、降级、校准、事件译成建议、增量重规划、退出学习模式、会话切换交接与 `/resume` 恢复、护栏），黑板文件内容符合预期。核对 pi 0.84.2 类型定义确认两件事：`ctx.newSession` 只在命令上下文提供（工具经 `pi.sendUserMessage(..., { expandPromptTemplates: true })` 派发 `/go` 跨越这道边界），且会重建扩展实例、在 `withSession` 之前发出 `session_start(reason="new")`，交接文件的设计成立。Obsidian 插件的 RPC 测试对真实 pi 端到端验证了前台默认进入与 `/go` 派发。历史修正仍然有效：接受无指定文件时按修改时间取最近一份尚未接受的提案，接受后改名为 `*.accepted.json` 防止重复合并；无角色（明确退出学习模式）时从工具白名单中摘掉 bb_*。

尚未验证：在真实模型上运行。角色是否稳定地按提示调用工具、提示措辞是否需要为不同模型调整、`ctx.newSession` 交接在你的终端环境中的体验，都要在第一周使用中校准。建议第一天只跑流程 A 与一次 `/read`，把遇到的偏差写进 `reflections/`。

## 7. 演进方向

第一，把学习者的作答体验做成自定义组件（`ctx.ui.custom`）：一屏内显示题目、编辑器与信心条，替代逐题弹窗。第二，用 `renderResult` 给 `bb_evidence`、`bb_grade` 做卡片式渲染，让证据与批改结果在终端里可读。第三，利用 pi 的 `/tree` 与 `/fork`：闭卷作答前打标签，作答不满意可以分支重来而不污染主线。第四，把角色提示抽成 pi skills 或打包为 pi package（`pi install git:...`），在多台机器上复用。第五，若要其他界面，用 pi 的 RPC 或 SDK 模式把同一套扩展跑在别处：`obsidian-plugin/` 已按此思路把 Agent 嵌进 Obsidian 侧边栏（子进程 `pi --mode rpc`，扩展 UI 子协议映射为 Obsidian 模态框）。第六，黑板超过几百个概念时再考虑 SQLite；此前文件方案更利于手改与 git 管理。

## 8. 已知限制与风险

模型可能忽略「只用 bb_* 工具」而尝试写文件，护栏会拒绝并给出理由，但会浪费一轮；若某个模型频繁如此，把角色提示中的工具说明前置。`ctx.newSession` 的交接依赖 `session_start` 在 `withSession` 之前触发，这是 pi 文档描述的顺序；若未来版本改变，退回到原地进入（当前会话为空时 `/go` 本就原地进入角色）即可。路由把推进从「用户拉取」改成了「Agent 推送」，对话框疲劳是新的风险面：防线是一轮至多一次询问、必有「稍后」且搁置后不重提；若某个模型仍频繁打断，收紧其白名单里的 `bb_route_ask`。所有闸门对话框都需要交互界面，非交互模式下一律不通过（不代替学习者选择）。链接可达不等于内容正确，`verified` 必须由学习者亲自置位。最后，与前一版一样：先让流程跑起来两周，再决定改什么，不要在使用之前扩展它。
