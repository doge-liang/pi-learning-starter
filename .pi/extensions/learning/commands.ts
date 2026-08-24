/**
 * commands.ts —— 仅存的两个斜杠命令：
 * - /learn：黑板概览 + 确定性的下一步建议，选中即执行（学习者的拉取入口）；
 * - /go：内部路由执行器。bb_route_ask 与提交类工具的尾部询问经 pi.sendUserMessage
 *   （expandPromptTemplates）派发 "/go <route>"，从而在命令上下文中获得 newSession 能力。
 *   会话切换只存在于命令上下文（pi 的约束），这条派发桥是工具触发会话切换的唯一途径。
 *
 * 角色会话的隔离仍靠 pi 的会话：进入角色的路由通过 ctx.newSession 切到新会话，
 * 目标角色经交接文件传给新的扩展实例（见 state.ts）。当前会话尚无消息时则原地进入角色。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { collectAnswers, editArtifact, editExemplar, editGloss, editReflection, runCollect, runVerify } from "./actions.ts";
import { type Blackboard, today } from "./blackboard.ts";
import { readConfig } from "./config.ts";
import { libraryReport } from "./library.ts";
import { kickoff, ROLES } from "./roles.ts";
import { hubMode, nextSteps, parseRoute, ROUTE_ACTIONS } from "./route.ts";
import { type LearningState, type Role, takeHandoff, writeHandoff } from "./state.ts";
import { applyProposal } from "./tools.ts";

const LATER = "稍后再说";

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

	/**
	 * 进入角色：会话为空则原地进入，否则切到新会话并交接。
	 * hub（常驻实例）模式下角色固定在实例上：同角色原地重进（重设单元等参数），
	 * 跨角色一律不切会话，提示学习者用 @ 唤醒对应实例。
	 */
	async function enter(ctx: ExtensionCommandContext, role: Role, partial: Partial<LearningState>, sessionName: string, kick: string) {
		if (hubMode()) {
			const current = deps.state().role;
			if (current && current !== role) {
				return ctx.ui.notify(`常驻实例模式下不切换角色：请用 @${ROLES[role].label.split("（")[0]} 唤醒对应实例。`, "warning");
			}
			await deps.applyRole(role, partial, undefined, ctx);
			pi.sendUserMessage(kick);
			return;
		}
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

	/** 执行一个路由串。进入角色、闸门确认、学习者侧编辑器都从这里走。 */
	async function executeRoute(route: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseRoute(route);
		if (!parsed) return ctx.ui.notify(`无法识别的路由：${route}。可用动作：${ROUTE_ACTIONS.join(", ")}。`, "warning");
		const { action, args } = parsed;
		const [a0, ...rest] = args.split(/\s+/).filter(Boolean);

		switch (action) {
			case "placement": {
				const existing = Boolean(bb.domain().domain);
				const maxItems = Number.parseInt(a0 ?? "", 10) || 10;
				return enter(ctx, "placement", {}, `placement ${today()}`, kickoff("placement", { maxItems, existing }));
			}
			case "plan": {
				if (!bb.domain().domain) return ctx.ui.notify("还没有学习者画像；先做水平测试（对前台说「开始水平测试」）。", "warning");
				const replan = args === "replan";
				const revise = args === "revise";
				if (revise) {
					const pending = bb.latestProposal("plan");
					if (!pending || !bb.readReview(pending)) return ctx.ui.notify("没有带评审意见的待接受规划提案；先送独立评审。", "warning");
				}
				return enter(ctx, "planner", {}, `planner ${revise ? "revise" : replan ? "replan" : "plan"} ${today()}`, kickoff("planner", { replan, revise }));
			}
			case "critique": {
				const file = a0 ? resolve(ctx.cwd, a0) : bb.latestProposal();
				if (!file || !existsSync(file)) return ctx.ui.notify("没有待审的提案文件；先请规划者或资料管理员提交提案。", "warning");
				const base = file.split(/[\\/]/).pop() ?? "proposal";
				return enter(ctx, "critic", { proposal: file }, `critic ${base} ${today()}`, kickoff("critic", { proposal: file }));
			}
			case "accept": {
				const file = a0 ? resolve(ctx.cwd, a0) : bb.latestProposal();
				if (!file || !existsSync(file)) return ctx.ui.notify("没有可接受的提案文件。", "warning");
				let summary = file;
				try {
					summary = bb.summarizeProposal(JSON.parse(readFileSync(file, "utf8")));
				} catch {
					/* 摘要失败时退回显示路径 */
				}
				// 有评审意见时一并提示：结论与各级发现数
				const review = bb.readReview(file) as { verdict?: string; counts?: { blocking?: number; major?: number; minor?: number } } | undefined;
				const reviewLine = review
					? `\n\n评审结论：${review.verdict}（blocking ${review.counts?.blocking ?? 0}，major ${review.counts?.major ?? 0}，minor ${review.counts?.minor ?? 0}）${review.verdict === "revise" ? "。评审员建议先请提案者修改。" : ""}`
					: "\n\n（尚未评审；也可以先送独立评审员审查。）";
				const ok = ctx.hasUI ? await ctx.ui.confirm("接受提案？", `${summary}${reviewLine}\n\n接受后写入黑板。要修改请回到该角色会话说明，由其重新提交。`) : false;
				if (!ok) return;
				try {
					deps.note(ctx, await bb.mutate(() => applyProposal(bb, file)));
				} catch (e) {
					ctx.ui.notify(String((e as Error).message ?? e), "error");
				}
				return;
			}
			case "sources": {
				const note = rest.join(" ");
				const units = a0 ? [a0] : bb.units().filter((u) => !u.sources?.length).map((u) => u.id);
				if (!units.length) return ctx.ui.notify("所有单元都已有资料；要请求替代资料请指定单元与障碍说明，要整理馆藏请路由 curate。", "info");
				return enter(ctx, "librarian", { unit: a0 }, `librarian ${today()}`, kickoff("librarian", { units, unit: a0, note: note || undefined }));
			}
			case "curate": {
				if (!bb.sources().length) return ctx.ui.notify("馆藏为空；先请资料管理员选材。", "warning");
				return enter(ctx, "librarian", { unit: a0 }, `librarian curate ${today()}`, kickoff("librarian", { curate: true, unit: a0 }));
			}
			case "read": {
				const unit = a0 ? bb.findUnit(a0) : bb.nextUnit();
				if (!unit) return ctx.ui.notify("没有可学习的单元；先完成规划与选材。", "warning");
				const units = bb.units();
				for (const u of units) if (u.id === unit.id) u.status = "active";
				bb.saveUnits(units);
				return enter(ctx, "tutor", { unit: unit.id, mode: "hint", prequestions: [], answers: [] }, `tutor ${unit.id} ${today()}`, kickoff("tutor"));
			}
			case "review": {
				if (!a0) return ctx.ui.notify("需要产出物文件路径：review <文件> [单元id]", "warning");
				const abs = resolve(ctx.cwd, a0);
				if (!existsSync(abs)) return ctx.ui.notify(`文件不存在：${abs}`, "warning");
				return enter(ctx, "reviewer", { artifact: abs, unit: rest[0] }, `reviewer ${a0} ${today()}`, kickoff("reviewer", { artifact: abs, unit: rest[0] }));
			}
			case "assess": {
				const maxItems = Number.parseInt(a0 ?? "", 10) || 8;
				if (!bb.concepts().length) return ctx.ui.notify("还没有可考核的概念。", "warning");
				return enter(ctx, "assessor", {}, `assessor generate ${today()}`, kickoff("assessor", { maxItems }));
			}
			case "take":
				return runTake(a0 ?? "", ctx);
			case "collect":
				return runCollect(bb, ctx, (t) => deps.note(ctx, t), a0 ?? "");
			case "verify": {
				await runVerify(bb, ctx, a0 ?? "");
				return;
			}
			case "library": {
				if (!bb.sources().length) return ctx.ui.notify("馆藏为空；先请资料管理员选材。", "info");
				return deps.note(ctx, libraryReport(bb, ctx.cwd, readConfig(ctx.cwd).library, a0));
			}
			case "reflect": {
				await editReflection(bb, ctx, args);
				return;
			}
			case "artifact": {
				await editArtifact(bb, ctx, a0 ?? "");
				return;
			}
			case "exemplar": {
				await editExemplar(bb, ctx, a0 ?? "");
				return;
			}
			case "gloss": {
				const state = deps.state();
				const entry = await editGloss(bb, ctx, a0 ?? "");
				if (entry && state.role === "tutor") pi.sendUserMessage(`[mode: ${state.mode}] [glossary check] 请核对以下术语表条目：\n${entry}`);
				return;
			}
			case "none": {
				if (hubMode()) return ctx.ui.notify("常驻实例的角色是固定的，不支持退出学习模式；维护项目请在终端里进行。", "warning");
				await deps.applyRole(null, { optOut: true }, undefined, ctx);
				ctx.ui.notify("已退出学习模式，恢复普通编码助手（含文件写入与 shell）。", "info");
				return;
			}
		}
	}

	/** 闭卷作答最近一次（或指定的）测试，作答后交给相应角色批改 */
	async function runTake(fileArg: string, ctx: ExtensionCommandContext): Promise<void> {
		// 待作答的测试可能在 assessments/（复盘）或 placement/（入学诊断）；取最近写入的一份
		let rel: string | undefined;
		if (fileArg) {
			const base = fileArg.replace(/^.*[\\/]/, "");
			rel = fileArg.includes("placement") ? `placement/${base}` : `assessments/${base}`;
		} else {
			const candidates = [
				...bb.listFiles("assessments", "pending-", ".json").map((f) => `assessments/${f}`),
				...bb.listFiles("placement", "pending-", ".json").map((f) => `placement/${f}`),
			];
			candidates.sort((a, b) => statSync(bb.path(a)).mtimeMs - statSync(bb.path(b)).mtimeMs);
			rel = candidates[candidates.length - 1];
		}
		if (!rel || !existsSync(bb.path(rel))) return ctx.ui.notify("没有待作答的测试。", "warning");
		const isPlacement = rel.startsWith("placement/");
		const test = bb.readJson<{ items: Array<{ id: string; type: string; concept?: string; area?: string; level?: string; question: string }> }>(rel, { items: [] });
		const responses = await collectAnswers(
			ctx,
			test.items.map((it) => ({ id: it.id, prompt: `[${it.id} · ${it.type} · ${isPlacement ? `${it.area} · ${it.level}` : it.concept}]\n${it.question}` })),
			isPlacement ? "水平测试，闭卷作答：不确定就写不知道，这是为了定位起点，不是考核。" : "闭卷作答：不要翻资料，不要查术语表。",
		);
		if (!responses) return;
		const state = deps.state();
		const role = isPlacement ? "placement" : "assessor";
		const msg = isPlacement
			? `[grade-placement] 学习者已完成水平测试 ${rel}。作答如下（含信心 1–5）：\n${JSON.stringify(responses, null, 1)}\n请按 rubric 逐题评分并调用 bb_placement_grade。`
			: `[grade] 学习者已完成测试 ${rel}。作答如下（含信心 1–5）：\n${JSON.stringify(responses, null, 1)}\n请按 rubric 逐题评分并调用 bb_grade。`;
		if (state.role === role) {
			state.testFile = rel;
			state.responses = responses;
			state.contextHash = undefined;
			deps.persist();
			pi.sendUserMessage(msg);
		} else {
			await enter(ctx, role, { testFile: rel, responses }, `${role} grade ${today()}`, msg);
		}
	}

	pi.registerCommand("learn", {
		description: "黑板概览与下一步：查看状态，从建议里选择并直接执行",
		handler: async (_args, ctx) => {
			const steps = nextSteps(bb);
			const snoozed = new Set(deps.state().snoozed ?? []);
			const lines = steps.map((s, i) => `${i + 1}. ${s.label}（${s.reason}）${snoozed.has(s.key) ? "［已搁置］" : ""}`);
			deps.note(ctx, bb.status() + (lines.length ? `\n\n下一步建议：\n${lines.join("\n")}` : ""));
			if (!ctx.hasUI || !steps.length) return;
			const labels = steps.map((s) => s.label);
			const pick = await ctx.ui.select("接下来做什么？", [...labels, LATER]);
			if (!pick || pick === LATER) return;
			await executeRoute(steps[labels.indexOf(pick)].route, ctx);
		},
	});

	pi.registerCommand("go", {
		description: "（内部）执行一个路由，由对话框选择派发；日常使用直接对前台说话即可。/go <动作> [参数]",
		getArgumentCompletions: (prefix) => {
			const items = ROUTE_ACTIONS.filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const route = args.trim();
			if (!route) return ctx.ui.notify(`用法：/go <动作> [参数]；动作：${ROUTE_ACTIONS.join(", ")}。日常使用请直接对前台说话，或运行 /learn。`, "warning");
			await executeRoute(route, ctx);
		},
	});
}
