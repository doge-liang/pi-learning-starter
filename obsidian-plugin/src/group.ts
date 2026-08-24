/**
 * group.ts —— 群转写的落盘与读取（hub P2，插件侧）。
 *
 * hub 把群里的往来写进学习项目的 .pi/group/hub.jsonl：学习者的寻址消息（from: "learner"）、
 * 各实例回复的文本摘要（from: 角色名）、自主触发的派发（from: "hub"）。
 * 扩展在 before_agent_start 读取尾部注入常驻实例的上下文（.pi/extensions/learning/group.ts），
 * 两侧共用同一条 JSONL 格式；评审员与复盘老师的隔离在扩展侧写死。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GroupEntry {
	ts: string;
	/** 角色名、"learner" 或 "hub" */
	from: string;
	to?: string[];
	text: string;
}

/** 单条回复写入群转写前的截断上限；完整原文永远在各实例自己的会话里 */
export const REPLY_MAX_CHARS = 2000;

export function groupFilePath(projectDir: string): string {
	return join(projectDir, ".pi", "group", "hub.jsonl");
}

export function appendGroupEntry(projectDir: string, entry: Omit<GroupEntry, "ts">): void {
	const p = groupFilePath(projectDir);
	mkdirSync(dirname(p), { recursive: true });
	appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString().slice(0, 19), ...entry })}\n`, "utf8");
}

/** 读取尾部条目（坏行容忍），供群视图开屏回放 */
export function readGroupTail(projectDir: string, max = 50): GroupEntry[] {
	const p = groupFilePath(projectDir);
	if (!existsSync(p)) return [];
	const out: GroupEntry[] = [];
	for (const line of readFileSync(p, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as GroupEntry;
			if (e && typeof e.from === "string" && typeof e.text === "string") out.push(e);
		} catch {
			/* 容忍坏行 */
		}
	}
	return out.slice(-max);
}

export function truncateText(text: string, max = REPLY_MAX_CHARS): string {
	return text.length > max ? `${text.slice(0, max)}…（截断）` : text;
}
