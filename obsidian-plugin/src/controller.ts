/**
 * controller.ts —— 插件内唯一的 pi 会话控制器：管理子进程生命周期、维护状态（模型、会话、角色状态栏），
 * 把 RPC 事件分发给当前打开的视图，把扩展 UI 请求渲染成 Obsidian 模态框。
 */
import { type App, Notice } from "obsidian";
import { resolve } from "node:path";
import { locatePi } from "./locate.ts";
import { describeSession, listSessions } from "./sessions.ts";
import { PiRpcClient } from "./rpc/client.ts";
import type { AgentMessage, RpcEvent, RpcState, UiRequest, UiResponse } from "./rpc/types.ts";
import type { PiLearningSettings } from "./settings.ts";
import { confirmModal, editorModal, inputModal, selectModal } from "./ui/modals.ts";

export interface ControllerSurface {
	onEvent(event: RpcEvent): void;
	onStateChanged(): void;
	/** 会话被替换（扩展的 ctx.newSession 或 /new）：视图应清空并重新加载历史 */
	onSessionReplaced(messages: AgentMessage[]): void;
	onSystem(text: string, level?: "info" | "warning" | "error"): void;
	setEditorText(text: string): void;
}

export class LearningController {
	client: PiRpcClient | null = null;
	state: RpcState | null = null;
	/** 扩展 setStatus 的键值（学习扩展用键 "learning" 显示角色、单元、模式） */
	statuses = new Map<string, string>();
	widgets = new Map<string, string[]>();
	launchSource = "";
	lastError = "";
	private surface: ControllerSurface | null = null;
	private starting: Promise<void> | null = null;
	private refreshing = false;

	constructor(
		private app: App,
		private settings: () => PiLearningSettings,
	) {}

	attach(surface: ControllerSurface): void {
		this.surface = surface;
	}
	detach(surface: ControllerSurface): void {
		if (this.surface === surface) this.surface = null;
	}

	get running(): boolean {
		return !!this.client?.running;
	}
	get streaming(): boolean {
		return !!this.state?.isStreaming;
	}

	// ---------- 生命周期 ----------

	async start(): Promise<void> {
		if (this.starting) return this.starting;
		this.starting = this.doStart().finally(() => (this.starting = null));
		return this.starting;
	}

	private async doStart(): Promise<void> {
		await this.stop();
		const s = this.settings();
		const cwd = s.projectDir?.trim();
		if (!cwd) throw new Error("尚未设置学习项目目录（插件设置 → 学习项目目录）。");
		const launch = locatePi(s.piPath, s.nodePath || "node", cwd);
		if (!launch) throw new Error("找不到 pi：请全局安装 @earendil-works/pi-coding-agent，或在设置里填写 pi 的 dist/cli.js 路径。");
		this.launchSource = launch.source;
		const args = ["-a", ...(s.resumeLast ? ["-c"] : []), ...(s.extraArgs ? splitArgs(s.extraArgs) : [])];
		if (s.model?.trim()) args.push("--model", s.model.trim());
		const client = new PiRpcClient({
			command: launch.command,
			commandArgs: launch.args,
			cwd,
			args,
			onEvent: (e) => this.handleEvent(e),
			onUiRequest: (r) => this.handleUiRequest(r),
			onExit: (info) => {
				if (this.client !== client) return;
				this.lastError = info.stderr.slice(-800);
				this.surface?.onSystem(`pi 进程已退出（code=${info.code ?? "?"}）。${info.stderr.trim().split("\n").slice(-2).join(" ")}`, "error");
				this.state = null;
				this.surface?.onStateChanged();
			},
		});
		this.client = client;
		await client.start();
		await this.refreshState(true);
	}

	async stop(): Promise<void> {
		const c = this.client;
		this.client = null;
		this.state = null;
		this.statuses.clear();
		this.widgets.clear();
		if (c) await c.stop();
		this.surface?.onStateChanged();
	}

	// ---------- 动作 ----------

	/** 发送用户消息或斜杠命令；会先在视图里回显 */
	async send(text: string): Promise<void> {
		const client = this.requireClient();
		const msg = text.trim();
		if (!msg) return;
		const behavior = this.state?.isStreaming ? "steer" : undefined;
		try {
			await client.prompt(msg, behavior);
		} catch (e) {
			this.surface?.onSystem(`发送失败：${(e as Error).message}`, "error");
			throw e;
		}
		// 扩展命令会立即处理并可能切换会话；刷新一次状态
		await this.refreshState();
	}

	async abort(): Promise<void> {
		await this.requireClient().abort();
		await this.refreshState();
	}

	async newSession(): Promise<void> {
		const r = await this.requireClient().newSession();
		if (r.cancelled) new Notice("会话切换被取消。");
		await this.refreshState(true);
	}

	async loadHistory(): Promise<AgentMessage[]> {
		return this.requireClient().getMessages();
	}

	/** 弹出本项目的历史会话列表，选中即切换并重载记录 */
	async pickSession(): Promise<void> {
		const client = this.requireClient();
		const cwd = this.settings().projectDir;
		const sessions = listSessions(cwd);
		if (!sessions.length) {
			new Notice("本项目还没有历史会话。");
			return;
		}
		const current = this.state?.sessionFile ? resolve(this.state.sessionFile) : "";
		const labels = sessions.map((x) => `${resolve(x.path) === current ? "● " : ""}${describeSession(x)}`);
		const picked = await selectModal(this.app, "切换到历史会话", labels);
		if (!picked) return;
		const target = sessions[labels.indexOf(picked)];
		if (!target) return;
		if (resolve(target.path) === current) return;
		const r = await client.switchSession(target.path);
		if (r.cancelled) {
			new Notice("会话切换被取消。");
			return;
		}
		this.statuses.clear();
		await this.refreshState(true);
	}

	/** 弹出可用模型列表，选中即切换；记到设置里，下次启动沿用 */
	async pickModel(): Promise<void> {
		const client = this.requireClient();
		const models = await client.getAvailableModels();
		if (!models.length) {
			new Notice("pi 没有可用模型：请在终端运行 pi 并 /login，或配置 API key 环境变量。", 8000);
			return;
		}
		const current = this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : "";
		const labels = models.map((m) => `${m.provider}/${m.id}${m.name && m.name !== m.id ? `  ${m.name}` : ""}`);
		const picked = await selectModal(this.app, `选择模型（当前：${current || "无"}）`, labels);
		if (!picked) return;
		const m = models[labels.indexOf(picked)];
		if (!m) return;
		await client.setModel(m.provider, m.id);
		this.onModelChosen?.(`${m.provider}/${m.id}`);
		await this.refreshState();
		new Notice(`已切换到 ${m.provider}/${m.id}`);
	}

	/** 弹出当前模型支持的思考等级 */
	async pickThinkingLevel(): Promise<void> {
		const client = this.requireClient();
		const levels = await client.getAvailableThinkingLevels();
		if (levels.length <= 1) {
			new Notice("当前模型不支持调节思考等级。");
			return;
		}
		const picked = await selectModal(this.app, `思考等级（当前：${this.state?.thinkingLevel ?? "?"}）`, levels);
		if (!picked) return;
		await client.setThinkingLevel(picked);
		await this.refreshState();
	}

	/** 由插件注入：把用户在面板里选的模型写回设置 */
	onModelChosen: ((model: string) => void) | null = null;

	private requireClient(): PiRpcClient {
		if (!this.client?.running) throw new Error("pi 未运行；请先启动。");
		return this.client;
	}

	// ---------- 状态 ----------

	/** 拉取 get_state；sessionFile 变化时通知视图重载历史 */
	async refreshState(forceReload = false): Promise<void> {
		const client = this.client;
		if (!client?.running || this.refreshing) return;
		this.refreshing = true;
		try {
			const prev = this.state;
			const next = await client.getState();
			this.state = next;
			const replaced = forceReload || (prev?.sessionFile ?? null) !== (next.sessionFile ?? null) || (prev?.sessionId ?? null) !== (next.sessionId ?? null);
			if (replaced) {
				// 新会话的状态栏由新扩展实例重新 setStatus；先清掉旧的
				if (!forceReload) this.statuses.clear();
				const messages = await client.getMessages();
				this.surface?.onSessionReplaced(messages);
			}
			this.surface?.onStateChanged();
		} catch (e) {
			this.lastError = (e as Error).message;
		} finally {
			this.refreshing = false;
		}
	}

	private handleEvent(e: RpcEvent): void {
		// 扩展触发的会话切换（/go 的进入角色路由）不会有专门事件：在每轮开始时核对一次 sessionFile
		if (e.type === "agent_start" || e.type === "agent_settled") void this.refreshState();
		if (e.type === "agent_start" && this.state) this.state.isStreaming = true;
		if (e.type === "agent_settled" && this.state) this.state.isStreaming = false;
		this.surface?.onEvent(e);
		if (e.type === "agent_start" || e.type === "agent_settled") this.surface?.onStateChanged();
	}

	// ---------- 扩展 UI 子协议 ----------

	private async handleUiRequest(req: UiRequest): Promise<UiResponse | undefined> {
		switch (req.method) {
			case "notify": {
				const text = req.message ?? "";
				new Notice(text, req.notifyType === "error" ? 10000 : 6000);
				this.surface?.onSystem(text, req.notifyType ?? "info");
				return undefined;
			}
			case "setStatus": {
				if (req.statusKey) {
					if (req.statusText === undefined || req.statusText === null) this.statuses.delete(req.statusKey);
					else this.statuses.set(req.statusKey, req.statusText);
				}
				this.surface?.onStateChanged();
				return undefined;
			}
			case "setWidget": {
				if (req.widgetKey) {
					if (!req.widgetLines) this.widgets.delete(req.widgetKey);
					else this.widgets.set(req.widgetKey, req.widgetLines);
				}
				this.surface?.onStateChanged();
				return undefined;
			}
			case "setTitle":
				return undefined;
			case "set_editor_text":
				this.surface?.setEditorText(req.text ?? "");
				return undefined;
			case "confirm": {
				const ok = await confirmModal(this.app, req.title ?? "确认", req.message ?? "");
				return { confirmed: ok };
			}
			case "select": {
				const v = await selectModal(this.app, req.title ?? "请选择", req.options ?? []);
				return v === undefined ? { cancelled: true } : { value: v };
			}
			case "input": {
				const v = await inputModal(this.app, req.title ?? "请输入", req.placeholder ?? "");
				return v === undefined ? { cancelled: true } : { value: v };
			}
			case "editor": {
				const v = await editorModal(this.app, req.title ?? "编辑", req.prefill ?? "");
				return v === undefined ? { cancelled: true } : { value: v };
			}
			default:
				return undefined;
		}
	}
}

/** 把设置里的额外参数按空白切分，支持双引号包裹 */
export function splitArgs(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
	return out;
}
