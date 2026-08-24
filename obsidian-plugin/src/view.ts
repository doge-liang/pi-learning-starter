/**
 * view.ts —— 侧边栏视图（hub 花名册）：顶栏（活跃实例的状态与控制）、角色页签、
 * 每实例一份对话记录、寻址输入框（@角色 唤醒与路由，无 @ 发给当前页签的实例）。
 * 所有与 pi 的通信经 InstanceManager / LearningController；视图只负责渲染与收集输入。
 */
import { ItemView, Notice, type WorkspaceLeaf, setIcon } from "obsidian";
import { COMMAND_GROUPS } from "./commands.ts";
import type { ControllerSurface, LearningController } from "./controller.ts";
import type { InstanceManager } from "./instances.ts";
import { ROSTER } from "./roster.ts";
import type { AgentMessage, RpcEvent } from "./rpc/types.ts";
import { Transcript, contentText } from "./transcript.ts";

export const VIEW_TYPE = "pi-learning-view";

interface Tab {
	role: string;
	label: string;
	btn: HTMLElement;
	container: HTMLElement;
	transcript: Transcript;
	surface: ControllerSurface;
}

export class LearningView extends ItemView {
	private statusEl!: HTMLElement;
	private widgetEl!: HTMLElement;
	private transcriptsEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private abortBtn!: HTMLButtonElement;
	private startBtn!: HTMLButtonElement;
	private tabs = new Map<string, Tab>();

	constructor(
		leaf: WorkspaceLeaf,
		private manager: InstanceManager,
		private autoStart: () => boolean,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Pi Learning";
	}
	getIcon(): string {
		return "graduation-cap";
	}

	private active(): LearningController {
		return this.manager.get(this.manager.activeRole);
	}
	private activeTab(): Tab {
		return this.tabs.get(this.manager.activeRole) as Tab;
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pi-learning-view");

		// 顶栏：活跃实例的状态 + 控制
		const header = root.createDiv({ cls: "pi-learning-header" });
		this.statusEl = header.createDiv({ cls: "pi-learning-status" });
		const ctl = header.createDiv({ cls: "pi-learning-controls" });
		this.startBtn = this.iconButton(ctl, "play", "启动 / 重启当前实例", () => void this.startActive(true));
		this.iconButton(ctl, "cpu", "切换当前实例的模型", () => void this.safely(() => this.active().pickModel()));
		this.iconButton(ctl, "brain", "思考等级", () => void this.safely(() => this.active().pickThinkingLevel()));
		this.iconButton(ctl, "history", "历史会话（当前实例）", () => void this.safely(() => this.active().pickSession()));
		this.iconButton(ctl, "file-plus", "新会话（当前实例）", () => void this.safely(() => this.active().newSession()));
		this.abortBtn = this.iconButton(ctl, "square", "中止当前实例的回合", () => void this.safely(() => this.active().abort()));
		this.iconButton(ctl, "refresh-cw", "重新加载当前实例的记录", () => void this.reloadActive());

		// 角色页签（花名册）
		const tabBar = root.createDiv({ cls: "pi-learning-tabs" });
		this.widgetEl = root.createDiv({ cls: "pi-learning-widgets" });

		// 命令条（仅 概览）
		const bar = root.createDiv({ cls: "pi-learning-commands" });
		for (const g of COMMAND_GROUPS) {
			const grp = bar.createDiv({ cls: "pi-learning-command-group" });
			grp.createSpan({ cls: "pi-learning-command-group-title", text: g.title });
			for (const c of g.commands) {
				const b = grp.createEl("button", { cls: "pi-learning-command-btn", text: c.label, attr: { title: `/${c.name} — ${c.hint}` } });
				b.addEventListener("click", () => this.manager.dispatch(this.manager.activeRole, `/${c.name}`));
			}
		}

		// 每实例一份对话记录（容器互斥显示）
		this.transcriptsEl = root.createDiv({ cls: "pi-learning-transcripts" });
		for (const spec of ROSTER) {
			const btn = tabBar.createEl("button", { cls: "pi-learning-tab", text: spec.label, attr: { title: `@${spec.label}` } });
			btn.addEventListener("click", () => this.activate(spec.role));
			const container = this.transcriptsEl.createDiv({ cls: "pi-learning-transcript" });
			const controller = this.manager.get(spec.role);
			const transcript = new Transcript(this.app, this, container, () => controller.statuses.get("learning")?.split(" · ")[0] ?? spec.label);
			const surface = this.makeSurface(spec.role, transcript);
			controller.attach(surface);
			this.tabs.set(spec.role, { role: spec.role, label: spec.label, btn, container, transcript, surface });
		}

		// 输入
		const inputWrap = root.createDiv({ cls: "pi-learning-input-wrap" });
		this.inputEl = inputWrap.createEl("textarea", {
			cls: "pi-learning-input-area",
			attr: { placeholder: "对当前页签的实例说话；@角色 唤醒并路由（如 @资料管理员）；Enter 发送，Shift+Enter 换行", rows: "3" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.sendInput();
			}
		});
		this.sendBtn = inputWrap.createEl("button", { cls: "mod-cta pi-learning-send", text: "发送" });
		this.sendBtn.addEventListener("click", () => void this.sendInput());

		this.manager.onQueueChanged = () => this.renderState();
		this.manager.onEcho = (role, message) => this.echo(role, message);
		this.manager.onError = (role, err) => {
			new Notice(`【${this.tabs.get(role)?.label ?? role}】${err.message}`, 8000);
			this.tabs.get(role)?.transcript.addSystem(err.message, "error");
		};

		this.activate(this.manager.activeRole);
		if (this.autoStart()) void this.safely(() => this.manager.ensureStarted("concierge"));
	}

	async onClose(): Promise<void> {
		for (const [role, tab] of this.tabs) this.manager.get(role).detach(tab.surface);
		this.manager.onQueueChanged = null;
		this.manager.onEcho = null;
		this.manager.onError = null;
	}

	// ---------- 动作 ----------

	private activate(role: string): void {
		this.manager.activeRole = role;
		for (const [r, tab] of this.tabs) tab.container.toggleClass("pi-learning-hidden", r !== role);
		this.renderState();
	}

	private async startActive(restart: boolean): Promise<void> {
		const c = this.active();
		if (c.running && !restart) return;
		this.activeTab().transcript.addSystem(c.running ? "正在重启实例…" : "正在启动实例…");
		try {
			await c.start();
			this.activeTab().transcript.addSystem(`实例已启动（${c.launchSource}）。`);
		} catch (e) {
			this.activeTab().transcript.addSystem(`启动失败：${(e as Error).message}`, "error");
		}
		this.renderState();
	}

	private async reloadActive(): Promise<void> {
		const c = this.active();
		if (!c.running) return;
		try {
			this.activeTab().transcript.loadHistory(await c.loadHistory());
		} catch (e) {
			this.activeTab().transcript.addSystem(`加载历史失败：${(e as Error).message}`, "error");
		}
	}

	private async sendInput(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		const { targets, unknown } = this.manager.route(text);
		if (unknown) new Notice(`未知角色：@${unknown}。可用：${ROSTER.map((r) => r.label).join("、")}`);
		if (targets.length) this.activate(targets[0]);
	}

	private echo(role: string, message: string): void {
		const tab = this.tabs.get(role);
		if (!tab) return;
		if (message.startsWith("/")) tab.transcript.addCommand(message);
		else tab.transcript.addUser(message);
	}

	private async safely(fn: () => Promise<unknown>): Promise<void> {
		try {
			await fn();
		} catch (e) {
			new Notice((e as Error).message, 6000);
		}
	}

	private iconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "clickable-icon pi-learning-icon-btn", attr: { "aria-label": title, title } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
		return b;
	}

	// ---------- 每实例的事件面 ----------

	private makeSurface(role: string, transcript: Transcript): ControllerSurface {
		const view = this;
		return {
			onEvent(e: RpcEvent): void {
				switch (e.type) {
					case "message_start":
						transcript.onMessageStart(e.message as AgentMessage);
						break;
					case "message_update":
						transcript.onDelta(e.assistantMessageEvent);
						break;
					case "message_end":
						transcript.onMessageEnd(e.message as AgentMessage);
						break;
					case "tool_execution_start":
						transcript.onToolStart(e.toolCallId, e.toolName, e.args);
						break;
					case "tool_execution_end": {
						const text = contentText((e.result?.content ?? []) as Array<{ type: string; text?: string }>);
						transcript.onToolEnd(e.toolCallId, text, !!e.isError);
						break;
					}
					case "entry_appended": {
						if (e.entry?.customType === "learning-note") {
							const text = (e.entry.data as { text?: string } | undefined)?.text ?? "";
							if (text) transcript.addNote(text);
						}
						break;
					}
					case "agent_settled":
						transcript.finishStreaming();
						break;
					case "extension_error":
						transcript.addSystem(`扩展错误（${e.event ?? "?"}）：${e.error}`, "error");
						break;
					case "auto_retry_start":
						transcript.addSystem(`请求失败，正在重试（${e.attempt ?? "?"}/${e.maxAttempts ?? "?"}）：${e.errorMessage ?? ""}`, "warning");
						break;
					default:
						break;
				}
			},
			onStateChanged(): void {
				view.renderState();
			},
			onSessionReplaced(messages: AgentMessage[]): void {
				transcript.loadHistory(messages);
				view.renderState();
			},
			onSystem(text: string, level: "info" | "warning" | "error" = "info"): void {
				transcript.addSystem(text, level);
			},
			setEditorText(text: string): void {
				if (view.manager.activeRole !== role) return;
				view.inputEl.value = text;
				view.inputEl.focus();
			},
		};
	}

	// ---------- 渲染 ----------

	private renderState(): void {
		// 页签：运行状态点 + 生成中标记
		for (const [role, tab] of this.tabs) {
			const c = this.manager.get(role);
			tab.btn.setText(`${c.running ? "●" : "○"} ${tab.label}${c.streaming ? " …" : ""}`);
			tab.btn.toggleClass("pi-learning-tab-active", role === this.manager.activeRole);
			tab.btn.toggleClass("pi-learning-tab-running", c.running);
		}

		// 顶栏：活跃实例
		const c = this.active();
		const st = c.state;
		const roleStatus = c.statuses.get("learning");
		this.statusEl.empty();
		this.statusEl.createSpan({ text: c.running ? (roleStatus ?? this.activeTab().label) : `${this.activeTab().label} 未启动` });
		if (st?.model) {
			this.statusEl.createSpan({ text: " · " });
			const m = this.statusEl.createSpan({
				cls: "pi-learning-model-link",
				text: `${st.model.provider}/${st.model.id}${st.thinkingLevel && st.thinkingLevel !== "off" ? ` (${st.thinkingLevel})` : ""}`,
				attr: { title: "点击切换模型" },
			});
			m.addEventListener("click", () => void this.safely(() => this.active().pickModel()));
		} else if (c.running) {
			this.statusEl.createSpan({ text: " · " });
			const m = this.statusEl.createSpan({ cls: "pi-learning-model-link pi-learning-model-missing", text: "无可用模型", attr: { title: "点击选择模型" } });
			m.addEventListener("click", () => void this.safely(() => this.active().pickModel()));
		}
		if (st?.sessionName) this.statusEl.createSpan({ text: ` · ${st.sessionName}` });
		if (st?.isStreaming) this.statusEl.createSpan({ text: " · 生成中" });
		if (this.manager.pendingCount > 1) this.statusEl.createSpan({ text: ` · 队列 ${this.manager.pendingCount - 1}` });
		this.statusEl.toggleClass("pi-learning-status-off", !c.running);
		this.abortBtn.toggleClass("pi-learning-hidden", !st?.isStreaming);
		setIcon(this.startBtn, c.running ? "rotate-ccw" : "play");

		this.widgetEl.empty();
		for (const [, lines] of c.widgets) this.widgetEl.createEl("pre", { text: lines.join("\n") });
		this.widgetEl.toggleClass("pi-learning-hidden", c.widgets.size === 0);
	}
}
