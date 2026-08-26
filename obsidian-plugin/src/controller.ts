/**
 * controller.ts —— 单个角色实例的 pi 会话控制器：管理子进程生命周期（LEARN_ROLE 固定角色、
 * LEARN_HUB 常驻实例模式）、维护状态（模型、会话、角色状态栏）、跨插件重启续接本实例的会话，
 * 把 RPC 事件分发给视图，把扩展 UI 请求渲染成带角色标注的 Obsidian 模态框。
 * hub 花名册的每个角色各持有一个本类实例（见 instances.ts）。
 */
import { type App, Notice } from "obsidian";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PiAuth } from "./auth.ts";
import { locatePi } from "./locate.ts";
import { describeSession, listSessions } from "./sessions.ts";
import { pickProviderModel, type RpcModel } from "./ui/model-picker.ts";
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

export interface InstanceSpec {
	/** 扩展的角色名；作为子进程的 LEARN_ROLE */
	role: string;
	/** 页签与模态框的角色标注 */
	label: string;
	/** 本实例上次的会话文件（跨插件重启续接）；返回空则新开会话 */
	savedSession?: () => string | undefined;
	/** 会话文件变化时回写（由 instances.ts 持久化到插件数据） */
	onSessionFile?: (file: string) => void;
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
	/** 强制重载撞上进行中的刷新时排队补刷，而不是丢弃（否则新会话后页签可能不刷新） */
	private forceReloadQueued = false;

	constructor(
		private app: App,
		private settings: () => PiLearningSettings,
		readonly spec: InstanceSpec,
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
		const args = ["-a", ...(s.extraArgs ? splitArgs(s.extraArgs) : [])];
		const preferred = this.preferredModel();
		if (preferred) args.push("--model", preferred);
		const thinking = this.preferredThinking();
		if (thinking) args.push("--thinking", thinking);
		const client = new PiRpcClient({
			command: launch.command,
			commandArgs: launch.args,
			cwd,
			args,
			// 常驻实例：角色固定在子进程环境上，扩展在 session_start 里应用并启用 hub 护栏
			env: { LEARN_ROLE: this.spec.role, LEARN_HUB: "1" },
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
		// 续接本实例上次的会话（每实例各续各的；-c 会让全部实例抢同一个会话，不能用）
		const saved = this.settings().resumeLast ? this.spec.savedSession?.() : undefined;
		if (saved && existsSync(saved)) {
			try {
				await client.switchSession(saved);
				this.surface?.onSystem("已续接上次会话。");
			} catch (e) {
				// 静默吞掉会让「新会话」与「历史没加载」无从分辨
				this.surface?.onSystem(`上次会话续接失败（${(e as Error).message}），已新开会话。`, "warning");
			}
		}
		await this.refreshState(true);
		if (!this.state?.sessionName) {
			try {
				await client.setSessionName(`hub ${this.spec.label}`);
				await this.refreshState();
			} catch {
				/* 命名失败不影响使用 */
			}
		}
		// 会话建立时扩展可能按 .pi/learning.json 设过模型；学习者的角色级选择优先，最后校准一次
		await this.applyPreferredModel();
		await this.fallbackIfNoModel();
		await this.applyPreferredThinking();
	}

	/** 本角色的思考等级偏好：角色 > 全局默认；空串视为未配置 */
	private preferredThinking(): string {
		const s = this.settings();
		return (s.roleThinking?.[this.spec.role] ?? s.thinking ?? "").trim();
	}

	/** 当前思考等级与偏好不一致时切换过去；当前模型不支持该等级则保持现状 */
	async applyPreferredThinking(): Promise<void> {
		const pref = this.preferredThinking();
		const client = this.client;
		if (!pref || !client?.running || this.state?.thinkingLevel === pref) return;
		try {
			const levels = await client.getAvailableThinkingLevels();
			if (!levels.includes(pref)) return;
			await client.setThinkingLevel(pref);
			await this.refreshState();
		} catch {
			/* 等级不可用则保持现状 */
		}
	}

	/** 本角色的模型偏好：角色模型 > 全局默认；空串视为未配置 */
	private preferredModel(): string {
		const s = this.settings();
		return (s.roleModels?.[this.spec.role] ?? s.model ?? "").trim();
	}

	/** 当前模型与角色偏好不一致时切换过去；模型不可用（未登录该供应商等）则保持现状 */
	async applyPreferredModel(): Promise<void> {
		const pref = this.settings().roleModels?.[this.spec.role]?.trim();
		const client = this.client;
		if (!pref || !client?.running) return;
		const cur = this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : "";
		if (cur === pref) return;
		const idx = pref.indexOf("/");
		if (idx <= 0) return;
		try {
			await client.setModel(pref.slice(0, idx), pref.slice(idx + 1));
			await this.refreshState();
		} catch {
			this.surface?.onSystem(`角色模型 ${pref} 不可用，沿用 ${cur || "pi 默认"}。`, "warning");
		}
	}

	/** 配置的模型失效（供应商无凭据、模型下线）时自动回退到可用列表的第一个，避免实例瘫在「无可用模型」 */
	private async fallbackIfNoModel(): Promise<void> {
		const client = this.client;
		if (!client?.running || this.state?.model) return;
		try {
			const models = await client.getAvailableModels();
			const m = models[0];
			if (!m) return;
			await client.setModel(m.provider, m.id);
			await this.refreshState();
			this.surface?.onSystem(`配置的模型不可用，已回退到 ${m.provider}/${m.id}。可在顶栏或设置里改选。`, "warning");
		} catch {
			/* 连模型列表都取不到：保持无模型状态，顶栏会提示 */
		}
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

	/**
	 * 等本实例的当前回合结束（含对话框等待）。hub 的回合串行队列用它保证
	 * 同一时刻只有一个实例在生成，也是黑板并发写的第一道防线。
	 */
	async waitIdle(timeoutMs = 15 * 60_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const client = this.client;
			if (!client?.running) return;
			try {
				const st = await client.getState();
				this.state = st;
				if (!st.isStreaming && !(st.pendingMessageCount ?? 0)) return;
			} catch {
				return; // 实例中途退出：不阻塞队列
			}
			await new Promise((r) => setTimeout(r, 400));
		}
	}

	async newSession(): Promise<void> {
		const r = await this.requireClient().newSession();
		if (r.cancelled) new Notice("会话切换被取消。");
		await this.refreshState(true);
		await this.applyPreferredModel();
		await this.applyPreferredThinking();
	}

	async loadHistory(): Promise<AgentMessage[]> {
		return this.requireClient().getMessages();
	}

	/** 最近一条助手回复的纯文本（群转写摘要用）；实例未运行或取失败为空串 */
	async lastAssistantText(): Promise<string> {
		const c = this.client;
		if (!c?.running) return "";
		try {
			return await c.getLastAssistantText();
		} catch {
			return "";
		}
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
		await this.switchToSession(target.path);
	}

	/** 切到指定会话文件并重载校准（历史会话选择器与会话树共用） */
	async switchToSession(path: string): Promise<void> {
		const client = this.requireClient();
		if (this.state?.sessionFile && resolve(this.state.sessionFile) === resolve(path)) return;
		const r = await client.switchSession(path);
		if (r.cancelled) {
			new Notice("会话切换被取消。");
			return;
		}
		this.statuses.clear();
		await this.refreshState(true);
		await this.applyPreferredModel();
		await this.applyPreferredThinking();
	}

	/** 本实例是否正在流式生成（回滚等操作应避开进行中的回合） */
	get streamingNow(): boolean {
		return !!this.state?.isStreaming;
	}

	/** 当前会话文件（会话树标注实例落点用）；未运行或未知为 null */
	get currentSessionFile(): string | null {
		return this.state?.sessionFile ?? null;
	}

	/** 按原文定位当前会话线上的用户消息条目（重发 / 编辑的回滚点；取最后一个全等匹配） */
	async findForkEntry(text: string): Promise<string | undefined> {
		const client = this.client;
		if (!client?.running) return undefined;
		const list = await client.getForkMessages();
		for (let i = list.length - 1; i >= 0; i--) if (list[i].text === text) return list[i].entryId;
		return undefined;
	}

	/**
	 * 回滚到某条用户消息之前：pi 的 fork 把根到落点的路径抄成新会话线并切换，
	 * 旧线原样保留（会话树里可随时切回）。返回该消息原文；取消返回 undefined。
	 */
	async rewindBefore(entryId: string): Promise<string | undefined> {
		const client = this.requireClient();
		const r = await client.fork(entryId);
		if (r.cancelled) {
			new Notice("回滚被取消。");
			return undefined;
		}
		this.statuses.clear();
		await this.refreshState(true);
		await this.applyPreferredModel();
		await this.applyPreferredThinking();
		return r.text ?? "";
	}

	/**
	 * 两级模型选择：先供应商（含未登录的，选中即走官方登录流程），再模型。
	 * 只负责「选出一个值」（"provider/id"），不改实例模型、不写设置——写到哪由调用方定
	 * （顶栏 → 当前角色；设置页默认模型 → 全局；各角色模型行 → 对应角色）。
	 * 实例未运行会先拉起（可用模型列表来自 RPC）；登录成功则重启加载新凭据后接着选。
	 */
	async pickModelValue(): Promise<string | undefined> {
		if (!this.client?.running) {
			new Notice(`【${this.spec.label}】未运行，正在启动…`);
			await this.start();
		}
		const client = this.requireClient();
		const models = (await client.getAvailableModels()) as RpcModel[];
		const s = this.settings();
		const auth = PiAuth.load(locatePi(s.piPath, s.nodePath || "node", s.projectDir?.trim() || undefined));
		const r = await pickProviderModel(this.app, { available: models, auth });
		if (!r) return undefined;
		if (r.kind === "logged_in") {
			new Notice(`已登录 ${r.provider}，正在重启【${this.spec.label}】以加载新凭据…`);
			await this.start();
			return this.pickModelValue();
		}
		return `${r.provider}/${r.id}`;
	}

	/** 顶栏入口：选中即切换本实例的模型，并记到本角色的设置里 */
	async pickModel(): Promise<void> {
		const v = await this.pickModelValue();
		if (!v) return;
		const idx = v.indexOf("/");
		await this.requireClient().setModel(v.slice(0, idx), v.slice(idx + 1));
		this.onModelChosen?.(this.spec.role, v);
		await this.refreshState();
		new Notice(`已为【${this.spec.label}】切换到 ${v}`);
	}

	/** 弹出当前模型支持的思考等级；选中记到本角色的设置里，下次启动沿用 */
	async pickThinkingLevel(): Promise<void> {
		const client = this.requireClient();
		const levels = await client.getAvailableThinkingLevels();
		if (levels.length <= 1) {
			new Notice("当前模型不支持调节思考等级。");
			return;
		}
		const picked = await selectModal(this.app, `【${this.spec.label}】思考等级（当前：${this.state?.thinkingLevel ?? "?"}）`, levels);
		if (!picked) return;
		await client.setThinkingLevel(picked);
		this.onThinkingChosen?.(this.spec.role, picked);
		await this.refreshState();
		new Notice(`已为【${this.spec.label}】把思考等级设为 ${picked}`);
	}

	/** 由插件注入：把用户在面板里选的模型写回本角色的设置 */
	onModelChosen: ((role: string, model: string) => void) | null = null;
	/** 由插件注入：把用户在面板里选的思考等级写回本角色的设置 */
	onThinkingChosen: ((role: string, level: string) => void) | null = null;

	private requireClient(): PiRpcClient {
		if (!this.client?.running) throw new Error("pi 未运行；请先启动。");
		return this.client;
	}

	// ---------- 状态 ----------

	/** 拉取 get_state；sessionFile 变化时通知视图重载历史 */
	async refreshState(forceReload = false): Promise<void> {
		const client = this.client;
		if (!client?.running) return;
		if (this.refreshing) {
			// 并发的事件刷新可能读到的还是旧会话，对比不出变化；强制重载必须补做
			if (forceReload) this.forceReloadQueued = true;
			return;
		}
		this.refreshing = true;
		try {
			const prev = this.state;
			const next = await client.getState();
			this.state = next;
			// 会话文件回写：插件重启后本实例续接同一会话
			if (next.sessionFile && next.sessionFile !== prev?.sessionFile) this.spec.onSessionFile?.(next.sessionFile);
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
			if (this.forceReloadQueued) {
				this.forceReloadQueued = false;
				void this.refreshState(true);
			}
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
		// 多实例并存：对话框与通知一律标注来源角色，学习者才知道在回应谁
		const tag = `【${this.spec.label}】`;
		switch (req.method) {
			case "notify": {
				const text = req.message ?? "";
				new Notice(`${tag}${text}`, req.notifyType === "error" ? 10000 : 6000);
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
				const ok = await confirmModal(this.app, `${tag}${req.title ?? "确认"}`, req.message ?? "");
				return { confirmed: ok };
			}
			case "select": {
				const v = await selectModal(this.app, `${tag}${req.title ?? "请选择"}`, req.options ?? []);
				return v === undefined ? { cancelled: true } : { value: v };
			}
			case "input": {
				const v = await inputModal(this.app, `${tag}${req.title ?? "请输入"}`, req.placeholder ?? "");
				return v === undefined ? { cancelled: true } : { value: v };
			}
			case "editor": {
				const v = await editorModal(this.app, `${tag}${req.title ?? "编辑"}`, req.prefill ?? "");
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
