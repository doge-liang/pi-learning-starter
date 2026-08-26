/**
 * project.ts —— 学习项目（黑板）的识别与新建。
 *
 * 一块黑板 = 一个学习项目目录：blackboard/ 是数据，.pi/extensions/learning 是扩展。
 * 换领域重新开始的正解是「换目录」而非「清文件」——黑板、群转写、pi 会话都按目录天然隔离。
 * 新建 = 从现有项目复制扩展骨架（不带任何学习数据）+ 写一份与仓库种子等价的空黑板。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 学习项目的最低结构：黑板数据 + 学习扩展 */
export function isLearningProject(dir: string): boolean {
	return existsSync(join(dir, "blackboard", "domain.json")) && existsSync(join(dir, ".pi", "extensions", "learning"));
}

/**
 * 在 destDir 新建学习项目：复制 srcDir 的扩展骨架（.pi/extensions、.pi/learning.json、AGENTS.md），
 * 写空种子黑板。destDir 已有黑板或非空目录则拒绝——绝不覆盖既有数据。
 */
export function initLearningProject(srcDir: string, destDir: string): void {
	if (!isLearningProject(srcDir)) throw new Error(`源目录不是学习项目（缺 blackboard/ 或 .pi/extensions/learning）：${srcDir}`);
	if (existsSync(destDir) && readdirSync(destDir).length > 0) throw new Error(`目标目录非空，拒绝初始化：${destDir}`);
	mkdirSync(destDir, { recursive: true });
	cpSync(join(srcDir, ".pi", "extensions"), join(destDir, ".pi", "extensions"), { recursive: true });
	for (const f of [join(".pi", "learning.json"), "AGENTS.md"]) {
		if (existsSync(join(srcDir, f))) cpSync(join(srcDir, f), join(destDir, f));
	}
	writeSeedBlackboard(join(destDir, "blackboard"));
}

/** 与仓库种子等价的空黑板：未访谈的 domain、空概念 / 路径 / 资料、术语表头、空日志、全部子目录 */
export function writeSeedBlackboard(dir: string): void {
	for (const d of ["", "evidence", "artifacts", "artifacts/reviews", "assessments", "reflections", "proposals", "exemplars", "placement", "library"]) mkdirSync(join(dir, d), { recursive: true });
	const w = (rel: string, text: string) => writeFileSync(join(dir, rel), text, "utf8");
	w("domain.json", `${JSON.stringify({ language: "zh", preferences: { formats: ["textbook", "paper", "course", "code"], languages: ["zh", "en"] } }, null, 2)}\n`);
	w("concepts.json", '{ "concepts": [] }\n');
	w("path.json", '{ "units": [], "notes": "" }\n');
	w("sources.json", '{ "sources": [] }\n');
	w("glossary.md", "# 术语表\n\n由学习者亲笔撰写。\n");
	w("errors.jsonl", "");
	w("events.jsonl", "");
}
