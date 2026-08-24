/**
 * workflow.test.ts —— 用伪造的 ExtensionAPI 跑通设计稿的流程（0 水平测试、A 规划、B 阅读、C 评审、D 复盘、E 调整、F 馆藏）。
 *
 * 断言的对象是黑板文件与状态迁移，不是模型输出：模型的"判断"由测试代码直接以工具参数给出，
 * 这里检验的是"规则在代码"那一半——提案合并、掌握度上限、升降级、复习间隔、校准、事件与护栏。
 *
 * 界面收敛后学习者只有两个命令（/learn 与内部 /go）；推进经 bb_route_ask 与提交类工具的
 * 尾部询问派发 "/go <route>"。测试里派发只是把消息记入 sentMessages，后续步骤手动调用
 * pi.command("go") 模拟 pi 对派发消息的命令展开。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import learningExtension from "../.pi/extensions/learning/index.ts";
import { Blackboard, INTERVALS, LEVELS } from "../.pi/extensions/learning/blackboard.ts";
import { READ_TOOLS, ROLES } from "../.pi/extensions/learning/roles.ts";
import { nextSteps } from "../.pi/extensions/learning/route.ts";
import { FakePi, makeCtx, makeProject, type UiScript } from "./fake-pi.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const LATER = "稍后再说";

function readJson<T = any>(p: string): T {
	return JSON.parse(readFileSync(p, "utf8")) as T;
}
function readJsonl<T = any>(p: string): T[] {
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as T);
}
/** sources.json 的 id → 条目索引，测试里反复要用 */
function sourceIndex(bbDir: string): Record<string, any> {
	return Object.fromEntries(readJson(join(bbDir, "sources.json")).sources.map((s: any) => [s.id, s]));
}
/** 最近一条 learning-note 的文本（/learn、馆藏概览、提案接受等输出） */
function lastNote(pi: FakePi): string {
	return (pi.entries.filter((e) => e.customType === "learning-note").at(-1)?.data as { text: string } | undefined)?.text ?? "";
}
/** 最近保存的会话状态（learning-state 条目） */
function lastState(pi: FakePi): any {
	return pi.entries.filter((e) => e.customType === "learning-state").at(-1)?.data as any;
}
function daysFromToday(iso: string): number {
	return Math.round((Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000);
}
/** 单元测试里，模型看到的"黑板上下文"文本 */
async function contextOf(pi: FakePi, ctx: unknown): Promise<{ systemPrompt: string; message?: { content: string } } | undefined> {
	return pi.emit("before_agent_start", { systemPrompt: "BASE", messages: [] }, ctx);
}

describe("学习工作流（全流程）", () => {
	const project = makeProject(repoRoot);
	const bbDir = join(project.cwd, "blackboard");
	const pi = new FakePi();
	const uiScript: Required<UiScript> = { editor: [], select: [], confirm: [], input: [] };
	const ctx = makeCtx(pi, { cwd: project.cwd, ui: uiScript, models: { "anthropic/claude-opus-5": { provider: "anthropic", id: "claude-opus-5" } } });

	before(async () => {
		learningExtension(pi.api());
		await pi.emit("session_start", { reason: "startup" }, ctx);
		bb_latestProposal = () => {
			const files = readdirSync(join(bbDir, "proposals")).filter((f) => f.endsWith(".json") && !f.endsWith(".accepted.json") && !f.endsWith(".review.json")).sort();
			return join(bbDir, "proposals", files[files.length - 1]);
		};
	});
	after(() => project.cleanup());

	it("注册了 22 个 bb_* 工具、2 个命令与 4 个事件处理器", () => {
		const bbTools = [...pi.tools.keys()].filter((n) => n.startsWith("bb_"));
		assert.equal(bbTools.length, 22, bbTools.join(","));
		assert.deepEqual([...pi.commands.keys()].sort(), ["go", "learn"]);
		assert.deepEqual([...pi.handlers.keys()].sort(), ["before_agent_start", "input", "session_start", "tool_call"]);
	});

	it("启动时默认进入前台：白名单、状态栏与提示语", () => {
		assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.concierge.tools]);
		assert.match(ctx.statuses.get("learning") ?? "", /前台/);
		assert.ok(ctx.notices.some(([, m]) => m.includes("直接说你想做什么")));
	});

	it("前台上下文含代码算出的下一步建议；内容不变则不再注入", async () => {
		const r1 = await contextOf(pi, ctx);
		assert.ok(r1?.systemPrompt.startsWith("BASE\n\n# 角色：前台"));
		assert.ok(r1?.message?.content.includes("下一步建议"));
		assert.ok(r1?.message?.content.includes('"placement"'), "无画像时建议水平测试");
		const r2 = await contextOf(pi, ctx);
		assert.equal(r2?.message, undefined);
	});

	it("bb_route_ask：无效路由被拒；选稍后则搁置；选定后派发 /go", async () => {
		const bad = await pi.tool("bb_route_ask").execute("t", { routes: ["bogus"] }, undefined, undefined, ctx);
		assert.match(bad.content[0].text, /无效或目标不存在/);
		const bad2 = await pi.tool("bb_route_ask").execute("t", { routes: ["read u99"] }, undefined, undefined, ctx);
		assert.match(bad2.content[0].text, /无效或目标不存在/);

		// 选稍后：搁置并要求模型不再重提
		uiScript.select.push(undefined);
		const later = await pi.tool("bb_route_ask").execute("t", { routes: ["placement"] }, undefined, undefined, ctx);
		assert.match(later.content[0].text, /稍后/);
		assert.ok((lastState(pi).snoozed ?? []).includes("placement"), "搁置写入状态");

		// 选定：派发 /go placement
		uiScript.select.push("进入水平测试官：确定画像并定位起点");
		const go = await pi.tool("bb_route_ask").execute("t", { routes: ["placement"] }, undefined, undefined, ctx);
		assert.match(go.content[0].text, /已派发.*本回合结束后执行/);
		assert.equal(pi.lastMessage(), "/go placement");
		assert.deepEqual(pi.sentMessageOptions.at(-1), { deliverAs: "followUp", expandPromptTemplates: true });
	});

	it("/learn 输出概览与建议（含已搁置标记），选稍后不执行", async () => {
		uiScript.select.push(LATER);
		await pi.command("learn").handler("", ctx);
		const note = lastNote(pi);
		assert.match(note, /领域：（未设置）/);
		assert.match(note, /下一步建议：\n1\. 开始水平测试/);
		assert.match(note, /［已搁置］/);
		assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.concierge.tools], "未执行任何路由");
	});

	// ------------------------------------------------------------ 流程 0：水平测试（画像 + 诊断）
	describe("流程 0：水平测试", () => {
		it("无画像时路由 plan 被拒并指向水平测试", async () => {
			ctx.notices.length = 0;
			await pi.command("go").handler("plan", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("水平测试")));
			assert.equal(pi.activeTools?.includes("bb_plan_propose"), false);
		});

		it("/go placement 以画像对话开场；bb_domain_set 经确认写入 domain.json，取消则不写，非交互一律不通过", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("placement", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.placement.tools]);
			assert.match(pi.lastMessage(), /^\[begin-placement\] 请开始水平测试：先通过几个问题/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("现有 domain.json（domain 为空则先做画像对话）"));

			const params = {
				domain: "深度学习框架内部原理",
				goal: "能够独立阅读 PyTorch 自动微分与计算图相关的核心代码，并从零实现一个最小的自动微分引擎",
				background: "会写 Python；线性代数与微积分达到本科水平；用过 PyTorch 训练模型。",
				weekly_hours: 8,
				language: "zh",
				preferences: { formats: ["textbook", "paper", "code"] },
			};
			// 非交互：闸门不通过
			const noUi = makeCtx(pi, { cwd: project.cwd, hasUI: false });
			const rn = await pi.tool("bb_domain_set").execute("t", params, undefined, undefined, noUi);
			assert.match(rn.content[0].text, /非交互模式/);
			assert.equal(readJson(join(bbDir, "domain.json")).domain, undefined);

			uiScript.confirm.push(false);
			const r0 = await pi.tool("bb_domain_set").execute("t", params, undefined, undefined, ctx);
			assert.match(r0.content[0].text, /未确认/);
			assert.equal(readJson(join(bbDir, "domain.json")).domain, undefined);

			uiScript.confirm.push(true);
			const r1 = await pi.tool("bb_domain_set").execute("t", params, undefined, undefined, ctx);
			assert.match(r1.content[0].text, /第二步.*bb_placement_create/);
			const d = readJson(join(bbDir, "domain.json"));
			assert.equal(d.domain, "深度学习框架内部原理");
			assert.equal(d.weekly_hours, 8);
			assert.deepEqual(d.preferences.formats, ["textbook", "paper", "code"]);
			assert.deepEqual(d.preferences.languages, ["zh", "en"], "未提交的 preferences 键保留种子值");
		});

		it("已有画像时 /go placement 直接进入出题；bb_placement_create 写 pending 并弹尾部询问；领域不一致被拒", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("placement 6", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.placement.tools]);
			assert.match(pi.lastMessage(), /\[begin-placement\] 画像已有。phase=generate：题数上限 6/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("学习者画像（完整）") && ctxText.includes("深度学习框架内部原理"));
			await assert.rejects(
				pi.tool("bb_placement_create").execute("t", { areas: [{ area: "Python", why: "x" }], items: [{ id: "p1", area: "C++", level: "basic", type: "recall", question: "q", reference: "r", rubric: "k" }] }, undefined, undefined, ctx),
				/不在 areas 中/,
			);
			uiScript.select.push(LATER); // 尾部询问：稍后作答
			const r = await pi.tool("bb_placement_create").execute(
				"t",
				{
					areas: [
						{ area: "Python", why: "读框架源码的前提" },
						{ area: "微积分", why: "自动微分依赖链式法则" },
					],
					items: [
						{ id: "p1", area: "Python", level: "basic", type: "recall", question: "列表与元组的区别？", reference: "可变性", rubric: "提到可变/不可变" },
						{ id: "p2", area: "Python", level: "intermediate", type: "apply", question: "写一个装饰器记录函数调用次数", reference: "闭包+计数", rubric: "闭包、wraps" },
						{ id: "p3", area: "微积分", level: "basic", type: "recall", question: "写出复合函数求导的链式法则", reference: "(f∘g)' = f'(g)·g'", rubric: "形式正确" },
						{ id: "p4", area: "微积分", level: "advanced", type: "apply", question: "对 y = softmax(Wx) 的标量损失求 W 的梯度形状并说明", reference: "与 W 同形", rubric: "形状正确、说明外积" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			assert.match(r.content[0].text, /4 题，2 个领域/);
			assert.match(r.content[0].text, /稍后处理/);
			assert.ok(readdirFirst(join(bbDir, "placement"), ".json", "pending-"));
			assert.match(readJsonEntries(join(bbDir, "placement"))[0].kind, /placement/);
		});

		it("/go take 识别水平测试：收集作答后发 [grade-placement]；bb_placement_grade 聚合、写 domain.placement、尾部询问派发规划", async () => {
			uiScript.editor.push("元组不可变", "不会", "dy/dx = f'(g(x))·g'(x)", "不知道");
			uiScript.select.push("5", "2", "4", "1");
			pi.sentMessages.length = 0;
			await pi.command("go").handler("take", ctx);
			assert.match(pi.lastMessage(), /^\[grade-placement\]/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("待批改的水平测试") && ctxText.includes("装饰器"));
			uiScript.select.push("请领域专家依据结果规划学习路径"); // 尾部询问：进入规划
			const r = await pi.tool("bb_placement_grade").execute(
				"t",
				{
					grades: [
						{ id: "p1", score: 1, comment: "正确" },
						{ id: "p2", score: 0, comment: "空白" },
						{ id: "p3", score: 1, comment: "正确" },
						{ id: "p4", score: 0, comment: "空白" },
					],
					by_area: [
						{ area: "Python", level_reached: "basic", note: "基础扎实，缺闭包与装饰器" },
						{ area: "微积分", level_reached: "basic", note: "会链式法则，矩阵微分未涉及" },
					],
					strengths: ["Python 基础", "链式法则"],
					gaps: ["Python 闭包与装饰器", "矩阵微分"],
					recommendations: "第一单元从计算图直接开始；在反向传播前插入矩阵微分补救单元；Python 装饰器可在读源码时顺带补。",
				},
				undefined,
				undefined,
				ctx,
			);
			assert.match(r.content[0].text, /总分 0\.5/);
			assert.match(r.content[0].text, /Python 0\.5（basic）；微积分 0\.5（basic）/);
			assert.equal(pi.lastMessage(), "/go plan", "尾部询问派发规划");
			const d = readJson(join(bbDir, "domain.json"));
			assert.equal(d.placement.overall, 0.5);
			assert.deepEqual(d.placement.gaps, ["Python 闭包与装饰器", "矩阵微分"]);
			assert.equal(d.domain, "深度学习框架内部原理", "其余字段保留");
			assert.equal(readdirFirst(join(bbDir, "placement"), ".json", "pending-"), undefined, "pending 改名为 taken");
			assert.ok(readdirFirst(join(bbDir, "placement"), "-result.json"));
			assert.equal(readJson(join(bbDir, "concepts.json")).concepts.length, 0, "不创建概念、不动掌握度");
		});
	});

	// ------------------------------------------------------------ 流程 A：规划
	describe("流程 A：规划与选材", () => {
		it("/go plan 原地进入规划者：白名单、模型偏好、会话名、状态栏、开场语", async () => {
			await pi.command("go").handler("plan", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.planner.tools]);
			assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-5" }); // 来自 .pi/learning.json 的默认配置
			assert.match(pi.sessionName ?? "", /^planner plan \d{4}-\d{2}-\d{2}$/);
			assert.match(ctx.statuses.get("learning") ?? "", /领域专家/);
			assert.match(pi.lastMessage(), /bb_plan_propose/);
		});

		it("before_agent_start 追加角色提示并注入一次黑板上下文；首次规划带自带范例；内容不变则不再注入", async () => {
			const r1 = await contextOf(pi, ctx);
			assert.ok(r1?.systemPrompt.startsWith("BASE\n\n# 角色：领域专家"));
			assert.ok(r1?.systemPrompt.includes("好的规划的标准"));
			assert.ok(r1?.message?.content.includes("# 黑板上下文"));
			assert.ok(r1?.message?.content.includes("深度学习框架内部原理"));
			assert.ok(r1?.message?.content.includes("规划范例（结构示范") && r1?.message?.content.includes("limited-direct-execution"), "首次规划注入自带范例");
			assert.ok(r1?.message?.content.includes("水平测试结果") && r1?.message?.content.includes("矩阵微分"), "规划者看到水平测试结论");
			assert.ok(!r1?.message?.content.includes("学习者提供的范例"), "尚无学习者范例");
			const r2 = await contextOf(pi, ctx);
			assert.equal(r2?.message, undefined);
		});

		it("/go exemplar 经编辑器写入 blackboard/exemplars/，随后进入规划者上下文；路径参数被拒", async () => {
			uiScript.editor.push("# CS336 大纲（节选）\n\nLecture 1: Tokenization …");
			ctx.notices.length = 0;
			await pi.command("go").handler("exemplar cs336-syllabus", ctx);
			assert.ok(existsSync(join(bbDir, "exemplars", "cs336-syllabus.md")));
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("学习者提供的范例") && ctxText.includes("Tokenization"));
			await pi.command("go").handler("exemplar ../evil", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("只接受名字")));
		});

		it("bb_plan_propose 拒绝悬空前置与成环", async () => {
			const tool = pi.tool("bb_plan_propose");
			await assert.rejects(
				tool.execute("t", { concepts: [{ id: "a", name: "A", tier: "core", prereqs: ["zzz"] }], units: [], notes: "" }, undefined, undefined, ctx),
				/前置 zzz 不在提案中/,
			);
			await assert.rejects(
				tool.execute(
					"t",
					{
						concepts: [
							{ id: "a", name: "A", tier: "core", prereqs: ["b"] },
							{ id: "b", name: "B", tier: "core", prereqs: ["a"] },
						],
						units: [],
						notes: "",
					},
					undefined,
					undefined,
					ctx,
				),
				/存在环/,
			);
		});

		it("bb_plan_propose 写入提案并弹尾部询问；选送评审即派发 /go critique", async () => {
			const proposal = {
				concepts: [
					{ id: "tensor", name: "张量（Tensor）", tier: "core", prereqs: [] },
					{ id: "autograd-graph", name: "计算图（Computation Graph）", tier: "core", prereqs: ["tensor"] },
					{ id: "backward", name: "反向传播（Backpropagation）", tier: "core", prereqs: ["autograd-graph"] },
					{ id: "jit", name: "即时编译（JIT）", tier: "branch", prereqs: ["autograd-graph"], uncertain: true },
				],
				units: [
					{ id: "u01", title: "张量与计算图", concepts: ["tensor", "autograd-graph"], exercises: ["手画一个三节点计算图"], exit_criteria: ["不看资料说明叶子节点与中间节点的区别"] },
					{ id: "u02", title: "反向传播", concepts: ["backward"], exercises: ["手推链式法则"], exit_criteria: ["能写出标量输出的 backward 伪代码"] },
				],
				notes: "依据 Deep Learning (Goodfellow) 第 6 章",
			};
			pi.sentMessages.length = 0;
			uiScript.select.push("送独立评审（另开评审会话）");
			const r = await pi.tool("bb_plan_propose").execute("t", proposal, undefined, undefined, ctx);
			assert.match(r.content[0].text, /4 个概念（core 3，branch 1），2 个单元/);
			assert.match(r.content[0].text, /- u01 张量与计算图：张量（Tensor）、计算图（Computation Graph）/);
			assert.match(r.content[0].text, /学习者选择：送独立评审/);
			assert.equal(pi.lastMessage(), "/go critique");
			assert.ok(existsSync(join(bbDir, "proposals")));
		});

		it("/go critique 进入独立评审员：上下文含提案原文；bb_proposal_review 写评审文件；blocking 时不得 accept", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("critique", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.critic.tools]);
			assert.match(pi.lastMessage(), /独立审查提案/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("待审提案") && ctxText.includes('"autograd-graph"') && ctxText.includes("学习者画像（完整）"));

			await assert.rejects(
				pi.tool("bb_proposal_review").execute("t", { verdict: "accept", summary: "x", findings: [{ severity: "blocking", target: "u02", issue: "缺前置", suggestion: "补" }] }, undefined, undefined, ctx),
				/blocking 发现时结论必须为 revise/,
			);
			uiScript.select.push(LATER); // 尾部询问：稍后
			const r = await pi.tool("bb_proposal_review").execute(
				"t",
				{
					verdict: "revise",
					summary: "结构可用，但反向传播单元缺少链式法则前置。",
					findings: [
						{ severity: "blocking", target: "u02", issue: "反向传播依赖多元微积分的链式法则，提案未作为前置概念列出", suggestion: "在 u01 与 u02 之间插入链式法则概念" },
						{ severity: "minor", target: "jit", issue: "JIT 与目标无关", suggestion: "后置或删除" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			assert.match(r.content[0].text, /结论 revise：blocking 1，major 0，minor 1/);
			const proposalFile = bb_latestProposal();
			const reviewJson = proposalFile.replace(/\.json$/, ".review.json");
			assert.ok(existsSync(reviewJson) && existsSync(reviewJson.replace(/\.json$/, ".md")));
			assert.equal(readJson(reviewJson).verdict, "revise");
		});

		it("/go plan revise：规划者上下文含待修改的提案与评审意见", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("plan revise", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.planner.tools]);
			assert.match(pi.lastMessage(), /依据黑板上下文中「对该提案的评审意见」修改/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("对该提案的评审意见") && ctxText.includes("链式法则") && ctxText.includes("待修改的提案"));
		});

		it("/go accept 的确认框带评审结论；接受后写入黑板并发 structure_ready", async () => {
			uiScript.confirm.push(true);
			ctx.confirms.length = 0;
			await pi.command("go").handler("accept", ctx);
			assert.match(ctx.confirms[0]?.[1] ?? "", /评审结论：revise（blocking 1，major 0，minor 1）。评审员建议先请提案者修改/);
			const concepts = readJson(join(bbDir, "concepts.json")).concepts;
			assert.equal(concepts.length, 4);
			assert.ok(concepts.every((c: any) => c.mastery === "untouched" && Array.isArray(c.evidence)));
			const units = readJson(join(bbDir, "path.json")).units;
			assert.equal(units.length, 2);
			assert.equal(units[0].status, "pending");
			const events = readJsonl(join(bbDir, "events.jsonl"));
			assert.equal(events.at(-1).type, "structure_ready");
			assert.deepEqual(events.at(-1).payload.units, ["u01", "u02"]);
			// 已接受的提案改名，不会被第二次 accept 重复合并
			assert.ok(readdirFirst(join(bbDir, "proposals"), ".accepted.json", "plan-"));
			assert.equal(readdirFirst(join(bbDir, "proposals"), ".json", "plan-")?.endsWith(".accepted.json"), true);
			ctx.notices.length = 0;
			await pi.command("go").handler("accept", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("没有可接受的提案")));
		});

		it("/go sources 进入馆员；bb_sources_propose + accept 挂载资料且 verified=false", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("sources", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.librarian.tools]);
			assert.match(pi.lastMessage(), /u01, u02/);

			uiScript.select.push(LATER); // 尾部询问：稍后
			await pi.tool("bb_sources_propose").execute(
				"t",
				{
					sources: [
						{ id: "dl-ch6", title: "Deep Learning, Ch. 6", type: "textbook", locator: "Goodfellow et al., 2016, ch. 6.5", covers: ["tensor", "autograd-graph"], for_units: ["u01"], est_minutes: 90, quality_note: "标准教材" },
						{ id: "cs231n-bp", title: "CS231n Backprop notes", type: "course", locator: "https://cs231n.github.io/optimization-2/", covers: ["backward"], for_units: ["u02"], est_minutes: 60, quality_note: "课程讲义", verified: true },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			uiScript.confirm.push(true);
			await pi.command("go").handler("accept", ctx);
			const sources = readJson(join(bbDir, "sources.json")).sources;
			assert.equal(sources.length, 2);
			assert.ok(sources.every((s: any) => s.verified === false), "馆员无法把 verified 置为 true");
			const units = readJson(join(bbDir, "path.json")).units;
			assert.deepEqual(units[0].sources, ["dl-ch6"]);
			assert.deepEqual(units[1].sources, ["cs231n-bp"]);
			assert.ok(readJsonl(join(bbDir, "events.jsonl")).every((e) => e.type !== "structure_ready" || e.handled));
		});

		it("/go verify 由学习者亲自置位 verified：指定 id、从列表选择、取消；bb_verify 只在前台可用", async () => {
			uiScript.confirm.push(true);
			await pi.command("go").handler("verify dl-ch6", ctx);
			assert.equal(readJson(join(bbDir, "sources.json")).sources.find((x: any) => x.id === "dl-ch6").verified, true);
			// 无参数：从未核验列表中选择
			uiScript.select.push("cs231n-bp  CS231n Backprop notes");
			uiScript.confirm.push(false);
			await pi.command("go").handler("verify", ctx);
			assert.equal(readJson(join(bbDir, "sources.json")).sources.find((x: any) => x.id === "cs231n-bp").verified, false, "取消则不置位");
			ctx.notices.length = 0;
			await pi.command("go").handler("verify nope", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("不在 sources.json")));
			await assert.rejects(pi.tool("bb_verify").execute("t", {}, undefined, undefined, ctx), /concierge/);
		});

		it("bb_check_link 只在馆员角色可用", async () => {
			const r = await pi.tool("bb_check_link").execute("t", { url: "http://127.0.0.1:9/nope" });
			assert.equal(r.details.reachable, false);
		});
	});

	// ------------------------------------------------------------ 流程 B：阅读会话
	describe("流程 B：陪读会话", () => {
		it("/go read 进入陪读老师，单元置为 active，开场 [begin-session]", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("read u01", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.tutor.tools]);
			assert.equal(readJson(join(bbDir, "path.json")).units[0].status, "active");
			assert.match(pi.lastMessage(), /\[begin-session\]/);
			assert.match(ctx.statuses.get("learning") ?? "", /u01 · hint/);
		});

		it("陪读会话中，学习者的交互输入被加上 [mode: …] 前缀；bb_mode_set 经确认切换模式", async () => {
			const r = await pi.emit("input", { text: "叶子节点是什么", source: "interactive" }, ctx);
			assert.deepEqual(r, { action: "transform", text: "[mode: hint] 叶子节点是什么" });
			const r2 = await pi.emit("input", { text: "x", source: "extension" }, ctx);
			assert.deepEqual(r2, { action: "continue" });
			uiScript.confirm.push(true);
			const m = await pi.tool("bb_mode_set").execute("t", { mode: "explain" }, undefined, undefined, ctx);
			assert.match(m.content[0].text, /已切换到 explain/);
			const r3 = await pi.emit("input", { text: "请讲解", source: "interactive" }, ctx);
			assert.equal(r3.text, "[mode: explain] 请讲解");
			uiScript.confirm.push(false);
			const m2 = await pi.tool("bb_mode_set").execute("t", { mode: "hint" }, undefined, undefined, ctx);
			assert.match(m2.content[0].text, /未确认/);
			uiScript.confirm.push(true);
			await pi.tool("bb_mode_set").execute("t", { mode: "hint" }, undefined, undefined, ctx);
		});

		it("护栏：write/edit/bash 被拒；读取会话目录被拒；bb_* 串角色调用抛错", async () => {
			const w = await pi.emit("tool_call", { toolName: "write", input: { path: "x", content: "" } }, ctx);
			assert.equal(w.block, true);
			const b = await pi.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
			assert.equal(b.block, true);
			const s = await pi.emit("tool_call", { toolName: "read", input: { path: "/home/u/.pi/agent/sessions/abc.jsonl" } }, ctx);
			assert.equal(s.block, true);
			const ok = await pi.emit("tool_call", { toolName: "read", input: { path: join(bbDir, "domain.json") } }, ctx);
			assert.equal(ok, undefined);
			await assert.rejects(pi.tool("bb_review").execute("t", { verdict: "pass", findings: [], unresolved: [] }), /只在 reviewer 角色会话中可用/);
		});

		it("bb_prequestions 登记；bb_collect_answers 逐题收集作答与信心并返回给老师批改", async () => {
			await pi.tool("bb_prequestions").execute("t", {
				questions: [
					{ id: "q1", text: "什么是叶子节点？", concept: "tensor" },
					{ id: "q2", text: "计算图的边表示什么？", concept: "autograd-graph" },
				],
			});
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("本会话预问题") && ctxText.includes("dl-ch6"));
			assert.ok(ctxText.includes("全部概念索引") && ctxText.includes('"jit"'), "单元之外的概念 id 也可查（术语表跨单元引用）");

			uiScript.editor.push("requires_grad 为 true 且由用户创建的张量", "运算的依赖关系");
			uiScript.select.push("4", "2");
			const r = await pi.tool("bb_collect_answers").execute("t", {}, undefined, undefined, ctx);
			assert.match(r.content[0].text, /q1: requires_grad/);
			assert.doesNotMatch(r.content[0].text, /confidence/, "信心不发给老师");
		});

		it("bb_collect_answers 中途取消不写入状态", async () => {
			uiScript.editor.push(undefined);
			const r = await pi.tool("bb_collect_answers").execute("t", {}, undefined, undefined, ctx);
			assert.match(r.content[0].text, /取消了作答/);
		});

		it("bb_gloss_edit 追加术语表条目并交老师核对", async () => {
			uiScript.editor.push("张量是带自动微分元数据的多维数组。");
			const r = await pi.tool("bb_gloss_edit").execute("t", { concept: "tensor" }, undefined, undefined, ctx);
			const gl = readFileSync(join(bbDir, "glossary.md"), "utf8");
			assert.ok(gl.includes("<!-- id: tensor -->") && gl.includes("带自动微分元数据"));
			assert.match(r.content[0].text, /请核对以下术语表条目/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("带自动微分元数据"), "术语表条目进入陪读上下文");
		});

		it("bb_evidence 写证据、升级上限 learned、记错误、确认后单元完成", async () => {
			uiScript.confirm.push(true);
			const r = await pi.tool("bb_evidence").execute(
				"t",
				{
					answers: [
						{ id: "q1", verdict: "correct", note: "" },
						{ id: "q2", verdict: "partial", note: "没有提到方向" },
					],
					hints_given: 2,
					misconceptions: [{ concept: "autograd-graph", description: "把边理解成数据本身" }],
					gaps: [],
					concepts_touched: ["tensor", "autograd-graph"],
					concepts_learned: ["tensor", "autograd-graph"],
					exit_criteria_met: true,
					remedy: "",
				},
				undefined,
				undefined,
				ctx,
			);
			assert.match(r.content[0].text, /升级为 learned：tensor, autograd-graph/);
			assert.match(r.content[0].text, /单元已标为完成/);
			const concepts = readJson(join(bbDir, "concepts.json")).concepts;
			const byId = Object.fromEntries(concepts.map((c: any) => [c.id, c]));
			assert.equal(byId.tensor.mastery, "learned");
			assert.equal(byId["autograd-graph"].mastery, "learned");
			assert.equal(byId.backward.mastery, "untouched");
			assert.equal(byId.tensor.evidence.length, 1);
			const evidence = readJson(join(bbDir, "evidence", byId.tensor.evidence[0]));
			assert.equal(evidence.unit, "u01");
			assert.equal(evidence.learner_answers.length, 2);
			assert.equal(evidence.learner_answers[0].confidence, 4);
			assert.equal(readJson(join(bbDir, "path.json")).units[0].status, "done");
			const errors = readJsonl(join(bbDir, "errors.jsonl"));
			assert.equal(errors.length, 1);
			assert.equal(errors[0].type, "misconception");
			assert.equal(errors[0].resolved, false);
			const events = readJsonl(join(bbDir, "events.jsonl"));
			assert.ok(events.some((e) => e.type === "unit_complete" && !e.handled));
		});

		it("导师无法把概念推过 learned：再次提交 evidence 不改变 learned", async () => {
			await pi.tool("bb_evidence").execute(
				"t",
				{ answers: [], hints_given: 0, misconceptions: [], gaps: [], concepts_touched: ["tensor"], concepts_learned: ["tensor"], exit_criteria_met: false, remedy: "" },
				undefined,
				undefined,
				ctx,
			);
			const c = readJson(join(bbDir, "concepts.json")).concepts.find((x: any) => x.id === "tensor");
			assert.equal(c.mastery, "learned");
		});
	});

	// ------------------------------------------------------------ 流程 C：评审
	describe("流程 C：产出与评审", () => {
		it("/go artifact 落盘产出物；/go review 进入评审员；bb_review 写入 md 与 json，误解入错误日志", async () => {
			const artifact = join(bbDir, "artifacts", "graph.md");
			uiScript.editor.push("# 我的计算图笔记\n\n边表示数据。");
			ctx.notices.length = 0;
			await pi.command("go").handler("artifact graph", ctx);
			assert.ok(existsSync(artifact), "缺省补 .md 并落盘");
			assert.ok(ctx.notices.some(([, m]) => m.includes("/go review blackboard/artifacts/graph.md")));
			await pi.command("go").handler("artifact ../evil.md", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("只接受文件名")));
			pi.sentMessages.length = 0;
			await pi.command("go").handler(`review blackboard/artifacts/graph.md u01`, ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.reviewer.tools]);
			assert.match(pi.lastMessage(), /graph\.md/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("产出物路径") && ctxText.includes("graph.md"));

			const r = await pi.tool("bb_review").execute("t", {
				verdict: "revise",
				findings: [
					{ severity: "major", location: "第 3 行", kind: "misconception", concept: "autograd-graph", issue: "边表示的是依赖而不是数据", why: "混淆节点与边" },
					{ severity: "minor", location: "标题", kind: "slip", issue: "缺少日期", why: "便于追踪" },
				],
				unresolved: ["第 2 段疑似复制自资料"],
			});
			assert.match(r.content[0].text, /结论 revise，2 条发现/);
			const reviews = readJson(join(bbDir, "artifacts", "reviews", mustFind(join(bbDir, "artifacts", "reviews"), ".json")));
			assert.equal(reviews.verdict, "revise");
			const md = readFileSync(join(bbDir, "artifacts", "reviews", mustFind(join(bbDir, "artifacts", "reviews"), ".md")), "utf8");
			assert.ok(md.includes("[major/misconception]") && md.includes("待学习者说明"));
			const errors = readJsonl(join(bbDir, "errors.jsonl"));
			assert.equal(errors.length, 2, "slip 不入错误日志，misconception 入");
		});
	});

	// ------------------------------------------------------------ 流程 D：复盘
	describe("流程 D：出题、作答、批改", () => {
		it("/go assess 进入考评官；bb_test_create 写 pending、标记事件并经尾部询问派发作答", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("assess 5", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.assessor.tools]);
			assert.match(pi.lastMessage(), /题数上限 5/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("到期概念") && ctxText.includes('"tensor"'), "刚 learned 且无 due 的概念视为到期");

			uiScript.select.push("现在闭卷作答");
			await pi.tool("bb_test_create").execute(
				"t",
				{
					items: [
						{ id: "t1", concept: "tensor", type: "recall", question: "用自己的话定义叶子张量。", reference: "由用户创建且 requires_grad 的张量", rubric: "提到用户创建、requires_grad" },
						{ id: "t2", concept: "tensor", type: "discriminate", question: "叶子张量与中间张量在 grad 保存上的区别？", reference: "中间张量默认不保存 grad", rubric: "提到 retain_grad" },
						{ id: "t3", concept: "autograd-graph", type: "apply", question: "画出 y = (a*b)+c 的计算图并标注边。", reference: "两个运算节点，三条输入边", rubric: "边表示依赖" },
					],
				},
				undefined,
				undefined,
				ctx,
			);
			assert.equal(pi.lastMessage(), "/go take", "尾部询问派发作答");
			assert.deepEqual(pi.sentMessageOptions.at(-1), { deliverAs: "followUp", expandPromptTemplates: true }, "派发排到回合后执行，不打断当前回合");
			const pending = readdirFirst(join(bbDir, "assessments"), ".json", "pending-");
			assert.ok(pending);
			const events = readJsonl(join(bbDir, "events.jsonl"));
			assert.ok(events.filter((e) => e.type === "unit_complete").every((e) => e.handled));
		});

		it("bb_grade 在未收集作答时拒绝", async () => {
			await assert.rejects(pi.tool("bb_grade").execute("t", { grades: [], outline: "", structural_gap: false, gap_note: "" }, undefined, undefined, ctx), /先闭卷作答/);
		});

		it("/go take 在考评官会话中直接收集作答并发 [grade]", async () => {
			uiScript.editor.push("用户创建、requires_grad=True", "中间张量不保存 grad", "不会画");
			uiScript.select.push("5", "5", "1");
			pi.sentMessages.length = 0;
			await pi.command("go").handler("take", ctx);
			assert.match(pi.lastMessage(), /^\[grade\]/);
			assert.match(pi.lastMessage(), /"confidence": 5/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("待批改的测试") && ctxText.includes("叶子张量"));
		});

		it("bb_grade：通过升级 tested 并排复习；未通过降级 touched；校准偏差；提纲；replan_request", async () => {
			uiScript.select.push(LATER); // 尾部询问：稍后写复盘
			const r = await pi.tool("bb_grade").execute(
				"t",
				{
					grades: [
						{ id: "t1", score: 1, comment: "完整" },
						{ id: "t2", score: 1, comment: "完整" },
						{ id: "t3", score: 0, comment: "空白", misconception: "仍不清楚边的含义" },
					],
					outline: "- 掌握了叶子张量\n- 计算图仍是缺口",
					structural_gap: true,
					gap_note: "autograd-graph 反复出错，建议插入补救单元",
				},
				undefined,
				undefined,
				ctx,
			);
			const text = r.content[0].text;
			assert.match(text, /通过 \[tensor\]/);
			assert.match(text, /未通过（降级）\[autograd-graph\]/);
			assert.match(text, /已发出 replan_request/);

			const concepts = readJson(join(bbDir, "concepts.json")).concepts;
			const byId = Object.fromEntries(concepts.map((c: any) => [c.id, c]));
			assert.equal(byId.tensor.mastery, "tested");
			assert.equal(byId.tensor.review.streak, 1);
			assert.equal(byId.tensor.review.interval_idx, 1);
			assert.equal(daysFromToday(byId.tensor.review.due), INTERVALS[1]);
			assert.equal(byId["autograd-graph"].mastery, "touched", "learned 未通过降为 touched");
			assert.equal(daysFromToday(byId["autograd-graph"].review.due), 1);

			const resultFile = mustFind(join(bbDir, "assessments"), "-result.json");
			const result = readJson(join(bbDir, "assessments", resultFile));
			assert.equal(result.mean_score, 0.667);
			// 信心归一：(5-1)/4=1, 1, 0；得分 1, 1, 0 → 偏差 0
			assert.equal(result.calibration_gap, 0);
			assert.deepEqual(result.passed_concepts, ["tensor"]);
			assert.deepEqual(result.failed_concepts, ["autograd-graph"]);
			assert.equal(readJsonl(join(bbDir, "assessments", "calibration.jsonl")).length, 1);
			assert.ok(readdirFirst(join(bbDir, "assessments"), ".json", "taken-"), "pending 改名为 taken");
			assert.equal(readdirFirst(join(bbDir, "assessments"), ".json", "pending-"), undefined);

			const outline = mustFind(join(bbDir, "reflections"), "-outline.md");
			assert.ok(readFileSync(join(bbDir, "reflections", outline), "utf8").includes("我的复盘（学习者亲笔）"));

			const errors = readJsonl(join(bbDir, "errors.jsonl"));
			assert.equal(errors.length, 3);
			assert.ok(errors.filter((e) => e.concept === "autograd-graph").every((e) => !e.resolved), "未通过的概念错误保持未解决");
			const events = readJsonl(join(bbDir, "events.jsonl"));
			assert.ok(events.some((e) => e.type === "replan_request" && !e.handled));
		});

		it("/go reflect 在提纲后就地写复盘：编辑器预填提纲，未修改则不写", async () => {
			const outline = mustFind(join(bbDir, "reflections"), "-outline.md");
			const before = readFileSync(join(bbDir, "reflections", outline), "utf8");
			uiScript.editor.push((prefill: string) => prefill);
			ctx.notices.length = 0;
			await pi.command("go").handler("reflect", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("未修改")));
			uiScript.editor.push((prefill: string) => {
				assert.ok(prefill.includes("我的复盘（学习者亲笔）"), "编辑器预填提纲");
				return `${prefill}计算图的边我一直理解成数据，这次才分清依赖与数据。\n`;
			});
			await pi.command("go").handler("reflect", ctx);
			const after = readFileSync(join(bbDir, "reflections", outline), "utf8");
			assert.ok(after.startsWith(before) && after.includes("分清依赖与数据"));
		});

		it("连续通过三次即 consolidated；部分通过两天后复测", async () => {
			// 直接驱动状态机（规则函数），不经模型
			const { onPass, onPartial } = await import("../.pi/extensions/learning/blackboard.ts");
			const c: any = { id: "x", name: "X", mastery: "learned", evidence: [] };
			onPass(c);
			onPass(c);
			assert.equal(c.mastery, "tested");
			onPass(c);
			assert.equal(c.mastery, "consolidated");
			assert.equal(c.review.interval_idx, 3);
			onPartial(c);
			assert.equal(daysFromToday(c.review.due), 2);
			assert.equal(c.mastery, "consolidated");
			assert.equal(LEVELS.indexOf("consolidated"), 4);
		});
	});

	// ------------------------------------------------------------ 流程 E：调整路径
	describe("流程 E：事件驱动的增量重规划", () => {
		it("nextSteps 把 replan_request 事件译成 plan replan 建议", () => {
			const routes = nextSteps(new Blackboard(project.cwd)).map((s) => s.route);
			assert.ok(routes.includes("plan replan"), routes.join(" | "));
		});

		it("/go plan replan 进入规划者做增量重规划", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("plan replan", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.planner.tools]);
			assert.match(pi.lastMessage(), /增量重规划/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("最近测评结果") && ctxText.includes("failed"));
		});

		it("增量提案接受后保留已有概念的掌握度与复习状态、已有单元的状态与资料", async () => {
			uiScript.select.push(LATER); // 尾部询问：稍后
			await pi.tool("bb_plan_propose").execute(
				"t",
				{
					concepts: [
						{ id: "tensor", name: "张量（Tensor）", tier: "core", prereqs: [] },
						{ id: "graph-edges", name: "计算图的边（Edges）", tier: "core", prereqs: ["tensor"] },
						{ id: "autograd-graph", name: "计算图（Computation Graph）", tier: "core", prereqs: ["graph-edges"] },
						{ id: "backward", name: "反向传播（Backpropagation）", tier: "core", prereqs: ["autograd-graph"] },
					],
					units: [
						{ id: "u01", title: "张量与计算图", concepts: ["tensor", "autograd-graph"], exercises: [], exit_criteria: [] },
						{ id: "u01b", title: "补救：计算图的边", concepts: ["graph-edges"], exercises: ["把三段代码翻译成图"], exit_criteria: ["说明边为什么不是数据"] },
						{ id: "u02", title: "反向传播", concepts: ["backward"], exercises: [], exit_criteria: [] },
					],
					notes: "插入补救单元 u01b",
				},
				undefined,
				undefined,
				ctx,
			);
			uiScript.confirm.push(true);
			await pi.command("go").handler("accept", ctx);
			const concepts = readJson(join(bbDir, "concepts.json")).concepts;
			const byId = Object.fromEntries(concepts.map((c: any) => [c.id, c]));
			assert.equal(concepts.length, 4);
			assert.equal(byId.tensor.mastery, "tested");
			assert.equal(byId.tensor.review.streak, 1);
			assert.equal(byId["graph-edges"].mastery, "untouched");
			assert.equal(byId.jit, undefined, "被修剪的分支不再保留");
			const units = readJson(join(bbDir, "path.json")).units;
			assert.equal(units.length, 3);
			assert.equal(units[0].status, "done");
			assert.deepEqual(units[0].sources, ["dl-ch6"]);
			assert.equal(units[1].status, "pending");
			const events = readJsonl(join(bbDir, "events.jsonl"));
			assert.ok(events.filter((e) => e.type === "replan_request").every((e) => e.handled));
			assert.deepEqual(events.at(-1).payload.units, ["u01b"], "只有无资料的单元进入 structure_ready");
		});

		it("/go none 退出学习模式，恢复默认工具并记住退出", async () => {
			await pi.command("go").handler("none", ctx);
			assert.ok(pi.activeTools?.includes("write") && pi.activeTools?.includes("bash"));
			assert.ok(!pi.activeTools?.some((t) => t.startsWith("bb_")), "退出角色后不再暴露 bb_* 工具");
			assert.equal(ctx.statuses.get("learning"), undefined);
			const r = await contextOf(pi, ctx);
			assert.equal(r, undefined, "无角色时不改系统提示");
			assert.equal(lastState(pi).optOut, true, "明确退出被持久化");
		});

		it("/go 无参数给出用法；参数补全列出动作", async () => {
			ctx.notices.length = 0;
			await pi.command("go").handler("", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("用法：/go")));
			const items = pi.command("go").getArgumentCompletions?.("re") ?? [];
			assert.deepEqual(items.map((x) => x.value), ["read", "review", "reflect"]);
		});
	});

	// ------------------------------------------------------------ 流程 F：馆藏的收集与整理
	// 放在流程 E 之后：此时黑板上正好有一个刚插入、尚无资料的补救单元 u01b，
	// 覆盖缺口、补料、收集与整理可以在同一份数据上依次验证。
	describe("流程 F：馆藏的收集与整理", () => {
		it("/go sources 请求替代资料：提案带获取等级、获取途径与题录元数据；接受后仍有缺口则发 sources_gap", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("sources u02 现有讲义推导跳步，需要更系统的教材", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.librarian.tools]);
			assert.match(pi.lastMessage(), /理解困难/);

			uiScript.select.push(LATER); // 尾部询问：稍后
			await pi.tool("bb_sources_propose").execute(
				"t",
				{
					sources: [
						{
							id: "prml",
							title: "Pattern Recognition and Machine Learning",
							type: "textbook",
							locator: "Bishop, 2006, ch. 5.3",
							covers: ["backward"],
							for_units: ["u02"],
							est_minutes: 120,
							quality_note: "反向传播的标准推导",
							alternative: true,
							access: "paid",
							acquire_note: "Springer 正版；图书馆索书号 QA76.87 B54",
							meta: { authors: ["Christopher M. Bishop"], year: 2006, publisher: "Springer", isbn: "978-0387310732" },
							tags: ["教材"],
						},
						{
							id: "prml-free",
							title: "Pattern Recognition and Machine Learning（官方免费版）",
							type: "textbook",
							locator: "Bishop, 2006, ch. 5.3",
							covers: ["backward"],
							for_units: ["u02"],
							est_minutes: 120,
							quality_note: "同一本书由出版方公开的免费版",
							alternative: true,
							access: "open",
							acquire_note: "出版方公开的免费 PDF",
							meta: { authors: ["Christopher M. Bishop"], year: 2006, publisher: "Springer" },
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			uiScript.confirm.push(true);
			await pi.command("go").handler("accept", ctx);
			const byId = sourceIndex(bbDir);
			assert.equal(byId.prml.access, "paid");
			assert.match(byId.prml.acquire_note, /索书号/);
			assert.deepEqual(byId.prml.meta.authors, ["Christopher M. Bishop"]);
			assert.equal(byId.prml.verified, false);
			assert.match(lastNote(pi), /收集流程/);
			// u01b 仍无资料、graph-edges 仍无资料覆盖 → 缺口事件
			const gap = readJsonl(join(bbDir, "events.jsonl")).filter((e) => e.type === "sources_gap").at(-1);
			assert.deepEqual(gap.payload.units, ["u01b"]);
			assert.deepEqual(gap.payload.concepts, ["graph-edges"]);
			assert.equal(gap.handled, false);
		});

		it("/go collect 下载直链、写出 Zotero 题录并登记收集台账", async () => {
			// 本地 HTTP 服务代替外网：验证下载、后缀推断与台账登记，不引入网络依赖
			const server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/pdf" });
				res.end("%PDF-1.4 fake");
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
			const port = (server.address() as AddressInfo).port;
			try {
				// 模拟馆员在提案里填好的开放获取直链
				const data = readJson(join(bbDir, "sources.json"));
				const s = data.sources.find((x: any) => x.id === "cs231n-bp");
				s.access = "open";
				s.meta = { authors: ["Andrej Karpathy"], year: 2016, url: `http://127.0.0.1:${port}/optimization-2.pdf` };
				writeFileSync(join(bbDir, "sources.json"), JSON.stringify(data, null, 2), "utf8");

				ctx.confirms.length = 0;
				uiScript.confirm.push(true); // 下载
				uiScript.confirm.push(true); // 入 Zotero
				await pi.command("go").handler("collect cs231n-bp", ctx);
				assert.match(ctx.confirms[0][1], /保存到 blackboard/);

				const cs = sourceIndex(bbDir)["cs231n-bp"];
				assert.equal(cs.acquisition.status, "obtained");
				assert.equal(cs.acquisition.local_path, "blackboard/library/cs231n-bp.pdf");
				assert.equal(readFileSync(join(project.cwd, cs.acquisition.local_path), "utf8"), "%PDF-1.4 fake");
				assert.equal(cs.verified, false, "下载不等于核验");
				assert.equal(cs.acquisition.zotero.mode, "file");
				const csl = readJson(join(project.cwd, cs.acquisition.zotero.file));
				assert.equal(csl[0].type, "document", "course → CSL document");
				assert.deepEqual(csl[0].author, [{ literal: "Andrej Karpathy" }]);
				assert.match(csl[0].note, /pi-learning-source: cs231n-bp/);
			} finally {
				server.close();
			}
		});

		it("/go collect 登记学习者自备的本地副本；拿不到时记 unavailable 并提示换料", async () => {
			const manual = join(bbDir, "library", "dl-goodfellow.pdf");
			writeFileSync(manual, "local copy", "utf8");
			uiScript.input.push(manual);
			uiScript.confirm.push(false); // 不入 Zotero
			await pi.command("go").handler("collect dl-ch6", ctx);
			const dl = sourceIndex(bbDir)["dl-ch6"];
			assert.equal(dl.acquisition.local_path, "blackboard/library/dl-goodfellow.pdf", "项目内的路径存成相对路径");
			assert.equal(dl.acquisition.zotero, undefined);
			assert.equal(dl.verified, true, "此前的核验状态不受影响");

			// 付费教材拿不到：不填路径，登记为 unavailable
			ctx.notices.length = 0;
			uiScript.input.push("");
			uiScript.select.push("unavailable  暂无渠道");
			await pi.command("go").handler("collect prml", ctx);
			assert.equal(sourceIndex(bbDir).prml.acquisition.status, "unavailable");
			assert.ok(ctx.notices.some(([, m]) => m.includes("换一份更易得")));
		});

		it("/go library 按单元列出获取与核验状态并汇总缺口", async () => {
			await pi.command("go").handler("library", ctx);
			const text = lastNote(pi);
			assert.match(text, /在架 4 份，已获取 2，已核验 1/);
			assert.ok(text.includes("本地 blackboard/library/cs231n-bp.pdf"));
			assert.ok(text.includes("（无资料）"), "u01b 没有资料");
			assert.ok(text.includes("单元无资料：u01b"));
			assert.ok(text.includes("概念无资料：graph-edges"));
			assert.ok(text.includes("已获取但未核验：cs231n-bp"));
		});

		it("/go curate 提交整理提案；接受后合并、下线、排序与标签落到索引，本地副本不动", async () => {
			pi.sentMessages.length = 0;
			await pi.command("go").handler("curate", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.librarian.tools]);
			assert.match(pi.lastMessage(), /请整理馆藏/);

			uiScript.select.push(LATER); // 尾部询问：稍后
			await pi.tool("bb_sources_curate").execute(
				"t",
				{
					merge: [{ keep: "prml-free", drop: ["prml"], reason: "同一本书，保留可直接获取的免费版" }],
					reorder: [{ unit: "u02", order: ["cs231n-bp", "prml-free"] }],
					tag: [{ id: "cs231n-bp", tags: ["讲义", "反向传播"] }],
					gaps: [{ scope: "unit", id: "u01b", note: "补救单元尚无资料", suggestion: "找一份专讲计算图边与节点区别的讲义" }],
					notes: "合并重复入口，按主次排序",
				},
				undefined,
				undefined,
				ctx,
			);
			ctx.confirms.length = 0;
			uiScript.confirm.push(true);
			await pi.command("go").handler("accept", ctx);
			assert.match(ctx.confirms[0][1], /合并 prml（Pattern Recognition and Machine Learning） → prml-free/);

			const byId = sourceIndex(bbDir);
			assert.equal(byId.prml.retired, true);
			assert.match(byId.prml.retired_reason, /^合并到 prml-free/);
			assert.equal(byId["prml-free"].retired, undefined);
			assert.deepEqual(byId["cs231n-bp"].tags, ["讲义", "反向传播"]);
			assert.equal(byId["cs231n-bp"].order, 1);
			assert.equal(byId["prml-free"].order, 2);
			assert.equal(byId.prml.acquisition.status, "unavailable", "下线不抹掉台账");
			const u02 = readJson(join(bbDir, "path.json")).units.find((u: any) => u.id === "u02");
			assert.deepEqual(u02.sources, ["cs231n-bp", "prml-free"], "被合并的 id 由保留的那条顶替并去重");
			assert.ok(existsSync(join(bbDir, "library", "cs231n-bp.pdf")), "整理只改索引，不动本地副本");

			const gap = readJsonl(join(bbDir, "events.jsonl")).filter((e) => e.type === "sources_gap").at(-1);
			assert.equal(gap.payload.from, "curate");
			assert.deepEqual(gap.payload.units, ["u01b"]);
		});

		it("再次收集已有副本的资料：先问保留还是重新获取，下载分支不再被永久跳过", async () => {
			// 保留现有副本：跳过下载与登记，只走 Zotero 询问
			uiScript.select.push("保留现有副本");
			uiScript.confirm.push(false); // 不入 Zotero
			await pi.command("go").handler("collect cs231n-bp", ctx);
			assert.deepEqual(ctx.selects.at(-1)?.[1], ["保留现有副本", "重新下载 / 重新登记路径", "取消"]);
			assert.equal(sourceIndex(bbDir)["cs231n-bp"].acquisition.local_path, "blackboard/library/cs231n-bp.pdf", "保留时路径不变");

			// 重新登记：换成手工获取的新副本
			const manual2 = join(bbDir, "library", "cs231n-manual.pdf");
			writeFileSync(manual2, "manual pdf", "utf8");
			uiScript.select.push("重新下载 / 重新登记路径");
			uiScript.confirm.push(false); // 不重新下载直链
			uiScript.input.push(manual2);
			uiScript.confirm.push(false); // 不入 Zotero
			await pi.command("go").handler("collect cs231n-bp", ctx);
			assert.equal(sourceIndex(bbDir)["cs231n-bp"].acquisition.local_path, "blackboard/library/cs231n-manual.pdf");
		});

		it("sources_gap 事件进入下一步建议，路由回馆员补料", async () => {
			const routes = nextSteps(new Blackboard(project.cwd)).map((s) => s.route);
			assert.ok(routes.some((r) => r.startsWith("sources")), routes.join(" | "));
			pi.sentMessages.length = 0;
			await pi.command("go").handler("sources", ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.librarian.tools]);
			assert.match(pi.lastMessage(), /u01b/);
			const ctxText = (await contextOf(pi, ctx))?.message?.content ?? "";
			assert.ok(ctxText.includes("馆藏缺口") && ctxText.includes("graph-edges"));
			assert.ok(ctxText.includes('"acquisition": "unavailable"'), "馆员看得到哪些资料迟迟拿不到");
		});
	});
});

describe("会话切换交接与恢复", () => {
	const project = makeProject(repoRoot);
	after(() => project.cleanup());

	it("会话已有消息时 /go assess 写交接文件并切换；新实例在 session_start(new) 中接过角色，然后收到开场语", async () => {
		const bbDir = join(project.cwd, "blackboard");
		writeFileSync(join(bbDir, "concepts.json"), JSON.stringify({ concepts: [{ id: "a", name: "A", mastery: "learned", evidence: [] }] }), "utf8");

		const oldPi = new FakePi();
		const newPi = new FakePi();
		let newCtx: ReturnType<typeof makeCtx> | undefined;
		const oldCtx = makeCtx(oldPi, {
			cwd: project.cwd,
			hasMessages: true,
			newSession: async (opts) => {
				// 模拟 pi：重建扩展实例 → session_start(reason=new) → withSession
				learningExtension(newPi.api());
				newCtx = makeCtx(newPi, { cwd: project.cwd });
				await newPi.emit("session_start", { reason: "new" }, newCtx);
				await opts.withSession?.({ ...newCtx, sendUserMessage: async (t: string) => newPi.sentMessages.push(t) });
				return { cancelled: false };
			},
		});
		learningExtension(oldPi.api());
		await oldPi.emit("session_start", { reason: "startup" }, oldCtx);
		await oldPi.command("go").handler("assess", oldCtx);

		assert.deepEqual(oldPi.activeTools, [...READ_TOOLS, ...ROLES.concierge.tools], "旧实例保持前台，不原地进入角色");
		assert.ok(!existsSync(join(project.cwd, ".pi", "learning-handoff.json")), "交接文件被新实例消费并删除");
		assert.deepEqual(newPi.activeTools, [...READ_TOOLS, ...ROLES.assessor.tools]);
		assert.match(newPi.sessionName ?? "", /^assessor generate/);
		assert.match(newPi.lastMessage(), /phase=generate/);
		const saved = newPi.entries.filter((e) => e.customType === "learning-state").at(-1)?.data as { role: string };
		assert.equal(saved.role, "assessor");
	});

	it("切换被取消时清理交接文件", async () => {
		const p = new FakePi();
		const c = makeCtx(p, { cwd: project.cwd, hasMessages: true, newSession: async () => ({ cancelled: true }) });
		learningExtension(p.api());
		await p.emit("session_start", { reason: "startup" }, c);
		await p.command("go").handler("assess", c);
		assert.ok(!existsSync(join(project.cwd, ".pi", "learning-handoff.json")));
		assert.ok(c.notices.some(([, m]) => m.includes("取消")));
	});

	it("/resume：从会话条目恢复角色与单元；LEARN_ROLE 在无状态时指定角色；明确退出的会话不再回前台", async () => {
		const p = new FakePi();
		p.entries.push({ type: "custom", customType: "learning-state", data: { role: "tutor", unit: "u01", mode: "explain", prequestions: [], answers: [], responses: [] }, id: "e1" });
		const c = makeCtx(p, { cwd: project.cwd });
		learningExtension(p.api());
		await p.emit("session_start", { reason: "resume" }, c);
		assert.deepEqual(p.activeTools, [...READ_TOOLS, ...ROLES.tutor.tools]);
		assert.match(c.statuses.get("learning") ?? "", /u01 · explain/);

		process.env.LEARN_ROLE = "assessor";
		try {
			const p2 = new FakePi();
			const c2 = makeCtx(p2, { cwd: project.cwd, hasUI: false });
			learningExtension(p2.api());
			await p2.emit("session_start", { reason: "startup" }, c2);
			assert.deepEqual(p2.activeTools, [...READ_TOOLS, ...ROLES.assessor.tools]);
		} finally {
			delete process.env.LEARN_ROLE;
		}

		// 学习者明确退出过（optOut）：恢复会话不再自动进入前台
		const p3 = new FakePi();
		p3.entries.push({ type: "custom", customType: "learning-state", data: { role: null, optOut: true, mode: "hint", prequestions: [], answers: [], responses: [] }, id: "e1" });
		const c3 = makeCtx(p3, { cwd: project.cwd });
		learningExtension(p3.api());
		await p3.emit("session_start", { reason: "resume" }, c3);
		assert.deepEqual(p3.activeTools, p3.builtin, "退出过学习模式的会话保持普通助手");
	});
});

// ---------- 辅助 ----------
/** 最近一份尚未接受的提案（测试里只有一个 proposals 目录在用） */
let bb_latestProposal: () => string = () => {
	throw new Error("未初始化");
};
function readdirFirst(dir: string, suffix: string, prefix = ""): string | undefined {
	if (!existsSync(dir)) return undefined;
	return readdirSync(dir)
		.filter((f) => f.endsWith(suffix) && f.startsWith(prefix))
		.sort()[0];
}
function readJsonEntries(dir: string): any[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => readJson(join(dir, f)));
}
function mustFind(dir: string, suffix: string, prefix = ""): string {
	const f = readdirFirst(dir, suffix, prefix);
	if (!f) throw new Error(`${dir} 下没有 ${prefix}*${suffix}`);
	return f;
}
