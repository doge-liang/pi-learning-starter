/**
 * lock.test.ts —— 黑板跨进程锁：互斥、陈旧回收、超时。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { withBlackboardLock } from "../.pi/extensions/learning/lock.ts";

describe("黑板跨进程锁", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-learning-lock-"));
	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("并发的读改写在锁下串行，不丢更新", async () => {
		const file = join(cwd, "counter.txt");
		writeFileSync(file, "0", "utf8");
		const bump = () =>
			withBlackboardLock(cwd, async () => {
				const n = Number(readFileSync(file, "utf8"));
				await new Promise((r) => setTimeout(r, 20)); // 制造重叠窗口：无锁时必然丢更新
				writeFileSync(file, String(n + 1), "utf8");
			});
		await Promise.all([bump(), bump(), bump(), bump(), bump()]);
		assert.equal(readFileSync(file, "utf8"), "5");
	});

	it("陈旧锁被回收；活跃锁导致等待并最终超时", async () => {
		const lockDir = join(cwd, ".pi", "blackboard.lock");
		mkdirSync(lockDir, { recursive: true });
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(lockDir, old, old);
		// 陈旧：回收后正常获得锁
		assert.equal(await withBlackboardLock(cwd, () => "ok"), "ok");
		// 活跃：占住锁，短超时内失败
		mkdirSync(lockDir);
		await assert.rejects(withBlackboardLock(cwd, () => "x", { timeoutMs: 200, retryMs: 20 }), /等待锁超时/);
		rmSync(lockDir, { recursive: true, force: true });
	});

	it("fn 抛错时锁被释放", async () => {
		await assert.rejects(
			withBlackboardLock(cwd, () => {
				throw new Error("boom");
			}),
			/boom/,
		);
		assert.equal(await withBlackboardLock(cwd, () => "again"), "again");
	});
});
