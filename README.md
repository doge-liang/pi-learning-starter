# pi 学习工作流（starter）

[![CI](https://github.com/doge-liang/pi-learning-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/doge-liang/pi-learning-starter/actions/workflows/ci.yml)

设计稿「五个 Agent 与一块黑板」在 pi 上的最小实现。黑板是 `blackboard/` 目录，八个角色（前台，五个学习角色，加定位起点的水平测试官、独立的提案评审员）是八段系统提示加各自的工具白名单，规则写在 `.pi/extensions/learning/` 的 bb_* 工具里，角色会话的隔离靠 pi 的会话机制。完整的设计说明见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

学习者的界面刻意收敛：一个对话入口（前台，Concierge）加各处的对话框，命令只剩 `/learn`（概览与建议）与内部的 `/go`。下一步去哪由代码从黑板算出、以选择框呈现，学习者点选即可；接受提案、下载入库、核验、闭卷作答这些节点仍由学习者在对话框里亲自裁决——模型只掌握时机，对话框里的内容与后果都在代码里。

## 安装

```
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # 或 curl -fsSL https://pi.dev/install.sh | sh
export ANTHROPIC_API_KEY=...                                        # 或在 pi 里 /login
cd pi-learning-starter
pi
```

首次进入会询问是否信任本项目（加载 `.pi/extensions`）；选择信任，或运行 `/trust` 保存决定。启动后会进入前台并看到「学习工作流已加载」的提示：直接说你想做什么即可；`/learn` 查看黑板与建议。

角色使用的模型在 `.pi/learning.json` 中配置（`provider/modelId`），未配置则沿用当前模型；用 `pi --list-models` 查看可用模型。这是唯一需要手工编辑的文件，且是可选的。

## 三十分钟上手

不需要记忆任何流程：对前台说出意图，它会弹出选择框；每个阶段完成时，工具会就地询问下一步。以下是一条典型路径。

1. **定位起点。** 启动后说「开始」或「我想学 X」。前台把你送进水平测试官：先通过几个问题确定领域、可检验的目标、背景与每周小时数（写入画像前你会在确认框里最终确认），随后按画像出 2 到 4 题一组、按 basic / intermediate / advanced 阶梯排列的诊断题。测试就绪时工具直接问「现在闭卷作答？」——逐题弹出编辑器并让你给信心（1–5）。批改后优势、缺口与「给规划者的建议」写进 `domain.json`，工具接着问「进入规划？」。这是诊断不是认证，不动掌握度。以后要改画像或重测，对前台说一声即可。
2. **规划。** 领域专家读取黑板提交知识结构与学习路径的提案，提交后工具就地问你：送独立评审、接受、还是稍后。独立的提案评审员在另一个会话里（看不到规划者的对话）逐项检查目标对齐、覆盖与缺口、前置关系、粒度、顺序与负荷、退出标准，给出 blocking / major / minor 发现与 accept / revise 结论，然后同样问你接受还是请规划者修改。接受时确认框里显示提案摘要与评审结论。想给规划者「好的规划长什么样」的输入：扩展自带一份规划范例与反例（首次规划与修改时注入），你也可以对前台说「我有一份大纲」，它会打开编辑器让你粘贴，规划者与评审员都会参考。
3. **资料。** 资料管理员为每个单元匹配资料：除定位外，还给出获取等级（开放获取 / 需机构权限 / 需购买 / 纸质馆藏 / 暂无渠道）、怎么拿到（开放获取版本的链接、DOI、ISBN、图书馆检索式）与题录元数据。提案接受后回到前台说「开始获取」：开放获取或机构权限且有直链的，确认后下载到 `blackboard/library/`；付费、纸质与暂无渠道的只显示获取途径，由你自己拿到后填一句存放位置；都拿不到就记为暂无渠道，馆员下次会换一份更易得的。同一流程里可以把题录送进 Zotero、把副本送进网盘（见下节）。最后亲自打开资料，对前台说「核验 <资料id>」——`verified` 只有这一条路径。馆藏概览、整理（合并重复、下线失效、排定阅读顺序、打标签、列出缺口）也都对前台说一声。
4. **阅读。** 选择「进入陪读会话」：老师给预问题；你去读资料，卡住了直接提问（默认最小提示，想要讲解就说，老师经你确认切换模式）；读完说「作答」，逐题闭卷作答并给信心；想为某概念写术语表就说一声，编辑器由你亲笔填写、老师只核对；结束时说「结束」，老师提交结构化证据，掌握度最多推进到 learned。
5. **产出。** 对前台说「写产出物 <名字>」，在编辑器里完成练习、推导或复述（代码类产出也可直接放进 `blackboard/artifacts/`），然后说「评审」交给评审员。
6. **复盘。** 单元完成或复习到期时，前台的建议里会出现「出题」；复盘老师生成闭卷检索测试，就绪时问「现在作答？」；批改后升级、降级、校准与复盘提纲落盘，工具问「亲笔写复盘？」。
7. **随时 `/learn`。** 概览掌握度、当前单元、到期复习与事件，末尾列出代码算出的下一步建议，选中即执行。黑板事件（资料缺口、重规划请求等）都会译成这里的建议，不需要单独处理。

每个进入角色的路由会开一个新的 pi 会话并以角色命名，`/resume` 可以回到任一会话继续；当前会话尚无消息时则原地进入角色。在选择框里选「稍后再说」的建议不会被反复追问，`/learn` 里仍然看得到。黑板文件仍是普通的 JSON 与 Markdown，想直接看或直接改随时可以，只是不必。

## 资料的获取与整理

分工是固定的：资料管理员负责**定位、判定获取等级、写清获取途径与题录元数据、整理索引**；**下载、存盘、入 Zotero、入网盘、核验**在前台的收集流程里完成，每一步经你确认。对前台说的一句话对应关系：

| 你说 | 发生什么 |
| --- | --- |
| 「开始获取」/「获取 <资料id>」 | 获取等级为开放获取或机构权限、且有直链时，确认后下载到 `blackboard/library/`；付费、纸质与暂无渠道的不自动下载（直链多半只是付费墙落地页），改为填写你自己存放的位置；都拿不到就记 `unavailable`。随后可选把题录送进 Zotero、把副本送进网盘。 |
| 「馆藏情况」 | 馆藏概览：按单元列出资料、获取等级、是否已获取、是否已核验、本地副本与入库去向，末尾汇总缺口。 |
| 「整理馆藏」 | 馆员合并重复入口、下线失效或被取代的资料、排定单元内阅读顺序、打标签、逐条列出还缺什么。整理提案接受后只改索引，不动本地文件。 |
| 「核验 <资料id>」 | 你亲自打开资料后确认；确认框写明「还没打开就取消」。 |

单元或概念还没有在架资料时，黑板会发一条 `sources_gap` 事件，`/learn` 的建议里会出现「请资料管理员选材」。

`.pi/learning.json` 里的三段配置都是可选的（凭据写 `env:变量名`，从环境变量取，配置文件本身可以进版本库）：

```json
{
  "library": { "dir": "blackboard/library", "max_mb": 64 },
  "zotero":  { "mode": "file" },
  "remote":  { "mode": "folder", "dir": "D:/OneDrive/学习资料", "layout": "unit" }
}
```

- `library`：本地副本的落盘目录与单份大小上限（超限直接拒绝，让你手工下载后填路径）。
- `zotero.mode`
  - `file`（默认，零配置）：写一份 CSL-JSON 到 `blackboard/library/zotero/<资料id>.json`，你在 Zotero 里「文件 → 导入」。
  - `connector`：打本地 Zotero 桌面端的连接器端口（默认 `http://127.0.0.1:23119`），题录直接落库；Zotero 需正在运行，附件只能按 URL 抓。
  - `web`：Zotero Web API，建题录并把本地副本作为附件上传。需要 `user_id`（或 `group_id`）与 `api_key`，例如 `{ "mode": "web", "user_id": "123456", "api_key": "env:ZOTERO_API_KEY", "collection": "ABCD1234" }`。
- `remote.mode`
  - `folder`：复制到网盘客户端的本地同步目录，由客户端自己上传。百度网盘、OneDrive、iCloud、坚果云都能用，不需要凭据，是推荐做法。
  - `webdav`：直接 PUT 到 WebDAV 服务器，例如 `{ "mode": "webdav", "url": "https://dav.jianguoyun.com/dav/学习资料", "user": "you@example.com", "password": "env:WEBDAV_PASSWORD" }`。
  - `layout` 为 `unit`（默认）时按单元建子目录，`flat` 则全部平铺。

`blackboard/library/` 已在 `.gitignore` 里：本地副本体量大，且多是受版权保护的原件，不进版本库。

## 把 starter 直接当作学习项目使用时

仓库里的 `blackboard/` 只是种子。若你就在这个目录里学习（黑板会被真实数据填满），注意不要把个人数据推到公开的 starter 仓库：运行时目录（`proposals/`、`evidence/`、`assessments/`、`reflections/`、`artifacts/`、`exemplars/`、`placement/`、`library/`）已在 `.gitignore` 里；`domain.json`、`concepts.json`、`path.json`、`sources.json`、`glossary.md`、`errors.jsonl`、`events.jsonl` 这七个既是种子又会被改写的文件，请在本地标记为 `skip-worktree`，之后 `git add -A` 不会再带上它们：

```
git update-index --skip-worktree blackboard/domain.json blackboard/concepts.json blackboard/path.json blackboard/sources.json blackboard/glossary.md blackboard/errors.jsonl blackboard/events.jsonl
```

更稳妥的做法是把学习项目放到另一个私有目录或私有仓库里（复制本仓库即可），黑板连同学习记录用 git 正常管理；插件设置里的「学习项目目录」指向那里。

## 无人值守出题

作答仍由学习者在交互模式中完成（测试就绪时工具会问「现在作答？」，`/learn` 的建议里也会列出待作答的测试）；脚本只在满足条件时出题（有 3 个以上到期概念、有待处理的 `unit_complete` / `errors_threshold` 事件、或距上次测试超过 7 天；没有 learned 及以上的概念或已有待作答的测试时跳过）。

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

`assess-cron.mjs` 依次尝试环境变量 `PI_BIN`、项目内安装的 pi（见下节）、PATH 上的 `pi`；`--force` 跳过判定直接出题，`--max <n>` 设题数上限。用 Obsidian hub 时，插件的「自主触发」（见下节）覆盖同类判定且不止出题，可代替 cron。

## Obsidian 插件（obsidian-plugin/）：hub 花名册

把八个角色作为常驻后端实例嵌进 Obsidian 侧边栏（[HUB-PLAN.md](HUB-PLAN.md) 的完整形态）：插件为每个角色维持一个 `pi --mode rpc` 子进程（`LEARN_ROLE` 固定角色、懒启动、崩溃后可重启并各自续接上次会话），页签切换即独立对话。输入 `@角色`（如 `@资料管理员`、`@提案评审员`、`@复盘老师`）唤醒并路由，一条消息可点名多个角色依次触发；无 `@` 的消息发给当前页签的实例。回合串行执行——同一时刻只有一个实例在生成，扩展内的跨进程黑板锁兜底并发写；Agent 回复里的 `@` 只是文本，路由权只在学习者手里。常驻实例模式下角色固定：跨角色的下一步不再切会话，工具会提示「请 @对应角色」。

「群」页签是聚合时间线：你的寻址消息与各实例的回复汇成一条流（回复也实时流式镜像进来）。群里的往来落盘到 `.pi/group/hub.jsonl`，扩展把尾部注入各常驻实例的上下文——被点名的实例因此知道群里刚才发生了什么，未点名的实例不消耗推理；**提案评审员与复盘老师不接收群转写**（隔离策略写死在扩展里），它们的上下文永远只来自黑板。

插件设置里可开启**自主触发**（默认关闭）：轮询黑板，把无人值守的准备性工作派发给实例——单元缺资料时请馆员选材、到期或单元完成时请复盘老师出题、结构性缺口时请规划者重规划。产物（提案、测试）照旧排队等你裁决；队列忙或有实例在对话时让路，同类触发有冷却时间（默认 6 小时）。

扩展的对话框（确认、选择、单行输入、多行编辑器）经 pi 的扩展 UI 子协议变成 Obsidian 的模态框并标注来源角色（如「【资料管理员】接受提案？」），`/learn` 与馆藏概览的输出以卡片显示，bb_* 工具调用默认展开作为回执。黑板文件仍在本项目目录（可作为第二个 vault 打开，或按需镜像到主库）。渲染用 Obsidian 自带的 MarkdownRenderer（与笔记同一套主题、数学、代码高亮），流式输出按块增量：已完成的段落只渲染一次，只重绘末尾未完成的块并临时闭合未结束的代码围栏，工具与思考块就地更新，折叠状态不丢。

```
cd obsidian-plugin
npm install
npm run build                                   # dist/main.js、manifest.json、styles.css
node scripts/install-to-vault.mjs <vault 路径>   # 复制到 <vault>/.obsidian/plugins/pi-learning/
npm test                                        # 对真实 pi（RPC 模式）测试客户端，不调用模型
```

在 Obsidian「设置 → 第三方插件」启用 Pi Learning，再到插件设置里填「学习项目目录」（本项目的绝对路径）；模型凭据由 pi 自己管理（终端里 `pi` 后 `/login`，或用户级环境变量），插件不保存任何密钥。顶栏显示当前实例的角色、模型、会话与串行队列长度；各实例的会话文件记在插件数据里，重启 Obsidian 后各自续接。

## 开发与验证

扩展由 pi 用 jiti 直接加载 TypeScript，运行不需要构建。仓库附带类型检查与测试，用于修改扩展后自检：

```
npm install --ignore-scripts    # 安装 pi 及其类型定义（devDependencies）
npm run check                   # tsc --strict + node --test
```

测试（`tests/`）不调用模型：`workflow.test.ts` 用伪造的 ExtensionAPI 跑通全部流程（前台默认进入与路由询问、水平测试的画像与诊断、规划提案与尾部询问、独立评审、接受确认、资料提案与核验、收集台账与馆藏整理、陪读会话的预问题、闭卷作答、术语表、证据与状态迁移、评审、出题、作答、批改与升降级、校准、事件译成建议、增量重规划、退出学习模式、会话切换交接与恢复、护栏），断言黑板文件与状态；`library.test.ts` 用注入的 fetch 与临时目录检验下载、Zotero 三种入库模式与网盘上传，不触网；`load.test.ts` 用 pi 自己的加载器加载扩展；`scripts.test.ts` 检验定时出题的判定。改动扩展后在 pi 里 `/reload` 即可生效；也可以直接让 pi 修改它自己的扩展（对前台说「退出学习模式」即恢复普通编码助手）。

## 目录

```
AGENTS.md                         每个会话都会加载的项目说明与规则
IMPLEMENTATION-PLAN.md            设计与实现方案
.pi/learning.json                 角色 → 模型
.pi/extensions/learning/
  index.ts                        入口：会话生命周期（默认进入前台）、系统提示与上下文注入、工具护栏
  state.ts                        会话级状态、持久化、会话切换交接
  roles.ts                        八个角色的提示、工具白名单、上下文装配、开场语
  route.ts                        路由层：确定性的下一步建议（nextSteps）、路由串渲染与 hub 模式判定
  actions.ts                      学习者侧对话框流程：闭卷作答、核验、收集入库、各类亲笔编辑器
  lock.ts                         黑板跨进程锁（hub 多实例与 cron 并发写的兜底）
  group.ts                        群转写注入（hub）：读取尾部并附进实例上下文；评审员与复盘老师被隔离
  exemplars/plan-exemplar.md      规划范例与反例（首次规划与修改时注入规划者、评审员上下文）
  tools.ts                        bb_* 工具（模型改写黑板的唯一入口；路由询问与尾部询问在此收口）
  blackboard.ts                   黑板 I/O、状态机、复习调度、事件、错误日志
  commands.ts                     仅存的两个命令：/learn 与内部路由执行器 /go
  config.ts                       .pi/learning.json 的读取（角色模型、馆藏、Zotero、网盘）
  library.ts                      馆藏：下载、获取清单、馆藏概览与覆盖缺口
  zotero.ts                       Zotero 入库（CSL-JSON 文件 / 本地连接器 / Web API）
  remote.ts                       网盘入库（同步目录 / WebDAV）
blackboard/                       黑板（含 library/：本地资料副本，不进版本库）
scripts/                          定时出题脚本（sh 与 node 两版）
tests/                            伪造 ExtensionAPI 的全流程测试、加载测试、脚本测试
obsidian-plugin/                  Obsidian 插件（hub）：RPC 客户端、实例管理器、花名册与群页签、寻址解析、群转写落盘、自主触发、模态框
```
