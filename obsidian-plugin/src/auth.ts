/**
 * auth.ts —— 模型供应商的认证状态与登录 / 登出。
 *
 * RPC 模式没有认证命令：pi 子进程只吃启动时 auth.json 里已有的凭据。本模块在插件进程内
 * 动态加载 pi 安装自带的 pi-ai（供应商目录与官方登录流程）与 pi 的 AuthStorage
 * （auth.json 的唯一写路径），把终端 /login 的能力搬进 Obsidian：
 * 交互（密钥输入、OAuth 链接、设备码）由调用方以 AuthInteraction 提供（见 ui/auth-modals.ts）。
 * 密钥由学习者亲自输入、只经官方 AuthStorage 落盘，本模块不读取、不展示、不记录密钥内容。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { PiLaunch } from "./locate.ts";

/** pi-ai 登录交互的最小面（与 @earendil-works/pi-ai 的 AuthInteraction 对齐；手写以免依赖其类型） */
export interface AuthPrompt {
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
	signal?: AbortSignal;
}
export type AuthEvent =
	| { type: "info"; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };
export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

export interface ProviderModel {
	id: string;
	name?: string;
}
export interface ProviderStatus {
	id: string;
	name: string;
	/** auth.json 里已存凭据的类型；undefined 即未登录（环境变量凭据不在此显示） */
	cred?: "api_key" | "oauth";
	/** OAuth 登录可用（如 anthropic / xai / github-copilot）及其选项文案 */
	oauthLabel?: string;
	/** 交互式 API key 登录可用 */
	apiKeyLabel?: string;
	models: ProviderModel[];
}

/** 内部持有的 pi-ai / AuthStorage 引用（any 化：跨包动态加载，形状以运行时为准） */
interface Loaded {
	providers: any[];
	getBuiltinModels: (id: string) => any[];
	readStoredCredential: (id: string) => { type?: string } | undefined;
	createStore: () => { modify: (id: string, fn: (cur: unknown) => Promise<unknown>) => Promise<unknown>; delete: (id: string) => Promise<void> };
}

function nodeRequire(): NodeRequire {
	// Obsidian（CJS 打包）有全局 require；node --test（ESM 直跑 TS）用 createRequire
	if (typeof require === "function") return require;
	return createRequire(import.meta.url);
}

/** 从 cli.js 路径推导 pi-coding-agent 包根（…/@earendil-works/pi-coding-agent） */
function packageRootFromCli(cliPath: string): string {
	return resolve(dirname(cliPath), "..");
}

/** pi-ai 的候选位置：包内嵌套 node_modules，或提升到同一 node_modules */
function piAiCandidates(pkgRoot: string): string[] {
	return [join(pkgRoot, "node_modules", "@earendil-works", "pi-ai"), resolve(pkgRoot, "..", "pi-ai")];
}

export class PiAuth {
	// 显式字段而非构造器参数属性：node --test 的类型剥离不支持参数属性
	private loaded: Loaded;
	private constructor(loaded: Loaded) {
		this.loaded = loaded;
	}

	/**
	 * 从 pi 的启动定位加载；只支持 node + cli.js 的形态（可执行文件形态无从定位包内模块）。
	 * 找不到包或加载失败返回 undefined，调用方降级为「仅列已认证模型」。
	 */
	static load(launch: PiLaunch | undefined): PiAuth | undefined {
		const cliPath = launch?.args.find((a) => a.endsWith(".js") || a.endsWith(".mjs"));
		if (!cliPath || !existsSync(cliPath)) return undefined;
		const pkgRoot = packageRootFromCli(cliPath);
		const piAiRoot = piAiCandidates(pkgRoot).find((p) => existsSync(p));
		if (!piAiRoot) return undefined;
		try {
			const req = nodeRequire();
			const all = req(join(piAiRoot, "dist", "providers", "all.js"));
			const authStorage = req(join(pkgRoot, "dist", "core", "auth-storage.js"));
			return new PiAuth({
				providers: all.builtinProviders(),
				getBuiltinModels: (id: string) => {
					try {
						return all.getBuiltinModels(id) ?? [];
					} catch {
						return [];
					}
				},
				readStoredCredential: (id: string) => authStorage.readStoredCredential(id),
				createStore: () => authStorage.AuthStorage.create(),
			});
		} catch {
			return undefined;
		}
	}

	/** 全部内置供应商：名称、已存凭据类型、可用登录方式、模型目录。已登录的排前，其余按模型数降序。 */
	listProviders(): ProviderStatus[] {
		const out: ProviderStatus[] = [];
		for (const p of this.loaded.providers) {
			const id = String(p.id ?? "");
			if (!id) continue;
			const cred = this.loaded.readStoredCredential(id);
			const models = this.loaded.getBuiltinModels(id).map((m: any) => ({ id: String(m.id ?? ""), name: m.name ? String(m.name) : undefined }));
			out.push({
				id,
				name: String(p.name ?? id),
				cred: cred?.type === "oauth" || cred?.type === "api_key" ? cred.type : undefined,
				oauthLabel: p.auth?.oauth ? String(p.auth.oauth.loginLabel ?? p.auth.oauth.name ?? "OAuth 登录") : undefined,
				apiKeyLabel: p.auth?.apiKey?.login ? String(p.auth.apiKey.name ?? "API key") : undefined,
				models,
			});
		}
		return out.sort((a, b) => (b.cred ? 1 : 0) - (a.cred ? 1 : 0) || b.models.length - a.models.length || a.name.localeCompare(b.name));
	}

	/** 走供应商的官方登录流程并把凭据写进 auth.json；kind 必须是该供应商声明过的方式 */
	async login(id: string, kind: "api_key" | "oauth", interaction: AuthInteraction): Promise<void> {
		const p = this.loaded.providers.find((x) => x.id === id);
		const flow = kind === "oauth" ? p?.auth?.oauth : p?.auth?.apiKey;
		if (!flow?.login) throw new Error(`供应商 ${id} 不支持${kind === "oauth" ? " OAuth" : " API key"} 登录。`);
		const signal = interaction.signal ?? new AbortController().signal;
		const credential = await flow.login({ ...interaction, signal });
		if (!credential) throw new Error("登录流程未返回凭据。");
		await this.loaded.createStore().modify(id, async () => credential);
	}

	/** 删除 auth.json 里该供应商的凭据（登出） */
	async logout(id: string): Promise<void> {
		await this.loaded.createStore().delete(id);
	}
}
