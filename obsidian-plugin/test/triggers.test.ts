/**
 * triggers.test.ts —— 自主触发的判定（computeTriggers，纯代码）与看门器的节流（poll）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { InstanceManager } from "../src/instances.ts";
import type { PiLearningSettings } from "../src/settings.ts";
import { computeTriggers, TriggerWatcher } from "../src/triggers.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-learning-triggers-"));
const bb = join(dir, "blackboard");

function seed(opts: {
	events?: Array<Record<string, unknown>>;
	concepts?: Array<Record<string, unknown>>;
	units?: Array<Record<string, unknown>>;
	pendingProposal?: boolean;
	pendingTest?: boolean;
}): void {
	rmSync(bb, { recursive: true, force: true });
	for (const d of ["", "proposals", "assessments", "placement"]) mkdirSync(join(bb, d), { recursive: true });
	writeFileSync(join(bb, "events.jsonl"), (opts.events ?? []).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
	writeFileSync(join(bb, "concepts.json"), JSON.stringify({ concepts: opts.concepts ?? [] }), "utf8");
	writeFileSync(join(bb, "path.json"), JSON.stringify({ units: opts.units ?? [] }), "utf8");
	if (opts.pendingProposal) writeFileSync(join(bb, "proposals", "plan-1.json"), "{}", "utf8");
	if (opts.pendingTest) writeFileSync(join(bb, "assessments", "pending-1.json"), "{}", "utf8");
}

describe("computeTriggers", () => {
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("replan_request → 规划者；有待接受提案时抑制", () => {
		seed({ events: [{ ts: "t", type: "replan_request", payload: {}, handled: false }] });
		assert.deepEqual(computeTriggers(dir).map((t) => t.key), ["planner-replan"]);
		seed({ events: [{ ts: "t", type: "replan_request", payload: {}, handled: false }], pendingProposal: true });
		assert.deepEqual(computeTriggers(dir), []);
	});

	it("unit_complete / 到期复习 → 复盘老师；已有待作答测试或无可考概念时抑制", () => {
		const learned = [{ id: "a", mastery: "learned" }];
		seed({ events: [{ ts: "t", type: "unit_complete", payload: {}, handled: false }], concepts: learned });
		assert.deepEqual(computeTriggers(dir).map((t) => t.key), ["assessor-generate"]);

		seed({ events: [{ ts: "t", type: "unit_complete", payload: {}, handled: false }], concepts: learned, pendingTest: true });
		assert.deepEqual(computeTriggers(dir), []);

		seed({ events: [{ ts: "t", type: "unit_complete", payload: {}, handled: false }], concepts: [{ id: "a", mastery: "touched" }] });
		assert.deepEqual(computeTriggers(dir), [], "没有 learned 及以上的概念时无题可出");

		// 无事件但到期概念 ≥ 3
		const due = [
			{ id: "a", mastery: "tested", review: { due: "2020-01-01" } },
			{ id: "b", mastery: "learned" },
			{ id: "c", mastery: "consolidated", review: { due: "2020-01-02" } },
		];
		seed({ concepts: due });
		assert.deepEqual(computeTriggers(dir).map((t) => t.key), ["assessor-generate"]);
		seed({ concepts: due.slice(0, 2) });
		assert.deepEqual(computeTriggers(dir), [], "到期不足 3 个不触发");
	});

	it("resource_request 带单元与障碍说明 → 馆员替代资料；sources_gap 且有缺资料单元 → 馆员选材", () => {
		seed({
			events: [
				{ ts: "t", type: "resource_request", payload: { unit: "u02", note: "太难" }, handled: false },
				{ ts: "t", type: "sources_gap", payload: {}, handled: false },
			],
			units: [
				{ id: "u01", sources: ["s1"] },
				{ id: "u02", sources: [] },
			],
		});
		const ts = computeTriggers(dir);
		assert.deepEqual(ts.map((t) => t.key), ["librarian-alt-u02", "librarian-sources"]);
		assert.equal(ts[0].message, "/go sources u02 太难");
		assert.equal(ts[1].message, "/go sources");

		// 所有单元都有资料：sources_gap 不再触发选材
		seed({ events: [{ ts: "t", type: "sources_gap", payload: {}, handled: false }], units: [{ id: "u01", sources: ["s1"] }] });
		assert.deepEqual(computeTriggers(dir), []);
	});

	it("已处理事件不触发", () => {
		seed({ events: [{ ts: "t", type: "replan_request", payload: {}, handled: true }] });
		assert.deepEqual(computeTriggers(dir), []);
	});
});

describe("TriggerWatcher", () => {
	const fired: Array<{ role: string; message: string; reason: string }> = [];
	const manager = {
		pendingCount: 0,
		all: () => [] as Array<[string, { streaming: boolean }]>,
		dispatchAuto: (role: string, message: string, reason: string) => fired.push({ role, message, reason }),
	} as unknown as InstanceManager;
	// settings.ts 运行时依赖 obsidian 包（测试环境不可加载），此处手写字面量、仅类型导入
	const settings: PiLearningSettings = {
		projectDir: dir,
		projectHistory: [],
		piPath: "",
		nodePath: "",
		model: "",
		roleModels: {},
		thinking: "",
		roleThinking: {},
		extraArgs: "",
		autoStart: false,
		resumeLast: false,
		roleSessions: {},
		autoTriggers: true,
		triggerCooldownMinutes: 60,
	};

	beforeEach(() => {
		fired.length = 0;
	});

	it("开关关闭不触发；打开后每次轮询至多一项；冷却期内不重复", async () => {
		seed({ events: [{ ts: "t", type: "replan_request", payload: {}, handled: false }] });
		const w = new TriggerWatcher(manager, () => settings);

		settings.autoTriggers = false;
		assert.equal(await w.poll(), null);
		assert.equal(fired.length, 0);

		settings.autoTriggers = true;
		const t0 = Date.now();
		const t = await w.poll(t0);
		assert.equal(t?.key, "planner-replan");
		assert.deepEqual(fired.map((f) => f.message), ["/go plan replan"]);

		assert.equal(await w.poll(t0 + 10 * 60_000), null, "冷却期内不重复");
		assert.notEqual(await w.poll(t0 + 61 * 60_000), null, "冷却期过后可再触发");
	});

	it("队列忙或有实例在流式时让路", async () => {
		seed({ events: [{ ts: "t", type: "replan_request", payload: {}, handled: false }] });
		const busy = { ...manager, pendingCount: 1 } as unknown as InstanceManager;
		assert.equal(await new TriggerWatcher(busy, () => settings).poll(), null);
		const streaming = { pendingCount: 0, all: () => [["tutor", { streaming: true }]], dispatchAuto: () => {} } as unknown as InstanceManager;
		assert.equal(await new TriggerWatcher(streaming, () => settings).poll(), null);
	});
});
