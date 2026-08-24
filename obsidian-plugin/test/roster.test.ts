/**
 * roster.test.ts —— 花名册与 @ 寻址解析：纯代码，无进程。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAddress, ROSTER, roleSpec } from "../src/roster.ts";

describe("花名册", () => {
	it("八个角色，别名全局唯一", () => {
		assert.equal(ROSTER.length, 8);
		const all = ROSTER.flatMap((r) => r.aliases.map((a) => a.toLowerCase()));
		assert.equal(new Set(all).size, all.length, "别名不得跨角色重复");
		assert.equal(roleSpec("librarian")?.label, "资料管理员");
	});
});

describe("寻址解析", () => {
	it("单个与多个 @：识别、去重、保序，正文剥离寻址记号", () => {
		assert.deepEqual(parseAddress("@馆员 换一份资料"), { roles: ["librarian"], body: "换一份资料", unknown: undefined });
		assert.deepEqual(parseAddress("@规划者 @提案评审员 看看这个"), { roles: ["planner", "critic"], body: "看看这个", unknown: undefined });
		assert.deepEqual(parseAddress("@馆员 @资料管理员 x").roles, ["librarian"], "同角色别名去重");
	});

	it("别名不区分大小写；「评审员」与「提案评审员」是不同角色", () => {
		assert.deepEqual(parseAddress("@Tutor 开始").roles, ["tutor"]);
		assert.deepEqual(parseAddress("@评审员 x").roles, ["reviewer"]);
		assert.deepEqual(parseAddress("@提案评审员 x").roles, ["critic"]);
	});

	it("只 @ 不带话即唤醒（正文为空）；无 @ 则不寻址；中途的 @ 不解析", () => {
		assert.deepEqual(parseAddress("@老师"), { roles: ["tutor"], body: "", unknown: undefined });
		assert.deepEqual(parseAddress("没有寻址"), { roles: [], body: "没有寻址", unknown: undefined });
		assert.deepEqual(parseAddress("请 @馆员 帮忙").roles, [], "只认开头的 @");
	});

	it("未知的 @ 记号停止解析且不吞正文", () => {
		const r = parseAddress("@馆员长 你好");
		assert.deepEqual(r.roles, []);
		assert.equal(r.unknown, "馆员长");
		assert.equal(r.body, "@馆员长 你好");
		const r2 = parseAddress("@馆员 @不存在 你好");
		assert.deepEqual(r2.roles, ["librarian"]);
		assert.equal(r2.unknown, "不存在");
		assert.equal(r2.body, "@不存在 你好");
	});
});
