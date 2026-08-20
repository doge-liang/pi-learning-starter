/**
 * remote.ts —— 把本地副本送进网盘。
 *
 * - folder 模式（默认）：复制到网盘客户端的本地同步目录，由客户端自己上传。百度网盘、OneDrive、
 *   iCloud、坚果云都有本地同步目录，这条路不需要任何凭据，也不受各家 API 限制。
 * - webdav 模式：直接 PUT 到 WebDAV 服务器（坚果云、Nextcloud 等），凭据从环境变量取。
 *
 * 只被 /collect 命令调用；模型没有调用路径。
 */
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Source } from "./blackboard.ts";
import { type RemoteConfig, secret } from "./config.ts";
import { API_TIMEOUT_MS, TRANSFER_TIMEOUT_MS, withTimeout } from "./library.ts";

export interface RemoteResult {
	provider: string;
	/** 目标位置：folder 模式是绝对路径，webdav 模式是相对配置 URL 的路径 */
	path: string;
	message: string;
}

/** 网盘里的相对路径：按单元建子目录（默认）或全部平铺；文件名沿用本地副本名 */
export function remoteRelPath(source: Source, localAbs: string, cfg: RemoteConfig | undefined): string {
	const name = basename(localAbs);
	if ((cfg?.layout ?? "unit") === "flat") return name;
	const unit = source.for_units?.[0];
	return unit ? `${unit}/${name}` : name;
}

export async function pushToRemote(
	source: Source,
	localAbs: string,
	opts: { cfg?: RemoteConfig; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<RemoteResult> {
	const cfg = opts.cfg;
	if (!cfg || !cfg.mode) throw new Error("未配置网盘：在 .pi/learning.json 里写 remote.mode（folder 或 webdav）。");
	const rel = remoteRelPath(source, localAbs, cfg);
	if (cfg.mode === "folder") {
		if (!cfg.dir) throw new Error("folder 模式需要配置 remote.dir（网盘客户端的本地同步目录）。");
		const target = join(cfg.dir, rel);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(localAbs, target);
		return { provider: "folder", path: target, message: `已复制到 ${target}；由网盘客户端同步上传。` };
	}

	if (!cfg.url) throw new Error("webdav 模式需要配置 remote.url（目标目录的 WebDAV 地址）。");
	const base = cfg.url.replace(/\/$/, "");
	const f = opts.fetchImpl ?? fetch;
	const auth = cfg.user ? `Basic ${Buffer.from(`${cfg.user}:${secret(cfg.password) ?? ""}`).toString("base64")}` : undefined;
	const headers: Record<string, string> = auth ? { Authorization: auth } : {};

	// WebDAV 不会自动建父目录；MKCOL 逐级建，已存在时返回 405，按成功处理
	const segments = rel.split("/").slice(0, -1);
	let prefix = base;
	for (const seg of segments) {
		prefix = `${prefix}/${encodeURIComponent(seg)}`;
		const res = await req(f, prefix, { method: "MKCOL", headers }, opts.signal);
		if (!res.ok && res.status !== 405) throw new Error(`建目录 ${seg} 失败：HTTP ${res.status}`);
	}

	const target = `${base}/${rel.split("/").map(encodeURIComponent).join("/")}`;
	const data = readFileSync(localAbs);
	const res = await req(
		f,
		target,
		{ method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(statSync(localAbs).size) }, body: new Uint8Array(data) },
		opts.signal,
		TRANSFER_TIMEOUT_MS,
	);
	if (!res.ok) throw new Error(`上传失败：HTTP ${res.status} ${res.statusText}`);
	return { provider: "webdav", path: rel, message: `已上传到 ${target}。` };
}

/** 所有对外请求都带超时：命令执行期间 pi 不提供可取消的 signal */
async function req(f: typeof fetch, url: string, init: RequestInit, outer?: AbortSignal, ms = API_TIMEOUT_MS): Promise<Response> {
	const t = withTimeout(ms, outer);
	try {
		return await f(url, { ...init, signal: t.signal });
	} finally {
		t.done();
	}
}
