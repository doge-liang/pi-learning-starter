/**
 * markdown-blocks.test.ts —— 流式渲染切块与围栏闭合的纯函数测试。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeOpenFence, splitBlocks } from "../src/markdown-blocks.ts";

const NL = String.fromCharCode(10);
const lines = (...xs: string[]) => xs.join(NL);

describe("splitBlocks", () => {
	it("空行分块，末尾块是 tail", () => {
		const r = splitBlocks(lines("第一段", "", "第二段", "", "第三段未完"));
		assert.deepEqual(r.blocks, ["第一段", "第二段"]);
		assert.equal(r.tail, "第三段未完");
	});

	it("围栏代码里的空行不是边界；围栏未闭合时整段留在 tail", () => {
		const r = splitBlocks(lines("前言", "", "```ts", "a", "", "b"));
		assert.deepEqual(r.blocks, ["前言"]);
		assert.equal(r.tail, lines("```ts", "a", "", "b"));
	});

	it("围栏闭合并遇到空行后成为稳定块", () => {
		const r = splitBlocks(lines("```", "x", "", "y", "```", "", "后文"));
		assert.deepEqual(r.blocks, [lines("```", "x", "", "y", "```")]);
		assert.equal(r.tail, "后文");
	});

	it("文本以空行结尾时 tail 为空，稳定块保留", () => {
		const r = splitBlocks(lines("a", "", "b", ""));
		assert.deepEqual(r.blocks, ["a", "b"]);
		assert.equal(r.tail, "");
	});

	it("前缀稳定：追加文本不改变已切出的块", () => {
		const t1 = lines("a", "", "b 未完");
		const t2 = lines("a", "", "b 未完 续", "", "c");
		assert.deepEqual(splitBlocks(t1).blocks, ["a"]);
		assert.deepEqual(splitBlocks(t2).blocks.slice(0, 1), ["a"]);
	});

	it("波浪线围栏与更长的围栏", () => {
		const r = splitBlocks(lines("~~~", "", "````", "", "~~~", "", "尾"));
		assert.equal(r.blocks.length, 1);
		assert.equal(r.tail, "尾");
	});
});

describe("closeOpenFence", () => {
	it("未闭合的围栏临时补上", () => {
		assert.equal(closeOpenFence(lines("```py", "print(1)")), lines("```py", "print(1)", "```"));
	});
	it("已闭合或没有围栏则原样返回", () => {
		assert.equal(closeOpenFence(lines("```", "x", "```")), lines("```", "x", "```"));
		assert.equal(closeOpenFence("纯文本"), "纯文本");
	});
	it("内层更短的围栏不会误闭合外层", () => {
		const t = lines("````md", "```js", "a", "```");
		assert.equal(closeOpenFence(t), lines(t, "````"));
	});
});
