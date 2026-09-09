# pi 学习套件（pi-learn-kit）

[![CI](https://github.com/doge-liang/pi-learning-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/doge-liang/pi-learning-starter/actions/workflows/ci.yml)

一套以 markdown 为主的一对一教学配置，运行在 [pi](https://github.com/badlogic/pi-mono) 上，由四个技能组成：`teach-cn` 按「摸底 → 规划 → 单步教学」三阶段讲授任意主题，先用逐题测验定位你理解的边缘，再给出依赖图供你确认，然后每次只推进一个推理步并当场检验；`quiz-cn` 随时出题只测不讲；`viz-cn` 为概念生成最小化图示（mermaid 或 SVG）；`fact-check-cn` 对具体断言做分级核查。整个过程写成 Obsidian 库里的笔记（会话记录、依赖图、学习者档案、图示），公式、mermaid 与 SVG 在 Obsidian 中实时渲染。

技能部分只由 markdown 构成，不触发 pi 的项目信任流程；第八节的两个扩展是可选的用户级 TypeScript 扩展（代码在本仓库 `extensions/`，随时可读），不想装时用 `-NoExtensions`。教学方法参考 [amosblomqvist/learn](https://github.com/amosblomqvist/learn)，此处为纯 markdown 的中文本地化改写，不包含该仓库的扩展与子代理。本套件此前的复杂实现（八角色多实例 hub、Obsidian 插件、JSON 黑板）保留在分支 `archive/hub` 与标签 `v0-hub`；后续按需补回的功能见 [ROADMAP.md](ROADMAP.md)。

本文以 Windows 11 原生环境（PowerShell、Windows Terminal）与 pi 0.84.4 为准；WSL 与 macOS 见附录。

## 一、前置条件

- Node.js（npm 全局安装 pi 需要）。
- Git for Windows：pi 的 `bash` 工具与编辑器里的 `!命令` 都经 Git Bash 执行，查找顺序为 `settings.json` 的 `shellPath`、`C:\Program Files\Git\bin\bash.exe`、PATH 上的 `bash.exe`。
- pi 0.84.4 或更新。0.84.2 及更早版本的按键与命令有差异，见附录。

```powershell
node --version
Test-Path "C:\Program Files\Git\bin\bash.exe"
pi --version
```

尚未安装 pi 时：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

升级用 `pi update`，或重复上面的安装命令；升级后重开终端。

## 二、登录

首次运行 `pi` 后在其中执行 `/login`，选「Sign in with an account」用订阅账号登录（Claude Pro/Max、ChatGPT、GitHub Copilot 等），凭据保存在 `$HOME\.pi\agent\auth.json`。若用 API key，二选一：在 pi 里 `/login anthropic` 选「Sign in with an API key」粘贴密钥；或在 PowerShell 执行 `[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")` 后重开终端。官方文档里的 `export ANTHROPIC_API_KEY=...` 是 bash 写法，PowerShell 不会读取 `~/.bashrc`。

## 三、安装技能并建立学习目录

在本仓库根目录执行（把路径换成你的 Obsidian 库内的学习目录）：

```powershell
.\scripts\install.ps1 -LearnDir D:\Knowledge\PiLearn
```

若提示 running scripts is disabled，改用 `powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -LearnDir D:\Knowledge\PiLearn`（PowerShell 7 用 `pwsh -ExecutionPolicy Bypass -File …`）。

脚本把 `skills\` 下的全部技能复制到 pi 的全局技能目录 `$HOME\.pi\agent\skills`（设置了 `PI_CODING_AGENT_DIR` 时以它为准），在学习目录下建立 `maps\`、`sessions\`、`attachments\` 并放入 `AGENTS.md`；重复执行是安全的，已有的 `AGENTS.md` 不覆盖（加 `-ForceAgents` 才覆盖）。等价的手动步骤：

```powershell
$skills = Join-Path $HOME ".pi\agent\skills"
New-Item -ItemType Directory -Force $skills | Out-Null
foreach ($name in "teach-cn", "quiz-cn", "viz-cn", "fact-check-cn") {
    Remove-Item -Recurse -Force (Join-Path $skills $name) -ErrorAction Ignore   # 目标已存在时 Copy-Item 会把目录嵌套进去，先删
    Copy-Item -Recurse ".\skills\$name" (Join-Path $skills $name)
}
$learn = "D:\Knowledge\PiLearn"
New-Item -ItemType Directory -Force "$learn\maps", "$learn\sessions", "$learn\attachments" | Out-Null
if (-not (Test-Path "$learn\AGENTS.md")) { Copy-Item .\AGENTS.md "$learn\AGENTS.md" }
```

学习目录不要用点开头的名字（如 `.learning`），Obsidian 会隐藏这类目录，笔记就看不见了。

## 四、开始一次学习

```powershell
Set-Location D:\Knowledge\PiLearn
pi
```

必须在学习目录（或其子目录）里启动：pi 只向上查找 `AGENTS.md`，在库根启动不会加载学习目录的约定；`pi -c` 与 `pi -r` 也按启动目录归档会话。启动信息里会列出已加载的技能与上下文文件。

进入后先设定模型与思考档位。教学质量对模型智能高度敏感，这里不宜省钱：

1. `/model`（或 `Ctrl+L`）打开选择器。`Enter` 仅在本会话切换到该模型；`Ctrl+S` 切换并同时保存为启动默认。
2. `/thinking` 打开思考档位选择器，同样 `Enter` 仅本会话、`Ctrl+S` 切换并保存为默认；`Shift+Tab` 循环切换档位，只对本会话生效。规划阶段尤其需要较高档位。

然后：

```
/skill:teach-cn 我想系统入门微分形式，目标是读懂广义斯托克斯定理
```

接下来按提示走：回答摸底题，一次一道；在 Obsidian 里看依赖图并确认；然后一步一步往下学。同时在 Obsidian 中打开 `PiLearn/sessions/` 下当天的文件，公式与 mermaid 图会实时渲染。若 `/skill:teach-cn` 不可用，在 `/settings` 里确认「Skill commands」已开启（默认开启）。

四个技能的调用方式（也可以用自然语言，`AGENTS.md` 已把「考考我」「画个图」「核实一下」映射到对应技能）：

| 你说 | 发生什么 |
|---|---|
| `/skill:teach-cn <主题或目标>` | 建档、摸底、规划、教学，直到收尾 |
| `/skill:teach-cn 只摸底 <主题>` | 摸底后写入档案即停，下次直接从规划开始 |
| `/skill:teach-cn 继续 <主题>` | 读取上次的依赖图与记录，复核薄弱与暂缓节点后接着讲 |
| `/skill:quiz-cn [范围] [题数]` | 只测不讲：一次一道单选题，答后立即判定；结束给得分、逐题清单与薄弱点，写入当日记录与档案。范围缺省先取今天学过的节点，题数有余时补档案里的薄弱点；题数缺省五道 |
| `/skill:viz-cn <对象>` | 为一个概念、结构或过程画一张最小化图示：关系与流程用 mermaid 嵌入笔记，几何与坐标用 SVG 写入 `attachments/`，生成后做源码级自检 |
| `/skill:fact-check-cn <说法>` | 断言重述、类别、判定与失效条件；无法核实时明确标注未核验 |

## 五、常用操作（Windows 默认按键）

| 目的 | 操作 |
|---|---|
| 换行不发送 | `Shift+Enter`；Windows Terminal 下也可 `Ctrl+Enter` |
| 中途插话而不打断当前步（转向消息） | 模型工作时直接 `Enter` |
| 排一条等它完全空闲后再发的后续消息 | `Ctrl+Q`；`Alt+Q` 把排队消息取回编辑器 |
| 中止当前回答 | `Escape`（排队消息退回编辑器）；空闲且输入框为空时在 0.5 秒内连按两次打开 `/tree` |
| 思考档位 | `Shift+Tab` 循环（仅本会话）；`/thinking` 选择，选择器内 `Ctrl+S` 切换并存为默认 |
| 模型 | `Ctrl+L` 或 `/model`，选择器内 `Ctrl+S` 切换并存为默认 |
| 粘贴图片 | `Alt+V` |
| 引用一份资料 | 输入 `@` 模糊搜索文件 |
| 上下文将满时压缩 | `/compact 保留依赖图与已通过的节点`，压缩后执行 `/skill:teach-cn 继续 <主题>`：技能会识别为同一会话的续接，不新建文件，只把教学规则找回上下文 |
| 回到之前某条消息处重新开始（会话分支） | `/tree`；教学节点的重讲直接对教师说「重讲节点 N」 |
| 给会话命名 | `/name 微分形式-第一次` |
| 次日继续 | 在同一目录执行 `pi -c`，或新开 pi 后 `/skill:teach-cn 继续 <主题>`；更早的会话用 `pi -r` |
| 导出整段会话 | `/export 微分形式.html` |
| 修改技能后生效 | `/reload`（回答生成中不可用） |
| 查看全部快捷键 | `/hotkeys` |

## 六、注意事项

- **上级目录的 AGENTS.md 会一并加载。** pi 从启动目录逐级向上收集 `AGENTS.md`（同一目录内按 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md` 取第一个），库根的约定也会进入上下文。本套件的 `AGENTS.md` 已声明自己优先于上级约定。
- **信任询问。** 技能装在全局目录，本身不触发项目信任。只有两种情况会在首次启动时询问：学习目录自身含 `.pi\settings.json`、`.pi\extensions`、`.pi\skills`、`.pi\prompts`、`.pi\themes`、`.pi\SYSTEM.md` 或 `.pi\APPEND_SYSTEM.md`；或学习目录及其任一上级目录含 `.agents\skills`。选择信任后写入 `trust.json`，以后不再问；上级目录的 `.pi` 既不触发询问也不会被加载。
- **系统提示里的技能数量。** 库级与用户级的其它技能都会以名称与描述进入系统提示。想让系统提示只含指定技能，用 `--no-skills` 加若干 `--skill` 路径，例如只保留 teach-cn 与 quiz-cn：`pi --no-skills --skill "$HOME\.pi\agent\skills\teach-cn" --skill "$HOME\.pi\agent\skills\quiz-cn"`。
- **PowerShell 工具。** pi 默认给模型 `bash` 工具（经 Git Bash）。0.84.3 起可在 `settings.json` 用 `"defaultTools": ["read", "bash", "powershell", "edit", "write"]` 额外启用 `powershell` 工具；`AGENTS.md` 的安全边界同时覆盖二者。
- **中文输入法候选框错位。** 在 `settings.json` 设置 `"showHardwareCursor": true`。
- **一次只跑一个 pi 写同一个学习目录。** 需要并行（例如另开一个会话做评审），用不同主题或等前一个收尾。

## 七、按自己的方式修改

`teach-cn` 是一份可读的 markdown，改它就是改教学方式：

- 节奏太慢：放宽 `skills/teach-cn/SKILL.md` 阶段 3「一步是什么」的粒度定义。
- 摸底太长：把 SKILL.md 阶段 1 的知识链数量上限从六条降到三条，或把二十五题的上限调低。
- 想要不同的笔记结构：改 `references/logging.md` 中的模板。
- 想固定某个学科的处理方式：改 `references/subjects.md`。
- 改 `AGENTS.md` 时同步 SKILL.md 里重复的硬规则。

修改后重新执行安装脚本（或直接改 `$HOME\.pi\agent\skills` 里的副本），在 pi 中 `/reload` 生效。`npm test` 运行套件自检（frontmatter、引用路径、mermaid 模板约束、语体禁令、两个扩展的纯逻辑），零依赖。

## 八、随套件安装的两个用户级扩展

安装脚本会把 `extensions\` 下的两个扩展复制到 `$HOME\.pi\agent\extensions\`（用户级扩展不经过项目信任流程；代码就在本仓库里，随时可读）：

- **quiz**：给模型一个 `quiz` 工具。模型只提供题干、裸断言选项、正确项下标与解析；选项由代码打乱、固定附加「我不知道」，学习者在弹出的选择框里用方向键作答，随即弹出判定与解析，结构化结果返回模型。`teach-cn` 的摸底题与检验题、`quiz-cn` 的测验都优先走这个工具，没有它时退回对话格式。
- **viz-tools**：给模型 `render_svg`（把 SVG 渲染成 PNG 并作为图片返回，让模型亲眼核对坐标、重叠与箭头方向）与 `check_mermaid`（静态检查 mermaid 里在 Obsidian 中最常见的解析失败写法）。渲染优先用 npm 预编译的 `@resvg/resvg-js`（脚本会在扩展目录里 `npm install`，Windows 无需额外安装），其次系统里的 `rsvg-convert` 或 ImageMagick；依赖安装失败时 `render_svg` 会给出提示，`viz-cn` 退回源码级自检。

不想装扩展时用 `.\scripts\install.ps1 -NoExtensions`（sh 版设 `NO_EXTENSIONS=1`）。事实核查不需要扩展：`fact-check-cn` 用 `curl` 查免密钥的公开 API（Crossref、OpenAlex、arXiv、Wikipedia、npm 等，见 `skills/fact-check-cn/references/verify.md`），`AGENTS.md` 的安全边界已允许这类只读请求。

## 九、可选增强

- **联网核查**：安装 [badlogic/pi-skills](https://github.com/badlogic/pi-skills) 的 `brave-search` 技能，`fact-check-cn` 会自动利用它。只复制这一个技能，整个仓库放进技能目录会让其中全部技能都进入系统提示：`git clone https://github.com/badlogic/pi-skills $env:TEMP\pi-skills`，然后 `Copy-Item -Recurse $env:TEMP\pi-skills\brave-search "$HOME\.pi\agent\skills\brave-search"`，在 `$HOME\.pi\agent\skills\brave-search` 里 `npm install`；需要 Brave 的 API key。
- **原仓库的扩展**（测验弹窗、子代理事实核查与自动图示）依赖 [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)，而它只支持 tmux，Windows 原生下不可用；需要时在 WSL 中另行搭建，并注意 pi 没有沙箱，信任一个含 `extensions/` 的 `.pi` 目录等于允许其中代码在你的机器上执行，启用前先通读。

## 附录 A：WSL 与 macOS

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
sh scripts/install.sh /mnt/d/Knowledge/PiLearn     # macOS 换成库的实际路径
cd /mnt/d/Knowledge/PiLearn && pi
```

WSL 下 pi 同样使用 Windows 风格按键（`Ctrl+Q`、`Alt+Q`、`Alt+V`），撤销为 `Alt+Z`；macOS 与 Linux 下后续消息为 `Alt+Enter`、取回为 `Alt+Up`、粘贴图片为 `Ctrl+V`。

## 附录 B：pi 0.84.2 及更早版本的差异

- 没有 `/thinking` 命令，思考档位在 `/settings` 的 Thinking level 里设置；`Shift+Tab` 的改动会直接写入默认值。
- `/model` 选择器按 `Enter` 即存为默认，没有 `Ctrl+S`。
- Windows 上后续消息是 `Alt+Enter`（与 Windows Terminal 的全屏快捷键冲突，需在其设置中把 `alt+enter` 重映射为 `sendInput "\u001b[13;3u"`），取回是 `Alt+Up`，撤销是 `Ctrl+-`，粘贴图片是 `Ctrl+V`，反向切换模型是 `Shift+Ctrl+P`。

## 仓库结构

```
AGENTS.md                         学习目录约定（复制到学习目录根部）
skills/teach-cn/SKILL.md          教学技能：三阶段流程、单步展开、答错处理、收尾
skills/teach-cn/references/       logging.md 文件模板与写入时机；subjects.md 分学科约定；fact-check.md 讲授中的事实纪律
skills/quiz-cn/SKILL.md           随时测验技能
skills/viz-cn/SKILL.md            最小化图示技能；references/svg.md 是 SVG 规则与自检清单
skills/fact-check-cn/SKILL.md     断言核查技能；references/verify.md 是免密钥核查渠道与 curl 用法
extensions/quiz/                  quiz 工具：打乱选项、弹出选择框、即时判定（index.ts 接 pi，logic.mjs 是纯逻辑）
extensions/viz-tools/             render_svg 与 check_mermaid 工具（package.json 声明 @resvg/resvg-js）
scripts/install.ps1 / install.sh  安装脚本（技能、扩展及其依赖、学习目录）
tests/kit.test.mjs                套件自检（npm test）
ROADMAP.md                        以后缺了再加的功能清单
```
