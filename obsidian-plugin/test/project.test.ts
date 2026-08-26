/**
 * project.test.ts —— 学习项目（黑板）的识别与新建：纯文件操作，无进程。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { initLearningProject, isLearningProject, listBlackboardFiles, prettyBlackboardText, writeSeedBlackboard } from "../src/project.ts";

const starterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("学习项目的识别与新建", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-learning-project-"));
	after(() => rmSync(base, { recursive: true, force: true }));

	it("isLearningProject：starter 仓库是；空目录与只有黑板的目录不是", () => {
		assert.ok(isLearningProject(starterRoot));
		const empty = join(base, "empty");
		mkdirSync(empty, { recursive: true });
		assert.equal(isLearningProject(empty), false);
		const onlyBb = join(base, "only-bb");
		writeSeedBlackboard(join(onlyBb, "blackboard"));
		assert.equal(isLearningProject(onlyBb), false, "缺扩展不算学习项目");
	});

	it("initLearningProject：复制扩展骨架 + 空种子黑板，产物即合法学习项目", () => {
		const dest = join(base, "new-project");
		initLearningProject(starterRoot, dest);
		assert.ok(isLearningProject(dest));
		assert.ok(existsSync(join(dest, ".pi", "extensions", "learning", "index.ts")), "扩展代码应复制");
		assert.ok(existsSync(join(dest, ".pi", "learning.json")), "角色配置应复制");
		const domain = JSON.parse(readFileSync(join(dest, "blackboard", "domain.json"), "utf8"));
		assert.equal(domain.domain, undefined, "种子黑板未访谈，不携带任何学习数据");
		assert.ok(existsSync(join(dest, "blackboard", "library")), "全部子目录就位");
	});

	it("拒绝覆盖：目标非空即报错；源不是学习项目即报错", () => {
		const occupied = join(base, "occupied");
		mkdirSync(occupied, { recursive: true });
		writeFileSync(join(occupied, "x.txt"), "y", "utf8");
		assert.throws(() => initLearningProject(starterRoot, occupied), /非空/);
		assert.throws(() => initLearningProject(join(base, "empty"), join(base, "another")), /不是学习项目/);
	});

	it("listBlackboardFiles：核心文件置顶、子目录递归、相对路径用 /；目录不存在返回空", () => {
		const proj = join(base, "listing");
		writeSeedBlackboard(join(proj, "blackboard"));
		writeFileSync(join(proj, "blackboard", "placement", "pending-1.json"), "{}", "utf8");
		const rels = listBlackboardFiles(proj).map((f) => f.rel);
		assert.deepEqual(rels.slice(0, 4), ["domain.json", "concepts.json", "path.json", "sources.json"], "核心文件按既定次序置顶");
		assert.ok(rels.includes("placement/pending-1.json"), "子目录文件带相对路径");
		assert.ok(rels.indexOf("glossary.md") < rels.indexOf("placement/pending-1.json"), "非核心文件排在核心之后");
		assert.deepEqual(listBlackboardFiles(join(base, "nowhere")), []);
	});

	it("prettyBlackboardText：JSON 统一缩进；坏 JSON 与非 JSON 原样返回", () => {
		assert.equal(prettyBlackboardText("domain.json", '{"a":1}'), '{\n  "a": 1\n}');
		assert.equal(prettyBlackboardText("domain.json", "{oops"), "{oops");
		assert.equal(prettyBlackboardText("glossary.md", "# 术语表"), "# 术语表");
		assert.equal(prettyBlackboardText("events.jsonl", '{"a":1}\n{"b":2}'), '{"a":1}\n{"b":2}', "jsonl 不整体解析，原样逐行显示");
	});
});
