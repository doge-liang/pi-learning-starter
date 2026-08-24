/**
 * triggers.ts —— 自主触发（hub P3）：轮询黑板，把满足条件的准备性工作派发给对应实例。
 *
 * 原则（HUB-PLAN §3.7）：自主性来自触发器而非拓扑。实例被唤醒后做的只是「准备」——
 * 选材提案、出题、重规划提案——产物照旧落黑板排队等学习者裁决，闸门一个不少。
 * 判定是纯代码（computeTriggers），与扩展的 nextSteps 同一套规则的无人值守子集；
 * 看门器负责节流：默认关闭（设置里打开）、队列空闲且无实例在流式时才触发、
 * 每次轮询至多一项、每个触发键有冷却时间。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { InstanceManager } from "./instances.ts";
import type { PiLearningSettings } from "./settings.ts";

export interface Trigger {
	/** 冷却去重的键 */
	key: string;
	role: string;
	/** 派发给实例的消息（/go 路由） */
	message: string;
	reason: string;
}

function readJson<T>(p: string, fallback: T): T {
	try {
		return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
	} catch {
		return fallback;
	}
}

function listFiles(dir: string, prefix: string, suffix: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix));
}

/** 与扩展 nextSteps 同源的无人值守判定：只产出「实例能独立准备」的工作 */
export function computeTriggers(projectDir: string): Trigger[] {
	const bb = join(projectDir, "blackboard");
	if (!existsSync(bb)) return [];

	const events: Array<{ type: string; payload?: Record<string, unknown>; handled?: boolean }> = [];
	const eventsFile = join(bb, "events.jsonl");
	if (existsSync(eventsFile)) {
		for (const line of readFileSync(eventsFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				/* 容忍坏行 */
			}
		}
	}
	const unhandled = events.filter((e) => !e.handled);
	const has = (type: string) => unhandled.some((e) => e.type === type);

	// 待裁决的产物存在时不再叠加生产：提案压提案、测试压测试只会堆积对话框
	const pendingProposal = listFiles(join(bb, "proposals"), "", ".json").some((f) => !f.endsWith(".accepted.json") && !f.endsWith(".review.json"));
	const pendingTest = listFiles(join(bb, "assessments"), "pending-", ".json").length > 0 || listFiles(join(bb, "placement"), "pending-", ".json").length > 0;

	const concepts = readJson<{ concepts: Array<{ mastery?: string; review?: { due?: string | null } }> }>(join(bb, "concepts.json"), { concepts: [] }).concepts ?? [];
	const today = new Date().toISOString().slice(0, 10);
	const testable = concepts.filter((c) => ["learned", "tested", "consolidated"].includes(c.mastery ?? ""));
	const due = testable.filter((c) => !c.review?.due || c.review.due <= today);

	const units = readJson<{ units: Array<{ id: string; sources?: string[] }> }>(join(bb, "path.json"), { units: [] }).units ?? [];
	const unsourced = units.filter((u) => !u.sources?.length).map((u) => u.id);

	const out: Trigger[] = [];

	if (has("replan_request") && !pendingProposal) {
		out.push({ key: "planner-replan", role: "planner", message: "/go plan replan", reason: "复盘发现结构性缺口（replan_request），请规划者准备增量重规划提案" });
	}
	if (!pendingTest && testable.length) {
		if (has("unit_complete") || has("errors_threshold")) {
			out.push({ key: "assessor-generate", role: "assessor", message: "/go assess", reason: "单元完成或错误累计（unit_complete / errors_threshold），请复盘老师出题" });
		} else if (due.length >= 3) {
			out.push({ key: "assessor-generate", role: "assessor", message: "/go assess", reason: `到期复习概念 ${due.length} 个，请复盘老师出题` });
		}
	}
	if (!pendingProposal) {
		for (const e of unhandled.filter((x) => x.type === "resource_request")) {
			const unit = String(e.payload?.unit ?? "").trim();
			if (!unit) continue;
			const note = String(e.payload?.note ?? "").trim();
			out.push({ key: `librarian-alt-${unit}`, role: "librarian", message: `/go sources ${unit} ${note}`.trim(), reason: `阅读中请求了替代资料（${unit}），请资料管理员准备提案` });
		}
		if ((has("structure_ready") || has("sources_gap")) && unsourced.length) {
			out.push({ key: "librarian-sources", role: "librarian", message: "/go sources", reason: `单元缺资料（${unsourced.join(", ")}），请资料管理员准备选材提案` });
		}
	}
	return out;
}

export class TriggerWatcher {
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastFired = new Map<string, number>();
	// 不用构造器参数属性：本文件被 node --test 直接加载，类型剥离模式不支持该语法
	private manager: InstanceManager;
	private settings: () => PiLearningSettings;

	constructor(manager: InstanceManager, settings: () => PiLearningSettings) {
		this.manager = manager;
		this.settings = settings;
	}

	start(intervalMs = 5 * 60_000): void {
		this.stop();
		this.timer = setInterval(() => void this.poll(), intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** 一次轮询；返回实际触发的项（无则 null），供测试与日志 */
	async poll(now = Date.now()): Promise<Trigger | null> {
		const s = this.settings();
		if (!s.autoTriggers) return null;
		const dir = s.projectDir?.trim();
		if (!dir) return null;
		if (this.manager.pendingCount) return null; // 队列忙：不与学习者抢
		for (const [, c] of this.manager.all()) if (c.streaming) return null;
		const cooldownMs = Math.max(1, s.triggerCooldownMinutes) * 60_000;
		for (const t of computeTriggers(dir)) {
			const last = this.lastFired.get(t.key) ?? 0;
			if (now - last < cooldownMs) continue;
			this.lastFired.set(t.key, now);
			this.manager.dispatchAuto(t.role, t.message, t.reason);
			return t; // 每次轮询至多一项，避免突发
		}
		return null;
	}
}
