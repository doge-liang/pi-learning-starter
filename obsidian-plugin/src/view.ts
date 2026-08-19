/**
 * view.ts —— 侧边栏视图：状态栏、命令条、对话记录、输入框。
 * 所有与 pi 的通信经 LearningController；视图只负责渲染与收集输入。
 */
import { ItemView, Notice, type WorkspaceLeaf, setIcon } from "obsidian";
import { COMMAND_GROUPS, type LearningCommand } from "./commands.ts";
import type { ControllerSurface, LearningController } from "./controller.ts";
import type { AgentMessage, RpcEvent } from "./rpc/types.ts";
import { Transcript, contentText } from "./transcript.ts";
import { inputModal } from "./ui/modals.ts";

export const VIEW_TYPE = "pi-learning-view";

export class LearningView extends ItemView implements ControllerSurface {
	private statusEl!: HTMLElement;
	private widgetEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private abortBtn!: HTMLButtonElement;
	private startBtn!: HTMLButtonElement;
	private transcript!: Transcript;

	constructor(
		leaf: WorkspaceLeaf,
		private controller: LearningController,
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

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pi-learning-view");

		// 顶栏：状态 + 进程控制
		const header = root.createDiv({ cls: "pi-learning-header" });
		this.statusEl = header.createDiv({ cls: "pi-learning-status" });
		const ctl = header.createDiv({ cls: "pi-learning-controls" });
		this.startBtn = this.iconButton(ctl, "play", "启动 / 重启 pi", () => void this.start(true));
		this.iconButton(ctl, "cpu", "切换模型", () => void this.safely(() => this.controller.pickModel()));
		this.iconButton(ctl, "brain", "思考等级", () => void this.safely(() => this.controller.pickThinkingLevel()));
		this.iconButton(ctl, "history", "历史会话", () => void this.safely(() => this.controller.pickSession()));
		this.iconButton(ctl, "file-plus", "新会话", () => void this.safely(() => this.controller.newSession()));
		this.abortBtn = this.iconButton(ctl, "square", "中止当前回合", () => void this.safely(() => this.controller.abort()));
		this.iconButton(ctl, "refresh-cw", "重新加载历史", () => void this.reload());

		this.widgetEl = root.createDiv({ cls: "pi-learning-widgets" });

		// 命令条
		const bar = root.createDiv({ cls: "pi-learning-commands" });
		for (const g of COMMAND_GROUPS) {
			const grp = bar.createDiv({ cls: "pi-learning-command-group" });
			grp.createSpan({ cls: "pi-learning-command-group-title", text: g.title });
			for (const c of g.commands) {
				const b = grp.createEl("button", { cls: "pi-learning-command-btn", text: c.label, attr: { title: `/${c.name} — ${c.hint}` } });
				b.addEventListener("click", () => void this.runCommand(c));
			}
		}

		// 对话记录
		this.transcriptEl = root.createDiv({ cls: "pi-learning-transcript" });
		this.transcript = new Transcript(this.app, this, this.transcriptEl);

		// 输入
		const inputWrap = root.createDiv({ cls: "pi-learning-input-wrap" });
		this.inputEl = inputWrap.createEl("textarea", { cls: "pi-learning-input-area", attr: { placeholder: "对角色说话，或输入 /learn 等命令；Enter 发送，Shift+Enter 换行", rows: "3" } });
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.sendInput();
			}
		});
		this.sendBtn = inputWrap.createEl("button", { cls: "mod-cta pi-learning-send", text: "发送" });
		this.sendBtn.addEventListener("click", () => void this.sendInput());

		this.controller.attach(this);
		this.onStateChanged();
		if (this.controller.running) await this.reload();
		else if (this.autoStart()) await this.start(false);
	}

	async onClose(): Promise<void> {
		this.controller.detach(this);
	}

	// ---------- 动作 ----------

	private async start(restart: boolean): Promise<void> {
		if (this.controller.running && !restart) return;
		this.transcript.addSystem(restart && this.controller.running ? "正在重启 pi…" : "正在启动 pi…");
		try {
			await this.controller.start();
			this.transcript.addSystem(`pi 已启动（${this.controller.launchSource}）。`);
		} catch (e) {
			this.transcript.addSystem(`启动失败：${(e as Error).message}`, "error");
		}
		this.onStateChanged();
	}

	private async reload(): Promise<void> {
		if (!this.controller.running) return;
		try {
			const messages = await this.controller.loadHistory();
			this.transcript.loadHistory(messages);
		} catch (e) {
			this.transcript.addSystem(`加载历史失败：${(e as Error).message}`, "error");
		}
	}

	private async sendInput(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		await this.sendText(text);
	}

	private async sendText(text: string): Promise<void> {
		if (!this.controller.running) {
			new Notice("pi 未运行；先点击启动。");
			return;
		}
		if (text.startsWith("/")) this.transcript.addCommand(text);
		else this.transcript.addUser(text);
		await this.safely(() => this.controller.send(text));
	}

	private async runCommand(c: LearningCommand): Promise<void> {
		let arg = "";
		if (c.arg) {
			const v = await inputModal(this.app, `/${c.name}：${c.arg.prompt}`, c.arg.placeholder ?? "");
			if (v === undefined) return;
			if (!v.trim() && !c.arg.optional) return;
			arg = v.trim();
		}
		await this.sendText(arg ? `/${c.name} ${arg}` : `/${c.name}`);
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

	// ---------- ControllerSurface ----------

	onEvent(e: RpcEvent): void {
		switch (e.type) {
			case "message_start":
				this.transcript.onMessageStart(e.message as AgentMessage);
				break;
			case "message_update":
				this.transcript.onDelta(e.assistantMessageEvent);
				break;
			case "message_end":
				this.transcript.onMessageEnd(e.message as AgentMessage);
				break;
			case "tool_execution_start":
				this.transcript.onToolStart(e.toolCallId, e.toolName, e.args);
				break;
			case "tool_execution_end": {
				const text = contentText((e.result?.content ?? []) as Array<{ type: string; text?: string }>);
				this.transcript.onToolEnd(e.toolCallId, text, !!e.isError);
				break;
			}
			case "entry_appended": {
				if (e.entry?.customType === "learning-note") {
					const text = (e.entry.data as { text?: string } | undefined)?.text ?? "";
					if (text) this.transcript.addNote(text);
				}
				break;
			}
			case "agent_settled":
				this.transcript.finishStreaming();
				break;
			case "extension_error":
				this.transcript.addSystem(`扩展错误（${e.event ?? "?"}）：${e.error}`, "error");
				break;
			case "auto_retry_start":
				this.transcript.addSystem(`请求失败，正在重试（${e.attempt ?? "?"}/${e.maxAttempts ?? "?"}）：${e.errorMessage ?? ""}`, "warning");
				break;
			default:
				break;
		}
	}

	onStateChanged(): void {
		const c = this.controller;
		const st = c.state;
		const role = c.statuses.get("learning");
		this.statusEl.empty();
		this.statusEl.createSpan({ text: c.running ? (role ?? "无角色") : "pi 未运行" });
		if (st?.model) {
			this.statusEl.createSpan({ text: " · " });
			const m = this.statusEl.createSpan({ cls: "pi-learning-model-link", text: `${st.model.provider}/${st.model.id}${st.thinkingLevel && st.thinkingLevel !== "off" ? ` (${st.thinkingLevel})` : ""}`, attr: { title: "点击切换模型" } });
			m.addEventListener("click", () => void this.safely(() => this.controller.pickModel()));
		} else if (c.running) {
			this.statusEl.createSpan({ text: " · " });
			const m = this.statusEl.createSpan({ cls: "pi-learning-model-link pi-learning-model-missing", text: "无可用模型", attr: { title: "点击选择模型" } });
			m.addEventListener("click", () => void this.safely(() => this.controller.pickModel()));
		}
		if (st?.sessionName) this.statusEl.createSpan({ text: ` · ${st.sessionName}` });
		if (st?.isStreaming) this.statusEl.createSpan({ text: " · 生成中" });
		this.statusEl.toggleClass("pi-learning-status-off", !c.running);
		this.abortBtn.toggleClass("pi-learning-hidden", !st?.isStreaming);
		setIcon(this.startBtn, c.running ? "rotate-ccw" : "play");

		this.widgetEl.empty();
		for (const [, lines] of c.widgets) this.widgetEl.createEl("pre", { text: lines.join("\n") });
		this.widgetEl.toggleClass("pi-learning-hidden", c.widgets.size === 0);
	}

	onSessionReplaced(messages: AgentMessage[]): void {
		this.transcript.loadHistory(messages);
		this.onStateChanged();
	}

	onSystem(text: string, level: "info" | "warning" | "error" = "info"): void {
		this.transcript.addSystem(text, level);
	}

	setEditorText(text: string): void {
		this.inputEl.value = text;
		this.inputEl.focus();
	}
}
