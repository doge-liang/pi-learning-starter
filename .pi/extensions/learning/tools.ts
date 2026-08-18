/**
 * tools.ts —— bb_* 工具：模型改写黑板的唯一入口。
 *
 * 每个工具先检查当前角色（防止串角色调用），再把模型提交的结构化内容交给 blackboard.ts 的
 * 规则函数处理。工具都以 executionMode: "sequential" 注册，避免并行写黑板文件。
 */
import { readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	acceptPlan,
	acceptSources,
	Blackboard,
	type Concept,
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
import type { LearningState, Role } from "./state.ts";

export interface ToolDeps {
	bb: Blackboard;
	state: () => LearningState;
	persist: () => void;
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: {} };
}

function requireRole(state: LearningState, ...roles: Role[]) {
	if (!state.role || !roles.includes(state.role)) {
		throw new Error(`该工具只在 ${roles.join(" / ")} 角色会话中可用；当前角色：${state.role ?? "无"}。用 /read、/assess 等命令进入相应角色。`);
	}
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
	const { bb } = deps;

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

	// ------------------------------------------------------------------ 领域专家
	pi.registerTool({
		name: "bb_plan_propose",
		label: "提交规划提案",
		description:
			"领域专家提交知识结构与学习路径的提案。提案写入 blackboard/proposals/，学习者审阅并用 /accept 接受后才写入 concepts.json 与 path.json。",
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
		async execute(_id, params) {
			requireRole(deps.state(), "planner");
			// 前置关系不得指向不存在的概念，也不得成环（简单检查）
			const ids = new Set(params.concepts.map((c) => c.id));
			for (const c of params.concepts) {
				for (const p of c.prereqs) if (!ids.has(p)) throw new Error(`概念 ${c.id} 的前置 ${p} 不在提案中`);
			}
			if (hasCycle(params.concepts)) throw new Error("前置关系存在环，请修正后重新提交");
			const path = bb.writeProposal("plan", params);
			return text(`提案已写入 ${path}：${params.concepts.length} 个概念，${params.units.length} 个单元。请告知学习者审阅后运行 /accept。`);
		},
	});

	// ------------------------------------------------------------------ 资料管理员
	pi.registerTool({
		name: "bb_sources_propose",
		label: "提交资料提案",
		description: "资料管理员提交单元与资料的映射提案。写入 blackboard/proposals/，学习者用 /accept 接受后写入 sources.json 并挂到单元上。",
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
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			requireRole(deps.state(), "librarian");
			const path = bb.writeProposal("sources", params);
			return text(`提案已写入 ${path}：${params.sources.length} 份资料。请告知学习者核对后运行 /accept，并亲自打开资料确认后把 verified 改为 true。`);
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
		description: "陪读老师在会话开始时登记 3 到 5 个预问题；学习者随后用 /answer 闭卷作答。",
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
			return text(`已登记 ${params.questions.length} 个预问题。学习者读完资料后运行 /answer 闭卷作答。`);
		},
	});

	pi.registerTool({
		name: "bb_evidence",
		label: "提交会话证据",
		description:
			"陪读老师在会话结束时提交结构化证据。工具会写入 blackboard/evidence/，按规则更新掌握度（最多到 learned），记录误解与缺口，并在需要时发出事件。",
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
			const idx = bb.conceptIndex();
			const concepts = [...idx.values()];

			// 1. 证据落盘（附上学习者自己输入的作答与信心，那部分来自 /answer，不来自模型）
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

			let unitNote = "";
			if (params.exit_criteria_met) {
				const ok = ctx.hasUI ? await ctx.ui.confirm("单元完成？", `陪读老师认为单元 ${unitId} 的退出标准已满足。标为完成并发出 unit_complete 事件？`) : false;
				if (ok) {
					const units = bb.units();
					const u = units.find((x) => x.id === unitId);
					if (u) {
						u.status = "done";
						bb.saveUnits(units);
					}
					bb.emit("unit_complete", { unit: unitId });
					unitNote = "单元已标为完成。";
				} else {
					unitNote = ctx.hasUI ? "学习者未确认完成，单元保持 active。" : "非交互模式，未自动标记完成。";
				}
			}
			bb.maybeErrorThreshold();

			state.answers = [];
			deps.persist();
			return text(
				[
					`证据已写入 evidence/${file}。`,
					`升级为 learned：${learned.length ? learned.join(", ") : "无"}；误解 ${params.misconceptions.length}，缺口 ${params.gaps.length}。`,
					unitNote,
					params.remedy ? `补救建议：${params.remedy}` : "",
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
			return text(`评审已写入 ${rel}（结论 ${params.verdict}，${params.findings.length} 条发现）。`);
		},
	});

	// ------------------------------------------------------------------ 复盘老师
	pi.registerTool({
		name: "bb_test_create",
		label: "写入测试",
		description: "复盘老师写入一次闭卷检索测试到 blackboard/assessments/pending-*.json；学习者之后用 /take 作答。",
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
		async execute(_id, params) {
			const state = deps.state();
			requireRole(state, "assessor");
			const rel = `assessments/pending-${stamp()}.json`;
			bb.writeJson(rel, { date: today(), items: params.items, due_concepts: bb.dueConcepts().map((c) => c.id) });
			bb.markHandled(["unit_complete", "errors_threshold"]);
			return text(`测试已写入 ${rel}（${params.items.length} 题）。学习者准备好后运行 /take。不要在对话中透露参考答案。`);
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
		async execute(_id, params) {
			const state = deps.state();
			requireRole(state, "assessor");
			if (!state.testFile || !state.responses.length) {
				throw new Error("尚未收集学习者作答：请学习者先运行 /take 闭卷作答，再进行批改。");
			}
			const test = bb.readJson<{ items: Array<{ id: string; concept: string }> }>(state.testFile, { items: [] });
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
					bb.logError(it?.concept ?? null, "misconception", g.misconception, `assessor:${state.testFile}`);
				}
			}
			const resolved = bb.resolveErrors(new Set(passed), `assessor:${state.testFile}`);

			// 校准：信心归一到 0–1 后与得分之差；正值为过度自信
			const conf = state.responses.map((r) => (r.confidence - 1) / 4);
			const score = state.responses.map((r) => Number(grades.get(r.id)?.score ?? 0));
			const meanScore = score.length ? score.reduce((a, b) => a + b, 0) / score.length : 0;
			const gap = score.length ? conf.reduce((acc, c, i) => acc + (c - score[i]), 0) / score.length : 0;
			const result = {
				date: today(),
				test: state.testFile,
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
			bb.renamePending(state.testFile);

			const outlineRel = `reflections/${today()}-outline.md`;
			bb.writeText(outlineRel, `# 复盘提纲 ${today()}\n\n${params.outline}\n\n---\n\n# 我的复盘（学习者亲笔）\n\n`);
			if (params.structural_gap) bb.emit("replan_request", { note: params.gap_note });

			state.testFile = undefined;
			state.responses = [];
			deps.persist();
			return text(
				[
					`结果已写入 ${resultRel}；平均得分 ${result.mean_score}，校准偏差 ${result.calibration_gap}（正值为过度自信）。`,
					`通过 [${passed.join(", ")}]　部分 [${partial.join(", ")}]　未通过（降级）[${failed.join(", ")}]　已解决错误 ${resolved}。`,
					`复盘提纲已写入 ${outlineRel}，请学习者亲笔撰写复盘。`,
					params.structural_gap ? "已发出 replan_request 事件。" : "",
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

/** 供 commands.ts 的 /accept 使用：按提案类型合并；成功后把文件标为已接受 */
export function applyProposal(bb: Blackboard, file: string): string {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (e) {
		throw new Error(`无法读取提案文件 ${file}：${(e as Error).message}`);
	}
	let summary: string;
	if (Array.isArray((data as { sources?: unknown }).sources)) {
		const n = acceptSources(bb, data as { sources: Source[] });
		summary = `已写入 sources.json（共 ${n} 份）并挂到单元上。请亲自打开资料，确认后把 verified 改为 true。`;
	} else if (Array.isArray((data as { units?: unknown }).units)) {
		const r = acceptPlan(bb, data as { concepts?: Concept[]; units?: Unit[]; notes?: string });
		summary = `已写入 concepts.json（${r.concepts} 个概念）与 path.json（${r.units} 个单元），并发出 structure_ready 事件。`;
	} else {
		throw new Error("提案文件既不是规划提案也不是资料提案。");
	}
	const accepted = bb.markProposalAccepted(file);
	return `${summary}\n提案已标记为已接受：${accepted}`;
}
