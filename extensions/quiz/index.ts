/**
 * quiz —— 一题一答的选择题工具。
 *
 * 模型给出题干、若干不带论证的裸断言选项、正确项下标与一句话解析；工具负责打乱选项、
 * 固定附加「我不知道」、弹出选择框让学习者作答、随即弹出判定与解析，并把结构化结果返回模型。
 * 装在 ~/.pi/agent/extensions/quiz/（用户级，不需要 /trust）。没有交互界面时提示改用对话形式。
 * 「我不知道」与取消的语义由技能决定，工具只如实返回。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildQuiz, judge } from "./logic.mjs";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "选择题",
		description:
			"向学习者出一道单选题：给出题干、若干不带论证的裸断言选项、正确项下标与一句话解析。工具负责打乱选项、附加「我不知道」、弹出选择框、即时向学习者显示判定与解析，并返回学习者的选择与判定结果。一次只出一道；学习者已经看到了解析，你不必重复。",
		promptSnippet: "向学习者出一道单选题并即时判定",
		promptGuidelines: ["出测验题或检验题时用 quiz 工具，不要把选项写进对话；题干、选项与解析用中文，选项不含「我不知道」。"],
		parameters: Type.Object({
			question: Type.String({ description: "题干，文字优先，尽量简短" }),
			options: Type.Array(Type.String(), { minItems: 2, maxItems: 6, description: "不带论证的裸断言；不要包含「我不知道」，工具会自动附加" }),
			correct: Type.Integer({ minimum: 0, description: "正确选项在 options 中的下标，从 0 起" }),
			explanation: Type.String({ description: "答后显示的一句话解析：关键点在哪里" }),
			topic: Type.Optional(Type.String({ description: "考点或所属节点，用于记录" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "当前没有交互界面，无法弹出选择框；请改用对话形式出题。" }], details: { status: "no-ui" } };
			}
			const quiz = buildQuiz({ options: params.options, correct: params.correct });
			// signal 让宿主中止本轮时弹窗随之收起，不会把整轮卡在未回答的题上
			const picked = await ctx.ui.select(params.question, quiz.display, { signal });
			if (picked === undefined || signal?.aborted) {
				return { content: [{ type: "text", text: "学习者取消了作答。" }], details: { status: "cancelled", topic: params.topic } };
			}
			const r = judge(quiz, picked);
			const title = r.status === "correct" ? "正确" : r.status === "unknown" ? "记为不知道" : "错误";
			const body = r.status === "correct" ? params.explanation : `正确答案：${r.correctText}\n\n${params.explanation}`;
			// 用单选项的 select 展示判定与解析：confirm 在 TUI 里是英文 Yes/No，语义也不对
			await ctx.ui.select(`${title}\n\n${body}`, ["继续"], { signal });
			const line =
				r.status === "correct"
					? "学习者答对。"
					: r.status === "unknown"
						? `学习者选择「我不知道」（未作猜测，按技能规则处理）。正确答案：${r.correctText}`
						: `学习者答错，选了「${r.pickedText}」；正确答案：${r.correctText}`;
			return {
				content: [{ type: "text", text: `${line}\n解析已向学习者显示，不必重复。` }],
				details: { ...r, question: params.question, explanation: params.explanation, topic: params.topic },
			};
		},
	});
}
