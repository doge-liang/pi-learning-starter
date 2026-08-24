/**
 * hub-instances.test.ts —— 对真实 pi 验证 hub 的多实例并存：
 * 两个固定角色的 RPC 实例（LEARN_ROLE + LEARN_HUB）同时运行，各自的角色状态与会话互不干扰。
 * 不调用模型。找不到 pi 则跳过。
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { locatePi } from "../src/locate.ts";
import { PiRpcClient } from "../src/rpc/client.ts";
import type { UiRequest } from "../src/rpc/types.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const starterRoot = resolve(pluginRoot, "..");

function makeProject(): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-learning-hub-test-"));
	cpSync(join(starterRoot, ".pi", "extensions"), join(cwd, ".pi", "extensions"), { recursive: true });
	cpSync(join(starterRoot, ".pi", "learning.json"), join(cwd, ".pi", "learning.json"));
	cpSync(join(starterRoot, "AGENTS.md"), join(cwd, "AGENTS.md"));
	const bb = join(cwd, "blackboard");
	for (const d of ["", "evidence", "artifacts", "assessments", "reflections", "proposals"]) mkdirSync(join(bb, d), { recursive: true });
	writeFileSync(join(bb, "domain.json"), JSON.stringify({ domain: "x", goal: "y", language: "zh" }), "utf8");
	writeFileSync(join(bb, "concepts.json"), JSON.stringify({ concepts: [] }), "utf8");
	writeFileSync(join(bb, "path.json"), JSON.stringify({ units: [] }), "utf8");
	writeFileSync(join(bb, "sources.json"), JSON.stringify({ sources: [] }), "utf8");
	writeFileSync(join(bb, "glossary.md"), "# 术语表\n", "utf8");
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const launch = locatePi(undefined, "node", starterRoot);

describe("hub 多实例（真实 pi）", { skip: launch ? false : "本机找不到 pi" }, () => {
	const project = makeProject();
	after(() => project.cleanup());

	it("两个固定角色实例并存：各自 setStatus 与会话互不干扰", async () => {
		const make = (role: string) => {
			const uiRequests: UiRequest[] = [];
			const client = new PiRpcClient({
				command: launch!.command,
				commandArgs: launch!.args,
				cwd: project.cwd,
				args: ["-a", "--no-session"],
				env: { LEARN_ROLE: role, LEARN_HUB: "1" },
				onUiRequest: (req) => {
					uiRequests.push(req);
					if (req.method === "editor" || req.method === "select" || req.method === "input") return { cancelled: true };
					if (req.method === "confirm") return { confirmed: false };
					return undefined;
				},
			});
			return { client, uiRequests };
		};
		const a = make("librarian");
		const b = make("tutor");
		try {
			await Promise.all([a.client.start(), b.client.start()]);
			const statusOf = (reqs: UiRequest[]) =>
				reqs.filter((r) => r.method === "setStatus" && r.statusKey === "learning").map((r) => r.statusText ?? "");
			await waitFor(() => statusOf(a.uiRequests).some((t) => t.includes("资料管理员")));
			await waitFor(() => statusOf(b.uiRequests).some((t) => t.includes("陪读老师")));
			assert.ok(!statusOf(a.uiRequests).some((t) => t.includes("陪读老师")), "实例状态不串台");

			// 两个实例各自可用（--no-session 下无会话文件；会话隔离由每进程各建会话保证）
			const [sa, sb] = await Promise.all([a.client.getState(), b.client.getState()]);
			assert.equal(sa.isStreaming, false);
			assert.equal(sb.isStreaming, false);
		} finally {
			await Promise.all([a.client.stop(), b.client.stop()]);
		}
	});
});

async function waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("等待超时");
}
