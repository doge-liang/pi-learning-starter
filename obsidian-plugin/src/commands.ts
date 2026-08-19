/**
 * commands.ts —— 学习工作流命令目录：侧边栏命令条的分组、标签、参数提示。
 * 命令本身由 pi 扩展实现（.pi/extensions/learning/commands.ts），这里只负责"怎么发"。
 */
export interface LearningCommand {
	name: string;
	label: string;
	hint: string;
	/** 需要参数时弹输入框；prompt 为输入框标题，optional 表示可留空 */
	arg?: { prompt: string; placeholder?: string; optional?: boolean };
}
export interface CommandGroup {
	title: string;
	commands: LearningCommand[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
	{
		title: "开始",
		commands: [
			{ name: "learn", label: "概览", hint: "黑板概览：掌握度、当前单元、到期复习、事件" },
			{ name: "domain", label: "入学访谈", hint: "学习顾问通过对话整理领域、目标、背景与偏好" },
			{ name: "placement", label: "水平测试", hint: "入学诊断：按画像出题定位起点，作答用「作答」", arg: { prompt: "题数上限（留空为 10）", placeholder: "10", optional: true } },
			{ name: "plan", label: "规划", hint: "领域专家规划知识结构与学习路径", arg: { prompt: "参数（留空为首次规划；replan 增量重规划；revise 按评审意见修改）", placeholder: "replan / revise", optional: true } },
			{ name: "critique", label: "评审提案", hint: "独立的提案评审员审查最近一份提案" },
			{ name: "exemplar", label: "提供范例", hint: "粘贴课程大纲或良好实践供规划者参考", arg: { prompt: "范例名字", placeholder: "cs336-syllabus" } },
			{ name: "accept", label: "接受提案", hint: "接受最近一份尚未接受的规划 / 资料提案" },
			{ name: "sources", label: "选材", hint: "资料管理员为单元匹配资料", arg: { prompt: "参数（留空为所有无资料单元；或「单元id 障碍说明」请求替代资料）", placeholder: "u01 看不懂第二节", optional: true } },
			{ name: "verify", label: "核验资料", hint: "亲自打开资料后标记已核验", arg: { prompt: "资料 id（留空则从未核验列表选择）", optional: true } },
		],
	},
	{
		title: "阅读",
		commands: [
			{ name: "read", label: "开始阅读", hint: "进入某单元的陪读会话", arg: { prompt: "单元 id（留空为当前单元）", placeholder: "u01", optional: true } },
			{ name: "hint", label: "提示模式", hint: "陪读老师只给最小提示（默认）" },
			{ name: "explain", label: "讲解模式", hint: "陪读老师可以讲解（先让你陈述理解）" },
			{ name: "answer", label: "闭卷作答", hint: "逐题回答预问题并给信心" },
			{ name: "gloss", label: "写术语表", hint: "用自己的话写术语表条目并请老师核对", arg: { prompt: "概念 id", placeholder: "tensor" } },
			{ name: "done", label: "结束会话", hint: "请陪读老师提交证据" },
		],
	},
	{
		title: "产出",
		commands: [
			{ name: "artifact", label: "写产出物", hint: "在编辑器里写练习、推导或复述", arg: { prompt: "文件名（缺省扩展名 .md）", placeholder: "u01-graph" } },
			{ name: "review", label: "评审", hint: "评审员评审你的产出物", arg: { prompt: "文件路径 [单元id]", placeholder: "blackboard/artifacts/u01-graph.md u01" } },
		],
	},
	{
		title: "复盘",
		commands: [
			{ name: "assess", label: "出题", hint: "复盘老师生成一次闭卷检索测试", arg: { prompt: "题数上限（留空为 8）", placeholder: "8", optional: true } },
			{ name: "take", label: "作答", hint: "闭卷作答最近一次测试（复盘测试或水平测试）并交给相应角色批改" },
			{ name: "reflect", label: "写复盘", hint: "在复盘提纲后亲笔作答" },
		],
	},
	{
		title: "事件",
		commands: [
			{ name: "events", label: "事件", hint: "查看黑板上的未处理事件" },
			{ name: "dispatch", label: "处理事件", hint: "处理第一条未处理事件" },
		],
	},
];

export const ALL_COMMANDS: LearningCommand[] = COMMAND_GROUPS.flatMap((g) => g.commands);
