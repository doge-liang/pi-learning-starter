/**
 * project.ts —— 学习项目（黑板）的识别与新建。
 *
 * 一块黑板 = 一个学习项目目录：blackboard/ 是数据，.pi/extensions/learning 是扩展。
 * 换领域重新开始的正解是「换目录」而非「清文件」——黑板、群转写、pi 会话都按目录天然隔离。
 * 新建 = 从现有项目复制扩展骨架（不带任何学习数据）+ 写一份与仓库种子等价的空黑板。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

/** 黑板文件清单里置顶的核心文件（其余按路径字典序排在后面） */
const BLACKBOARD_PRIORITY = ["domain.json", "concepts.json", "path.json", "sources.json", "glossary.md", "errors.jsonl", "events.jsonl"];

export interface BlackboardFile {
	/** 相对 blackboard/ 的路径，统一用 / 分隔 */
	rel: string;
	size: number;
}

/**
 * 列出黑板目录下的全部文件（Obsidian 隐藏点目录、不显示 .json，
 * 黑板浏览器据此清单自行展示）。核心文件置顶，其余按路径排序。
 */
export function listBlackboardFiles(projectDir: string): BlackboardFile[] {
	const root = join(projectDir, "blackboard");
	if (!existsSync(root)) return [];
	const out: BlackboardFile[] = [];
	const walk = (dir: string, prefix: string, depth: number) => {
		if (depth > 4) return;
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const st = statSync(full);
			if (st.isDirectory()) walk(full, `${prefix}${name}/`, depth + 1);
			else out.push({ rel: `${prefix}${name}`, size: st.size });
		}
	};
	walk(root, "", 0);
	const rank = (f: BlackboardFile) => {
		const i = BLACKBOARD_PRIORITY.indexOf(f.rel);
		return i === -1 ? BLACKBOARD_PRIORITY.length : i;
	};
	return out.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
}

interface ExamItem {
	id?: string;
	area?: string;
	concept?: string;
	level?: string;
	type?: string;
	question?: string;
}

/**
 * 试卷文件（placement/ 或 assessments/ 下的 pending-/taken-*.json）渲染成卷面 markdown：
 * 题干按题号排版可读；参考答案与评分要点一律不出现（闭卷——原始 JSON 视图等于泄题）。
 * 不是试卷或结构不符返回 undefined，走普通 JSON 展示。
 */
export function examMarkdown(rel: string, raw: string): string | undefined {
	if (!/^(placement|assessments)\/(pending-|taken-).*\.json$/.test(rel)) return undefined;
	let data: { date?: string; areas?: Array<{ area?: string }>; items?: ExamItem[] };
	try {
		data = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(data.items) || !data.items.length) return undefined;
	const lines: string[] = [`# 试卷${data.date ? ` · ${data.date}` : ""}`, ""];
	const areas = (data.areas ?? []).map((a) => a?.area).filter(Boolean);
	if (areas.length) lines.push(`考察领域：${areas.join("、")}`, "");
	data.items.forEach((it, i) => {
		const meta = [it.area ?? it.concept, it.level, it.type].filter(Boolean).join(" · ");
		lines.push(`### 第 ${i + 1} 题${meta ? `（${meta}）` : ""}`, "", String(it.question ?? "").trim(), "");
	});
	lines.push("> 参考答案与评分要点已隐藏（闭卷）。要作答就对相应角色说，或直接发送 /go take——会按题号逐题弹出作答框。");
	return lines.join("\n");
}

/** 黑板文件的显示文本：JSON 统一缩进美化（坏 JSON 原样），其余原样 */
export function prettyBlackboardText(rel: string, raw: string): string {
	if (rel.endsWith(".json")) {
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}
	return raw;
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
