/**
 * hub.test.ts —— 常驻实例（hub）模式：LEARN_HUB=1 时角色固定在实例上，
 * 跨角色路由不切会话而提示学习者 @，同角色可原地重进（重设单元等参数）。
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import learningExtension from "../.pi/extensions/learning/index.ts";
import { READ_TOOLS, ROLES } from "../.pi/extensions/learning/roles.ts";
import { FakePi, makeCtx, makeProject, type UiScript } from "./fake-pi.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function lastState(pi: FakePi): any {
	return pi.entries.filter((e) => e.customType === "learning-state").at(-1)?.data as any;
}

describe("常驻实例（hub）模式", () => {
	const project = makeProject(repoRoot);
	const bbDir = join(project.cwd, "blackboard");
	after(() => project.cleanup());

	it("LEARN_ROLE 固定角色；跨角色路由提示 @ 且不切会话；同角色原地重进；none 被拒", async () => {
		process.env.LEARN_HUB = "1";
		process.env.LEARN_ROLE = "tutor";
		try {
			writeFileSync(join(bbDir, "domain.json"), JSON.stringify({ domain: "x", goal: "y", language: "zh" }), "utf8");
			writeFileSync(join(bbDir, "concepts.json"), JSON.stringify({ concepts: [{ id: "a", name: "A", mastery: "untouched", evidence: [] }] }), "utf8");
			writeFileSync(
				join(bbDir, "path.json"),
				JSON.stringify({ units: [{ id: "u01", title: "单元一", concepts: ["a"], sources: [] }, { id: "u02", title: "单元二", concepts: ["a"], sources: [] }] }),
				"utf8",
			);

			const pi = new FakePi();
			let newSessions = 0;
			const uiScript: Required<UiScript> = { editor: [], select: [], confirm: [], input: [] };
			const ctx = makeCtx(pi, {
				cwd: project.cwd,
				hasMessages: true, // 即便会话已有消息，hub 模式也不切换会话
				ui: uiScript,
				newSession: async () => {
					newSessions++;
					return { cancelled: false };
				},
			});
			learningExtension(pi.api());
			await pi.emit("session_start", { reason: "startup" }, ctx);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.tutor.tools], "环境变量固定角色，不落入前台默认");

			// 系统提示带常驻实例附加段
			const r = await pi.emit("before_agent_start", { systemPrompt: "BASE", messages: [] }, ctx);
			assert.ok(r?.systemPrompt.includes("常驻实例模式"));

			// 跨角色：提示 @ 对应实例，不 newSession，角色不变
			ctx.notices.length = 0;
			await pi.command("go").handler("assess", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("@复盘老师")));
			assert.equal(newSessions, 0);
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.tutor.tools]);

			// 同角色：原地重进并重设单元
			pi.sentMessages.length = 0;
			await pi.command("go").handler("read u02", ctx);
			assert.equal(newSessions, 0);
			assert.match(pi.lastMessage(), /\[begin-session\]/);
			assert.equal(lastState(pi).unit, "u02");

			// bb_route_ask 跨角色：返回 @ 指引文本，不弹选择框
			const before = ctx.selects.length;
			const ask = await pi.tool("bb_route_ask").execute("t", { routes: ["assess"] }, undefined, undefined, ctx);
			assert.match(ask.content[0].text, /@复盘老师/);
			assert.equal(ctx.selects.length, before, "跨角色路由不应弹框");

			// 常驻实例不支持退出学习模式
			ctx.notices.length = 0;
			await pi.command("go").handler("none", ctx);
			assert.ok(ctx.notices.some(([, m]) => m.includes("固定")));
			assert.deepEqual(pi.activeTools, [...READ_TOOLS, ...ROLES.tutor.tools]);
		} finally {
			delete process.env.LEARN_HUB;
			delete process.env.LEARN_ROLE;
		}
	});

	it("尾部询问过滤跨角色选项：规划提案只剩「接受」，跨角色以 @ 提示返回给模型", async () => {
		process.env.LEARN_HUB = "1";
		process.env.LEARN_ROLE = "planner";
		try {
			const pi = new FakePi();
			const uiScript: Required<UiScript> = { editor: [], select: [], confirm: [], input: [] };
			const ctx = makeCtx(pi, { cwd: project.cwd, ui: uiScript });
			learningExtension(pi.api());
			await pi.emit("session_start", { reason: "startup" }, ctx);

			uiScript.select.push("稍后再说");
			const r = await pi.tool("bb_plan_propose").execute(
				"t",
				{
					concepts: [{ id: "c1", name: "C1", tier: "core", prereqs: [] }],
					units: [{ id: "u01", title: "U", concepts: ["c1"], exercises: [], exit_criteria: [] }],
					notes: "",
				},
				undefined,
				undefined,
				ctx,
			);
			assert.match(r.content[0].text, /@提案评审员/, "被过滤的送评审选项转为 @ 提示");
			const [, options] = ctx.selects.at(-1)!;
			assert.deepEqual(options, ["审阅并接受（弹出摘要确认）", "稍后再说"], "选择框只剩角色无关的选项");
		} finally {
			delete process.env.LEARN_HUB;
			delete process.env.LEARN_ROLE;
		}
	});
});
