/**
 * fake-pi.ts —— 测试用的伪造 ExtensionAPI 与上下文。
 *
 * 只实现扩展实际用到的那部分表面：工具与命令注册、事件订阅、会话条目、工具白名单、
 * 模型与会话名、发送用户消息，以及 ctx.ui 的对话框（用预置答案代替真人输入）。
 * newSession 模拟 pi 的真实行为：重建扩展实例、先发 session_start(reason="new")，再调用 withSession。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AnyFn = (...args: any[]) => any;

export interface RegisteredTool {
	name: string;
	execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: AnyFn, ctx?: any) => Promise<any>;
	[k: string]: unknown;
}
export interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: any) => Promise<any> | any;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
}

/** 预置的对话框答案队列：editor / select / confirm 依次弹出时按顺序消费 */
export interface UiScript {
	editor?: Array<string | undefined>;
	select?: Array<string | undefined>;
	confirm?: boolean[];
}

export class FakePi {
	tools = new Map<string, RegisteredTool>();
	commands = new Map<string, RegisteredCommand>();
	handlers = new Map<string, AnyFn[]>();
	entries: Array<{ type: "custom"; customType: string; data: unknown; id: string }> = [];
	activeTools: string[] | null = null;
	model: unknown = null;
	sessionName: string | undefined;
	sentMessages: string[] = [];
	renderers = new Map<string, AnyFn>();
	/** 内置工具名，供 getAllTools 与默认白名单使用 */
	builtin = ["read", "write", "edit", "bash", "grep", "find", "ls"];

	api(): ExtensionAPI {
		const self = this;
		const api = {
			registerTool(def: RegisteredTool) {
				self.tools.set(def.name, def);
			},
			registerCommand(name: string, def: Omit<RegisteredCommand, "name">) {
				self.commands.set(name, { name, ...def });
			},
			on(event: string, handler: AnyFn) {
				self.handlers.set(event, [...(self.handlers.get(event) ?? []), handler]);
			},
			appendEntry(customType: string, data: unknown) {
				self.entries.push({ type: "custom", customType, data, id: `e${self.entries.length + 1}` });
			},
			registerEntryRenderer(customType: string, render: AnyFn) {
				self.renderers.set(customType, render);
			},
			setActiveTools(names: string[]) {
				self.activeTools = [...names];
			},
			getActiveTools() {
				return self.activeTools ?? [...self.builtin, ...self.tools.keys()];
			},
			getAllTools() {
				return [...self.builtin, ...self.tools.keys()].map((name) => ({ name }));
			},
			async setModel(model: unknown) {
				self.model = model;
				return true;
			},
			setSessionName(name: string) {
				self.sessionName = name;
			},
			sendUserMessage(text: string) {
				self.sentMessages.push(text);
			},
			sendMessage() {},
			getCommands() {
				return [...self.commands.keys()].map((name) => ({ name, source: "extension" }));
			},
		};
		return api as unknown as ExtensionAPI;
	}

	async emit(event: string, payload: Record<string, unknown>, ctx: unknown): Promise<any> {
		let last: any;
		for (const h of this.handlers.get(event) ?? []) {
			const r = await h({ type: event, ...payload }, ctx);
			if (r !== undefined) last = r;
		}
		return last;
	}

	tool(name: string): RegisteredTool {
		const t = this.tools.get(name);
		if (!t) throw new Error(`工具未注册：${name}`);
		return t;
	}
	command(name: string): RegisteredCommand {
		const c = this.commands.get(name);
		if (!c) throw new Error(`命令未注册：${name}`);
		return c;
	}
	lastMessage(): string {
		return this.sentMessages[this.sentMessages.length - 1] ?? "";
	}
}

export interface HarnessOptions {
	cwd: string;
	hasUI?: boolean;
	ui?: UiScript;
	/** 当前会话分支里是否已有消息（决定 enter 是原地进入还是切换会话） */
	hasMessages?: boolean;
	/** ctx.newSession 的实现；缺省为记录一次调用并返回 { cancelled: false } */
	newSession?: (opts: any) => Promise<{ cancelled: boolean }>;
	models?: Record<string, unknown>;
}

/** 构造扩展上下文；工具与命令共用同一个对象（ExtensionCommandContext 是其超集） */
export function makeCtx(pi: FakePi, opts: HarnessOptions): ExtensionCommandContext & { notices: Array<[string, string]>; statuses: Map<string, string | undefined> } {
	const ui = opts.ui ?? {};
	const notices: Array<[string, string]> = [];
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		cwd: opts.cwd,
		hasUI: opts.hasUI ?? true,
		notices,
		statuses,
		ui: {
			notify: (msg: string, level = "info") => notices.push([level, msg]),
			confirm: async () => (ui.confirm ?? []).shift() ?? false,
			editor: async () => (ui.editor ?? []).shift(),
			select: async () => (ui.select ?? []).shift(),
			input: async () => undefined,
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWorkingMessage: () => {},
			setWidget: () => {},
			custom: async () => undefined,
			setTitle: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			pasteToEditor: () => {},
			theme: {},
			onTerminalInput: () => () => {},
		},
		sessionManager: {
			getEntries: () => pi.entries,
			getBranch: () => (opts.hasMessages ? [{ type: "message", id: "m1" }, ...pi.entries] : pi.entries),
			getLeafId: () => null,
			getSessionFile: () => join(opts.cwd, ".fake-session.jsonl"),
			getCwd: () => opts.cwd,
		},
		modelRegistry: {
			find: (provider: string, id: string) => opts.models?.[`${provider}/${id}`] ?? null,
			getAll: () => [],
			getAvailable: () => [],
		},
		model: undefined,
		newSession: opts.newSession ?? (async () => ({ cancelled: false })),
		fork: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		isIdle: () => true,
		abort: async () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		waitForIdle: async () => {},
		compact: async () => {},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		signal: new AbortController().signal,
	};
	return ctx as unknown as ExtensionCommandContext & { notices: Array<[string, string]>; statuses: Map<string, string | undefined> };
}

/** 把仓库里的 blackboard/ 与 .pi/learning.json 复制到临时目录，作为一次测试的项目根 */
export function makeProject(repoRoot: string): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-learning-test-"));
	cpSync(join(repoRoot, "blackboard"), join(cwd, "blackboard"), { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	cpSync(join(repoRoot, ".pi", "learning.json"), join(cwd, ".pi", "learning.json"));
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}
