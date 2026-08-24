/**
 * library.ts —— 馆藏：本地副本的下载与命名、获取清单的呈现、馆藏概览与覆盖缺口。
 *
 * 这里是「收集」的执行面，由 actions.ts 的收集流程与馆藏概览（/go、前台工具）调用：
 * 每一步经学习者确认；资料管理员仍然只负责定位、判定获取等级与整理索引。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ACCESS_LABEL, type AccessLevel, type Blackboard, type Source, sourceGaps } from "./blackboard.ts";
import type { LibraryConfig } from "./config.ts";

/** 常见资料类型的扩展名，用于从 Content-Type 推断文件后缀 */
const EXT_BY_TYPE: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/epub+zip": ".epub",
	"application/zip": ".zip",
	"application/x-tex": ".tex",
	"text/html": ".html",
	"text/plain": ".txt",
	"text/markdown": ".md",
	"video/mp4": ".mp4",
};

const DEFAULT_MAX_MB = 64;
/** 下载与上传的默认超时；慢速链路上大文件仍应手工下载后在收集流程里填路径 */
export const TRANSFER_TIMEOUT_MS = 120_000;
export const API_TIMEOUT_MS = 30_000;

/**
 * 把外部 signal 与一个超时合并成一个 signal。
 * 命令执行期间 pi 的 ctx.signal 是 undefined（没有正在流式的回合），没有超时就意味着
 * 一个挂住的请求会把整个命令卡死，所以这里的超时是必需的而不是保险。
 */
export function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error(`请求超时（${Math.round(ms / 1000)} 秒）`)), ms);
	const onAbort = () => ctrl.abort(outer?.reason);
	outer?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: ctrl.signal,
		done: () => {
			clearTimeout(timer);
			outer?.removeEventListener("abort", onAbort);
		},
	};
}

export function libraryDirRel(cfg: LibraryConfig | undefined): string {
	return cfg?.dir?.trim() || "blackboard/library";
}

export function libraryDirAbs(cwd: string, cfg: LibraryConfig | undefined): string {
	return join(cwd, libraryDirRel(cfg));
}

/**
 * 可直接下载的 URL：优先元数据里的 url（馆员应填开放获取版本），其次 locator 本身是 URL 的情形。
 *
 * 只有馆员判为 open / campus（或尚未判定）的资料才给出直链：paid、physical 与 unavailable
 * 的直链多半只是付费墙落地页或书目页，自动拉回来除了污染馆藏没有别的作用。
 */
export function downloadableUrl(s: Source): string | undefined {
	if (!["open", "campus", "unknown", undefined].includes(s.access)) return undefined;
	for (const v of [s.meta?.url, s.locator]) {
		if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim();
	}
	if (s.meta?.doi) return `https://doi.org/${s.meta.doi.replace(/^https?:\/\/doi\.org\//i, "")}`;
	return undefined;
}

export interface Downloaded {
	/** 相对项目根的路径 */
	rel: string;
	abs: string;
	bytes: number;
	contentType: string;
	/** 落地页而非资料本身的可能性（Content-Type 是 HTML） */
	looksLikeLandingPage: boolean;
}

/**
 * 下载一份资料到馆藏目录。失败抛错，由命令层转成提示。
 * 只接受 http/https；超过上限直接拒绝，避免把整本影印书拖进项目目录。
 */
export async function download(
	url: string,
	opts: { cwd: string; cfg?: LibraryConfig; id: string; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Downloaded> {
	if (!/^https?:\/\//i.test(url)) throw new Error(`只支持 http/https 链接：${url}`);
	const maxBytes = Math.max(1, opts.cfg?.max_mb ?? DEFAULT_MAX_MB) * 1024 * 1024;
	const f = opts.fetchImpl ?? fetch;
	const t = withTimeout(TRANSFER_TIMEOUT_MS, opts.signal);
	let contentType = "";
	let buf: Buffer;
	let disposition: string | null = null;
	try {
		const res = await f(url, { redirect: "follow", signal: t.signal, headers: { "User-Agent": "pi-learning/0.1" } });
		if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
		contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		disposition = res.headers.get("content-disposition");
		const declared = Number(res.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new Error(`文件 ${(declared / 1048576).toFixed(1)} MB 超过上限 ${maxBytes / 1048576} MB；请手工下载后在收集流程里填本地路径。`);
		}
		buf = Buffer.from(await res.arrayBuffer());
	} finally {
		t.done();
	}
	if (buf.byteLength > maxBytes) throw new Error(`文件 ${(buf.byteLength / 1048576).toFixed(1)} MB 超过上限 ${maxBytes / 1048576} MB。`);

	const dirAbs = libraryDirAbs(opts.cwd, opts.cfg);
	mkdirSync(dirAbs, { recursive: true });
	const name = `${opts.id}${extFor(disposition, url, contentType)}`;
	const abs = join(dirAbs, name);
	writeFileSync(abs, buf);
	return {
		rel: `${libraryDirRel(opts.cfg)}/${name}`,
		abs,
		bytes: buf.byteLength,
		contentType,
		looksLikeLandingPage: contentType === "text/html",
	};
}

/** 后缀推断顺序：Content-Disposition 的文件名 → URL 路径 → Content-Type → .bin */
function extFor(disposition: string | null, url: string, contentType: string): string {
	const fromDisposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? "")?.[1];
	if (fromDisposition) {
		const e = extname(decodeURIComponent(fromDisposition));
		if (e) return e.toLowerCase();
	}
	try {
		const e = extname(basename(new URL(url).pathname));
		if (e && e.length <= 6) return e.toLowerCase();
	} catch {
		/* URL 解析失败时退到 Content-Type */
	}
	return EXT_BY_TYPE[contentType] ?? ".bin";
}

/** 获取清单：一份资料「在哪里、怎么拿到」的全部信息 */
export function acquireBrief(s: Source): string {
	const m = s.meta ?? {};
	const lines = [
		`${s.id}　${s.title}`,
		`类型：${s.type ?? "未标注"}　获取等级：${ACCESS_LABEL[(s.access ?? "unknown") as AccessLevel]}　估计 ${s.est_minutes ?? "?"} 分钟`,
		`定位：${s.locator ?? "unknown"}`,
	];
	const meta = [
		m.authors?.length ? `作者 ${m.authors.join("、")}` : "",
		m.year ? `${m.year}` : "",
		m.publisher ? `出版 ${m.publisher}` : "",
		m.edition ? `${m.edition}` : "",
		m.container ? `载体 ${m.container}` : "",
		m.pages ? `页码 ${m.pages}` : "",
		m.doi ? `DOI ${m.doi}` : "",
		m.isbn ? `ISBN ${m.isbn}` : "",
		m.url ? `URL ${m.url}` : "",
	].filter(Boolean);
	if (meta.length) lines.push(`元数据：${meta.join("　")}`);
	if (s.acquire_note) lines.push(`获取途径：${s.acquire_note}`);
	if (s.quality_note) lines.push(`选它的理由：${s.quality_note}`);
	const a = s.acquisition;
	if (a) {
		lines.push(
			`当前状态：${a.status === "obtained" ? "已获取" : a.status === "unavailable" ? "暂无渠道" : "未获取"}${a.local_path ? `　本地 ${a.local_path}` : ""}${a.zotero ? `　Zotero ${a.zotero.key ?? a.zotero.file ?? a.zotero.mode}` : ""}${a.remote ? `　网盘 ${a.remote.path}` : ""}`,
		);
	}
	return lines.join("\n");
}

/** 馆藏概览：按单元列出资料及其获取 / 核验状态，末尾给出缺口 */
export function libraryReport(bb: Blackboard, cwd: string, cfg: LibraryConfig | undefined, unitId?: string): string {
	const all = bb.sources();
	const active = all.filter((s) => !s.retired);
	const byId = new Map(all.map((s) => [s.id, s]));
	const obtained = active.filter((s) => s.acquisition?.status === "obtained");
	const out: string[] = [
		`馆藏（${libraryDirRel(cfg)}/）：在架 ${active.length} 份，已获取 ${obtained.length}，已核验 ${active.filter((s) => s.verified).length}，已下线 ${all.length - active.length}`,
	];

	const units = bb.units().filter((u) => !unitId || u.id === unitId);
	for (const u of units) {
		const ids = (u.sources ?? []).filter((id) => !byId.get(id)?.retired);
		out.push("", `${u.id}　${u.title}${ids.length ? "" : "　（无资料）"}`);
		for (const id of ids) {
			const s = byId.get(id);
			if (!s) {
				out.push(`  ?　${id}（不在 sources.json 中）`);
				continue;
			}
			out.push(`  ${flags(s)}　${s.id}　${s.title}（${s.type ?? "?"}｜${ACCESS_LABEL[(s.access ?? "unknown") as AccessLevel]}｜${s.est_minutes ?? "?"} 分钟）${s.alternative ? "［替代］" : ""}`);
			const detail = [
				s.acquisition?.local_path ? `本地 ${s.acquisition.local_path}${missing(cwd, s.acquisition.local_path) ? "（文件不存在）" : ""}` : "",
				s.acquisition?.zotero ? `Zotero ${s.acquisition.zotero.key ?? s.acquisition.zotero.file ?? s.acquisition.zotero.mode}` : "",
				s.acquisition?.remote ? `网盘 ${s.acquisition.remote.provider}:${s.acquisition.remote.path}` : "",
				s.tags?.length ? `标签 ${s.tags.join("、")}` : "",
			].filter(Boolean);
			if (detail.length) out.push(`      ${detail.join("　")}`);
			if (s.acquisition?.status !== "obtained" && s.acquire_note) out.push(`      获取途径：${s.acquire_note}`);
		}
	}

	const orphan = active.filter((s) => !(s.for_units ?? []).length);
	if (orphan.length) out.push("", `未挂到单元的资料：${orphan.map((s) => s.id).join("、")}`);

	const gaps = sourceGaps(bb);
	const unverified = active.filter((s) => s.acquisition?.status === "obtained" && !s.verified).map((s) => s.id);
	const unobtained = active.filter((s) => s.acquisition?.status !== "obtained").map((s) => s.id);
	const gapLines = [
		gaps.units.length ? `单元无资料：${gaps.units.join("、")}` : "",
		gaps.concepts.length ? `概念无资料：${gaps.concepts.join("、")}` : "",
		unobtained.length ? `未获取：${unobtained.join("、")}` : "",
		unverified.length ? `已获取但未核验：${unverified.join("、")}` : "",
	].filter(Boolean);
	if (gapLines.length) out.push("", "缺口：", ...gapLines.map((l) => `  ${l}`));
	if (gaps.units.length || gaps.concepts.length) out.push("  补料与整理：对前台说明即可，由资料管理员处理");
	return out.join("\n");
}

function flags(s: Source): string {
	return `${s.verified ? "已核验" : "未核验"}｜${s.acquisition?.status === "obtained" ? "已获取" : s.acquisition?.status === "unavailable" ? "无渠道" : "未获取"}`;
}

function missing(cwd: string, rel: string): boolean {
	const p = /^[a-zA-Z]:[\\/]|^\//.test(rel) ? rel : join(cwd, rel);
	try {
		return !existsSync(p) || !statSync(p).isFile();
	} catch {
		return true;
	}
}
