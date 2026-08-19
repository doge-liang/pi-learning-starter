/**
 * load.test.ts —— 用 pi 自己的扩展加载器（jiti）加载 .pi/extensions/learning/，
 * 确认它在真实的 pi 0.84 环境下能被发现并完整注册（而不只是在 Node 的类型剥离下可运行）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("pi 扩展加载器", () => {
	// 空的 agentDir：只发现项目本地的 .pi/extensions，不受本机全局扩展影响
	const agentDir = mkdtempSync(join(tmpdir(), "pi-learning-agentdir-"));
	after(() => rmSync(agentDir, { recursive: true, force: true }));

	it("jiti 发现并加载扩展：无错误；10 个 bb_* 工具、20 个命令、4 个事件、1 个条目渲染器", async () => {
		const result = await discoverAndLoadExtensions([], repoRoot, agentDir);
		assert.deepEqual(result.errors, []);
		const ext = result.extensions.find((e) => e.resolvedPath.replace(/\\/g, "/").endsWith(".pi/extensions/learning/index.ts"));
		assert.ok(ext, `未发现学习扩展；已加载：${result.extensions.map((e) => e.path).join(", ")}`);
		const tools = [...ext.tools.keys()].sort();
		assert.deepEqual(tools, ["bb_check_link", "bb_domain_set", "bb_evidence", "bb_grade", "bb_plan_propose", "bb_prequestions", "bb_review", "bb_sources_propose", "bb_status", "bb_test_create"]);
		assert.equal(ext.commands.size, 20);
		assert.deepEqual([...ext.handlers.keys()].sort(), ["before_agent_start", "input", "session_start", "tool_call"]);
		assert.equal(ext.entryRenderers?.size, 1);
		// 每个 bb_* 工具都声明了 sequential，避免并行写黑板（bb_check_link 只读，不作要求）
		for (const [name, tool] of ext.tools) {
			if (name === "bb_check_link") continue;
			assert.equal(tool.definition.executionMode, "sequential", name);
		}
	});
});
