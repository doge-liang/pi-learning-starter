/**
 * commands.ts —— 斜杠命令：设计稿五个流程的入口，以及学习者侧的交互（闭卷作答、术语表、复盘作答）。
 *
 * 角色会话的隔离靠 pi 的会话：/plan、/sources、/read、/review、/assess 会通过 ctx.newSession 切到新会话，
 * 目标角色通过交接文件传给新的扩展实例（见 state.ts）。当前会话尚无消息时则直接在原地进入角色。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Blackboard, today } from "./blackboard.ts";
import { kickoff, ROLES } from "./roles.ts";
import { type LearnerAnswer, type LearningState, type Role, ROLE_NAMES, writeHandoff, takeHandoff } from "./state.ts";
import { applyProposal } from "./tools.ts";

export interface CommandDeps {
	bb: Blackboard;
	state: () => LearningState;
	persist: () => void;
	/** 在当前会话原地进入角色（设置工具、模型、会话名） */
	applyRole: (role: Role | null, partial: Partial<LearningState>, sessionName: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;
	note: (ctx: ExtensionCommandContext, text: string) => void;
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
	const { bb } = deps;

	/** 进入角色：会话为空则原地进入，否则切到新会话并交接 */
	async function enter(ctx: ExtensionCommandContext, role: Role, partial: Partial<LearningState>, sessionName: string, kick: string) {
		const hasMessages = ctx.sessionManager.getBranch().some((e) => e.type === "message");
		if (!hasMessages) {
			await deps.applyRole(role, partial, sessionName, ctx);
			pi.sendUserMessage(kick);
			return;
		}
		writeHandoff(ctx.cwd, { ...partial, role, sessionName });
		const res = await ctx.newSession({
			withSession: async (c) => {
				await c.sendUserMessage(kick);
			},
		});
		if (res.cancelled) {
			takeHandoff(ctx.cwd);
			ctx.ui.notify("会话切换被取消。", "warning");
		}
	}

	pi.registerCommand("learn", {
		description: "黑板概览：掌握度、当前单元、到期复习、事件",
		handler: async (_args, ctx) => deps.note(ctx, bb.status()),
	});

	pi.registerCommand("domain", {
		description: "学习顾问：入学访谈，通过对话整理领域、目标、背景与偏好并写入 domain.json（再次运行可修改）",
		handler: async (_args, ctx) => {
			const existing = Boolean(bb.domain().domain);
			await enter(ctx, "intake", {}, `intake ${today()}`, kickoff("intake", { existing }));
		},
	});

	pi.registerCommand("plan", {
		description: "领域专家：规划（/plan）或增量重规划（/plan replan）",
		handler: async (args, ctx) => {
			if (!bb.domain().domain) return ctx.ui.notify("还没有学习者画像；请先运行 /domain 完成入学访谈。", "warning");
			const replan = args.trim() === "replan";
			await enter(ctx, "planner", {}, `planner ${replan ? "replan" : "plan"} ${today()}`, kickoff("planner", { replan }));
		},
	});

	pi.registerCommand("accept", {
		description: "接受最近一份尚未接受的（或指定的）规划 / 资料提案，写入黑板",
		handler: async (args, ctx) => {
			const file = args.trim() ? resolve(ctx.cwd, args.trim()) : bb.latestProposal();
			if (!file || !existsSync(file)) return ctx.ui.notify("没有可接受的提案文件。", "warning");
			let summary = file;
			try {
				summary = bb.summarizeProposal(JSON.parse(readFileSync(file, "utf8")));
			} catch {
				/* 摘要失败时退回显示路径 */
			}
			const ok = ctx.hasUI ? await ctx.ui.confirm("接受提案？", `${summary}\n\n接受后写入黑板。要修改请回到该角色会话说明，由其重新提交。`) : true;
			if (!ok) return;
			try {
				deps.note(ctx, applyProposal(bb, file));
			} catch (e) {
				ctx.ui.notify(String((e as Error).message ?? e), "error");
			}
		},
	});

	pi.registerCommand("verify", {
		description: "标记一份资料为已亲自核验：/verify <资料id>；无参数时从未核验列表中选择",
		getArgumentCompletions: (prefix) => {
			const items = bb
				.sources()
				.filter((s) => !s.verified && s.id.startsWith(prefix))
				.map((s) => ({ value: s.id, label: `${s.id} ${s.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			let id = args.trim();
			if (!id) {
				const pending = bb.sources().filter((s) => !s.verified);
				if (!pending.length) return ctx.ui.notify("所有资料都已核验。", "info");
				if (!ctx.hasUI) return ctx.ui.notify("用法：/verify <资料id>", "warning");
				const pick = await ctx.ui.select("选择已亲自核验的资料", pending.map((s) => `${s.id}  ${s.title}`));
				if (!pick) return;
				id = pick.split(/\s+/)[0];
			}
			const s = bb.sources().find((x) => x.id === id);
			if (!s) return ctx.ui.notify(`资料 ${id} 不在 sources.json 中。`, "warning");
			const ok = ctx.hasUI ? await ctx.ui.confirm("确认核验？", `${s.title}\n${s.locator ?? ""}\n\n你已亲自打开这份资料，确认它存在且适合对应单元？`) : true;
			if (!ok) return;
			bb.verifySource(id, true);
			ctx.ui.notify(`已标记 ${id} 为已核验。`, "info");
		},
	});

	pi.registerCommand("sources", {
		description: "资料管理员：为尚无资料的单元匹配资料；/sources <unit> <障碍说明> 请求替代资料",
		handler: async (args, ctx) => {
			const [unit, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const note = rest.join(" ");
			const units = unit ? [unit] : bb.units().filter((u) => !u.sources?.length).map((u) => u.id);
			if (!units.length) return ctx.ui.notify("所有单元都已有资料；要请求替代资料请指定单元与障碍说明。", "info");
			await enter(ctx, "librarian", { unit }, `librarian ${today()}`, kickoff("librarian", { units, unit, note: note || undefined }));
		},
	});

	pi.registerCommand("read", {
		description: "陪读老师：开始某单元的阅读会话（缺省为当前单元）",
		getArgumentCompletions: (prefix) => {
			const items = bb
				.units()
				.filter((u) => u.status !== "done" && u.id.startsWith(prefix))
				.map((u) => ({ value: u.id, label: `${u.id} ${u.title}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const unit = args.trim() ? bb.findUnit(args.trim()) : bb.nextUnit();
			if (!unit) return ctx.ui.notify("没有可学习的单元；先运行 /plan 与 /sources。", "warning");
			const units = bb.units();
			for (const u of units) if (u.id === unit.id) u.status = "active";
			bb.saveUnits(units);
			await enter(ctx, "tutor", { unit: unit.id, mode: "hint", prequestions: [], answers: [] }, `tutor ${unit.id} ${today()}`, kickoff("tutor"));
		},
	});

	pi.registerCommand("hint", {
		description: "陪读老师切换到最小提示模式（默认）",
		handler: async (_args, ctx) => setMode(ctx, "hint"),
	});
	pi.registerCommand("explain", {
		description: "陪读老师切换到讲解模式（仍会先要求你陈述理解）",
		handler: async (_args, ctx) => setMode(ctx, "explain"),
	});
	async function setMode(ctx: ExtensionCommandContext, mode: "hint" | "explain") {
		const state = deps.state();
		if (state.role !== "tutor") return ctx.ui.notify("当前不在陪读会话中。", "warning");
		state.mode = mode;
		state.contextHash = undefined;
		deps.persist();
		ctx.ui.notify(`已切换到 ${mode} 模式。`, "info");
	}

	pi.registerCommand("answer", {
		description: "闭卷回答本会话的预问题（逐题输入并给出信心 1–5）",
		handler: async (_args, ctx) => {
			const state = deps.state();
			if (state.role !== "tutor") return ctx.ui.notify("当前不在陪读会话中。", "warning");
			if (!state.prequestions.length) return ctx.ui.notify("本会话还没有预问题；请等陪读老师调用 bb_prequestions。", "warning");
			const answers = await collect(ctx, state.prequestions.map((q) => ({ id: q.id, prompt: `${q.id}: ${q.text}` })), "闭卷作答：不要翻资料。");
			if (!answers) return;
			state.answers = answers;
			deps.persist();
			pi.sendUserMessage(`[mode: ${state.mode}] [closed-book answers] 请逐题批改（不含信心评分）：\n\n${answers.map((a) => `${a.id}: ${a.answer}`).join("\n\n")}`);
		},
	});

	pi.registerCommand("gloss", {
		description: "为某概念写术语表条目（自己的话）并请陪读老师核对：/gloss <概念id>",
		getArgumentCompletions: (prefix) => {
			const items = bb.concepts().filter((c) => c.id.startsWith(prefix)).map((c) => ({ value: c.id, label: `${c.id} ${c.name}` }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const state = deps.state();
			const id = args.trim();
			const c = bb.conceptIndex().get(id);
			if (!c) return ctx.ui.notify(`概念 ${id || "（未指定）"} 不在 concepts.json 中。`, "warning");
			const body = await ctx.ui.editor(`术语表条目：${c.name}（用自己的话；先占位，理解加深后再改为完整）`, "");
			if (!body?.trim()) return;
			const entry = `\n## ${c.name} <!-- id: ${c.id} -->\n状态：占位\n依赖：${c.prereqs?.length ? c.prereqs.join(", ") : "无"}\n\n${body.trim()}\n`;
			bb.appendText("glossary.md", entry);
			ctx.ui.notify("已写入 glossary.md。", "info");
			if (state.role === "tutor") pi.sendUserMessage(`[mode: ${state.mode}] [glossary check] 请核对以下术语表条目：\n${entry}`);
		},
	});

	pi.registerCommand("done", {
		description: "结束陪读会话：请陪读老师提交证据（bb_evidence）",
		handler: async (_args, ctx) => {
			const state = deps.state();
			if (state.role !== "tutor") return ctx.ui.notify("当前不在陪读会话中。", "warning");
			pi.sendUserMessage(`[mode: ${state.mode}] [end-session] 请调用 bb_evidence 提交本会话的结构化证据。`);
		},
	});

	pi.registerCommand("review", {
		description: "评审员：评审你的产出物，/review <文件> [单元id]",
		handler: async (args, ctx) => {
			const [file, unit] = args.trim().split(/\s+/).filter(Boolean);
			if (!file) return ctx.ui.notify("用法：/review <文件路径> [单元id]", "warning");
			const abs = resolve(ctx.cwd, file);
			if (!existsSync(abs)) return ctx.ui.notify(`文件不存在：${abs}`, "warning");
			await enter(ctx, "reviewer", { artifact: abs, unit }, `reviewer ${file} ${today()}`, kickoff("reviewer", { artifact: abs, unit }));
		},
	});

	pi.registerCommand("assess", {
		description: "复盘老师：生成一次闭卷检索测试，/assess [题数上限]",
		handler: async (args, ctx) => {
			const maxItems = Number.parseInt(args.trim(), 10) || 8;
			if (!bb.concepts().length) return ctx.ui.notify("还没有可考核的概念。", "warning");
			await enter(ctx, "assessor", {}, `assessor generate ${today()}`, kickoff("assessor", { maxItems }));
		},
	});

	pi.registerCommand("take", {
		description: "闭卷作答最近一次（或指定的）测试，然后交给复盘老师批改",
		handler: async (args, ctx) => {
			const pending = bb.listFiles("assessments", "pending-", ".json");
			const rel = args.trim() ? `assessments/${args.trim().replace(/^.*assessments[\\/]/, "")}` : pending.length ? `assessments/${pending[pending.length - 1]}` : undefined;
			if (!rel || !existsSync(bb.path(rel))) return ctx.ui.notify("没有待作答的测试；先运行 /assess。", "warning");
			const test = bb.readJson<{ items: Array<{ id: string; type: string; concept: string; question: string }> }>(rel, { items: [] });
			const responses = await collect(
				ctx,
				test.items.map((it) => ({ id: it.id, prompt: `[${it.id} · ${it.type} · ${it.concept}]\n${it.question}` })),
				"闭卷作答：不要翻资料，不要查术语表。",
			);
			if (!responses) return;
			const state = deps.state();
			const msg = `[grade] 学习者已完成测试 ${rel}。作答如下（含信心 1–5）：\n${JSON.stringify(responses, null, 1)}\n请按 rubric 逐题评分并调用 bb_grade。`;
			if (state.role === "assessor") {
				state.testFile = rel;
				state.responses = responses;
				state.contextHash = undefined;
				deps.persist();
				pi.sendUserMessage(msg);
			} else {
				await enter(ctx, "assessor", { testFile: rel, responses }, `assessor grade ${today()}`, msg);
			}
		},
	});

	pi.registerCommand("reflect", {
		description: "亲笔写复盘：在最近一份（或指定的）复盘提纲后作答，/reflect [文件]",
		handler: async (args, ctx) => {
			const outlines = bb.listFiles("reflections", "", "-outline.md");
			const rel = args.trim() ? `reflections/${args.trim().replace(/^.*reflections[\\/]/, "")}` : outlines.length ? `reflections/${outlines[outlines.length - 1]}` : undefined;
			if (!rel || !existsSync(bb.path(rel))) return ctx.ui.notify("没有复盘提纲；先完成一次 /take 与批改。", "warning");
			if (!ctx.hasUI) return ctx.ui.notify("该命令需要交互界面。", "warning");
			const current = bb.readText(rel);
			const edited = await ctx.ui.editor(`复盘：${rel}（提纲之后「我的复盘」一节由你亲笔作答）`, current);
			if (edited === undefined || edited === current) return ctx.ui.notify("未修改。", "info");
			bb.writeText(rel, edited.endsWith("\n") ? edited : `${edited}\n`);
			ctx.ui.notify(`已保存 ${rel}。`, "info");
		},
	});

	pi.registerCommand("artifact", {
		description: "写一份产出物到 blackboard/artifacts/：/artifact <文件名>（缺省扩展名 .md），然后可 /review",
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name) return ctx.ui.notify("用法：/artifact <文件名>", "warning");
			if (!/\.[a-z0-9]+$/i.test(name)) name += ".md";
			if (/[\\/]/.test(name)) return ctx.ui.notify("只接受文件名，不接受路径。", "warning");
			if (!ctx.hasUI) return ctx.ui.notify("该命令需要交互界面。", "warning");
			const rel = `artifacts/${name}`;
			const current = bb.readText(rel);
			const body = await ctx.ui.editor(`产出物：${rel}（在无 AI 协助下完成）`, current);
			if (body === undefined || !body.trim()) return;
			bb.writeText(rel, body.endsWith("\n") ? body : `${body}\n`);
			ctx.ui.notify(`已保存 blackboard/${rel}。评审：/review blackboard/${rel} [单元id]`, "info");
		},
	});

	pi.registerCommand("events", {
		description: "查看黑板上的未处理事件",
		handler: async (_args, ctx) => {
			const ev = bb.unhandledEvents();
			deps.note(ctx, ev.length ? ev.map((e) => `${e.ts}  ${e.type}  ${JSON.stringify(e.payload)}`).join("\n") + "\n\n运行 /dispatch 处理第一条。" : "没有未处理事件。");
		},
	});

	pi.registerCommand("dispatch", {
		description: "处理第一条未处理事件：structure_ready/resource_request → 馆员；unit_complete/errors_threshold → 考评官；replan_request → 规划者",
		handler: async (_args, ctx) => {
			const ev = bb.unhandledEvents()[0];
			if (!ev) return ctx.ui.notify("没有未处理事件。", "info");
			switch (ev.type) {
				case "structure_ready": {
					const units = bb.units().filter((u) => !u.sources?.length).map((u) => u.id);
					if (!units.length) {
						bb.markHandled(["structure_ready"]);
						return ctx.ui.notify("所有单元已有资料，事件已标记处理。", "info");
					}
					return enter(ctx, "librarian", {}, `librarian ${today()}`, kickoff("librarian", { units }));
				}
				case "resource_request": {
					const unit = String(ev.payload.unit ?? "");
					return enter(ctx, "librarian", { unit }, `librarian alt ${unit}`, kickoff("librarian", { unit, note: String(ev.payload.note ?? "未说明") }));
				}
				case "unit_complete":
				case "errors_threshold":
					return enter(ctx, "assessor", {}, `assessor generate ${today()}`, kickoff("assessor", { maxItems: 8 }));
				case "replan_request":
					return enter(ctx, "planner", {}, `planner replan ${today()}`, kickoff("planner", { replan: true }));
				default:
					bb.markHandled([ev.type]);
					return ctx.ui.notify(`未知事件 ${ev.type} 已标记处理。`, "warning");
			}
		},
	});

	pi.registerCommand("role", {
		description: "在当前会话原地切换角色（高级用法）：/role <planner|librarian|tutor|reviewer|assessor|none>",
		getArgumentCompletions: (prefix) => {
			const items = [...ROLE_NAMES, "none"].filter((r) => r.startsWith(prefix)).map((r) => ({ value: r, label: r }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const r = args.trim();
			if (r === "none") {
				await deps.applyRole(null, {}, undefined, ctx);
				ctx.ui.notify("已退出角色，恢复默认工具。", "info");
				return;
			}
			if (!ROLE_NAMES.includes(r as Role)) return ctx.ui.notify(`未知角色：${r}`, "warning");
			await deps.applyRole(r as Role, {}, undefined, ctx);
			ctx.ui.notify(`已进入 ${ROLES[r as Role].label}。`, "info");
		},
	});
}

/** 逐题弹出编辑器与信心选择；任一步取消则返回 null */
async function collect(ctx: ExtensionCommandContext, items: Array<{ id: string; prompt: string }>, banner: string): Promise<LearnerAnswer[] | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("该命令需要交互界面。", "warning");
		return null;
	}
	ctx.ui.notify(banner, "info");
	const out: LearnerAnswer[] = [];
	for (const it of items) {
		const answer = await ctx.ui.editor(it.prompt, "");
		if (answer === undefined) return null;
		const conf = await ctx.ui.select("信心（1 完全猜测 … 5 确定）", ["1", "2", "3", "4", "5"]);
		if (conf === undefined) return null;
		out.push({ id: it.id, answer: answer.trim(), confidence: Number(conf) });
	}
	return out;
}
