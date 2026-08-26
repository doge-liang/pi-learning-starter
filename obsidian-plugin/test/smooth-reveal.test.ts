/**
 * smooth-reveal.test.ts —— 匀速揭示的纯计算部分：步进速率与代理对安全切点。
 * SmoothReveal / SmoothPlainText 依赖 rAF 与 DOM，不在 Node 下实例化。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATCHUP_S, HURRY_MIN_CPS, MAX_CPS, MIN_CPS, revealStep, safeCut } from "../src/smooth-reveal.ts";

describe("revealStep", () => {
	it("小积压走常速下限，不会停顿", () => {
		assert.equal(revealStep(1, 1000), MIN_CPS);
		assert.equal(revealStep(Math.floor(MIN_CPS * CATCHUP_S), 1000), MIN_CPS);
	});

	it("积压越多越快：速率 ≈ 积压 / 追平时限，且封顶", () => {
		const backlog = 900;
		assert.equal(revealStep(backlog, 1000), backlog / CATCHUP_S);
		assert.equal(revealStep(1_000_000, 1000), MAX_CPS);
	});

	it("步进与帧时长成正比", () => {
		assert.equal(revealStep(900, 16), (900 / CATCHUP_S) * 0.016);
	});

	it("加速模式下限更高，剩余积压很快走完", () => {
		assert.equal(revealStep(1, 1000, true), HURRY_MIN_CPS);
		assert.ok(revealStep(300, 1000, true) > revealStep(300, 1000));
	});
});

describe("safeCut", () => {
	it("普通文本与边界原样返回", () => {
		assert.equal(safeCut("你好世界", 2), 2);
		assert.equal(safeCut("abc", 0), 0);
		assert.equal(safeCut("abc", 3), 3);
		assert.equal(safeCut("abc", 99), 3);
	});

	it("切点落在代理对中间时向前退一格，不劈开 emoji", () => {
		const s = `a${String.fromCodePoint(0x1f600)}b`; // a + 😀(两个码元) + b
		assert.equal(safeCut(s, 2), 1); // 2 恰在高低位代理之间
		assert.equal(safeCut(s, 3), 3); // 完整包含代理对
	});
});
