/**
 * scripts.test.ts —— 定时出题的判定逻辑（due-check.mjs），以及 assess-cron.mjs 在"跳过"分支不会启动 pi。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error 纯 JS 模块，无类型声明
import { dueReport } from "../scripts/due-check.mjs";
import { makeProject } from "./fake-pi.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const today = new Date().toISOString().slice(0, 10);

describe("due-check", () => {
	const project = makeProject(repoRoot);
	const bb = join(project.cwd, "blackboard");
	after(() => project.cleanup());

	const writeConcepts = (concepts: unknown[]) => writeFileSync(join(bb, "concepts.json"), JSON.stringify({ concepts }), "utf8");

	it("空黑板：无可考核概念，跳过", () => {
		const r = dueReport(project.cwd);
		assert.equal(r.should, false);
		assert.equal(r.testable, 0);
	});

	it("有 learned 概念且从未测试（距上次 999 天）：生成", () => {
		writeConcepts([{ id: "a", name: "A", mastery: "learned", evidence: [] }]);
		const r = dueReport(project.cwd);
		assert.equal(r.should, true);
		assert.equal(r.due, 1);
		assert.equal(r.days, 999);
	});

	it("最近测过、到期不足 3 个、无事件：跳过；有 unit_complete 事件：生成", () => {
		mkdirSync(join(bb, "assessments"), { recursive: true });
		writeFileSync(join(bb, "assessments", "20990101-result.json"), JSON.stringify({ date: today }), "utf8");
		writeConcepts([
			{ id: "a", name: "A", mastery: "tested", evidence: [], review: { due: "2999-01-01", interval_idx: 1, streak: 1 } },
			{ id: "b", name: "B", mastery: "learned", evidence: [] },
		]);
		assert.equal(dueReport(project.cwd).should, false);
		writeFileSync(join(bb, "events.jsonl"), JSON.stringify({ ts: today, type: "unit_complete", payload: {}, handled: false }) + "\n", "utf8");
		assert.equal(dueReport(project.cwd).should, true);
	});

	it("已有待作答的 pending 测试：不重复出题", () => {
		writeFileSync(join(bb, "assessments", "pending-1.json"), "{}", "utf8");
		const r = dueReport(project.cwd);
		assert.equal(r.pending, 1);
		assert.equal(r.should, false);
	});

	it("作为脚本运行时以退出码表达结论", () => {
		const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "due-check.mjs")], { cwd: project.cwd, encoding: "utf8" });
		assert.equal(r.status, 1);
		assert.match(r.stdout, /跳过/);
	});
});

describe("assess-cron", () => {
	it("判定为跳过时不启动 pi，退出码 0", () => {
		const project = makeProject(repoRoot);
		try {
			// 把 PI_BIN 指向不存在的程序：若脚本误启动 pi，会报错并以非零退出
			const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "assess-cron.mjs")], {
				cwd: project.cwd,
				encoding: "utf8",
				env: { ...process.env, PI_BIN: join(project.cwd, "no-such-pi") },
			});
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, /跳过/);
		} finally {
			project.cleanup();
		}
	});
});
