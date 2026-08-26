/**
 * sessions.ts —— 读取 pi 的会话目录，列出某个项目目录下的历史会话（供"历史会话"选择器使用）。
 *
 * 目录规则与 pi 的 SessionManager 一致：~/.pi/agent/sessions/--<cwd 去掉开头的斜杠、/ \ : 换成 ->--/<时间>_<uuid>.jsonl。
 * 只解析需要的几种条目：头部、session_info（名称）、message（计数与首句）。与 Obsidian 无关，可在 Node 里测试。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SessionSummary {
	path: string;
	id: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	/** fork 来源：pi 的 fork 会把根到落点的路径抄成新文件，头部记下旧文件路径；会话树以此连边 */
	parentSession?: string;
}

export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
	return join(homedir(), ".pi", "agent");
}

export function sessionDirFor(cwd: string, agent = agentDir()): string {
	const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agent, "sessions", safe);
}

/** 最近修改的在前 */
export function listSessions(cwd: string, agent = agentDir()): SessionSummary[] {
	const dir = sessionDirFor(cwd, agent);
	if (!existsSync(dir)) return [];
	const out: SessionSummary[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".jsonl")) continue;
		const p = join(dir, f);
		try {
			const s = summarize(p, readFileSync(p, "utf8"), statSync(p).mtime);
			if (s) out.push(s);
		} catch {
			/* 跳过损坏文件 */
		}
	}
	return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function summarize(path: string, content: string, modified: Date): SessionSummary | undefined {
	const lines = content.split("\n").filter((l) => l.trim());
	if (!lines.length) return undefined;
	let header: any;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		return undefined;
	}
	if (header?.type !== "session") return undefined;
	let name: string | undefined;
	let messageCount = 0;
	let firstMessage = "";
	for (let i = 1; i < lines.length; i++) {
		let e: any;
		try {
			e = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (e?.type === "session_info") {
			name = typeof e.name === "string" && e.name ? e.name : undefined; // 最后一条生效；空名视为清除
		} else if (e?.type === "message") {
			const role = e.message?.role;
			if (role === "user" || role === "assistant") messageCount++;
			if (!firstMessage && role === "user") firstMessage = userPreview(e.message?.content);
		}
	}
	return {
		path,
		id: String(header.id ?? ""),
		name,
		created: new Date(header.timestamp ?? modified),
		modified,
		messageCount,
		firstMessage,
		parentSession: typeof header.parentSession === "string" && header.parentSession ? header.parentSession : undefined,
	};
}

// ---------- 会话树：按 parentSession 派生关系把会话文件连成森林 ----------

export interface SessionTreeNode {
	session: SessionSummary;
	children: SessionTreeNode[];
}

/**
 * 构建会话森林：父文件缺失（被删、跨项目）或成环者作根。
 * 子节点按创建时间升序（分支的先后一目了然），根按子树最近活动降序。
 */
export function buildSessionTree(sessions: SessionSummary[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();
	for (const s of sessions) byPath.set(resolve(s.path), { session: s, children: [] });
	const roots: SessionTreeNode[] = [];
	for (const node of byPath.values()) {
		const parent = node.session.parentSession ? byPath.get(resolve(node.session.parentSession)) : undefined;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	// 环（互指等畸形数据）不可达于任何根：提为根，保证每个会话都出现在树里
	const seen = new Set<SessionTreeNode>();
	const mark = (n: SessionTreeNode) => {
		if (seen.has(n)) return;
		seen.add(n);
		for (const c of n.children) mark(c);
	};
	for (const r of roots) mark(r);
	for (const node of byPath.values()) {
		if (!seen.has(node)) {
			const parent = node.session.parentSession ? byPath.get(resolve(node.session.parentSession)) : undefined;
			if (parent) parent.children = parent.children.filter((c) => c !== node);
			roots.push(node);
			mark(node);
		}
	}
	const newest = (n: SessionTreeNode): number => Math.max(n.session.modified.getTime(), ...n.children.map(newest));
	const sortRec = (ns: SessionTreeNode[]) => {
		ns.sort((a, b) => a.session.created.getTime() - b.session.created.getTime());
		for (const n of ns) sortRec(n.children);
	};
	sortRec(roots);
	roots.sort((a, b) => newest(b) - newest(a));
	return roots;
}

function userPreview(content: unknown): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) text = content.map((c: any) => (c?.type === "text" ? String(c.text ?? "") : "")).join(" ");
	return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** 选择器里的一行文字 */
export function describeSession(s: SessionSummary): string {
	const when = formatDate(s.modified);
	const title = s.name ?? (s.firstMessage || "（空会话）");
	return `${when} · ${title} · ${s.messageCount} 条`;
}

function formatDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
