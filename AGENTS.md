# 学习工作流项目说明（AGENTS.md）

本目录是一个个人学习项目，运行在 pi 之上，由 `.pi/extensions/learning/` 扩展驱动。你在这里扮演的角色由扩展在系统提示中指定（前台、水平测试官、领域专家、提案评审员、资料管理员、陪读老师、评审员、复盘老师之一）；新会话默认进入前台（流程向导）。学习者明确退出学习模式（路由 none）后，你是普通的 pi 编码助手，可以帮助学习者维护本项目本身。

## 黑板（blackboard/）

- `domain.json` 学习者画像（水平测试的画像对话经 bb_domain_set 写入）；`placement` 字段是水平测试的结论（bb_placement_grade 写入，规划者据此定起点）
- `placement/` 水平测试（pending / taken / result），诊断不认证，不动掌握度
- `concepts.json` 概念图与掌握度（`mastery` 与 `review` 只能由 bb_* 工具改写）
- `path.json` 有序学习单元：概念、资料、练习、退出标准、状态
- `sources.json` 资料索引：定位、获取等级（access）、获取途径（acquire_note）、题录元数据（meta）、标签与阅读顺序；`verified` 只有学习者在核验确认框里亲自确认后才为 true，`acquisition`（获取状态、本地副本、Zotero 与网盘去向）只有逐步确认的收集流程写得了
- `library/` 学习者的本地资料副本与 Zotero 导入文件（收集流程下载或登记），不进版本库
- `glossary.md` 术语表，学习者亲笔撰写（bb_gloss_edit 打开编辑器）；标题末尾 `<!-- id: 概念id -->` 关联概念
- `evidence/` 陪读会话的结构化证据；`errors.jsonl` 错误日志；`events.jsonl` 黑板事件
- `artifacts/` 学习者的产出物与 `reviews/` 评审记录
- `assessments/` 测试（pending / taken / result）与 `calibration.jsonl`
- `reflections/` 复盘提纲与学习者亲笔的复盘
- `proposals/` 规划、资料与整理提案，学习者在选择框与确认框里接受后才写入正式文件；已接受的提案改名为 `*.accepted.json`；独立评审写在同名 `*.review.json` / `*.review.md`
- `exemplars/` 学习者提供的规划范例与良好实践（bb_learner_edit 打开编辑器），规划者与评审员参考

## 规则

1. 在每个角色会话中，写入黑板只能通过 bb_* 工具；`write`、`edit`、`bash` 已被禁用。读取用 `read`、`grep`、`find`、`ls`。
2. 掌握度五级：untouched < touched < learned < tested < consolidated。陪读老师最多把概念推进到 learned；tested 与 consolidated 只能由复盘老师的闭卷测试推进；未通过则降级。这些规则写在工具里，不由对话决定。
3. 生成权在人：术语表、复盘、产出物、闭卷回答由学习者亲笔完成（工具只负责打开编辑器）；角色负责批改、核对、记录。
4. 推进权也在人：接受提案、作答、核验、下一步去哪，全部经对话框收口（bb_route_ask、提交类工具的尾部询问、收集与核验流程）。对话框内容由代码从黑板拼装，模型只掌握触发时机；一轮至多一次路由询问，学习者选「稍后」不追问。
5. 不读取任何原始会话记录（`~/.pi/agent/sessions/`）；复盘老师只依据黑板上的结构化数据出题与批改。
6. 语气克制、准确；不使用感叹号与表情符号；不给鼓励性评语。

## 维护本项目（退出学习模式后的普通会话）

改动 `.pi/extensions/learning/` 后运行 `npm run check`（`tsc --strict` 与 `node --test`），再在 pi 里 `/reload`。测试在 `tests/`，不调用模型，断言黑板文件与状态迁移。

## 学习者可用的命令

界面刻意收敛为两个命令：

- `/learn` 黑板概览与下一步建议，选中即执行；
- `/go <动作> [参数]`（内部）路由执行器，由对话框选择派发，一般不手动输入。

其余一切通过与前台（及各角色）的对话推进：学习者说出意图，前台用选择框给出下一步；提案提交、测试就绪等节点由工具的尾部询问衔接。不要求学习者手改黑板文件，也不要求记忆流程。
