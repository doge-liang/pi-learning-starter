/**
 * group.test.ts —— 群转写落盘与读取：JSONL 追加、坏行容忍、尾部截断、回复摘要截断。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendGroupEntry, groupFilePath, readGroupTail, truncateText } from "../src/group.ts";

describe("群转写", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-learning-group-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("追加与读取：顺序保持、字段齐全、坏行容忍", () => {
		assert.deepEqual(readGroupTail(dir), [], "无文件时为空");
		appendGroupEntry(dir, { from: "learner", to: ["librarian"], text: "换一份资料" });
		appendGroupEntry(dir, { from: "librarian", text: "已提交提案。" });
		appendFileSync(groupFilePath(dir), "not json\n", "utf8");
		appendGroupEntry(dir, { from: "hub", to: ["assessor"], text: "到期出题" });

		const tail = readGroupTail(dir);
		assert.equal(tail.length, 3);
		assert.deepEqual(tail.map((e) => e.from), ["learner", "librarian", "hub"]);
		assert.deepEqual(tail[0].to, ["librarian"]);
		assert.ok(tail.every((e) => typeof e.ts === "string" && e.ts.length > 0));
	});

	it("尾部截断：只取最近 max 条", () => {
		for (let i = 0; i < 10; i++) appendGroupEntry(dir, { from: "learner", to: ["tutor"], text: `m${i}` });
		const tail = readGroupTail(dir, 5);
		assert.equal(tail.length, 5);
		assert.equal(tail[4].text, "m9");
	});

	it("回复摘要截断", () => {
		assert.equal(truncateText("短", 10), "短");
		const long = truncateText("x".repeat(100), 10);
		assert.ok(long.startsWith("xxxxxxxxxx") && long.endsWith("…（截断）"));
	});
});
