# pi 学习工作流（starter）

设计稿「五个 Agent 与一块黑板」在 pi 上的最小实现。黑板是 `blackboard/` 目录，五个学习角色（加定位起点的水平测试官、独立的提案评审员）是七段系统提示加各自的工具白名单，规则写在 `.pi/extensions/learning/` 的 bb_* 工具里，角色会话的隔离靠 pi 的会话机制。完整的设计说明见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 安装

```
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # 或 curl -fsSL https://pi.dev/install.sh | sh
export ANTHROPIC_API_KEY=...                                        # 或在 pi 里 /login
cd pi-learning-starter
pi
```

首次进入会询问是否信任本项目（加载 `.pi/extensions`）；选择信任，或运行 `/trust` 保存决定。启动后会看到「学习工作流已加载」的提示；`/learn` 查看黑板。

角色使用的模型在 `.pi/learning.json` 中配置（`provider/modelId`），未配置则沿用当前模型；用 `pi --list-models` 查看可用模型。这是唯一需要手工编辑的文件，且是可选的。

## 三十分钟上手

学习者的界面始终是 pi 里的对话与对话框，不需要手改黑板文件。

1. `/placement` → 水平测试官先通过几个问题确定你的领域、可检验的目标、背景与每周小时数（`bb_domain_set` 写入画像，你在对话框里确认），随后按画像推断目标预设的前置领域，每个领域按 basic / intermediate / advanced 阶梯出 2 到 4 题；`/take` 闭卷作答并给信心；批改后按领域聚合得分与到达层级，优势、缺口与「给规划者的建议」写进 `domain.json` 的 `placement` 字段。这是诊断不是认证，不动掌握度；规划者据此定起点、跳过已会的、为缺口插补救单元。以后要改画像或重测，再运行 `/placement` 直接说。
2. `/plan` → 领域专家读取黑板并调用 `bb_plan_propose`；提案摘要会出现在对话里。审查可以交给 Agent：`/critique` 让独立的提案评审员（另一个会话，看不到规划者的对话）逐项检查目标对齐、覆盖与缺口、前置关系、粒度、顺序与负荷、退出标准是否可检验，给出 blocking / major / minor 发现与 accept / revise 结论；`/plan revise` 让规划者按评审意见修改后重新提交。满意后 `/accept`（确认框里显示摘要与评审结论）。想给规划者「好的规划长什么样」的输入：扩展自带一份规划范例与反例（首次规划与修改时注入），你也可以 `/exemplar <名字>` 粘贴自己认可的课程大纲或学习路径，规划者与评审员都会参考。
3. `/sources` → 资料管理员为每个单元匹配资料：除定位外，还给出获取等级（开放获取 / 需机构权限 / 需购买 / 纸质馆藏 / 暂无渠道）、怎么拿到（开放获取版本的链接、DOI、ISBN、图书馆检索式）与题录元数据。在对话里核对后 `/accept`。接着 `/collect <资料id>` 获取：馆员判为开放获取或机构权限、且给了直链的，确认后下载到 `blackboard/library/`；付费、纸质与暂无渠道的只显示获取途径，由你自己拿到后填一句存放位置；都拿不到就记为暂无渠道，馆员下次会换一份更易得的。同一步里可以把题录送进 Zotero、把副本送进网盘（见下节）。最后亲自打开资料，`/verify <资料id>`（无参数时从未核验列表里选）标记已核验。`verified` 只有这一条路径。`/library` 看馆藏与缺口，`/curate` 让馆员整理（合并重复、下线失效、排定阅读顺序、打标签、列出还缺什么），整理提案同样 `/accept` 后生效。
4. `/read` → 进入当前单元的陪读会话：老师给预问题；你去读资料，卡住了直接提问（默认最小提示，`/explain` 切换讲解）；读完 `/answer` 闭卷作答并给信心；`/gloss <概念id>` 写术语表并请老师核对；`/done` 结束，老师调用 `bb_evidence`，掌握度最多推进到 learned。
5. `/artifact <名字>` 在编辑器里写练习、推导或复述（代码类产出也可直接放进 `blackboard/artifacts/`），然后 `/review blackboard/artifacts/<文件> <单元id>`。
6. `/assess` 生成测试 → `/take` 闭卷作答并给信心 → 老师调用 `bb_grade`：升级、降级、校准、复盘提纲 → `/reflect` 在提纲后亲笔写复盘。
7. `/events` 看黑板事件，`/dispatch` 处理第一条。

每个流程命令会开一个新的 pi 会话并以角色命名，`/resume` 可以回到任一会话继续。当前会话尚无消息时则原地进入角色。

`/accept` 不带参数时取最近一份尚未接受的提案（按修改时间），接受后文件改名为 `*.accepted.json`，不会被重复合并；要接受某一份指定提案，`/accept blackboard/proposals/<文件>`。黑板文件仍是普通的 JSON 与 Markdown，想直接看或直接改随时可以，只是不必。

## 资料的获取与整理

分工是固定的：资料管理员负责**定位、判定获取等级、写清获取途径与题录元数据、整理索引**；**下载、存盘、入 Zotero、入网盘由你运行 `/collect` 完成**，每一步都先弹确认框。角色会话里 `write`、`bash` 仍是禁用的，馆员不接触文件系统，也不会替你绕过付费墙——拿不到的资料就记为暂无渠道，由它换一份更易得的。

| 命令 | 作用 |
| --- | --- |
| `/collect [资料id]` | 获取等级为开放获取或机构权限、且有直链时，确认后下载到 `blackboard/library/`；付费、纸质与暂无渠道的不自动下载（直链多半只是付费墙落地页），改为填写你自己存放的位置；都拿不到就记 `unavailable`。随后可选把题录送进 Zotero、把副本送进网盘。 |
| `/library [unit]` | 馆藏概览：按单元列出资料、获取等级、是否已获取、是否已核验、本地副本与入库去向，末尾汇总缺口。 |
| `/curate [unit]` | 让馆员整理馆藏：合并重复入口、下线失效或被取代的资料、排定单元内阅读顺序、打标签、逐条列出还缺什么。提案 `/accept` 后只改索引，不动本地文件。 |

单元或概念还没有在架资料时，黑板会发一条 `sources_gap` 事件，`/events` 能看到，`/dispatch` 会把它交回馆员。

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

仓库里的 `blackboard/` 只是种子。若你就在这个目录里学习（黑板会被真实数据填满），注意不要把个人数据推到公开的 starter 仓库：运行时目录（`proposals/`、`evidence/`、`assessments/`、`reflections/`、`artifacts/`、`exemplars/`、`library/`）已在 `.gitignore` 里；`domain.json`、`concepts.json`、`path.json`、`sources.json`、`glossary.md`、`errors.jsonl`、`events.jsonl` 这七个既是种子又会被改写的文件，请在本地标记为 `skip-worktree`，之后 `git add -A` 不会再带上它们：

```
git update-index --skip-worktree blackboard/domain.json blackboard/concepts.json blackboard/path.json blackboard/sources.json blackboard/glossary.md blackboard/errors.jsonl blackboard/events.jsonl
```

更稳妥的做法是把学习项目放到另一个私有目录或私有仓库里（复制本仓库即可），黑板连同学习记录用 git 正常管理；插件设置里的「学习项目目录」指向那里。

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

## Obsidian 插件（obsidian-plugin/）

把同一套 Agent 嵌进 Obsidian 侧边栏：插件以子进程方式启动 `pi --mode rpc`（工作目录就是本项目），扩展的对话框（确认、选择、单行输入、多行编辑器）经 pi 的扩展 UI 子协议变成 Obsidian 的模态框，`/learn`、`/events` 的黑板输出以卡片显示，bb_* 工具调用默认展开作为回执。学习者在 Obsidian 里对角色说话、点命令条按钮，黑板文件仍在本项目目录（可作为第二个 vault 打开，或按需镜像到主库）。渲染用 Obsidian 自带的 MarkdownRenderer（与笔记同一套主题、数学、代码高亮），流式输出按块增量：已完成的段落只渲染一次，只重绘末尾未完成的块并临时闭合未结束的代码围栏，工具与思考块就地更新，折叠状态不丢。

```
cd obsidian-plugin
npm install
npm run build                                   # dist/main.js、manifest.json、styles.css
node scripts/install-to-vault.mjs <vault 路径>   # 复制到 <vault>/.obsidian/plugins/pi-learning/
npm test                                        # 对真实 pi（RPC 模式）测试客户端，不调用模型
```

在 Obsidian「设置 → 第三方插件」启用 Pi Learning，再到插件设置里填「学习项目目录」（本项目的绝对路径）；模型凭据由 pi 自己管理（终端里 `pi` 后 `/login`，或用户级环境变量），插件不保存任何密钥。侧边栏顶部显示角色、模型与会话名；命令条按流程分组（开始 / 资料 / 阅读 / 产出 / 复盘 / 事件）。

## 开发与验证

扩展由 pi 用 jiti 直接加载 TypeScript，运行不需要构建。仓库附带类型检查与测试，用于修改扩展后自检：

```
npm install --ignore-scripts    # 安装 pi 及其类型定义（devDependencies）
npm run check                   # tsc --strict + node --test
```

测试（`tests/`）不调用模型：`workflow.test.ts` 用伪造的 ExtensionAPI 跑通六个流程（水平测试的画像与诊断、规划提案与接受、资料提案与接受、资料核验、收集台账与馆藏整理、陪读会话的预问题、闭卷作答、术语表、证据与状态迁移、评审、出题、作答、批改与升降级、校准、事件分发、增量重规划、会话切换交接与恢复、护栏），断言黑板文件与状态；`library.test.ts` 用注入的 fetch 与临时目录检验下载、Zotero 三种入库模式与网盘上传，不触网；`load.test.ts` 用 pi 自己的加载器加载扩展；`scripts.test.ts` 检验定时出题的判定。改动扩展后在 pi 里 `/reload` 即可生效；也可以直接让 pi 修改它自己的扩展（无角色时 pi 是普通编码助手）。

## 目录

```
AGENTS.md                         每个会话都会加载的项目说明与规则
IMPLEMENTATION-PLAN.md            设计与实现方案
.pi/learning.json                 角色 → 模型
.pi/extensions/learning/
  index.ts                        入口：会话生命周期、系统提示与上下文注入、工具护栏
  state.ts                        会话级状态、持久化、会话切换交接
  roles.ts                        七个角色的提示、工具白名单、上下文装配、开场语
  exemplars/plan-exemplar.md      规划范例与反例（首次规划与修改时注入规划者、评审员上下文）
  tools.ts                        bb_* 工具（模型改写黑板的唯一入口）
  blackboard.ts                   黑板 I/O、状态机、复习调度、事件、错误日志
  commands.ts                     斜杠命令与学习者侧对话框
  config.ts                       .pi/learning.json 的读取（角色模型、馆藏、Zotero、网盘）
  library.ts                      馆藏：下载、获取清单、馆藏概览与覆盖缺口
  zotero.ts                       Zotero 入库（CSL-JSON 文件 / 本地连接器 / Web API）
  remote.ts                       网盘入库（同步目录 / WebDAV）
blackboard/                       黑板（含 library/：本地资料副本，不进版本库）
scripts/                          定时出题脚本（sh 与 node 两版）
tests/                            伪造 ExtensionAPI 的全流程测试、加载测试、脚本测试
obsidian-plugin/                  Obsidian 插件：RPC 客户端、侧边栏视图、模态框、命令条
```
