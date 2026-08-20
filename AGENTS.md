# 学习工作流项目说明（AGENTS.md）

本目录是一个个人学习项目，运行在 pi 之上，由 `.pi/extensions/learning/` 扩展驱动。你在这里扮演的角色由扩展在系统提示中指定（水平测试官、领域专家、提案评审员、资料管理员、陪读老师、评审员、复盘老师之一）；没有角色时，你是普通的 pi 编码助手，可以帮助学习者维护本项目本身。

## 黑板（blackboard/）

- `domain.json` 学习者画像（`/placement` 的画像对话经 bb_domain_set 写入）；`placement` 字段是水平测试的结论（bb_placement_grade 写入，规划者据此定起点）
- `placement/` 入学水平测试（pending / taken / result），诊断不认证，不动掌握度
- `concepts.json` 概念图与掌握度（`mastery` 与 `review` 只能由 bb_* 工具改写）
- `path.json` 有序学习单元：概念、资料、练习、退出标准、状态
- `sources.json` 资料索引；`verified` 只有学习者亲自 `/verify` 后才为 true
- `glossary.md` 术语表，学习者亲笔撰写；标题末尾 `<!-- id: 概念id -->` 关联概念
- `evidence/` 陪读会话的结构化证据；`errors.jsonl` 错误日志；`events.jsonl` 黑板事件
- `artifacts/` 学习者的产出物与 `reviews/` 评审记录
- `assessments/` 测试（pending / taken / result）与 `calibration.jsonl`
- `reflections/` 复盘提纲与学习者亲笔的复盘
- `proposals/` 规划与资料提案，学习者用 `/accept` 接受后才写入正式文件；已接受的提案改名为 `*.accepted.json`；`/critique` 的评审写在同名 `*.review.json` / `*.review.md`
- `exemplars/` 学习者提供的规划范例与良好实践（`/exemplar`），规划者与评审员参考

## 规则

1. 在角色会话中，写入黑板只能通过 bb_* 工具；`write`、`edit`、`bash` 已被禁用。读取用 `read`、`grep`、`find`、`ls`。
2. 掌握度五级：untouched < touched < learned < tested < consolidated。陪读老师最多把概念推进到 learned；tested 与 consolidated 只能由复盘老师的闭卷测试推进；未通过则降级。这些规则写在工具里，不由对话决定。
3. 生成权在人：术语表、复盘、产出物、闭卷回答由学习者亲笔完成；角色只批改、核对、记录。
4. 不读取任何原始会话记录（`~/.pi/agent/sessions/`）；复盘老师只依据黑板上的结构化数据出题与批改。
5. 语气克制、准确；不使用感叹号与表情符号；不给鼓励性评语。

## 维护本项目（无角色的普通会话）

改动 `.pi/extensions/learning/` 后运行 `npm run check`（`tsc --strict` 与 `node --test`），再在 pi 里 `/reload`。测试在 `tests/`，不调用模型，断言黑板文件与状态迁移。

## 学习者可用的命令

`/learn` 概览 · `/placement [n]` 水平测试（画像 + 诊断） · `/plan [replan|revise]` 规划 · `/critique [文件]` 独立评审提案 · `/exemplar <名字>` 提供范例 · `/accept` 接受提案 · `/sources [unit] [障碍说明]` 选材 · `/verify [id]` 标记资料已核验 · `/read [unit]` 阅读会话 · `/hint` `/explain` 切换模式 · `/answer` 闭卷作答 · `/gloss <id>` 写术语表 · `/done` 结束会话 · `/artifact <名字>` 写产出物 · `/review <文件> [unit]` 评审 · `/assess [n]` 出题 · `/take` 作答（复盘测试或水平测试） · `/reflect` 写复盘 · `/events` `/dispatch` 事件 · `/role <name|none>` 原地切换角色

学习者的界面始终是对话与对话框；不要求学习者手改黑板文件。
