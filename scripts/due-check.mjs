#!/usr/bin/env node
// 判断是否应当生成一次复盘测试。作为脚本运行时，退出码 0 表示应当生成，1 表示跳过。
// 规则：有 3 个以上到期概念，或有待处理的 unit_complete / errors_threshold 事件，或距上次测试超过 7 天。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DUE_MIN = 3;
export const STALE_DAYS = 7;
export const TRIGGER_EVENTS = ["unit_complete", "errors_threshold"];

/** @param {string} projectRoot 含 blackboard/ 的项目目录 */
export function dueReport(projectRoot = process.cwd()) {
	const bb = join(projectRoot, "blackboard");
	const today = new Date().toISOString().slice(0, 10);
	const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
	const concepts = readJson(join(bb, "concepts.json"), { concepts: [] }).concepts ?? [];
	const testable = concepts.filter((c) => ["learned", "tested", "consolidated"].includes(c.mastery));
	const due = testable.filter((c) => !c.review?.due || c.review.due <= today).length;
	const events = existsSync(join(bb, "events.jsonl"))
		? readFileSync(join(bb, "events.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				.filter((e) => !e.handled && TRIGGER_EVENTS.includes(e.type))
		: [];
	const results = existsSync(join(bb, "assessments")) ? readdirSync(join(bb, "assessments")).filter((f) => f.endsWith("-result.json")).sort() : [];
	const last = results.length ? readJson(join(bb, "assessments", results.at(-1)), {}).date : null;
	const days = last ? Math.floor((Date.parse(today) - Date.parse(last)) / 86400000) : 999;
	const pending = existsSync(join(bb, "assessments")) ? readdirSync(join(bb, "assessments")).filter((f) => f.startsWith("pending-")).length : 0;
	// 没有 learned 及以上的概念时无题可出；已有未作答的测试时不再重复出题
	const should = testable.length > 0 && pending === 0 && (due >= DUE_MIN || events.length > 0 || days >= STALE_DAYS);
	const summary = `可考核 ${testable.length}，到期 ${due}，待处理事件 ${events.length}，距上次测试 ${days} 天，待作答 ${pending} → ${should ? "生成" : "跳过"}`;
	return { should, testable: testable.length, due, events: events.length, days, pending, summary };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
	const r = dueReport();
	console.log(r.summary);
	process.exit(r.should ? 0 : 1);
}
