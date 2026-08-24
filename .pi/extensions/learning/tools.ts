/**
 * tools.ts —— bb_* 工具：模型改写黑板的唯一入口，以及经对话框收口的学习者侧流程入口。
 *
 * 每个工具先检查当前角色（防止串角色调用），再把模型提交的结构化内容交给 blackboard.ts 的
 * 规则函数处理。工具都以 executionMode: "sequential" 注册，避免并行写黑板文件。
 *
 * 两类对话框收口（内容一律由代码拼装，模型只掌握触发时机）：
 * - 提交类工具的尾部询问：提案 / 测试落盘后向学习者弹一次选择框，选定的路由派发 /go 执行；
 * - bb_route_ask 与前台工具（bb_collect、bb_verify、bb_learner_edit 等）：路由与杂务的入口。
 * 非交互模式下所有闸门一律不通过（写入照常，裁决缺席时不代替学习者选择）。
 */
import { existsSync, readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectAnswers, editArtifact, editExemplar, editGloss, editReflection, runCollect, runVerify } from "./actions.ts";
import {
	acceptCurate,
	acceptPlan,
	acceptSources,
	ACCESS_LEVELS,
	Blackboard,
	type Concept,
	type CurateProposal,
	FAIL,
	onFail,
	onPartial,
	onPass,
	PASS,
	promote,
	type Source,
	stamp,
	today,
	type Unit,
} from "./blackboard.ts";
import { readConfig } from "./config.ts";
import { libraryReport } from "./library.ts";
import { ROLES } from "./roles.ts";
import { hubMode, renderRoute, ROUTE_ACTIONS, targetRoleOfRoute } from "./route.ts";
import type { LearningState, Role } from "./state.ts";

export interface ToolDeps {
	bb: Blackboard;
	state: () => LearningState;
	persist: () => void;
}

const LATER = "稍后再说";

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: {} };
}

function requireRole(state: LearningState, ...roles: Role[]) {
	if (!state.role || !roles.includes(state.role)) {
		throw new Error(`该工具只在 ${roles.join(" / ")} 角色会话中可用；当前角色：${state.role ?? "无"}。请学习者经前台进入相应角色。`);
	}
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
	const { bb } = deps;

	/** 学习者可见的整段输出（对话之外的正文），与 /learn 的概览走同一渲染 */
	function note(t: string) {
		pi.appendEntry("learning-note", { text: t });
	}

	/** 常驻实例模式下用于提示学习者 @ 的短角色名 */
	function shortLabel(role: Role): string {
		return ROLES[role].label.split("（")[0];
	}

	/**
	 * 尾部询问：向学习者弹一次选择框，选定的路由派发给 /go 执行。
	 * 选项文字由调用处的代码拼装；永远附带「稍后再说」。返回给模型的是学习者的选择结果。
	 * 常驻实例（hub）模式下过滤掉跨角色的选项，改为提示学习者用 @ 唤醒对应实例。
	 */
	async function askNext(ctx: ExtensionContext, title: string, options: Array<{ label: string; route: string }>): Promise<string> {
		let opts = options;
		let hint = "";
		if (hubMode()) {
			const role = deps.state().role;
			const dropped = options.filter((o) => {
				const t = targetRoleOfRoute(bb, o.route);
				return t !== null && t !== role;
			});
			opts = options.filter((o) => !dropped.includes(o));
			if (dropped.length) {
				hint = `\n跨角色的下一步请让学习者用 @ 唤醒对应实例：${dropped.map((o) => `@${shortLabel(targetRoleOfRoute(bb, o.route) as Role)}（${o.label}）`).join("；")}。`;
			}
		}
		if (!ctx.hasUI || !opts.length) return hint;
		const labels = opts.map((o) => o.label);
		const pick = await ctx.ui.select(title, [...labels, LATER]);
		if (!pick || pick === LATER) return `\n学习者选择稍后处理；不要催促。${hint}`;
		const chosen = opts[labels.indexOf(pick)];
		pi.sendUserMessage(`/go ${chosen.route}`, { expandPromptTemplates: true });
		return `\n学习者选择：${pick}。已派发执行。${hint}`;
	}

	// ------------------------------------------------------------------ 通用
	pi.registerTool({
		name: "bb_status",
		label: "黑板概览",
		description: "读取黑板概览：领域、掌握度分布、当前单元、到期复习数、未解决错误数、未处理事件。",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			return text(bb.status());
		},
	});

	// ------------------------------------------------------------------ 路由（前台为主，各角色在自然边界也可用）
	pi.registerTool({
		name: "bb_route_ask",
		label: "路由询问",
		description:
			"向学习者弹出下一步选择框并在选定后派发执行。routes 为路由串数组：优先取黑板上下文「下一步建议」的 route 字段，也可按学习者的明确意图构造（如 \"read u01\"、\"sources u02 现有资料推导跳步\"）。选择框文字由代码从黑板拼装，永远附带「稍后再说」。一轮至多调用一次；学习者选过稍后的不要再主动重提。",
		parameters: Type.Object({
			routes: Type.Array(Type.String({ description: "路由串：动作 + 参数" }), { minItems: 1, maxItems: 4 }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "concierge", "placement", "planner", "librarian", "tutor", "assessor");
			if (!ctx.hasUI) return text("非交互模式无法弹出选择框；请在交互会话中推进。");
			const rendered = params.routes.map((r) => ({ route: r.trim(), label: renderRoute(bb, ctx.cwd, r.trim()) }));
			const bad = rendered.filter((r) => !r.label);
			if (bad.length) {
				return text(`这些路由无效或目标不存在：${bad.map((b) => b.route).join("；")}。可用动作：${ROUTE_ACTIONS.join(", ")}。请修正后重试。`);
			}
			if (hubMode()) {
				const cross = rendered.filter((r) => {
					const t = targetRoleOfRoute(bb, r.route);
					return t !== null && t !== state.role;
				});
				if (cross.length) {
					return text(
						`常驻实例模式下不切换角色。请告诉学习者用 @ 唤醒对应实例：${cross.map((c) => `@${shortLabel(targetRoleOfRoute(bb, c.route) as Role)}（${c.label}）`).join("；")}。本工具只用于角色无关的动作（accept / take / collect / verify / library / reflect / artifact / exemplar / gloss）或本角色内的路由。`,
					);
				}
			}
			const labels = rendered.map((r) => r.label as string);
			const pick = await ctx.ui.select("接下来做什么？", [...labels, LATER]);
			if (!pick || pick === LATER) {
				const snoozed = new Set(state.snoozed ?? []);
				for (const r of rendered) snoozed.add(r.route);
				state.snoozed = [...snoozed];
				state.contextHash = undefined;
				deps.persist();
				return text("学习者选择稍后。不要再主动重提这些建议；学习者自己提起时再处理。");
			}
			pi.sendUserMessage(`/go ${rendered[labels.indexOf(pick)].route}`, { expandPromptTemplates: true });
			return text(`学习者选择：${pick}。已派发执行，本轮不需要你再推进别的。`);
		},
	});

	// ------------------------------------------------------------------ 前台：收集、核验、馆藏、编辑器
	pi.registerTool({
		name: "bb_collect",
		label: "获取资料",
		description:
			"启动一份资料的收集流程：呈现获取清单，下载（仅开放获取或机构权限且有直链）或由学习者登记本地路径，可选入 Zotero 与网盘，最后登记台账。每一步都经学习者确认，你无法代替确认。不带 id 时由学习者从未获取列表中选择。",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "资料 id；省略则由学习者选择" })) }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "concierge");
			if (!ctx.hasUI) return text("收集流程需要交互界面。");
			const id = params.id?.trim() ?? "";
			await runCollect(bb, ctx, note, id);
			const s = id ? bb.sources().find((x) => x.id === id) : undefined;
			return text(s ? `收集流程结束。${s.id} 当前获取状态：${s.acquisition?.status ?? "pending"}${s.acquisition?.local_path ? `，本地副本 ${s.acquisition.local_path}` : ""}。` : "收集流程结束（结果以通知与台账为准）。");
		},
	});

	pi.registerTool({
		name: "bb_verify",
		label: "核验资料",
		description:
			"请学习者确认已亲自打开某份资料（verified 置位的唯一路径）。只在学习者表示已经打开过资料时调用；确认框的默认取向是「还没打开就取消」，你不能代替学习者确认。不带 id 时由学习者从未核验列表中选择。",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "资料 id；省略则由学习者选择" })) }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "concierge");
			if (!ctx.hasUI) return text("核验需要交互界面。");
			const ok = await runVerify(bb, ctx, params.id?.trim() ?? "");
			return text(ok ? "学习者已确认核验。" : "未核验（学习者取消或资料不存在）。不要代替学习者标记核验。");
		},
	});

	pi.registerTool({
		name: "bb_library_report",
		label: "馆藏概览",
		description: "生成馆藏概览：按单元列出资料、获取等级、是否已获取、是否已核验、本地副本与入库去向，末尾汇总缺口。概览全文会直接展示给学习者。",
		parameters: Type.Object({ unit: Type.Optional(Type.String({ description: "只看某个单元；省略为全部" })) }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "concierge", "librarian");
			const report = libraryReport(bb, ctx.cwd, readConfig(ctx.cwd).library, params.unit?.trim() || undefined);
			note(report);
			return text(report);
		},
	});

	pi.registerTool({
		name: "bb_learner_edit",
		label: "打开学习者编辑器",
		description:
			"为学习者打开一个亲笔编辑器：kind=artifact 写产出物（name 为文件名，缺省扩展名 .md）；kind=exemplar 粘贴规划范例（name 为范例名）；kind=reflection 在最近一份复盘提纲后作答（name 可省略）。内容由学习者填写，你不提供草稿、不代写。",
		parameters: Type.Object({
			kind: StringEnum(["artifact", "exemplar", "reflection"] as const),
			name: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "concierge");
			if (!ctx.hasUI) return text("编辑器需要交互界面。");
			const name = params.name?.trim() ?? "";
			if (params.kind === "artifact") {
				const rel = await editArtifact(bb, ctx, name);
				return text(rel ? `已保存 blackboard/${rel}。要评审时用 bb_route_ask 提议 review blackboard/${rel} [单元id]。` : "学习者取消或内容为空，未保存。");
			}
			if (params.kind === "exemplar") {
				const rel = await editExemplar(bb, ctx, name);
				return text(rel ? `已保存 blackboard/${rel}；规划者与评审员会在下次进入时看到。` : "学习者取消或内容为空，未保存。");
			}
			const saved = await editReflection(bb, ctx, name);
			return text(saved ? "复盘已保存。" : "复盘未修改或没有可写的提纲。");
		},
	});

	// ------------------------------------------------------------------ 水平测试官：画像
	pi.registerTool({
		name: "bb_domain_set",
		label: "写入学习者画像",
		description:
			"水平测试第一步（画像对话）结束时写入 blackboard/domain.json：领域、可检验的目标、背景、每周小时数、语言、资料偏好。已有字段按提交内容覆盖，未提交的字段保留。写入前学习者在对话框里最终确认。",
		parameters: Type.Object({
			domain: Type.String({ description: "领域，一句话" }),
			goal: Type.String({ description: "可检验的目标：学完后能独立做到什么" }),
			background: Type.String({ description: "已有知识与经验" }),
			weekly_hours: Type.Number({ minimum: 0, description: "每周可投入小时数" }),
			language: Type.String({ description: "对话与资料语言，如 zh / en" }),
			preferences: Type.Optional(
				Type.Object({
					formats: Type.Optional(Type.Array(Type.String(), { description: "textbook / paper / course / code / video / doc / blog" })),
					languages: Type.Optional(Type.Array(Type.String(), { description: "可接受的资料语言" })),
					notes: Type.Optional(Type.String({ description: "其他偏好或限制" })),
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "placement");
			// 闸门在非交互模式下一律不通过：画像写入需要学习者在场确认
			if (!ctx.hasUI) return text("非交互模式无法确认画像写入；请在交互会话中完成画像。");
			const summary = [
				`领域：${params.domain}`,
				`目标：${params.goal}`,
				`背景：${params.background}`,
				`每周 ${params.weekly_hours} 小时；语言 ${params.language}`,
				params.preferences ? `偏好：${JSON.stringify(params.preferences)}` : "",
			]
				.filter(Boolean)
				.join("\n");
			const ok = await ctx.ui.confirm("写入 domain.json？", summary);
			if (!ok) return text("学习者未确认写入。请根据学习者的补充修改后重新提交 bb_domain_set。");
			await bb.mutate(() => bb.saveDomain(params));
			const state = deps.state();
			state.contextHash = undefined;
			deps.persist();
			return text("已写入 blackboard/domain.json。请继续水平测试的第二步：依据画像出题并调用 bb_placement_create 写入。");
		},
	});

	// ------------------------------------------------------------------ 水平测试官：出题与批改
	pi.registerTool({
		name: "bb_placement_create",
		label: "写入水平测试",
		description: "水平测试官写入一次入学诊断测试到 blackboard/placement/pending-*.json，并随即询问学习者是否立即闭卷作答。每题带考察领域（area）与难度层级。",
		parameters: Type.Object({
			areas: Type.Array(Type.Object({ area: Type.String({ description: "考察领域名，如 线性代数 / Python / 体系结构-缓存" }), why: Type.String({ description: "为什么目标预设这一领域" }) }), { minItems: 1, maxItems: 8 }),
			items: Type.Array(
				Type.Object({
					id: Type.String({ description: "如 p1" }),
					area: Type.String({ description: "所属领域名，须与 areas 中一致" }),
					level: StringEnum(["basic", "intermediate", "advanced"] as const),
					type: StringEnum(["recall", "discriminate", "apply"] as const),
					question: Type.String(),
					reference: Type.String({ description: "参考答案" }),
					rubric: Type.String({ description: "评分要点" }),
				}),
				{ minItems: 1, maxItems: 30 },
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "placement");
			const areaNames = new Set(params.areas.map((a) => a.area));
			for (const it of params.items) if (!areaNames.has(it.area)) throw new Error(`题目 ${it.id} 的领域 ${it.area} 不在 areas 中`);
			const rel = `placement/pending-${stamp()}.json`;
			await bb.mutate(() => bb.writeJson(rel, { date: today(), kind: "placement", areas: params.areas, items: params.items }));
			const asked = await askNext(ctx, `水平测试已就绪（${params.items.length} 题，${params.areas.length} 个领域），现在闭卷作答？`, [
				{ label: "现在闭卷作答", route: "take" },
			]);
			return text(`水平测试已写入 ${rel}（${params.items.length} 题，${params.areas.length} 个领域）。不要在对话中透露参考答案。${asked}`);
		},
	});

	pi.registerTool({
		name: "bb_placement_grade",
		label: "提交水平测试批改",
		description:
			"水平测试官提交逐题评分、各领域到达层级、优势与缺口、给规划者的建议。工具按领域聚合得分，写入 blackboard/placement/*-result.json，并把结论写进 domain.json 的 placement 字段；不改任何掌握度。",
		parameters: Type.Object({
			grades: Type.Array(Type.Object({ id: Type.String(), score: Type.Number({ minimum: 0, maximum: 1, description: "1、0.5 或 0" }), comment: Type.String() })),
			by_area: Type.Array(Type.Object({ area: Type.String(), level_reached: StringEnum(["none", "basic", "intermediate", "advanced"] as const), note: Type.String() })),
			strengths: Type.Array(Type.String()),
			gaps: Type.Array(Type.String({ description: "前置缺口；规划者会为此插入补救单元" })),
			recommendations: Type.String({ description: "给规划者：从哪里起步、可跳过什么、第一个单元难度如何定；以及对学习者校准的观察" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "placement");
			if (!state.testFile || !state.testFile.startsWith("placement/") || !state.responses.length) {
				throw new Error("尚未收集学习者作答：请学习者先闭卷作答水平测试（bb_route_ask 提议 take），再进行批改。");
			}
			const { areaRows, overall, gap, resultRel } = await bb.mutate(() => {
				const test = bb.readJson<{ items: Array<{ id: string; area: string; level: string }> }>(state.testFile as string, { items: [] });
				const grades = new Map(params.grades.map((g) => [g.id, g]));
				const levelOf = new Map(params.by_area.map((a) => [a.area, a]));
				// 规则在代码：按领域聚合得分；层级判断由模型给出，分数由工具算
				const byArea = new Map<string, number[]>();
				for (const it of test.items) byArea.set(it.area, [...(byArea.get(it.area) ?? []), Number(grades.get(it.id)?.score ?? 0)]);
				const areaRows = [...byArea].map(([area, scores]) => ({
					area,
					score: round3(scores.reduce((a, b) => a + b, 0) / scores.length),
					items: scores.length,
					level_reached: levelOf.get(area)?.level_reached ?? "none",
					note: levelOf.get(area)?.note,
				}));
				const all = test.items.map((it) => Number(grades.get(it.id)?.score ?? 0));
				const overall = all.length ? round3(all.reduce((a, b) => a + b, 0) / all.length) : 0;
				const conf = state.responses.map((r) => (r.confidence - 1) / 4);
				const scoreByResp = state.responses.map((r) => Number(grades.get(r.id)?.score ?? 0));
				const gap = scoreByResp.length ? round3(conf.reduce((acc, c, i) => acc + (c - scoreByResp[i]), 0) / scoreByResp.length) : 0;

				const resultRel = `placement/${stamp()}-result.json`;
				bb.writeJson(resultRel, { date: today(), test: state.testFile, responses: state.responses, grades: params.grades, by_area: areaRows, overall, calibration_gap: gap, strengths: params.strengths, gaps: params.gaps, recommendations: params.recommendations });
				bb.renamePending(state.testFile as string);
				bb.saveDomain({ placement: { date: today(), overall, by_area: areaRows, strengths: params.strengths, gaps: params.gaps, recommendations: params.recommendations, result_file: resultRel } });
				return { areaRows, overall, gap, resultRel };
			});

			state.testFile = undefined;
			state.responses = [];
			state.contextHash = undefined;
			deps.persist();
			const asked = await askNext(ctx, "水平测试已批改，进入规划？", [{ label: "请领域专家依据结果规划学习路径", route: "plan" }]);
			return text(
				[
					`结果已写入 ${resultRel}，结论已写入 domain.json 的 placement 字段；总分 ${overall}，校准偏差 ${gap}（正值为过度自信）。`,
					`各领域：${areaRows.map((a) => `${a.area} ${a.score}（${a.level_reached}）`).join("；")}。`,
					`请向学习者说明结果；规划者会据此定起点。${asked}`,
				].join("\n"),
			);
		},
	});

	// ------------------------------------------------------------------ 领域专家
	pi.registerTool({
		name: "bb_plan_propose",
		label: "提交规划提案",
		description:
			"领域专家提交知识结构与学习路径的提案。提案写入 blackboard/proposals/，并随即询问学习者送独立评审、接受或稍后；学习者接受后才写入 concepts.json 与 path.json。",
		parameters: Type.Object({
			concepts: Type.Array(
				Type.Object({
					id: Type.String({ description: "kebab-case 概念 id，重规划时保留已有 id" }),
					name: Type.String({ description: "中文名（English）" }),
					tier: StringEnum(["core", "branch"] as const),
					prereqs: Type.Array(Type.String(), { description: "真正阻塞理解的前置概念 id" }),
					uncertain: Type.Optional(Type.Boolean()),
				}),
			),
			units: Type.Array(
				Type.Object({
					id: Type.String({ description: "如 u01" }),
					title: Type.String(),
					concepts: Type.Array(Type.String()),
					exercises: Type.Array(Type.String()),
					exit_criteria: Type.Array(Type.String({ description: "学习者不看资料能做到什么" })),
				}),
			),
			notes: Type.String({ description: "依据的教材、版次与说明；重规划时说明每处改动的依据" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "planner");
			// 前置关系不得指向不存在的概念，也不得成环（简单检查）
			const ids = new Set(params.concepts.map((c) => c.id));
			for (const c of params.concepts) {
				for (const p of c.prereqs) if (!ids.has(p)) throw new Error(`概念 ${c.id} 的前置 ${p} 不在提案中`);
			}
			if (hasCycle(params.concepts)) throw new Error("前置关系存在环，请修正后重新提交");
			const path = await bb.mutate(() => bb.writeProposal("plan", params));
			const summary = bb.summarizeProposal(params as { concepts: Concept[]; units: Unit[]; notes: string });
			const asked = await askNext(ctx, "规划提案已提交，接下来？", [
				{ label: "送独立评审（另开评审会话）", route: "critique" },
				{ label: "审阅并接受（弹出摘要确认）", route: "accept" },
			]);
			return text(`提案已写入 ${path}。

${summary}

请把上面的摘要转述给学习者；学习者在对话里提出调整时，修改后重新调用 bb_plan_propose 提交。${asked}`);
		},
	});

	// ------------------------------------------------------------------ 提案评审员
	pi.registerTool({
		name: "bb_proposal_review",
		label: "提交提案评审",
		description:
			"提案评审员对一份尚未接受的提案（规划或资料）提交独立审查结果：逐条发现（严重程度、对象、问题、建议）与结论。写入与提案同名的 *.review.json / *.review.md，并随即询问学习者接受提案还是请提案者修改；不修改提案本身。存在 blocking 发现时结论必须为 revise。",
		parameters: Type.Object({
			verdict: StringEnum(["accept", "revise"] as const),
			summary: Type.String({ description: "一两句话：提案总体是否可用、主要问题是什么" }),
			findings: Type.Array(
				Type.Object({
					severity: StringEnum(["blocking", "major", "minor"] as const),
					target: Type.String({ description: "概念 id、单元 id、资料 id，或 structure" }),
					issue: Type.String(),
					suggestion: Type.String({ description: "建议的修改方向，不代写完整内容" }),
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "critic");
			const file = state.proposal;
			if (!file || !existsSync(file)) throw new Error("没有待审提案：请学习者重新发起评审并指定提案文件。");
			const blocking = params.findings.filter((f) => f.severity === "blocking").length;
			if (blocking > 0 && params.verdict === "accept") throw new Error("存在 blocking 发现时结论必须为 revise，请修正后重新提交。");
			const major = params.findings.filter((f) => f.severity === "major").length;
			const minor = params.findings.length - blocking - major;
			const data = { proposal: file, ...params, counts: { blocking, major, minor }, recorded_at: new Date().toISOString() };
			const lines = [`# 提案评审：${file}`, ``, `结论：${params.verdict}（blocking ${blocking}，major ${major}，minor ${minor}）`, ``, params.summary, ``];
			for (const f of params.findings) lines.push(`- [${f.severity}] ${f.target}：${f.issue}（建议：${f.suggestion}）`);
			const out = await bb.mutate(() => bb.writeReview(file, data, lines.join("\n") + "\n"));
			// 修改路由按提案类型定：plan → 规划者按意见修改；sources / curate → 馆员重新提交
			const base = file.split(/[\\/]/).pop() ?? "";
			const reviseRoute = base.startsWith("plan-") ? "plan revise" : base.startsWith("curate-") ? "curate" : "sources";
			const asked = await askNext(
				ctx,
				`评审结论 ${params.verdict}（blocking ${blocking}，major ${major}，minor ${minor}），接下来？`,
				params.verdict === "revise"
					? [
							{ label: "请提案者按评审意见修改", route: reviseRoute },
							{ label: "仍然接受提案（弹出摘要确认）", route: "accept" },
						]
					: [{ label: "审阅并接受提案（弹出摘要确认）", route: "accept" }],
			);
			return text(
				[
					`评审已写入 ${out.md}。`,
					`结论 ${params.verdict}：blocking ${blocking}，major ${major}，minor ${minor}。`,
					`请把发现要点转述给学习者。${asked}`,
				].join("\n"),
			);
		},
	});

	// ------------------------------------------------------------------ 资料管理员
	pi.registerTool({
		name: "bb_sources_propose",
		label: "提交资料提案",
		description: "资料管理员提交单元与资料的映射提案。写入 blackboard/proposals/，并随即询问学习者送评审、接受或稍后；接受后写入 sources.json 并挂到单元上。",
		parameters: Type.Object({
			sources: Type.Array(
				Type.Object({
					id: Type.String({ description: "kebab-case 资料 id" }),
					title: Type.String({ description: "精确标题" }),
					type: StringEnum(["textbook", "paper", "course", "doc", "blog", "video", "other"] as const),
					locator: Type.String({ description: "书名+版次+章节 / DOI 或 arXiv / 完整 URL / unknown" }),
					covers: Type.Array(Type.String(), { description: "覆盖的概念 id" }),
					for_units: Type.Array(Type.String(), { description: "适用的单元 id" }),
					est_minutes: Type.Integer({ minimum: 1 }),
					quality_note: Type.String({ description: "为何选它、可靠程度、不确定之处" }),
					alternative: Type.Optional(Type.Boolean({ description: "是否为替代讲解资料" })),
					access: Type.Optional(
						StringEnum(ACCESS_LEVELS, {
							description: "获取等级：open 开放获取 / campus 需机构或图书馆权限 / paid 需购买 / physical 纸质馆藏 / unavailable 暂无渠道 / unknown 未判定",
						}),
					),
					acquire_note: Type.Optional(Type.String({ description: "怎么拿到：开放获取版本的完整 URL、图书馆检索式、课程页面、购买渠道。" })),
					meta: Type.Optional(
						Type.Object(
							{
								authors: Type.Optional(Type.Array(Type.String())),
								year: Type.Optional(Type.Integer()),
								publisher: Type.Optional(Type.String()),
								edition: Type.Optional(Type.String()),
								container: Type.Optional(Type.String({ description: "期刊名、丛书名或课程名" })),
								pages: Type.Optional(Type.String()),
								doi: Type.Optional(Type.String()),
								isbn: Type.Optional(Type.String()),
								url: Type.Optional(Type.String({ description: "可直接获取的 URL，优先开放获取版本" })),
								language: Type.Optional(Type.String()),
							},
							{ description: "题录元数据：决定学习者能否一键入 Zotero；不确定的字段留空，不要编造" },
						),
					),
					tags: Type.Optional(Type.Array(Type.String(), { description: "少量可检索的标签" })),
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "librarian");
			const path = await bb.mutate(() => bb.writeProposal("sources", params));
			const summary = bb.summarizeProposal(params as { sources: Source[] });
			const asked = await askNext(ctx, "资料提案已提交，接下来？", [
				{ label: "送独立评审（另开评审会话）", route: "critique" },
				{ label: "审阅并接受（弹出摘要确认）", route: "accept" },
			]);
			return text(`提案已写入 ${path}。

${summary}

请把上面的摘要转述给学习者；学习者在对话里提出调整时，修改后重新调用 bb_sources_propose 提交。接受后由前台推进获取与核验。${asked}`);
		},
	});

	pi.registerTool({
		name: "bb_sources_curate",
		label: "提交资料整理提案",
		description: "资料管理员提交馆藏整理提案：合并重复、下线失效、排定单元内阅读顺序、打标签、记录覆盖缺口。写入 blackboard/proposals/，并随即询问学习者接受或稍后；接受后改写 sources.json 与 path.json 的索引，不会删除任何本地文件。",
		parameters: Type.Object({
			retire: Type.Optional(
				Type.Array(Type.Object({ id: Type.String(), reason: Type.String({ description: "为何下线：链接失效、被更好的资料取代、与单元不再相关" }) }), { description: "下线的资料" }),
			),
			merge: Type.Optional(
				Type.Array(
					Type.Object({
						keep: Type.String({ description: "保留的资料 id（定位最精确的那条）" }),
						drop: Type.Array(Type.String(), { description: "并入并随之下线的资料 id" }),
						reason: Type.String(),
					}),
					{ description: "同一份资料的不同版本或入口的合并" },
				),
			),
			reorder: Type.Optional(
				Type.Array(Type.Object({ unit: Type.String(), order: Type.Array(Type.String(), { description: "该单元资料的阅读顺序：主资料在前，替代讲解在后，参考手册最后" }) })),
			),
			tag: Type.Optional(Type.Array(Type.Object({ id: Type.String(), tags: Type.Array(Type.String()) }), { description: "少量可检索的标签，不要堆砌" })),
			gaps: Type.Optional(
				Type.Array(
					Type.Object({
						scope: StringEnum(["unit", "concept"] as const),
						id: Type.String(),
						note: Type.String({ description: "缺什么" }),
						suggestion: Type.Optional(Type.String({ description: "补料方向" })),
					}),
					{ description: "对照黑板上下文的「馆藏缺口」列出仍未覆盖的单元或概念" },
				),
			),
			notes: Type.Optional(Type.String({ description: "整理的总体依据" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "librarian");
			const proposal = { kind: "curate" as const, ...params };
			const path = await bb.mutate(() => bb.writeProposal("curate", proposal));
			const summary = bb.summarizeProposal(proposal);
			const asked = await askNext(ctx, "整理提案已提交，接下来？", [{ label: "审阅并接受（弹出摘要确认）", route: "accept" }]);
			return text(`整理提案已写入 ${path}。

${summary}

请把上面的摘要转述给学习者；学习者在对话里提出调整时，修改后重新调用 bb_sources_curate 提交。整理只改索引，不会删除本地副本。${asked}`);
		},
	});

	pi.registerTool({
		name: "bb_check_link",
		label: "检查链接",
		description: "检查一个 URL 是否可达（HEAD，失败则 GET）。可达不等于内容正确，只是排除明显编造。",
		parameters: Type.Object({ url: Type.String() }),
		async execute(_id, params, signal) {
			requireRole(deps.state(), "librarian");
			const ok = await checkLink(params.url, signal);
			return { content: [{ type: "text", text: `${params.url} → ${ok ? "可达" : "不可达"}` }], details: { reachable: ok } };
		},
	});

	// ------------------------------------------------------------------ 陪读老师
	pi.registerTool({
		name: "bb_prequestions",
		label: "登记预问题",
		description: "陪读老师在会话开始时登记 3 到 5 个预问题；学习者读完资料表示要作答时，调用 bb_collect_answers 收集闭卷作答。",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.String({ description: "如 q1" }),
					text: Type.String(),
					concept: Type.Optional(Type.String({ description: "对应的概念 id" })),
				}),
				{ minItems: 1, maxItems: 8 },
			),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const state = deps.state();
			requireRole(state, "tutor");
			state.prequestions = params.questions;
			state.answers = [];
			deps.persist();
			return text(`已登记 ${params.questions.length} 个预问题。等待学习者阅读；学习者说要作答时调用 bb_collect_answers。`);
		},
	});

	pi.registerTool({
		name: "bb_collect_answers",
		label: "收集闭卷作答",
		description:
			"学习者表示读完资料、要作答预问题时调用：逐题弹出编辑器（学习者亲笔）与信心选择（1–5，不提供给你）。工具返回作答全文，随后逐题批改。学习者中途取消时不要追问，等学习者准备好再试。",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "tutor");
			if (!state.prequestions.length) return text("本会话还没有预问题；先调用 bb_prequestions 登记。");
			const answers = await collectAnswers(
				ctx,
				state.prequestions.map((q) => ({ id: q.id, prompt: `${q.id}: ${q.text}` })),
				"闭卷作答：不要翻资料。",
			);
			if (!answers) return text("学习者取消了作答；等学习者准备好再收集。");
			state.answers = answers;
			deps.persist();
			return text(`闭卷作答已收集（信心已单独记录，批改时不可见）。请逐题批改：\n\n${answers.map((a) => `${a.id}: ${a.answer}`).join("\n\n")}`);
		},
	});

	pi.registerTool({
		name: "bb_gloss_edit",
		label: "打开术语表编辑器",
		description: "学习者想为某概念写术语表条目时调用：弹出编辑器由学习者亲笔填写，条目追加到 glossary.md。工具返回条目全文，随后只核对准确性、完整性与依赖标注，不代写。",
		parameters: Type.Object({ concept: Type.String({ description: "概念 id" }) }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			requireRole(deps.state(), "tutor");
			const entry = await editGloss(bb, ctx, params.concept);
			return text(entry ? `请核对以下术语表条目（只指出问题，不代写）：\n${entry}` : "学习者取消了编辑，或概念不存在。");
		},
	});

	pi.registerTool({
		name: "bb_mode_set",
		label: "切换陪读模式",
		description: "学习者要求切换提示 / 讲解模式时调用；切换前学习者在对话框里确认。不得在学习者未要求时调用。",
		parameters: Type.Object({ mode: StringEnum(["hint", "explain"] as const) }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "tutor");
			if (state.mode === params.mode) return text(`当前已是 ${params.mode} 模式。`);
			if (!ctx.hasUI) return text("非交互模式无法确认切换。");
			const ok = await ctx.ui.confirm(
				"切换陪读模式？",
				params.mode === "explain"
					? "hint → explain：老师可以完整讲解，但仍会先请你陈述当前的理解。"
					: "explain → hint：老师只给最小提示，不给完整讲解。",
			);
			if (!ok) return text("学习者未确认切换，模式保持不变。");
			state.mode = params.mode;
			state.contextHash = undefined;
			deps.persist();
			return text(`已切换到 ${params.mode} 模式。`);
		},
	});

	pi.registerTool({
		name: "bb_evidence",
		label: "提交会话证据",
		description:
			"陪读老师在学习者表示结束会话时提交结构化证据。工具会写入 blackboard/evidence/，按规则更新掌握度（最多到 learned），记录误解与缺口，并在需要时发出事件。",
		parameters: Type.Object({
			answers: Type.Array(
				Type.Object({
					id: Type.String(),
					verdict: StringEnum(["correct", "partial", "wrong"] as const),
					note: Type.String({ description: "错在哪里；正确则为空串" }),
				}),
			),
			hints_given: Type.Integer({ minimum: 0 }),
			misconceptions: Type.Array(Type.Object({ concept: Type.String(), description: Type.String() })),
			gaps: Type.Array(Type.Object({ concept: Type.String(), description: Type.String() })),
			concepts_touched: Type.Array(Type.String()),
			concepts_learned: Type.Array(Type.String({ description: "只包含闭卷作答正确且能用自己的话解释的概念" })),
			exit_criteria_met: Type.Boolean(),
			remedy: Type.String({ description: "补救建议；无则为空串" }),
			resource_request: Type.Optional(Type.String({ description: "需要替代资料时说明障碍；否则省略" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "tutor");
			const unitId = state.unit ?? bb.nextUnit()?.id ?? "unknown";

			// 1–3 是纯文件变更，整体持锁；4（单元完成确认）中间有对话框，锁分两段
			const { file, learned } = await bb.mutate(() => {
				const idx = bb.conceptIndex();
				const concepts = [...idx.values()];

				// 1. 证据落盘（附上学习者自己输入的作答与信心，那部分来自 bb_collect_answers，不来自模型）
				const file = `${today()}-${unitId}-${stamp()}.json`;
				bb.writeJson(`evidence/${file}`, {
					...params,
					unit: unitId,
					prequestions: state.prequestions,
					learner_answers: state.answers,
					mode_at_end: state.mode,
					recorded_at: new Date().toISOString(),
					source: "tutor",
				});

				// 2. 掌握度：导师上限 learned
				const learned: string[] = [];
				for (const cid of params.concepts_touched) {
					const c = idx.get(cid);
					if (c) {
						promote(c, "touched", "tutor");
						c.evidence ??= [];
						c.evidence.push(file);
					}
				}
				for (const cid of params.concepts_learned) {
					const c = idx.get(cid);
					if (c && promote(c, "learned", "tutor")) learned.push(cid);
				}
				bb.saveConcepts(concepts);

				// 3. 错误日志与事件
				for (const m of params.misconceptions) bb.logError(m.concept, "misconception", m.description, `tutor:${file}`);
				for (const g of params.gaps) bb.logError(g.concept, "gap", g.description, `tutor:${file}`);
				if (params.resource_request) bb.emit("resource_request", { unit: unitId, note: params.resource_request });
				return { file, learned };
			});

			let unitNote = "";
			if (params.exit_criteria_met) {
				const ok = ctx.hasUI ? await ctx.ui.confirm("单元完成？", `陪读老师认为单元 ${unitId} 的退出标准已满足。标为完成并发出 unit_complete 事件？`) : false;
				if (ok) {
					await bb.mutate(() => {
						const units = bb.units();
						const u = units.find((x) => x.id === unitId);
						if (u) {
							u.status = "done";
							bb.saveUnits(units);
						}
						bb.emit("unit_complete", { unit: unitId });
					});
					unitNote = "单元已标为完成。";
				} else {
					unitNote = ctx.hasUI ? "学习者未确认完成，单元保持 active。" : "非交互模式，未自动标记完成。";
				}
			}
			await bb.mutate(() => bb.maybeErrorThreshold());

			state.answers = [];
			deps.persist();
			return text(
				[
					`证据已写入 evidence/${file}。`,
					`升级为 learned：${learned.length ? learned.join(", ") : "无"}；误解 ${params.misconceptions.length}，缺口 ${params.gaps.length}。`,
					unitNote,
					params.remedy ? `补救建议：${params.remedy}` : "",
					unitNote.startsWith("单元已标为完成") ? "可用 bb_route_ask 提议下一步（如 assess）。" : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});

	// ------------------------------------------------------------------ 评审员
	pi.registerTool({
		name: "bb_review",
		label: "提交评审结果",
		description: "评审员提交对学习者产出物的评审：写入 blackboard/artifacts/reviews/，误解与缺口进入错误日志。",
		parameters: Type.Object({
			verdict: StringEnum(["pass", "revise"] as const),
			findings: Type.Array(
				Type.Object({
					severity: StringEnum(["blocking", "major", "minor"] as const),
					location: Type.String({ description: "行号 / 段落 / 函数名" }),
					kind: StringEnum(["misconception", "slip", "gap"] as const),
					concept: Type.Optional(Type.String({ description: "关联的概念 id；没有则省略" })),
					issue: Type.String(),
					why: Type.String(),
				}),
			),
			unresolved: Type.Array(Type.String({ description: "需要学习者自行说明的疑点" })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const state = deps.state();
			requireRole(state, "reviewer");
			const artifact = state.artifact ?? "unknown";
			const base = artifact.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "artifact";
			const rel = `artifacts/reviews/${base}-${stamp()}.md`;
			await bb.mutate(() => {
				const lines = [`# 评审：${artifact}`, `结论：${params.verdict}`, ""];
				for (const f of params.findings) {
					lines.push(`- [${f.severity}/${f.kind}] ${f.location}：${f.issue}（${f.why}）概念：${f.concept ?? "无"}`);
					if ((f.kind === "misconception" || f.kind === "gap") && f.concept) {
						bb.logError(f.concept, f.kind, `${artifact} ${f.location}: ${f.issue}`, `reviewer:${rel}`);
					}
				}
				if (params.unresolved.length) lines.push("", "待学习者说明：", ...params.unresolved.map((u) => `- ${u}`));
				bb.writeJson(rel.replace(/\.md$/, ".json"), { artifact, ...params, recorded_at: new Date().toISOString() });
				bb.writeText(rel, lines.join("\n") + "\n"); // Markdown 版本供人阅读
				bb.maybeErrorThreshold();
			});
			return text(`评审已写入 ${rel}（结论 ${params.verdict}，${params.findings.length} 条发现）。`);
		},
	});

	// ------------------------------------------------------------------ 复盘老师
	pi.registerTool({
		name: "bb_test_create",
		label: "写入测试",
		description: "复盘老师写入一次闭卷检索测试到 blackboard/assessments/pending-*.json，并随即询问学习者是否立即作答。",
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					id: Type.String({ description: "如 t1" }),
					concept: Type.String({ description: "概念 id" }),
					type: StringEnum(["recall", "discriminate", "apply"] as const),
					question: Type.String(),
					reference: Type.String({ description: "参考答案" }),
					rubric: Type.String({ description: "评分要点" }),
				}),
				{ minItems: 1, maxItems: 20 },
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "assessor");
			const rel = `assessments/pending-${stamp()}.json`;
			await bb.mutate(() => {
				bb.writeJson(rel, { date: today(), items: params.items, due_concepts: bb.dueConcepts().map((c) => c.id) });
				bb.markHandled(["unit_complete", "errors_threshold"]);
			});
			const asked = await askNext(ctx, `测试已就绪（${params.items.length} 题），现在闭卷作答？`, [{ label: "现在闭卷作答", route: "take" }]);
			return text(`测试已写入 ${rel}（${params.items.length} 题）。不要在对话中透露参考答案。${asked}`);
		},
	});

	pi.registerTool({
		name: "bb_grade",
		label: "提交批改",
		description:
			"复盘老师提交逐题评分、复盘提纲与结构性缺口判断。工具按规则更新掌握度（通过升级、未通过降级）、计算校准偏差、写入结果与复盘提纲，并在需要时发出重规划事件。",
		parameters: Type.Object({
			grades: Type.Array(
				Type.Object({
					id: Type.String(),
					score: Type.Number({ minimum: 0, maximum: 1, description: "1、0.5 或 0" }),
					comment: Type.String(),
					misconception: Type.Optional(Type.String()),
				}),
			),
			outline: Type.String({ description: "复盘提纲（Markdown），供学习者亲笔撰写复盘" }),
			structural_gap: Type.Boolean(),
			gap_note: Type.String({ description: "结构性缺口的说明；无则为空串" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = deps.state();
			requireRole(state, "assessor");
			if (!state.testFile || !state.responses.length) {
				throw new Error("尚未收集学习者作答：请学习者先闭卷作答（bb_route_ask 提议 take），再进行批改。");
			}
			const { passed, partial, failed, resolved, result, resultRel, outlineRel } = await bb.mutate(() => {
				const testFile = state.testFile as string;
				const test = bb.readJson<{ items: Array<{ id: string; concept: string }> }>(testFile, { items: [] });
				const grades = new Map(params.grades.map((g) => [g.id, g]));

				// 规则在代码：按概念聚合得分，决定通过 / 部分 / 未通过
				const idx = bb.conceptIndex();
				const byConcept = new Map<string, number[]>();
				for (const it of test.items) {
					const s = Number(grades.get(it.id)?.score ?? 0);
					byConcept.set(it.concept, [...(byConcept.get(it.concept) ?? []), s]);
				}
				const passed: string[] = [];
				const partial: string[] = [];
				const failed: string[] = [];
				for (const [cid, scores] of byConcept) {
					const c: Concept | undefined = idx.get(cid);
					if (!c) continue;
					const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
					if (mean >= PASS) {
						onPass(c);
						passed.push(cid);
					} else if (mean < FAIL) {
						onFail(c);
						failed.push(cid);
					} else {
						onPartial(c);
						partial.push(cid);
					}
				}
				bb.saveConcepts([...idx.values()]);
				for (const g of params.grades) {
					if (g.misconception) {
						const it = test.items.find((i) => i.id === g.id);
						bb.logError(it?.concept ?? null, "misconception", g.misconception, `assessor:${testFile}`);
					}
				}
				const resolved = bb.resolveErrors(new Set(passed), `assessor:${testFile}`);

				// 校准：信心归一到 0–1 后与得分之差；正值为过度自信
				const conf = state.responses.map((r) => (r.confidence - 1) / 4);
				const score = state.responses.map((r) => Number(grades.get(r.id)?.score ?? 0));
				const meanScore = score.length ? score.reduce((a, b) => a + b, 0) / score.length : 0;
				const gap = score.length ? conf.reduce((acc, c, i) => acc + (c - score[i]), 0) / score.length : 0;
				const result = {
					date: today(),
					test: testFile,
					responses: state.responses,
					grades: params.grades,
					mean_score: round3(meanScore),
					calibration_gap: round3(gap),
					passed_concepts: passed,
					partial_concepts: partial,
					failed_concepts: failed,
				};
				const resultRel = `assessments/${stamp()}-result.json`;
				bb.writeJson(resultRel, result);
				bb.appendJsonl("assessments/calibration.jsonl", { date: today(), mean_score: result.mean_score, gap: result.calibration_gap });
				bb.renamePending(testFile);

				const outlineRel = `reflections/${today()}-outline.md`;
				bb.writeText(outlineRel, `# 复盘提纲 ${today()}\n\n${params.outline}\n\n---\n\n# 我的复盘（学习者亲笔）\n\n`);
				if (params.structural_gap) bb.emit("replan_request", { note: params.gap_note });
				return { passed, partial, failed, resolved, result, resultRel, outlineRel };
			});

			state.testFile = undefined;
			state.responses = [];
			deps.persist();
			const asked = await askNext(ctx, "批改完成，亲笔写复盘？", [{ label: "在复盘提纲后亲笔作答", route: "reflect" }]);
			return text(
				[
					`结果已写入 ${resultRel}；平均得分 ${result.mean_score}，校准偏差 ${result.calibration_gap}（正值为过度自信）。`,
					`通过 [${passed.join(", ")}]　部分 [${partial.join(", ")}]　未通过（降级）[${failed.join(", ")}]　已解决错误 ${resolved}。`,
					`复盘提纲已写入 ${outlineRel}，复盘由学习者亲笔撰写。`,
					params.structural_gap ? "已发出 replan_request 事件。" : "",
					asked.trim(),
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	});
}

// ---------- 辅助 ----------

function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}

function hasCycle(concepts: Array<{ id: string; prereqs: string[] }>): boolean {
	const graph = new Map(concepts.map((c) => [c.id, c.prereqs]));
	const state = new Map<string, 0 | 1 | 2>();
	const visit = (id: string): boolean => {
		const s = state.get(id) ?? 0;
		if (s === 1) return true;
		if (s === 2) return false;
		state.set(id, 1);
		for (const p of graph.get(id) ?? []) if (visit(p)) return true;
		state.set(id, 2);
		return false;
	};
	return concepts.some((c) => visit(c.id));
}

async function checkLink(url: string, signal?: AbortSignal): Promise<boolean> {
	for (const method of ["HEAD", "GET"] as const) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 8000);
		signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
		try {
			const res = await fetch(url, { method, signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "pi-learning/0.1" } });
			if (res.ok) return true;
		} catch {
			/* try next */
		} finally {
			clearTimeout(timer);
		}
	}
	return false;
}

/** 供 /go accept 使用：按提案类型合并；成功后把文件标为已接受 */
export function applyProposal(bb: Blackboard, file: string): string {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (e) {
		throw new Error(`无法读取提案文件 ${file}：${(e as Error).message}`);
	}
	let summary: string;
	if (data.kind === "curate") {
		const r = acceptCurate(bb, data as unknown as CurateProposal);
		summary = `馆藏索引已更新：下线 ${r.retired}，合并 ${r.merged}，重排 ${r.reordered} 个单元，打标签 ${r.tagged}，记录缺口 ${r.gaps}。本地副本未被改动。`;
	} else if (Array.isArray((data as { sources?: unknown }).sources)) {
		const n = acceptSources(bb, data as { sources: Source[] });
		summary = `已写入 sources.json（共 ${n} 份）并挂到单元上。获取、入库与核验由前台的收集流程逐步推进。`;
	} else if (Array.isArray((data as { units?: unknown }).units)) {
		const r = acceptPlan(bb, data as { concepts?: Concept[]; units?: Unit[]; notes?: string });
		summary = `已写入 concepts.json（${r.concepts} 个概念）与 path.json（${r.units} 个单元），并发出 structure_ready 事件。`;
	} else {
		throw new Error("提案文件既不是规划提案，也不是资料提案或整理提案。");
	}
	const accepted = bb.markProposalAccepted(file);
	return `${summary}\n提案已标记为已接受：${accepted}`;
}
