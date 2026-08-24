/**
 * route.ts —— 路由层：确定性的「下一步」计算与路由串的渲染。
 *
 * 界面收敛后，用户不再记忆命令：前台（或任一角色）在自然边界用 bb_route_ask 弹出选择框，
 * 选定后派发内部命令 /go <route> 执行。本文件保证两件事：
 * 1. 建议由代码从黑板状态算出（nextSteps），模型只挑选时机，不产生建议本身；
 * 2. 选择框里的文字由代码从黑板拼装（renderRoute），模型提交的只是路由串，无法左右呈现。
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Blackboard } from "./blackboard.ts";

export interface Suggestion {
	/** 稳定标识（即路由串），用于「稍后」搁置 */
	key: string;
	/** /go 的参数串，如 "read u01"、"accept" */
	route: string;
	/** 选择框选项文本（代码拼装） */
	label: string;
	/** 一句话理由，用于 /learn 的文本输出与角色上下文 */
	reason: string;
}

/** /go 认识的动作；bb_route_ask 只接受这些开头的路由串 */
export const ROUTE_ACTIONS = [
	"placement",
	"plan",
	"critique",
	"accept",
	"sources",
	"curate",
	"read",
	"review",
	"assess",
	"take",
	"collect",
	"verify",
	"library",
	"reflect",
	"artifact",
	"exemplar",
	"gloss",
	"none",
] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

export function parseRoute(route: string): { action: RouteAction; args: string } | null {
	const m = route.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!m || !(ROUTE_ACTIONS as readonly string[]).includes(m[1])) return null;
	return { action: m[1] as RouteAction, args: (m[2] ?? "").trim() };
}

/** 复盘提纲是否还没有学习者亲笔的部分（提纲之后为空） */
function outlineUnanswered(bb: Blackboard): string | undefined {
	const outlines = bb.listFiles("reflections", "", "-outline.md");
	const last = outlines[outlines.length - 1];
	if (!last) return undefined;
	const text = bb.readText(`reflections/${last}`);
	const idx = text.indexOf("# 我的复盘（学习者亲笔）");
	if (idx < 0) return undefined;
	return text.slice(idx).replace(/^# 我的复盘（学习者亲笔）/, "").trim() ? undefined : last;
}

/** 待作答的测试（复盘或水平测试），取最近写入的一份的相对路径 */
export function pendingTest(bb: Blackboard): string | undefined {
	const candidates = [
		...bb.listFiles("assessments", "pending-", ".json").map((f) => `assessments/${f}`),
		...bb.listFiles("placement", "pending-", ".json").map((f) => `placement/${f}`),
	];
	return candidates.sort()[candidates.length - 1];
}

/**
 * 确定性的下一步建议，按优先级排列。覆盖流程图的全部机械分支；
 * 模糊意图（「看不懂」该换资料还是换讲解模式）留给前台的模型判断。
 */
export function nextSteps(bb: Blackboard, snoozed?: Iterable<string>): Suggestion[] {
	const skip = new Set(snoozed ?? []);
	const out: Suggestion[] = [];
	const push = (route: string, label: string, reason: string) => {
		if (!skip.has(route) && !out.some((s) => s.key === route)) out.push({ key: route, route, label, reason });
	};
	const domain = bb.domain();

	// 1. 画像与起点
	if (!domain.domain) {
		push("placement", "开始水平测试（先对话确定目标，再闭卷定位起点）", "还没有学习者画像");
		return out;
	}

	// 2. 待作答的测试
	const pending = pendingTest(bb);
	if (pending) push("take", `闭卷作答待批改的测试（${pending}）`, "有测试等待作答");

	// 3. 待处理的提案
	const proposal = bb.latestProposal();
	if (proposal) {
		const base = proposal.split(/[\\/]/).pop() ?? "";
		const kind = base.startsWith("plan-") ? "plan" : base.startsWith("curate-") ? "curate" : "sources";
		const review = bb.readReview(proposal) as { verdict?: string } | undefined;
		if (!review) {
			push("critique", `送独立评审：${base}`, "有提案尚未评审");
			push("accept", `接受提案：${base}`, "也可以直接接受");
		} else if (review.verdict === "revise") {
			const reviseRoute = kind === "plan" ? "plan revise" : kind === "curate" ? "curate" : "sources";
			push(reviseRoute, `请提案者按评审意见修改（${base}）`, "评审结论为 revise");
			push("accept", `仍然接受提案：${base}`, "评审意见仅供参考");
		} else {
			push("accept", `接受提案：${base}（评审结论 accept）`, "评审通过");
		}
	}

	// 4. 规划
	if (!bb.concepts().length) {
		if (!domain.placement) push("placement", "先做水平测试定位起点", "画像已有，尚无测得的基线");
		push("plan", "请领域专家规划知识结构与学习路径", "还没有概念与单元");
		return out;
	}

	// 5. 事件驱动
	for (const ev of bb.unhandledEvents()) {
		switch (ev.type) {
			case "structure_ready":
			case "sources_gap": {
				const units = bb.units().filter((u) => !u.sources?.length).map((u) => u.id);
				if (units.length) push("sources", `请资料管理员为单元选材（${units.join(", ")}）`, `事件 ${ev.type}`);
				else push("curate", "请资料管理员整理馆藏并列出缺口", `事件 ${ev.type}`);
				break;
			}
			case "resource_request": {
				const unit = String(ev.payload.unit ?? "");
				push(`sources ${unit} ${String(ev.payload.note ?? "")}`.trim(), `请资料管理员为单元 ${unit} 提供替代资料`, "阅读中请求了替代资料");
				break;
			}
			case "unit_complete":
			case "errors_threshold":
				push("assess", "请复盘老师出一次闭卷检索测试", `事件 ${ev.type}`);
				break;
			case "replan_request":
				push("plan replan", "请领域专家增量重规划", "复盘发现结构性缺口");
				break;
		}
	}

	// 6. 到期复习
	if (bb.dueConcepts().length >= 3) push("assess", `复习测试（${bb.dueConcepts().length} 个概念到期）`, "到期复习的概念不少了");

	// 7. 亲笔复盘
	const outline = outlineUnanswered(bb);
	if (outline) push("reflect", `亲笔写复盘（${outline}）`, "复盘提纲还没有你写的部分");

	// 8. 继续阅读
	const unit = bb.nextUnit();
	if (unit) {
		if (unit.sources?.length) push(`read ${unit.id}`, `进入陪读会话：${unit.id} ${unit.title}`, "继续当前单元");
		else push(`sources ${unit.id}`, `请资料管理员为单元 ${unit.id} 选材`, "当前单元还没有资料");
	}

	// 9. 馆藏杂务
	const active = bb.activeSources();
	const unobtained = active.filter((s) => s.acquisition?.status !== "obtained");
	if (unobtained.length) push("collect", `获取资料（${unobtained.length} 份未获取）`, "馆藏里还有资料没拿到");
	const unverified = active.filter((s) => s.acquisition?.status === "obtained" && !s.verified);
	if (unverified.length) push("verify", `核验资料（${unverified.length} 份已获取待核验）`, "已获取的资料需要你亲自打开确认");

	return out.slice(0, 6);
}

/**
 * 把路由串渲染成选择框文本。目标不存在或动作未知时返回 null（调用方据此拒绝）。
 * 文本全部由代码从黑板拼装；模型无法提供进入选择框的文字。
 */
export function renderRoute(bb: Blackboard, cwd: string, route: string): string | null {
	const parsed = parseRoute(route);
	if (!parsed) return null;
	const { action, args } = parsed;
	const [a0, ...rest] = args.split(/\s+/).filter(Boolean);
	switch (action) {
		case "placement":
			return bb.domain().domain ? "进入水平测试官：出诊断题定位起点" : "进入水平测试官：确定画像并定位起点";
		case "plan":
			if (args === "revise") return "进入领域专家：按评审意见修改规划提案";
			if (args === "replan") return "进入领域专家：增量重规划";
			if (args) return null;
			return "进入领域专家：规划知识结构与学习路径";
		case "critique": {
			const file = a0 ? (isAbsolute(a0) ? a0 : join(cwd, a0)) : bb.latestProposal();
			if (!file || !existsSync(file)) return null;
			return `送独立评审：${file.split(/[\\/]/).pop()}`;
		}
		case "accept": {
			const file = a0 && a0 !== "--confirmed" ? (isAbsolute(a0) ? a0 : join(cwd, a0)) : bb.latestProposal();
			if (!file || !existsSync(file)) return null;
			return `审阅并接受提案：${file.split(/[\\/]/).pop()}`;
		}
		case "sources": {
			if (!a0) return "进入资料管理员：为尚无资料的单元选材";
			const u = bb.findUnit(a0);
			if (!u) return null;
			return rest.length ? `进入资料管理员：为单元 ${u.id} ${u.title} 提供替代资料` : `进入资料管理员：为单元 ${u.id} ${u.title} 选材`;
		}
		case "curate":
			if (a0 && !bb.findUnit(a0)) return null;
			return `进入资料管理员：整理馆藏${a0 ? `（重点看单元 ${a0}）` : ""}`;
		case "read": {
			const u = a0 ? bb.findUnit(a0) : bb.nextUnit();
			if (!u || u.status === "done") return null;
			return `进入陪读会话：${u.id} ${u.title}`;
		}
		case "review": {
			if (!a0) return null;
			const abs = isAbsolute(a0) ? a0 : join(cwd, a0);
			if (!existsSync(abs)) return null;
			return `进入评审员：评审 ${a0}${rest[0] ? `（单元 ${rest[0]}）` : ""}`;
		}
		case "assess":
			return `进入复盘老师：生成闭卷检索测试${a0 ? `（题数上限 ${a0}）` : ""}`;
		case "take": {
			const pending = pendingTest(bb);
			if (!pending) return null;
			return `闭卷作答：${pending}`;
		}
		case "collect": {
			if (a0 && !bb.sources().some((s) => s.id === a0)) return null;
			return a0 ? `获取资料：${a0}` : "获取资料（从未获取列表中选择）";
		}
		case "verify": {
			if (a0 && !bb.sources().some((s) => s.id === a0)) return null;
			return a0 ? `核验资料：${a0}` : "核验资料（从未核验列表中选择）";
		}
		case "library":
			if (a0 && !bb.findUnit(a0)) return null;
			return `馆藏概览${a0 ? `（单元 ${a0}）` : ""}`;
		case "reflect":
			return "亲笔写复盘（在最近的提纲后作答）";
		case "artifact":
			return a0 ? `写产出物：blackboard/artifacts/${a0}` : null;
		case "exemplar":
			return a0 ? `提供规划范例：${a0}` : null;
		case "gloss": {
			const c = a0 ? bb.conceptIndex().get(a0) : undefined;
			return c ? `写术语表条目：${c.name}` : null;
		}
		case "none":
			return "退出学习模式，恢复普通编码助手";
	}
}
