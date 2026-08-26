/**
 * view.ts —— 侧边栏视图（hub 花名册）：顶栏（活跃实例的状态与控制）、「群」聚合页签 + 角色页签、
 * 每实例一份对话记录、寻址输入框（@角色 唤醒与路由，无 @ 发给当前角色页签的实例）。
 *
 * 群页签是聚合时间线：学习者与 hub 的寻址条目按落盘顺序渲染，各实例的回复经事件流实时镜像
 * （回合串行执行，同一时刻至多一个实例在流式，镜像无交错）。落盘与注入见 group.ts 两侧。
 * 所有与 pi 的通信经 InstanceManager / LearningController；视图只负责渲染与收集输入。
 */
import { ItemView, Menu, Notice, type WorkspaceLeaf, setIcon } from "obsidian";
import { COMMAND_GROUPS } from "./commands.ts";
import type { ControllerSurface, LearningController } from "./controller.ts";
import { readGroupTail } from "./group.ts";
import type { InstanceManager } from "./instances.ts";
import { ROSTER, type RoleSpec, roleSpec } from "./roster.ts";
import type { AgentMessage, RpcEvent } from "./rpc/types.ts";
import { Transcript, contentText } from "./transcript.ts";

export const VIEW_TYPE = "pi-learning-view";
const GROUP_TAB = "group";

/** label → 徽章外观（群时间线的角色名是 label；查不到的自定义状态名不画徽章） */
function badgeByLabel(label: string): { hue: number; glyph: string } | undefined {
	const spec = ROSTER.find((r) => r.label === label);
	return spec ? { hue: spec.hue, glyph: spec.glyph } : undefined;
}

interface Tab {
	id: string;
	label: string;
	btn: HTMLElement;
	/** 按钮内的状态点（运行 / 生成三态由 class 切换） */
	dotEl: HTMLElement;
	/** 页签面板：空状态 + 滚动转写，互斥显示由面板层切换 */
	pane: HTMLElement;
	emptyEl: HTMLElement;
	container: HTMLElement;
	transcript: Transcript;
	surface?: ControllerSurface;
	/** 非活跃页签收到助手回复后置位；切到该页签时清除 */
	unread?: boolean;
}

export class LearningView extends ItemView {
	private statusEl!: HTMLElement;
	private widgetEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private abortBtn!: HTMLButtonElement;
	private startBtn!: HTMLButtonElement;
	private targetChip!: HTMLElement;
	private tabs = new Map<string, Tab>();
	/** 当前显示的页签（可能是群）；manager.activeRole 始终是最近的真实角色 */
	private activeTabId: string = "concierge";
	/** 群时间线上当前块的角色标签（消息开始时快照）与正在镜像的实例 */
	private groupRole: string | undefined;
	private groupStreamingRole: string | null = null;
	/** @ 补全浮层：候选、高亮位与被补全的记号区间（[from, to) 含 @） */
	private mentionEl!: HTMLElement;
	private mentionItems: RoleSpec[] = [];
	private mentionIndex = 0;
	private mentionRange: [number, number] | null = null;

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
	private groupTranscript(): Transcript {
		return (this.tabs.get(GROUP_TAB) as Tab).transcript;
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
		this.iconButton(ctl, "refresh-cw", "重新加载当前页签的记录", () => void this.reloadActive());

		// 页签：群 + 花名册
		const tabBar = root.createDiv({ cls: "pi-learning-tabs" });
		this.widgetEl = root.createDiv({ cls: "pi-learning-widgets" });

		// 命令条（仅 概览）
		const bar = root.createDiv({ cls: "pi-learning-commands" });
		for (const g of COMMAND_GROUPS) {
			const grp = bar.createDiv({ cls: "pi-learning-command-group" });
			grp.createSpan({ cls: "pi-learning-command-group-title", text: g.title });
			for (const c of g.commands) {
				const b = grp.createEl("button", { cls: "pi-learning-command-btn", attr: { title: `/${c.name} — ${c.hint}` } });
				const ic = b.createSpan({ cls: "pi-learning-command-icon" });
				setIcon(ic, "compass");
				b.createSpan({ text: c.label });
				b.addEventListener("click", () => this.manager.dispatch(this.manager.activeRole, `/${c.name}`));
			}
		}

		// 页签面板（互斥显示）：先群，后各实例；每个面板 = 空状态 + 滚动转写
		const transcripts = root.createDiv({ cls: "pi-learning-transcripts" });
		const makeTab = (id: string, label: string, title: string, spec?: RoleSpec): Tab => {
			const btn = tabBar.createEl("button", { cls: "pi-learning-tab", attr: { title } });
			if (spec) btn.style.setProperty("--pi-role-h", String(spec.hue));
			const glyph = btn.createSpan({ cls: "pi-learning-glyph pi-learning-tab-glyph", text: spec?.glyph ?? "群" });
			if (!spec) glyph.addClass("pi-learning-glyph-group");
			btn.createSpan({ cls: "pi-learning-tab-name", text: label });
			const dotEl = btn.createSpan({ cls: "pi-learning-tab-dot" });
			btn.addEventListener("click", () => this.activate(id));
			const pane = transcripts.createDiv({ cls: "pi-learning-pane" });
			const emptyEl = pane.createDiv({ cls: "pi-learning-empty" });
			const container = pane.createDiv({ cls: "pi-learning-transcript" });
			const tab: Tab = { id, label, btn, dotEl, pane, emptyEl, container, transcript: undefined as unknown as Transcript };
			this.tabs.set(id, tab);
			return tab;
		};

		const groupTab = makeTab(GROUP_TAB, "群", "聚合时间线：学习者的寻址与各实例的回复");
		groupTab.transcript = new Transcript(this.app, this, groupTab.container, () => this.groupRole, badgeByLabel);
		this.buildGroupEmptyState(groupTab.emptyEl);

		for (const spec of ROSTER) {
			const tab = makeTab(spec.role, spec.label, `@${spec.label} — ${spec.brief}`, spec);
			const controller = this.manager.get(spec.role);
			tab.transcript = new Transcript(
				this.app,
				this,
				tab.container,
				() => controller.statuses.get("learning")?.split(" · ")[0] ?? spec.label,
				badgeByLabel,
				// 失败回合的重试：把触发它的用户输入按正常路径重新派发（入队、回显、群转写）
				(text) => this.manager.dispatch(spec.role, text),
			);
			this.buildRoleEmptyState(tab.emptyEl, spec);
			tab.surface = this.makeSurface(spec.role, spec.label, tab.transcript);
			controller.attach(tab.surface);
			// 视图重建（关闭侧栏再打开、reload 后实例仍在运行）时，转写是新建的空白：主动补载历史
			if (controller.running) {
				void controller
					.loadHistory()
					.then((m) => {
						tab.transcript.loadHistory(m);
						this.renderState();
					})
					.catch(() => {});
			}
		}

		// 群时间线开屏回放（落盘的尾部）
		for (const e of readGroupTail(this.manager.projectDir(), 50)) {
			if (e.from === "learner") this.groupTranscript().addUser(`@${(e.to ?? []).map((r) => roleSpec(r)?.label ?? r).join(" @")} ${e.text}`.trim());
			else if (e.from === "hub") this.groupTranscript().addSystem(`hub → ${(e.to ?? []).map((r) => roleSpec(r)?.label ?? r).join("、")}：${e.text}`);
			else {
				this.groupRole = roleSpec(e.from)?.label ?? e.from;
				this.groupTranscript().onMessageEnd({ role: "assistant", content: [{ type: "text", text: e.text }] } as AgentMessage);
			}
		}

		// 输入：收件人徽章行 + 文本域 + @ 补全浮层
		const inputWrap = root.createDiv({ cls: "pi-learning-input-wrap" });
		const inputHead = inputWrap.createDiv({ cls: "pi-learning-input-head" });
		this.targetChip = inputHead.createEl("button", { cls: "pi-learning-target-chip", attr: { title: "当前收件人；点击切换" } });
		this.targetChip.addEventListener("click", (e) => this.showTargetMenu(e));
		inputHead.createSpan({ cls: "pi-learning-input-hint", text: "@角色 可路由 · Enter 发送 · Shift+Enter 换行" });

		const inputRow = inputWrap.createDiv({ cls: "pi-learning-input-row" });
		this.mentionEl = inputRow.createDiv({ cls: "pi-learning-mention pi-learning-hidden" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "pi-learning-input-area",
			attr: { placeholder: "对当前收件人说话；输入 @ 可点名任意角色…", rows: "3" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (this.mentionKeydown(e)) return;
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.sendInput();
			}
		});
		this.inputEl.addEventListener("input", () => this.updateMention());
		this.inputEl.addEventListener("blur", () => window.setTimeout(() => this.closeMention(), 150));
		this.sendBtn = inputRow.createEl("button", { cls: "mod-cta pi-learning-send", attr: { "aria-label": "发送" } });
		setIcon(this.sendBtn, "send-horizontal");
		this.sendBtn.addEventListener("click", () => void this.sendInput());

		this.manager.onQueueChanged = () => this.renderState();
		this.manager.onEcho = (role, message) => this.echo(role, message);
		this.manager.onGroupEntry = (entry) => {
			const labels = (entry.to ?? []).map((r) => roleSpec(r)?.label ?? r);
			if (entry.from === "learner") this.groupTranscript().addUser(`@${labels.join(" @")} ${entry.text}`.trim());
			else if (entry.from === "hub") this.groupTranscript().addSystem(`hub → ${labels.join("、")}：${entry.text}`);
			if (entry.from !== "learner") this.markUnread(GROUP_TAB);
			this.renderState();
		};
		this.manager.onError = (role, err) => {
			new Notice(`【${this.tabs.get(role)?.label ?? role}】${err.message}`, 8000);
			this.tabs.get(role)?.transcript.addSystem(err.message, "error");
		};

		this.activate(this.activeTabId);
		if (this.autoStart()) void this.safely(() => this.manager.ensureStarted("concierge"));
	}

	async onClose(): Promise<void> {
		for (const [id, tab] of this.tabs) {
			if (tab.surface) this.manager.get(id).detach(tab.surface);
		}
		this.manager.onQueueChanged = null;
		this.manager.onEcho = null;
		this.manager.onGroupEntry = null;
		this.manager.onError = null;
	}

	// ---------- 动作 ----------

	private activate(id: string): void {
		this.activeTabId = id;
		if (id !== GROUP_TAB) this.manager.activeRole = id;
		const tab = this.tabs.get(id);
		if (tab) tab.unread = false;
		for (const [tid, t] of this.tabs) t.pane.toggleClass("pi-learning-hidden", tid !== id);
		tab?.transcript.scrollToBottom();
		this.renderState();
	}

	/** 非当前页签有新内容时点亮未读点 */
	private markUnread(id: string): void {
		if (id === this.activeTabId) return;
		const tab = this.tabs.get(id);
		if (tab) tab.unread = true;
	}

	private async startActive(restart: boolean): Promise<void> {
		const c = this.active();
		const tab = this.tabs.get(this.manager.activeRole) as Tab;
		if (c.running && !restart) return;
		tab.transcript.addSystem(c.running ? "正在重启实例…" : "正在启动实例…");
		try {
			await c.start();
			tab.transcript.addSystem(`实例已启动（${c.launchSource}）。`);
		} catch (e) {
			tab.transcript.addSystem(`启动失败：${(e as Error).message}`, "error");
		}
		this.renderState();
	}

	private async reloadActive(): Promise<void> {
		if (this.activeTabId === GROUP_TAB) {
			const t = this.groupTranscript();
			t.clear();
			for (const e of readGroupTail(this.manager.projectDir(), 50)) {
				if (e.from === "learner") t.addUser(`@${(e.to ?? []).map((r) => roleSpec(r)?.label ?? r).join(" @")} ${e.text}`.trim());
				else if (e.from === "hub") t.addSystem(`hub → ${(e.to ?? []).map((r) => roleSpec(r)?.label ?? r).join("、")}：${e.text}`);
				else {
					this.groupRole = roleSpec(e.from)?.label ?? e.from;
					t.onMessageEnd({ role: "assistant", content: [{ type: "text", text: e.text }] } as AgentMessage);
				}
			}
			this.renderState();
			return;
		}
		const c = this.active();
		if (!c.running) {
			new Notice("实例未运行，没有可加载的会话记录；启动后会自动续接历史。");
			return;
		}
		try {
			(this.tabs.get(this.manager.activeRole) as Tab).transcript.loadHistory(await c.loadHistory());
		} catch (e) {
			(this.tabs.get(this.manager.activeRole) as Tab).transcript.addSystem(`加载历史失败：${(e as Error).message}`, "error");
		}
	}

	private async sendInput(): Promise<void> {
		this.closeMention();
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		const { targets, unknown } = this.manager.route(text);
		if (unknown) new Notice(`未知角色：@${unknown}。可用：${ROSTER.map((r) => r.label).join("、")}`);
		// 群页签下留在群里看聚合流；角色页签下跳到目标实例
		if (this.activeTabId !== GROUP_TAB && targets.length) this.activate(targets[0]);
		else if (this.activeTabId === GROUP_TAB && targets.length) this.manager.activeRole = targets[0];
	}

	private echo(role: string, message: string): void {
		const tab = this.tabs.get(role);
		if (!tab) return;
		if (message.startsWith("/")) tab.transcript.addCommand(message);
		else tab.transcript.addUser(message);
		this.renderState();
	}

	// ---------- 收件人菜单与 @ 补全 ----------

	private showTargetMenu(e: MouseEvent): void {
		const menu = new Menu();
		for (const spec of ROSTER) {
			menu.addItem((item) =>
				item
					.setTitle(`${spec.glyph} ${spec.label} — ${spec.brief}`)
					.setChecked(this.manager.activeRole === spec.role && this.activeTabId !== GROUP_TAB)
					.onClick(() => this.activate(spec.role)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	/** 检查光标前是否有待补全的 @ 记号（@ 需在行首或空白后，与光标间无空白） */
	private updateMention(): void {
		const pos = this.inputEl.selectionStart ?? 0;
		const before = this.inputEl.value.slice(0, pos);
		const m = /(^|\s)@([^\s@]*)$/.exec(before);
		if (!m) {
			this.closeMention();
			return;
		}
		const q = m[2].toLowerCase();
		const items = ROSTER.filter((r) => !q || r.label.toLowerCase().includes(q) || r.aliases.some((a) => a.toLowerCase().startsWith(q)) || r.role.startsWith(q));
		if (!items.length) {
			this.closeMention();
			return;
		}
		this.mentionItems = items;
		this.mentionIndex = Math.min(this.mentionIndex, items.length - 1);
		this.mentionRange = [pos - m[2].length - 1, pos];
		this.renderMention();
	}

	private renderMention(): void {
		this.mentionEl.empty();
		this.mentionEl.removeClass("pi-learning-hidden");
		this.mentionItems.forEach((spec, i) => {
			const row = this.mentionEl.createDiv({ cls: "pi-learning-mention-item" });
			row.toggleClass("pi-learning-mention-active", i === this.mentionIndex);
			row.style.setProperty("--pi-role-h", String(spec.hue));
			row.createSpan({ cls: "pi-learning-glyph", text: spec.glyph });
			const body = row.createDiv({ cls: "pi-learning-mention-body" });
			body.createDiv({ cls: "pi-learning-mention-label", text: spec.label });
			body.createDiv({ cls: "pi-learning-mention-brief", text: spec.brief });
			// mousedown 而非 click：避免 textarea 先失焦触发延迟关闭
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.pickMention(i);
			});
		});
	}

	private mentionKeydown(e: KeyboardEvent): boolean {
		if (this.mentionEl.hasClass("pi-learning-hidden") || e.isComposing) return false;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const n = this.mentionItems.length;
			this.mentionIndex = (this.mentionIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
			this.renderMention();
			return true;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			this.pickMention(this.mentionIndex);
			return true;
		}
		if (e.key === "Escape") {
			this.closeMention();
			return true;
		}
		return false;
	}

	private pickMention(i: number): void {
		const spec = this.mentionItems[i];
		const range = this.mentionRange;
		if (!spec || !range) return;
		const v = this.inputEl.value;
		const inserted = `@${spec.label} `;
		this.inputEl.value = v.slice(0, range[0]) + inserted + v.slice(range[1]);
		const caret = range[0] + inserted.length;
		this.inputEl.setSelectionRange(caret, caret);
		this.closeMention();
		this.inputEl.focus();
	}

	private closeMention(): void {
		this.mentionEl.addClass("pi-learning-hidden");
		this.mentionRange = null;
		this.mentionIndex = 0;
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

	private makeSurface(role: string, label: string, transcript: Transcript): ControllerSurface {
		const view = this;
		const group = () => view.groupTranscript();
		return {
			onEvent(e: RpcEvent): void {
				switch (e.type) {
					case "message_start": {
						const m = e.message as AgentMessage;
						transcript.onMessageStart(m);
						// 群时间线只镜像助手消息；用户与 hub 条目由 onGroupEntry 渲染
						if (m.role === "assistant") {
							view.groupStreamingRole = role;
							view.groupRole = label;
							group().onMessageStart(m);
						}
						view.renderState();
						break;
					}
					case "message_update":
						transcript.onDelta(e.assistantMessageEvent);
						if (view.groupStreamingRole === role) group().onDelta(e.assistantMessageEvent);
						break;
					case "message_end": {
						const m = e.message as AgentMessage;
						transcript.onMessageEnd(m);
						if (view.groupStreamingRole === role && m.role === "assistant") {
							view.groupRole = label;
							group().onMessageEnd(m);
						}
						if (m.role === "assistant") {
							view.markUnread(role);
							view.markUnread(GROUP_TAB);
							view.renderState();
						}
						break;
					}
					case "tool_execution_start":
						transcript.onToolStart(e.toolCallId, e.toolName, e.args);
						if (view.groupStreamingRole === role) group().onToolStart(e.toolCallId, e.toolName, e.args);
						break;
					case "tool_execution_end": {
						const text = contentText((e.result?.content ?? []) as Array<{ type: string; text?: string }>);
						transcript.onToolEnd(e.toolCallId, text, !!e.isError);
						if (view.groupStreamingRole === role) group().onToolEnd(e.toolCallId, text, !!e.isError);
						break;
					}
					case "entry_appended": {
						if (e.entry?.customType === "learning-note") {
							const text = (e.entry.data as { text?: string } | undefined)?.text ?? "";
							if (text) transcript.addNote(text);
						}
						// 学习者在选择框里选中的跨角色路由：以学习者名义派发给目标实例
						// （队列串行，本回合结束后才执行；照常回显与记群转写）
						if (e.entry?.customType === "learning-route") {
							const d = e.entry.data as { role?: string; text?: string } | undefined;
							const spec = d?.role ? roleSpec(d.role) : undefined;
							if (spec && d?.text) {
								transcript.addSystem(`已转交 @${spec.label}：${d.text}`);
								view.markUnread(spec.role);
								view.manager.dispatch(spec.role, d.text);
							}
						}
						break;
					}
					case "agent_settled":
						transcript.finishStreaming();
						if (view.groupStreamingRole === role) {
							group().finishStreaming();
							view.groupStreamingRole = null;
						}
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

	// ---------- 空状态 ----------

	/** 群页签空状态：花名册导览，点击一张卡即把 @角色 填进输入框 */
	private buildGroupEmptyState(el: HTMLElement): void {
		el.createDiv({ cls: "pi-learning-empty-title", text: "教研室" });
		el.createDiv({ cls: "pi-learning-empty-sub", text: "八位常驻角色各司其职。在下方输入框直接说话，或点一张卡片点名。" });
		const grid = el.createDiv({ cls: "pi-learning-roster-grid" });
		for (const spec of ROSTER) {
			const card = grid.createDiv({ cls: "pi-learning-roster-card", attr: { title: `@${spec.label}` } });
			card.style.setProperty("--pi-role-h", String(spec.hue));
			const head = card.createDiv({ cls: "pi-learning-roster-card-head" });
			head.createSpan({ cls: "pi-learning-glyph", text: spec.glyph });
			head.createSpan({ cls: "pi-learning-roster-card-name", text: spec.label });
			card.createDiv({ cls: "pi-learning-roster-card-brief", text: spec.brief });
			card.addEventListener("click", () => {
				this.inputEl.value = `@${spec.label} `;
				this.inputEl.focus();
				this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
			});
		}
	}

	/** 角色页签空状态：身份卡 + 一句引导 */
	private buildRoleEmptyState(el: HTMLElement, spec: RoleSpec): void {
		const g = el.createDiv({ cls: "pi-learning-glyph pi-learning-empty-glyph", text: spec.glyph });
		g.style.setProperty("--pi-role-h", String(spec.hue));
		el.createDiv({ cls: "pi-learning-empty-title", text: spec.label });
		el.createDiv({ cls: "pi-learning-empty-sub", text: spec.brief });
		el.createDiv({ cls: "pi-learning-empty-hint", text: "直接在下方说话即可；首次发言会自动启动实例。" });
	}

	// ---------- 渲染 ----------

	private renderState(): void {
		// 页签：三态状态点（停 / 运行呼吸 / 生成脉冲）+ 未读点 + 活跃下划线 + 空状态显隐
		for (const [id, tab] of this.tabs) {
			const active = id === this.activeTabId;
			const running = id === GROUP_TAB ? false : this.manager.get(id).running;
			const streaming = id === GROUP_TAB ? this.groupStreamingRole !== null || this.manager.pendingCount > 0 : this.manager.get(id).streaming;
			tab.btn.toggleClass("pi-learning-tab-active", active);
			tab.btn.toggleClass("pi-learning-tab-running", running);
			tab.btn.toggleClass("pi-learning-tab-streaming", streaming);
			tab.btn.toggleClass("pi-learning-tab-unread", !!tab.unread && !active);
			tab.emptyEl.toggleClass("pi-learning-hidden", tab.transcript.blocks.length > 0);
		}

		// 输入区收件人徽章：未寻址消息的实际去向
		const spec = roleSpec(this.manager.activeRole);
		this.targetChip.empty();
		if (this.activeTabId === GROUP_TAB) this.targetChip.createSpan({ cls: "pi-learning-chip-prefix", text: "群 →" });
		if (spec) {
			this.targetChip.style.setProperty("--pi-role-h", String(spec.hue));
			this.targetChip.createSpan({ cls: "pi-learning-glyph", text: spec.glyph });
		}
		this.targetChip.createSpan({ cls: "pi-learning-chip-name", text: spec?.label ?? this.manager.activeRole });
		const chev = this.targetChip.createSpan({ cls: "pi-learning-chip-chevron" });
		setIcon(chev, "chevron-down");

		// 顶栏：活跃实例（群页签下显示未寻址消息的去向）
		const c = this.active();
		const st = c.state;
		const activeLabel = spec?.label ?? this.manager.activeRole;
		const roleStatus = c.statuses.get("learning");
		this.statusEl.empty();
		if (spec) {
			const g = this.statusEl.createSpan({ cls: "pi-learning-glyph pi-learning-status-glyph", text: spec.glyph });
			g.style.setProperty("--pi-role-h", String(spec.hue));
		}
		if (this.activeTabId === GROUP_TAB) this.statusEl.createSpan({ text: `群视图 · 未寻址消息发给 ${activeLabel}` });
		else this.statusEl.createSpan({ text: c.running ? (roleStatus ?? activeLabel) : `${activeLabel} 未启动` });
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
