/**
 * sessions.test.ts —— 会话目录规则与会话文件摘要。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { describeSession, listSessions, sessionDirFor, summarize } from "../src/sessions.ts";

const NL = String.fromCharCode(10);

describe("sessionDirFor", () => {
	it("与 pi 的 SessionManager 规则一致：去掉开头斜杠，/ \\ : 换成 -，前后加 --", () => {
		const d = sessionDirFor("D:\\Workspace\\project\\pi-learning-starter", "C:\\agent");
		assert.ok(d.endsWith(join("sessions", "--D--Workspace-project-pi-learning-starter--")), d);
		if (process.platform !== "win32") {
			// Windows 上 resolve("/home/u/proj") 会加上盘符，只在类 Unix 上检验
			const u = sessionDirFor("/home/u/proj", "/home/u/.pi/agent");
			assert.ok(u.endsWith(join("sessions", "--home-u-proj--")), u);
		}
	});
});

describe("summarize / listSessions", () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-learning-agent-"));
	after(() => rmSync(agent, { recursive: true, force: true }));

	const session = (name: string | undefined, msgs: Array<[string, string]>) =>
		[
			JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-08-19T10:00:00.000Z", cwd: "D:/p" }),
			JSON.stringify({ type: "model_change", id: "m", parentId: null, provider: "x", modelId: "y" }),
			...(name ? [JSON.stringify({ type: "session_info", id: "s", parentId: "m", name })] : []),
			...msgs.map(([role, text], i) => JSON.stringify({ type: "message", id: `e${i}`, parentId: "s", message: { role, content: [{ type: "text", text }] } })),
		].join(NL) + NL;

	it("解析名称、消息数与首句；空会话与无名会话", () => {
		const s = summarize("/x/a.jsonl", session("planner plan", [["user", "请规划  路径"], ["assistant", "好的"], ["toolResult", "..."]]), new Date("2026-08-19T11:00:00Z"));
		assert.ok(s);
		assert.equal(s.id, "abc");
		assert.equal(s.name, "planner plan");
		assert.equal(s.messageCount, 2, "toolResult 不计入");
		assert.equal(s.firstMessage, "请规划 路径");
		assert.match(describeSession(s), /planner plan · 2 条$/);
		const e = summarize("/x/b.jsonl", session(undefined, []), new Date());
		assert.equal(e?.name, undefined);
		assert.match(describeSession(e!), /（空会话） · 0 条$/);
		assert.equal(summarize("/x/c.jsonl", "not json", new Date()), undefined);
	});

	it("listSessions 只读本项目目录，按修改时间倒序", () => {
		const cwd = "D:/Some/Project";
		const dir = sessionDirFor(cwd, agent);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "old.jsonl"), session("old", [["user", "a"]]), "utf8");
		writeFileSync(join(dir, "new.jsonl"), session("new", [["user", "b"]]), "utf8");
		// 另一个项目的会话不应出现
		const other = sessionDirFor("D:/Other", agent);
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "x.jsonl"), session("other", []), "utf8");
		// 让 new 更新
		const t = Date.now();
		utimesSync(join(dir, "old.jsonl"), new Date(t - 60000), new Date(t - 60000));
		utimesSync(join(dir, "new.jsonl"), new Date(t), new Date(t));
		const list = listSessions(cwd, agent);
		assert.deepEqual(list.map((s) => s.name), ["new", "old"]);
	});
});
