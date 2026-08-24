/**
 * zotero.ts —— 把一份资料的题录（与本地副本）送进 Zotero。
 *
 * 三种模式，按「不需要配置就能用」到「最省事」排列：
 * - file      写一份 CSL-JSON 到馆藏目录，学习者在 Zotero 里「文件 → 导入」。默认模式，无凭据、跨平台、可重复。
 * - connector 打本地 Zotero 桌面端的连接器端口（浏览器插件用的同一个），题录直接落库。
 * - web       Zotero Web API：建题录，并把本地副本作为附件按官方三步流程上传。
 *
 * 与黑板的其他部分一样，这里只被逐步确认的收集流程（actions.ts 的 runCollect）调用。
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { Source } from "./blackboard.ts";
import { type LibraryConfig, secret, type ZoteroConfig } from "./config.ts";
import { API_TIMEOUT_MS, libraryDirAbs, libraryDirRel, TRANSFER_TIMEOUT_MS, withTimeout } from "./library.ts";

const ZOTERO_API = "https://api.zotero.org";
const DEFAULT_CONNECTOR = "http://127.0.0.1:23119";

/** pi-learning 的资料类型 → Zotero itemType / CSL type */
const TYPE_MAP: Record<string, { zotero: string; csl: string }> = {
	textbook: { zotero: "book", csl: "book" },
	paper: { zotero: "journalArticle", csl: "article-journal" },
	course: { zotero: "document", csl: "document" },
	doc: { zotero: "webpage", csl: "webpage" },
	blog: { zotero: "blogPost", csl: "post-weblog" },
	video: { zotero: "videoRecording", csl: "motion_picture" },
	other: { zotero: "document", csl: "document" },
};

export interface ZoteroCreator {
	creatorType: string;
	name: string;
}
export interface ZoteroItem {
	itemType: string;
	title: string;
	creators?: ZoteroCreator[];
	date?: string;
	publisher?: string;
	edition?: string;
	publicationTitle?: string;
	pages?: string;
	DOI?: string;
	ISBN?: string;
	url?: string;
	language?: string;
	abstractNote?: string;
	extra?: string;
	tags?: Array<{ tag: string }>;
	collections?: string[];
}

/** 题录映射：只写确知的字段，缺失的一律留空，不猜测 */
export function toZoteroItem(s: Source, collection?: string): ZoteroItem {
	const m = s.meta ?? {};
	const map = TYPE_MAP[s.type ?? "other"] ?? TYPE_MAP.other;
	const item: ZoteroItem = {
		itemType: map.zotero,
		title: s.title,
		// pi-learning 的资料 id 写进 extra，便于日后在 Zotero 里回查是哪个单元的资料
		extra: [`pi-learning-source: ${s.id}`, s.for_units?.length ? `pi-learning-units: ${s.for_units.join(", ")}` : ""].filter(Boolean).join("\n"),
	};
	if (m.authors?.length) item.creators = m.authors.map((name) => ({ creatorType: "author", name }));
	if (m.year) item.date = String(m.year);
	if (m.publisher) item.publisher = m.publisher;
	if (m.edition) item.edition = m.edition;
	if (m.container) item.publicationTitle = m.container;
	if (m.pages) item.pages = m.pages;
	if (m.doi) item.DOI = m.doi;
	if (m.isbn) item.ISBN = m.isbn;
	if (m.url) item.url = m.url;
	if (m.language) item.language = m.language;
	if (s.quality_note) item.abstractNote = s.quality_note;
	const tags = [...(s.tags ?? []), ...(s.covers ?? []).map((c) => `concept:${c}`)];
	if (tags.length) item.tags = [...new Set(tags)].map((tag) => ({ tag }));
	if (collection) item.collections = [collection];
	return item;
}

/** CSL-JSON（file 模式导入用）：字段名与 Zotero item 不同，单独映射 */
export function toCslJson(s: Source): Record<string, unknown> {
	const m = s.meta ?? {};
	const map = TYPE_MAP[s.type ?? "other"] ?? TYPE_MAP.other;
	const csl: Record<string, unknown> = { id: s.id, type: map.csl, title: s.title };
	if (m.authors?.length) csl.author = m.authors.map((name) => ({ literal: name }));
	if (m.year) csl.issued = { "date-parts": [[m.year]] };
	if (m.publisher) csl.publisher = m.publisher;
	if (m.edition) csl.edition = m.edition;
	if (m.container) csl["container-title"] = m.container;
	if (m.pages) csl.page = m.pages;
	if (m.doi) csl.DOI = m.doi;
	if (m.isbn) csl.ISBN = m.isbn;
	if (m.url) csl.URL = m.url;
	if (m.language) csl.language = m.language;
	const note = [`pi-learning-source: ${s.id}`, s.locator ? `定位：${s.locator}` : "", s.quality_note ?? ""].filter(Boolean).join("\n");
	if (note) csl.note = note;
	return csl;
}

export interface ZoteroResult {
	mode: "file" | "connector" | "web";
	key?: string;
	/** file 模式写出的文件（相对项目根） */
	file?: string;
	message: string;
}

export interface ZoteroOptions {
	cwd: string;
	cfg?: ZoteroConfig;
	library?: LibraryConfig;
	/** 本地副本的绝对路径；web 模式据此上传附件 */
	localAbs?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export async function saveToZotero(source: Source, opts: ZoteroOptions): Promise<ZoteroResult> {
	const mode = opts.cfg?.mode ?? "file";
	switch (mode) {
		case "connector":
			return saveViaConnector(source, opts);
		case "web":
			return saveViaWebApi(source, opts);
		default:
			return saveToFile(source, opts);
	}
}

/** file 模式：<馆藏目录>/zotero/<id>.json，一份 CSL-JSON 数组，导入后可以删除 */
function saveToFile(source: Source, opts: ZoteroOptions): ZoteroResult {
	const dir = join(libraryDirAbs(opts.cwd, opts.library), "zotero");
	mkdirSync(dir, { recursive: true });
	const abs = join(dir, `${source.id}.json`);
	writeFileSync(abs, `${JSON.stringify([toCslJson(source)], null, 2)}\n`, "utf8");
	const rel = `${libraryDirRel(opts.library)}/zotero/${source.id}.json`;
	return {
		mode: "file",
		file: rel,
		message: `已写出 CSL-JSON：${rel}。在 Zotero 里「文件 → 导入 → 选择该文件」入库${opts.localAbs ? `，再把本地副本 ${basename(opts.localAbs)} 拖到该条目上作为附件` : ""}。`,
	};
}

/** connector 模式：本地 Zotero 桌面端必须正在运行 */
async function saveViaConnector(source: Source, opts: ZoteroOptions): Promise<ZoteroResult> {
	const endpoint = (opts.cfg?.endpoint ?? DEFAULT_CONNECTOR).replace(/\/$/, "");
	const item = toZoteroItem(source, opts.cfg?.collection) as ZoteroItem & { attachments?: Array<{ title: string; url: string; mimeType?: string }> };
	// 连接器只能按 URL 抓附件，拿不到本地路径；本地副本仍需学习者手工拖进条目
	if (item.url) item.attachments = [{ title: source.title, url: item.url }];
	const f = opts.fetchImpl ?? fetch;
	const res = await req(
		f,
		`${endpoint}/connector/saveItems`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Zotero-Connector-API-Version": "2", "User-Agent": "pi-learning/0.1" },
			body: JSON.stringify({ items: [item], uri: item.url ?? "" }),
		},
		opts.signal,
	);
	if (!res.ok) throw new Error(`Zotero 连接器返回 HTTP ${res.status}；确认 Zotero 桌面端正在运行（端点 ${endpoint}）。`);
	return {
		mode: "connector",
		message: `已通过本地 Zotero 连接器入库${opts.localAbs ? `；本地副本 ${basename(opts.localAbs)} 请手工拖到该条目上作为附件（连接器只能按 URL 抓附件）` : ""}。`,
	};
}

/** web 模式：建题录，再按官方三步流程上传本地副本作为附件 */
async function saveViaWebApi(source: Source, opts: ZoteroOptions): Promise<ZoteroResult> {
	const apiKey = secret(opts.cfg?.api_key);
	const prefix = opts.cfg?.group_id ? `groups/${opts.cfg.group_id}` : opts.cfg?.user_id ? `users/${opts.cfg.user_id}` : undefined;
	if (!apiKey || !prefix) throw new Error("Zotero web 模式需要在 .pi/learning.json 里配置 zotero.api_key（建议写 env:ZOTERO_API_KEY）与 zotero.user_id 或 zotero.group_id。");
	const f = opts.fetchImpl ?? fetch;
	const base = `${ZOTERO_API}/${prefix}`;
	const headers = { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3", "Content-Type": "application/json" };

	const key = await postItems(f, base, headers, [toZoteroItem(source, opts.cfg?.collection)], opts.signal);
	let message = `已通过 Zotero Web API 入库，条目 key ${key}。`;
	if (opts.localAbs && opts.cfg?.attach !== false) {
		try {
			await uploadAttachment(f, base, headers, apiKey, key, opts.localAbs, opts.signal);
			message += `附件 ${basename(opts.localAbs)} 已上传。`;
		} catch (e) {
			// 题录已经建成，附件失败不该回滚，只报告
			message += `附件上传失败（${(e as Error).message}）；可在 Zotero 里手工添加 ${basename(opts.localAbs)}。`;
		}
	}
	return { mode: "web", key, message };
}

type FetchLike = typeof fetch;

/** 所有对外请求都带超时：命令执行期间 pi 不提供可取消的 signal，挂住的请求会卡死整个命令 */
async function req(f: FetchLike, url: string, init: RequestInit, outer?: AbortSignal, ms = API_TIMEOUT_MS): Promise<Response> {
	const t = withTimeout(ms, outer);
	try {
		return await f(url, { ...init, signal: t.signal });
	} finally {
		t.done();
	}
}

async function postItems(f: FetchLike, base: string, headers: Record<string, string>, items: unknown[], signal?: AbortSignal): Promise<string> {
	const res = await req(f, `${base}/items`, { method: "POST", headers, body: JSON.stringify(items) }, signal);
	if (!res.ok) throw new Error(`Zotero Web API 返回 HTTP ${res.status} ${res.statusText}`);
	const body = (await res.json()) as { successful?: Record<string, { key?: string }>; failed?: Record<string, { message?: string }> };
	const failed = Object.values(body.failed ?? {})[0];
	if (failed) throw new Error(`Zotero 拒绝了条目：${failed.message ?? "未说明"}`);
	const key = Object.values(body.successful ?? {})[0]?.key;
	if (!key) throw new Error("Zotero 未返回条目 key。");
	return key;
}

/** 官方附件上传：建 attachment 子条目 → 申请上传授权 → 传到对象存储 → 回执注册 */
async function uploadAttachment(f: FetchLike, base: string, headers: Record<string, string>, apiKey: string, parentKey: string, localAbs: string, signal?: AbortSignal): Promise<void> {
	const data = readFileSync(localAbs);
	const filename = basename(localAbs);
	const md5 = createHash("md5").update(data).digest("hex");
	const mtime = Math.floor(statSync(localAbs).mtimeMs);

	const attKey = await postItems(
		f,
		base,
		headers,
		[{ itemType: "attachment", parentItem: parentKey, linkMode: "imported_file", title: filename, filename, contentType: contentTypeOf(filename) }],
		signal,
	);

	const formHeaders = { "Zotero-API-Key": apiKey, "Zotero-API-Version": "3", "Content-Type": "application/x-www-form-urlencoded", "If-None-Match": "*" };
	const authRes = await req(
		f,
		`${base}/items/${attKey}/file`,
		{ method: "POST", headers: formHeaders, body: new URLSearchParams({ md5, filename, filesize: String(data.byteLength), mtime: String(mtime), params: "1" }).toString() },
		signal,
	);
	if (!authRes.ok) throw new Error(`申请上传授权失败：HTTP ${authRes.status}`);
	const auth = (await authRes.json()) as { exists?: number; url?: string; contentType?: string; prefix?: string; suffix?: string; uploadKey?: string };
	if (auth.exists) return; // 服务端已有同一份文件

	if (!auth.url || !auth.uploadKey) throw new Error("上传授权响应缺少 url 或 uploadKey。");
	const body = Buffer.concat([Buffer.from(auth.prefix ?? "", "utf8"), data, Buffer.from(auth.suffix ?? "", "utf8")]);
	const putRes = await req(f, auth.url, { method: "POST", headers: { "Content-Type": auth.contentType ?? "application/octet-stream" }, body: new Uint8Array(body) }, signal, TRANSFER_TIMEOUT_MS);
	if (!putRes.ok) throw new Error(`上传到存储失败：HTTP ${putRes.status}`);

	const doneRes = await req(f, `${base}/items/${attKey}/file`, { method: "POST", headers: formHeaders, body: new URLSearchParams({ upload: auth.uploadKey }).toString() }, signal);
	if (!doneRes.ok) throw new Error(`上传回执注册失败：HTTP ${doneRes.status}`);
}

const MIME_BY_EXT: Record<string, string> = {
	".pdf": "application/pdf",
	".epub": "application/epub+zip",
	".html": "text/html",
	".htm": "text/html",
	".txt": "text/plain",
	".md": "text/markdown",
	".mp4": "video/mp4",
	".zip": "application/zip",
};

function contentTypeOf(filename: string): string {
	const ext = /\.[a-z0-9]+$/i.exec(filename)?.[0]?.toLowerCase() ?? "";
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
