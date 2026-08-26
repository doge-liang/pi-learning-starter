/**
 * sessions.test.ts —— 会话目录规则与会话文件摘要。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSessionTree, describeSession, listSessions, sessionDirFor, type SessionSummary, summarize } from "../src/sessions.ts";

const NL = String.fromCharCode(10);

describe("sessionDirFor", () => {
	it("与 pi 的 SessionManager 规则一致：去掉开头斜杠，/ \\ : 换成 -，前后加 --", () => {
		// resolve() 只对本平台的绝对路径保持原样（Windows 路径在 Unix 上是相对路径，反之亦然），
		// 因此两种形态各在自己的平台上检验
		if (process.platform === "win32") {
			const d = sessionDirFor("D:\\Workspace\\project\\pi-learning-starter", "C:\\agent");
			assert.ok(d.endsWith(join("sessions", "--D--Workspace-project-pi-learning-starter--")), d);
		} else {
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

	it("summarize 解析 parentSession（fork 派生边）", () => {
		const raw = session("forked", [["user", "改一下"]]).replace('"cwd":"D:/p"', '"cwd":"D:/p","parentSession":"/x/a.jsonl"');
		const s = summarize("/x/f.jsonl", raw, new Date());
		assert.equal(s?.parentSession, "/x/a.jsonl");
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

describe("buildSessionTree", () => {
	const mk = (path: string, created: string, modified: string, parentSession?: string): SessionSummary => ({
		path,
		id: path,
		created: new Date(created),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: path,
		parentSession,
	});

	it("按 parentSession 连边；父缺失作根；子按创建时间升序，根按子树最近活动降序", () => {
		const a = mk("/s/a.jsonl", "2026-08-20T10:00:00Z", "2026-08-20T10:30:00Z");
		const b = mk("/s/b.jsonl", "2026-08-20T11:00:00Z", "2026-08-20T11:30:00Z", "/s/a.jsonl");
		const c = mk("/s/c.jsonl", "2026-08-20T12:00:00Z", "2026-08-27T09:00:00Z", "/s/a.jsonl");
		const orphan = mk("/s/o.jsonl", "2026-08-21T00:00:00Z", "2026-08-21T00:00:00Z", "/gone.jsonl");
		const roots = buildSessionTree([c, orphan, a, b]);
		assert.deepEqual(roots.map((r) => r.session.path), ["/s/a.jsonl", "/s/o.jsonl"], "a 子树的最近活动（c）更新，排前");
		assert.deepEqual(roots[0].children.map((n) => n.session.path), ["/s/b.jsonl", "/s/c.jsonl"], "同父分支按创建先后");
	});

	it("互指成环不丢节点：全部会话仍出现在树里", () => {
		const x = mk("/s/x.jsonl", "2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z", "/s/y.jsonl");
		const y = mk("/s/y.jsonl", "2026-08-20T11:00:00Z", "2026-08-20T11:00:00Z", "/s/x.jsonl");
		const all = new Set<string>();
		const walk = (n: { session: SessionSummary; children: unknown[] }) => {
			all.add(n.session.path);
			for (const c of n.children as Array<{ session: SessionSummary; children: unknown[] }>) walk(c);
		};
		for (const r of buildSessionTree([x, y])) walk(r);
		assert.deepEqual([...all].sort(), ["/s/x.jsonl", "/s/y.jsonl"]);
	});
});
