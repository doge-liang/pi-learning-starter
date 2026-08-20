/**
 * config.ts —— .pi/learning.json 的读取与类型。
 *
 * 除角色模型外，这里还配置馆藏（本地副本目录与大小上限）、Zotero 入库与网盘入库。
 * 凭据不写进配置文件：api_key、password 等字段写 "env:变量名"，运行时从环境变量取值
 * （与 pi 自己管理模型凭据的做法一致，配置文件可以进版本库）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { Role } from "./state.ts";

export interface LibraryConfig {
	/** 本地副本目录，相对项目根；默认 blackboard/library */
	dir?: string;
	/** 单份资料的下载上限（MB）；默认 64 */
	max_mb?: number;
}

export interface ZoteroConfig {
	/**
	 * file      写 CSL-JSON 到馆藏目录，学习者在 Zotero 里「文件 → 导入」（默认，无需配置与凭据）
	 * connector 本地 Zotero 桌面端的连接器端口，直接入库（需要 Zotero 正在运行）
	 * web       Zotero Web API，入库并上传附件（需要 api_key 与 user_id 或 group_id）
	 */
	mode?: "file" | "connector" | "web";
	/** connector 模式的端点；默认 http://127.0.0.1:23119 */
	endpoint?: string;
	user_id?: string;
	group_id?: string;
	/** 建议写 "env:ZOTERO_API_KEY" */
	api_key?: string;
	/** 目标分类的 key（可选） */
	collection?: string;
	/** web 模式是否上传本地副本作为附件；默认 true */
	attach?: boolean;
}

export interface RemoteConfig {
	/**
	 * folder 复制到网盘客户端的本地同步目录（百度网盘、OneDrive、坚果云等都可用，最稳且不需要凭据）
	 * webdav 直接 PUT 到 WebDAV 服务器（坚果云、Nextcloud 等）
	 */
	mode?: "folder" | "webdav";
	/** folder 模式的目标目录（绝对路径） */
	dir?: string;
	/** webdav 模式的目标目录 URL */
	url?: string;
	user?: string;
	/** 建议写 "env:WEBDAV_PASSWORD" */
	password?: string;
	/** 目录布局：flat 全部平铺；unit 按单元建子目录（默认） */
	layout?: "flat" | "unit";
}

export interface LearningConfig {
	/** 角色 → "provider/modelId"，例如 { "planner": "anthropic/claude-opus-5" } */
	models?: Partial<Record<Role, string>>;
	library?: LibraryConfig;
	zotero?: ZoteroConfig;
	remote?: RemoteConfig;
}

export function readConfig(cwd: string): LearningConfig {
	const p = join(cwd, CONFIG_DIR_NAME, "learning.json");
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf8")) as LearningConfig;
	} catch {
		return {};
	}
}

/** "env:NAME" → process.env.NAME；其余原样返回。空字符串按未配置处理。 */
export function secret(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const m = /^env:(.+)$/.exec(value.trim());
	const v = m ? process.env[m[1]] : value;
	return v ? v : undefined;
}
