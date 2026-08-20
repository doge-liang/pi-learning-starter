/**
 * rpc-client.test.ts —— 对真实的 pi（RPC 模式）测试客户端：启动、状态、命令目录、
 * 扩展命令（/learn 的 learning-note 条目）、扩展 UI 子协议（notify、editor 取消）。不调用模型。
 *
 * 需要本机能定位到 pi（全局安装或项目 devDependency）；找不到则跳过。
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { locatePi } from "../src/locate.ts";
import { PiRpcClient } from "../src/rpc/client.ts";
import type { RpcEvent, UiRequest } from "../src/rpc/types.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const starterRoot = resolve(pluginRoot, "..");

/** 复制一份 starter（扩展 + 黑板）到临时目录，避免污染仓库；会话存到临时 agent 目录 */
function makeProject(): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-learning-plugin-test-"));
	// 只复制扩展与说明；黑板用最小种子生成（仓库里的 blackboard/ 可能是学习者的真实数据）
	cpSync(join(starterRoot, ".pi", "extensions"), join(cwd, ".pi", "extensions"), { recursive: true });
	cpSync(join(starterRoot, ".pi", "learning.json"), join(cwd, ".pi", "learning.json"));
	cpSync(join(starterRoot, "AGENTS.md"), join(cwd, "AGENTS.md"));
	const bb = join(cwd, "blackboard");
	for (const d of ["", "evidence", "artifacts", "assessments", "reflections", "proposals"]) mkdirSync(join(bb, d), { recursive: true });
	writeFileSync(join(bb, "domain.json"), JSON.stringify({ language: "zh" }), "utf8");
	writeFileSync(join(bb, "concepts.json"), JSON.stringify({ concepts: [] }), "utf8");
	writeFileSync(join(bb, "path.json"), JSON.stringify({ units: [] }), "utf8");
	writeFileSync(join(bb, "glossary.md"), "# 术语表\n", "utf8");
	// 给 /verify 准备一份未核验资料
	writeFileSync(join(bb, "sources.json"), JSON.stringify({ sources: [{ id: "s1", title: "Source One", verified: false }] }), "utf8");
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const launch = locatePi(undefined, "node", starterRoot);

describe("PiRpcClient 对真实 pi", { skip: launch ? false : "本机找不到 pi" }, () => {
	const project = makeProject();
	const events: RpcEvent[] = [];
	const uiRequests: UiRequest[] = [];
	let client: PiRpcClient;

	before(async () => {
		client = new PiRpcClient({
			command: launch!.command,
			commandArgs: launch!.args,
			cwd: project.cwd,
			args: ["-a", "--no-session"],
			onEvent: (e) => events.push(e),
			onUiRequest: (req) => {
				uiRequests.push(req);
				if (req.method === "editor") return { cancelled: true };
				if (req.method === "confirm") return { confirmed: false };
				if (req.method === "select") return { cancelled: true };
				return undefined;
			},
		});
		await client.start();
	});
	after(async () => {
		await client.stop();
		project.cleanup();
	});

	it("启动后 get_state 可用，get_commands 包含学习扩展的命令", async () => {
		const state = await client.getState();
		assert.equal(state.isStreaming, false);
		const names = (await client.getCommands()).map((c) => c.name);
		for (const n of ["learn", "placement", "plan", "critique", "exemplar", "accept", "sources", "verify", "read", "answer", "gloss", "done", "artifact", "review", "assess", "take", "reflect", "events", "dispatch", "role"]) {
			assert.ok(names.includes(n), `缺少命令 ${n}`);
		}
	});

	it("启动时扩展的 notify 经 extension_ui_request 到达", async () => {
		await waitFor(() => uiRequests.some((r) => r.method === "notify" && (r.message ?? "").includes("学习工作流已加载")));
	});

	it("/learn 产生 learning-note 条目（entry_appended 事件）", async () => {
		await client.prompt("/learn");
		await waitFor(() => events.some((e) => e.type === "entry_appended" && (e as any).entry?.customType === "learning-note"));
		const note = events.find((e) => e.type === "entry_appended" && (e as any).entry?.customType === "learning-note") as any;
		assert.match(note.entry.data.text, /掌握度：untouched 0/);
	});

	it("/verify s1 弹出 confirm，回应 false 后不置位；/gloss 在无角色时给 warning", async () => {
		await client.prompt("/verify s1");
		await waitFor(() => uiRequests.some((r) => r.method === "confirm" && (r.title ?? "").includes("确认核验")));
		// 取消后 verified 保持 false（扩展不会再发成功 notify）
		await sleep(300);
		assert.ok(!uiRequests.some((r) => r.method === "notify" && (r.message ?? "").includes("已标记 s1")));
		await client.prompt("/gloss nope");
		await waitFor(() => uiRequests.some((r) => r.method === "notify" && (r.message ?? "").includes("不在 concepts.json")));
	});

	it("/role intake 原地进入角色：收到 setStatus；/role none 清除", async () => {
		await client.prompt("/role placement");
		await waitFor(() => uiRequests.some((r) => r.method === "setStatus" && r.statusKey === "learning" && (r.statusText ?? "").includes("水平测试官")));
		await client.prompt("/role none");
		await waitFor(() => uiRequests.some((r) => r.method === "setStatus" && r.statusKey === "learning" && (r.statusText === undefined || r.statusText === null)));
	});

	it("模型列表与切换、思考等级列表（本机无可用模型时只检查接口可用）", async () => {
		const models = await client.getAvailableModels();
		assert.ok(Array.isArray(models));
		if (models.length) {
			const m = models[0];
			await client.setModel(m.provider, m.id);
			const st = await client.getState();
			assert.equal(st.model?.id, m.id);
			assert.equal(st.model?.provider, m.provider);
			const levels = await client.getAvailableThinkingLevels();
			assert.ok(levels.length >= 1);
			await client.setThinkingLevel(levels[0]);
		}
	});

	it("stop 后 running 为 false，再次 send 抛错", async () => {
		const c2 = new PiRpcClient({ command: launch!.command, commandArgs: launch!.args, cwd: project.cwd, args: ["-a", "--no-session"] });
		await c2.start();
		assert.equal(c2.running, true);
		await c2.stop();
		assert.equal(c2.running, false);
		await assert.rejects(c2.getState(), /未启动|已停止|已退出/);
	});
});

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return;
		await sleep(50);
	}
	throw new Error("等待超时");
}
function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
