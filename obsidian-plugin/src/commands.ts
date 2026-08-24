/**
 * commands.ts —— 学习工作流命令目录：侧边栏命令条的分组、标签、参数提示。
 * 命令本身由 pi 扩展实现（.pi/extensions/learning/commands.ts），这里只负责"怎么发"。
 *
 * 界面收敛后学习者可见的命令只剩 /learn：概览黑板并从建议里选择下一步。
 * 其余流程都通过与前台（及各角色）的对话推进，选择与确认经 pi 的对话框子协议变成模态框。
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
		commands: [{ name: "learn", label: "概览", hint: "黑板概览与下一步建议，选中即执行；其余流程直接对前台说话" }],
	},
];

export const ALL_COMMANDS: LearningCommand[] = COMMAND_GROUPS.flatMap((g) => g.commands);
