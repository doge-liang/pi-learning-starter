/**
 * auth.test.ts —— PiAuth 对真实 pi 安装的动态加载与供应商枚举。
 * 只做结构性断言（供应商目录、登录方式标记、模型目录非空）；不断言本机凭据状态
 * （auth.json 因机器而异），更不触发 login / logout（会写用户真实凭据文件）。
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PiAuth } from "../src/auth.ts";
import { locatePi } from "../src/locate.ts";

const starterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launch = locatePi(undefined, "node", starterRoot);

describe("PiAuth", { skip: launch ? false : "本机找不到 pi" }, () => {
	it("从 pi 安装加载供应商目录；含 OAuth 与 API key 登录方式的标记与模型目录", () => {
		const auth = PiAuth.load(launch);
		assert.ok(auth, "应能从 node + cli.js 形态定位 pi-ai");
		const providers = auth.listProviders();
		assert.ok(providers.length >= 30, `内置供应商应有数十个，实际 ${providers.length}`);
		const anthropic = providers.find((p) => p.id === "anthropic");
		assert.ok(anthropic?.oauthLabel, "anthropic 应有 OAuth 登录方式");
		assert.ok(anthropic?.apiKeyLabel, "anthropic 应有 API key 登录方式");
		assert.ok((anthropic?.models.length ?? 0) > 0, "anthropic 的模型目录应非空");
		const zai = providers.find((p) => p.id === "zai-coding-cn");
		assert.ok(zai?.apiKeyLabel, "zai-coding-cn 应有 API key 登录方式");
	});

	it("定位不到 cli.js 时返回 undefined（可执行文件形态、路径不存在）", () => {
		assert.equal(PiAuth.load(undefined), undefined);
		assert.equal(PiAuth.load({ command: "pi", args: [], source: "PATH" }), undefined);
		assert.equal(PiAuth.load({ command: "node", args: ["Z:/not-exist/cli.js"], source: "x" }), undefined);
	});
});
