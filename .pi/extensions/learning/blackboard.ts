/**
 * blackboard.ts —— 黑板：blackboard/ 目录的读写、掌握度状态机、复习调度、事件与错误日志。
 *
 * 这里没有任何模型调用。设计稿的原则「判断在模型，规则在代码」落在此文件：
 * 模型只能通过 tools.ts 中的 bb_* 工具进入这里，而这里的函数决定状态如何变化。
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const LEVELS = ["untouched", "touched", "learned", "tested", "consolidated"] as const;
export type Level = (typeof LEVELS)[number];
/** 复习间隔（天）；每通过一次前进一档，连续通过三次即 consolidated */
export const INTERVALS = [1, 3, 7, 14, 30, 60];
/** 某概念一次测试的平均得分：>= PASS 通过；< FAIL 未通过并降级；介于两者之间保持并两天后复测 */
export const PASS = 0.75;
export const FAIL = 0.5;
/** 未解决错误累计到此数量即触发复盘事件 */
export const ERROR_THRESHOLD = 8;

export interface Review {
	interval_idx: number;
	streak: number;
	due: string | null;
}
export interface Concept {
	id: string;
	name: string;
	tier?: "core" | "branch" | string;
	prereqs?: string[];
	uncertain?: boolean;
	mastery: Level;
	evidence: string[];
	review?: Review;
}
export interface Unit {
	id: string;
	title: string;
	concepts: string[];
	exercises?: string[];
	exit_criteria?: string[];
	sources?: string[];
	status?: "pending" | "active" | "done";
}
export interface Source {
	id: string;
	title: string;
	type?: string;
	locator?: string;
	covers?: string[];
	for_units?: string[];
	est_minutes?: number;
	quality_note?: string;
	alternative?: boolean;
	verified?: boolean;
	reachable?: boolean;
}
export interface Domain {
	domain?: string;
	goal?: string;
	background?: string;
	weekly_hours?: number;
	language?: string;
	preferences?: Record<string, unknown>;
}
export interface ErrorRow {
	ts: string;
	concept: string | null;
	type: "misconception" | "slip" | "gap";
	description: string;
	source: string;
	resolved: boolean;
	resolved_by?: string;
	resolved_at?: string;
}
export interface EventRow {
	ts: string;
	type: string;
	payload: Record<string, unknown>;
	handled: boolean;
	handled_at?: string;
}

export const today = (): string => new Date().toISOString().slice(0, 10);
export const now = (): string => new Date().toISOString().slice(0, 19);
/** 文件名时间戳：YYYYMMDDhhmmssSSS 加随机后缀，毫秒级以保证同一秒内多次写入仍按时间排序 */
export const stamp = (): string => new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 17) + "-" + Math.random().toString(36).slice(2, 6);

function addDays(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return d.toISOString().slice(0, 10);
}

/** 简短的稳定哈希，用于判断上下文是否变化（避免每轮重复注入相同上下文） */
export function shortHash(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}

export class Blackboard {
	cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** pi 在 session_start 之后才提供 ctx.cwd；扩展加载时先用 process.cwd()，随后校正 */
	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	get root(): string {
		return join(this.cwd, "blackboard");
	}

	exists(): boolean {
		return existsSync(this.root);
	}

	path(...parts: string[]): string {
		return join(this.root, ...parts);
	}

	// ---------- 基础 I/O ----------

	readJson<T>(rel: string, fallback: T): T {
		const p = this.path(rel);
		if (!existsSync(p)) return fallback;
		try {
			return JSON.parse(readFileSync(p, "utf8")) as T;
		} catch {
			return fallback;
		}
	}

	writeJson(rel: string, data: unknown): string {
		const p = this.path(rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
		return p;
	}

	appendJsonl(rel: string, row: unknown): void {
		const p = this.path(rel);
		mkdirSync(join(p, ".."), { recursive: true });
		appendFileSync(p, JSON.stringify(row) + "\n", "utf8");
	}

	readJsonl<T>(rel: string): T[] {
		const p = this.path(rel);
		if (!existsSync(p)) return [];
		return readFileSync(p, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as T);
	}

	writeJsonl(rel: string, rows: unknown[]): void {
		writeFileSync(this.path(rel), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
	}

	readText(rel: string): string {
		const p = this.path(rel);
		return existsSync(p) ? readFileSync(p, "utf8") : "";
	}

	appendText(rel: string, text: string): void {
		mkdirSync(join(this.path(rel), ".."), { recursive: true });
		appendFileSync(this.path(rel), text, "utf8");
	}

	writeText(rel: string, text: string): string {
		const p = this.path(rel);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, text, "utf8");
		return p;
	}

	listFiles(rel: string, prefix = "", suffix = ""): string[] {
		const dir = this.path(rel);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
			.sort();
	}

	// ---------- 各类数据 ----------

	domain(): Domain {
		return this.readJson<Domain>("domain.json", {});
	}
	/** 入学访谈写入：按提交内容覆盖，未提交的字段与 preferences 中未提及的键保留 */
	saveDomain(patch: Domain): Domain {
		const prev = this.domain();
		const merged: Domain = { ...prev, ...patch, preferences: { ...(prev.preferences ?? {}), ...(patch.preferences ?? {}) } };
		this.writeJson("domain.json", merged);
		return merged;
	}
	concepts(): Concept[] {
		return this.readJson<{ concepts: Concept[] }>("concepts.json", { concepts: [] }).concepts ?? [];
	}
	saveConcepts(concepts: Concept[]): void {
		this.writeJson("concepts.json", { concepts });
	}
	units(): Unit[] {
		return this.readJson<{ units: Unit[] }>("path.json", { units: [] }).units ?? [];
	}
	saveUnits(units: Unit[], notes?: string): void {
		const prev = this.readJson<{ units: Unit[]; notes?: string }>("path.json", { units: [] });
		this.writeJson("path.json", { units, notes: notes ?? prev.notes ?? "" });
	}
	sources(): Source[] {
		return this.readJson<{ sources: Source[] }>("sources.json", { sources: [] }).sources ?? [];
	}
	saveSources(sources: Source[]): void {
		this.writeJson("sources.json", { sources });
	}
	/** 学习者亲自核验资料后置位（只有 /verify 命令调用，模型没有这条路径） */
	verifySource(id: string, verified = true): Source | undefined {
		const sources = this.sources();
		const s = sources.find((x) => x.id === id);
		if (!s) return undefined;
		s.verified = verified;
		this.saveSources(sources);
		return s;
	}

	conceptIndex(): Map<string, Concept> {
		return new Map(this.concepts().map((c) => [c.id, c]));
	}

	findUnit(id: string): Unit | undefined {
		return this.units().find((u) => u.id === id);
	}

	/** 当前单元：先取 active，再取第一个 pending */
	nextUnit(): Unit | undefined {
		const units = this.units();
		return units.find((u) => u.status === "active") ?? units.find((u) => (u.status ?? "pending") === "pending");
	}

	/** 概念的精简视图，供角色上下文使用（不含证据正文） */
	conceptBrief(ids?: Iterable<string>): Array<Pick<Concept, "id" | "name" | "tier" | "prereqs" | "mastery">> {
		const set = ids ? new Set(ids) : null;
		return this.concepts()
			.filter((c) => !set || set.has(c.id))
			.map((c) => ({ id: c.id, name: c.name, tier: c.tier, prereqs: c.prereqs ?? [], mastery: c.mastery ?? "untouched" }));
	}

	/** 解析 glossary.md，返回 {概念 id → 条目全文}。标题行形如：## 名称（English） <!-- id: xxx --> */
	glossary(): Map<string, string> {
		const out = new Map<string, string>();
		let current: string | null = null;
		let buf: string[] = [];
		for (const line of this.readText("glossary.md").split("\n")) {
			if (line.startsWith("## ")) {
				if (current) out.set(current, buf.join("\n").trim());
				const m = /<!--\s*id:\s*([\w-]+)\s*-->/.exec(line);
				current = m ? m[1] : null;
				buf = [line];
			} else if (current) {
				buf.push(line);
			}
		}
		if (current) out.set(current, buf.join("\n").trim());
		return out;
	}

	/** 学习者放进 blackboard/exemplars/ 的范例与良好实践（/exemplar 写入），供规划者与评审员参考 */
	exemplars(maxCharsEach = 12000): Array<{ name: string; text: string }> {
		return this.listFiles("exemplars", "", ".md").map((f) => {
			const text = this.readText(`exemplars/${f}`);
			return { name: f.replace(/\.md$/, ""), text: text.length > maxCharsEach ? `${text.slice(0, maxCharsEach)}\n…（已截断）` : text };
		});
	}

	// ---------- 错误日志 ----------

	unresolvedErrors(ids?: Iterable<string>): ErrorRow[] {
		const set = ids ? new Set(ids) : null;
		return this.readJsonl<ErrorRow>("errors.jsonl").filter((e) => !e.resolved && (!set || (e.concept && set.has(e.concept))));
	}

	logError(concept: string | null, type: ErrorRow["type"], description: string, source: string): void {
		this.appendJsonl("errors.jsonl", { ts: now(), concept, type, description, source, resolved: false } satisfies ErrorRow);
	}

	resolveErrors(ids: Set<string>, by: string): number {
		const rows = this.readJsonl<ErrorRow>("errors.jsonl");
		let n = 0;
		for (const r of rows) {
			if (!r.resolved && r.concept && ids.has(r.concept)) {
				r.resolved = true;
				r.resolved_by = by;
				r.resolved_at = now();
				n++;
			}
		}
		this.writeJsonl("errors.jsonl", rows);
		return n;
	}

	// ---------- 事件（黑板上的条目，不是 Agent 之间的消息） ----------

	emit(type: string, payload: Record<string, unknown> = {}): void {
		this.appendJsonl("events.jsonl", { ts: now(), type, payload, handled: false } satisfies EventRow);
	}

	unhandledEvents(): EventRow[] {
		return this.readJsonl<EventRow>("events.jsonl").filter((e) => !e.handled);
	}

	markHandled(kinds: string[]): void {
		const rows = this.readJsonl<EventRow>("events.jsonl");
		for (const r of rows) {
			if (!r.handled && kinds.includes(r.type)) {
				r.handled = true;
				r.handled_at = now();
			}
		}
		this.writeJsonl("events.jsonl", rows);
	}

	/** 未解决错误达到阈值时发一次复盘事件（若已有未处理的同类事件则不重复） */
	maybeErrorThreshold(): void {
		const n = this.unresolvedErrors().length;
		if (n >= ERROR_THRESHOLD && !this.unhandledEvents().some((e) => e.type === "errors_threshold")) {
			this.emit("errors_threshold", { count: n });
		}
	}

	// ---------- 复习调度 ----------

	dueConcepts(): Concept[] {
		const t = today();
		return this.concepts().filter((c) => {
			if (!["learned", "tested", "consolidated"].includes(c.mastery)) return false;
			const due = c.review?.due;
			return !due || due <= t;
		});
	}

	// ---------- 概览 ----------

	status(): string {
		const counts: Record<string, number> = {};
		for (const lv of LEVELS) counts[lv] = 0;
		for (const c of this.concepts()) counts[c.mastery ?? "untouched"] = (counts[c.mastery ?? "untouched"] ?? 0) + 1;
		const unit = this.nextUnit();
		const ev = this.unhandledEvents();
		const pending = this.listFiles("assessments", "pending-", ".json");
		return [
			`领域：${this.domain().domain ?? "（未设置，运行 /domain 开始入学访谈）"}`,
			`掌握度：${LEVELS.map((lv) => `${lv} ${counts[lv]}`).join("  ")}`,
			unit ? `当前单元：${unit.id} ${unit.title}（${unit.status ?? "pending"}）` : "当前单元：无（先运行 /plan）",
			`到期复习概念：${this.dueConcepts().length}　未解决错误：${this.unresolvedErrors().length}`,
			`未处理事件：${ev.length}${ev.length ? "　→ " + ev.map((e) => e.type).join(", ") : ""}`,
			pending.length ? `待作答的测试：${pending[pending.length - 1]}（运行 /take）` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	// ---------- 提案文件 ----------

	writeProposal(kind: "plan" | "sources", data: unknown): string {
		return this.writeJson(join("proposals", `${kind}-${stamp()}.json`), data);
	}

	/**
	 * 最近一份尚未接受的提案（绝对路径）。按修改时间而非文件名排序：
	 * plan-* 与 sources-* 按名字排序会让资料提案永远压在规划提案之后。
	 */
	latestProposal(kind?: "plan" | "sources"): string | undefined {
		// 排除已接受的提案与评审文件（x.review.json 与提案同目录同前缀）
		const files = this.listFiles("proposals", kind ? `${kind}-` : "", ".json").filter((f) => !f.endsWith(".accepted.json") && !f.endsWith(".review.json"));
		if (!files.length) return undefined;
		const ranked = files
			.map((f) => ({ f, t: statSync(this.path("proposals", f)).mtimeMs }))
			.sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : 1));
		return this.path("proposals", ranked[ranked.length - 1].f);
	}

	/** 提案的可读摘要：供工具返回值与 /accept 的确认框使用，让学习者不必打开 JSON 文件审阅 */
	summarizeProposal(data: { concepts?: Concept[]; units?: Unit[]; notes?: string; sources?: Source[] }): string {
		if (Array.isArray(data.sources)) {
			return [
				`资料提案：${data.sources.length} 份`,
				...data.sources.map((s) => `- ${s.id}｜${s.title}｜${s.type ?? "?"}｜${s.locator ?? "?"}｜约 ${s.est_minutes ?? "?"} 分钟 → 单元 ${(s.for_units ?? []).join(", ") || "无"}${s.alternative ? "（替代）" : ""}`),
			].join("\n");
		}
		const concepts = data.concepts ?? [];
		const units = data.units ?? [];
		const core = concepts.filter((c) => c.tier === "core").length;
		const names = new Map(concepts.map((c) => [c.id, c.name]));
		return [
			`规划提案：${concepts.length} 个概念（core ${core}，branch ${concepts.length - core}），${units.length} 个单元`,
			...units.map((u) => `- ${u.id} ${u.title}：${u.concepts.map((id) => names.get(id) ?? id).join("、")}（退出标准 ${u.exit_criteria?.length ?? 0} 条）`),
			data.notes ? `依据：${data.notes}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	/** 提案文件原文（绝对路径），供上下文装配；不存在则返回说明 */
	readProposalText(absPath: string): string {
		return existsSync(absPath) ? readFileSync(absPath, "utf8") : `（文件不存在：${absPath}）`;
	}

	/** 提案评审文件：与提案同目录，x.json → x.review.json（Markdown 版 x.review.md） */
	reviewPathFor(proposalAbs: string): string {
		return proposalAbs.replace(/\.accepted\.json$/, ".json").replace(/\.json$/, ".review.json");
	}
	readReview(proposalAbs: string): Record<string, unknown> | undefined {
		const p = this.reviewPathFor(proposalAbs);
		if (!existsSync(p)) return undefined;
		try {
			return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	writeReview(proposalAbs: string, data: Record<string, unknown>, markdown: string): { json: string; md: string } {
		const json = this.reviewPathFor(proposalAbs);
		writeFileSync(json, JSON.stringify(data, null, 2) + "\n", "utf8");
		const md = json.replace(/\.review\.json$/, ".review.md");
		writeFileSync(md, markdown, "utf8");
		return { json, md };
	}

	/** 接受后把 x.json 改名为 x.accepted.json，避免 /accept 重复合并同一份提案 */
	markProposalAccepted(absPath: string): string {
		if (absPath.endsWith(".accepted.json")) return absPath;
		const target = absPath.replace(/\.json$/, ".accepted.json");
		renameSync(absPath, target);
		return target;
	}

	renamePending(pendingRel: string): void {
		const p = this.path(pendingRel);
		if (existsSync(p)) renameSync(p, p.replace("pending-", "taken-"));
	}
}

// ======================================================================
// 掌握度状态机：只升不降由 promote 控制；升降由测试结果驱动
// ======================================================================

export function levelIndex(c: Concept): number {
	return Math.max(0, LEVELS.indexOf(c.mastery ?? "untouched"));
}

/** by 为 tutor 时上限 learned；为 assessor 时上限 consolidated。只升不降。 */
export function promote(c: Concept, target: Level, by: "tutor" | "assessor"): boolean {
	const cap: Level = by === "tutor" ? "learned" : "consolidated";
	const t = Math.min(LEVELS.indexOf(target), LEVELS.indexOf(cap));
	if (t > levelIndex(c)) {
		c.mastery = LEVELS[t];
		return true;
	}
	return false;
}

function reviewOf(c: Concept): Review {
	c.review ??= { interval_idx: 0, streak: 0, due: null };
	c.review.interval_idx ??= 0;
	c.review.streak ??= 0;
	c.review.due ??= null;
	return c.review;
}

export function onPass(c: Concept): void {
	const r = reviewOf(c);
	r.streak += 1;
	r.interval_idx = Math.min(r.interval_idx + 1, INTERVALS.length - 1);
	r.due = addDays(INTERVALS[r.interval_idx]);
	promote(c, r.streak >= 3 ? "consolidated" : "tested", "assessor");
}

export function onFail(c: Concept): void {
	const r = reviewOf(c);
	r.streak = 0;
	r.interval_idx = 0;
	r.due = addDays(1);
	c.mastery = LEVELS[Math.max(1, levelIndex(c) - 1)]; // 降一级，但不低于 touched
}

export function onPartial(c: Concept): void {
	reviewOf(c).due = addDays(2); // 状态不变，尽快复测
}

/** 把 plan 提案合并进黑板：保留已有概念的掌握度与复习状态，保留已有单元的状态与资料 */
export function acceptPlan(bb: Blackboard, proposal: { concepts?: Concept[]; units?: Unit[]; notes?: string }): { concepts: number; units: number } {
	const old = bb.conceptIndex();
	const merged: Concept[] = (proposal.concepts ?? []).map((c) => {
		const prev = old.get(c.id);
		return prev
			? { ...c, mastery: prev.mastery ?? "untouched", review: prev.review, evidence: prev.evidence ?? [] }
			: { ...c, mastery: c.mastery ?? "untouched", evidence: c.evidence ?? [] };
	});
	const oldUnits = new Map(bb.units().map((u) => [u.id, u]));
	const units: Unit[] = (proposal.units ?? []).map((u) => ({
		...u,
		status: oldUnits.get(u.id)?.status ?? "pending",
		sources: oldUnits.get(u.id)?.sources ?? u.sources ?? [],
	}));
	bb.saveConcepts(merged);
	bb.saveUnits(units, proposal.notes);
	bb.emit("structure_ready", { units: units.filter((u) => !u.sources?.length).map((u) => u.id) });
	bb.markHandled(["replan_request"]);
	return { concepts: merged.length, units: units.length };
}

/** 把 sources 提案合并进黑板：verified 一律 false，并把资料 id 挂到单元上 */
export function acceptSources(bb: Blackboard, proposal: { sources?: Source[] }): number {
	const existing = new Map(bb.sources().map((s) => [s.id, s]));
	const units = bb.units();
	for (const s of proposal.sources ?? []) {
		const merged: Source = { ...(existing.get(s.id) ?? {}), ...s, verified: existing.get(s.id)?.verified ?? false };
		existing.set(s.id, merged);
		for (const uid of s.for_units ?? []) {
			const u = units.find((x) => x.id === uid);
			if (u) {
				u.sources ??= [];
				if (!u.sources.includes(s.id)) u.sources.push(s.id);
			}
		}
	}
	bb.saveSources([...existing.values()]);
	bb.saveUnits(units);
	bb.markHandled(["structure_ready", "resource_request"]);
	return existing.size;
}
