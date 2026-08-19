/**
 * state.ts —— 会话级状态：当前角色、单元、模式、学习者已收集的作答。
 *
 * 持久化两条路：
 * 1. pi.appendEntry("learning-state", state)：随会话文件保存，/resume 后在 session_start 中恢复；
 * 2. 交接文件 .pi/learning-handoff.json：/read、/assess 等命令通过 ctx.newSession 切到新会话时，
 *    旧扩展实例把目标角色写进文件，新实例在 session_start(reason="new") 中读取并删除。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Role = "intake" | "planner" | "critic" | "librarian" | "tutor" | "reviewer" | "assessor";
export const ROLE_NAMES: Role[] = ["intake", "planner", "critic", "librarian", "tutor", "reviewer", "assessor"];

export interface PreQuestion {
	id: string;
	text: string;
	concept?: string;
}
export interface LearnerAnswer {
	id: string;
	answer: string;
	confidence: number; // 1–5
}

export interface LearningState {
	role: Role | null;
	/** 陪读老师会话的单元 id */
	unit?: string;
	/** 陪读老师模式：hint（默认）或 explain */
	mode: "hint" | "explain";
	/** 陪读老师登记的预问题（bb_prequestions 写入） */
	prequestions: PreQuestion[];
	/** /answer 收集的闭卷作答（含信心），由 bb_evidence 合并进证据 */
	answers: LearnerAnswer[];
	/** 复盘：/take 收集的作答与所属测试文件（相对 blackboard/） */
	testFile?: string;
	responses: LearnerAnswer[];
	/** 评审：产出物路径 */
	artifact?: string;
	/** 提案评审：待审提案的绝对路径（/critique 设置） */
	proposal?: string;
	/** 上一次注入的上下文哈希，避免重复注入 */
	contextHash?: string;
}

export function emptyState(): LearningState {
	return { role: null, mode: "hint", prequestions: [], answers: [], responses: [] };
}

const ENTRY_TYPE = "learning-state";

export function persist(pi: ExtensionAPI, state: LearningState): void {
	pi.appendEntry(ENTRY_TYPE, state);
}

/** 从当前分支的会话条目恢复最后一次保存的状态（/fork 后只看所在分支）；找不到返回 null */
export function restore(ctx: ExtensionContext): LearningState | null {
	let found: LearningState | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
			found = { ...emptyState(), ...(entry.data as Partial<LearningState>) };
		}
	}
	return found;
}

// ---------- 会话切换时的交接文件 ----------

function handoffPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "learning-handoff.json");
}

export function writeHandoff(cwd: string, partial: Omit<Partial<LearningState>, "role"> & { role: Role; sessionName?: string }): void {
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(handoffPath(cwd), JSON.stringify(partial), "utf8");
}

export function takeHandoff(cwd: string): (Omit<Partial<LearningState>, "role"> & { role: Role; sessionName?: string }) | null {
	const p = handoffPath(cwd);
	if (!existsSync(p)) return null;
	try {
		const data = JSON.parse(readFileSync(p, "utf8"));
		unlinkSync(p);
		return data;
	} catch {
		try {
			unlinkSync(p);
		} catch {
			/* ignore */
		}
		return null;
	}
}
