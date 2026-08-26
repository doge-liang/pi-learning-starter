/**
 * transcript.ts —— 对话记录的数据模型与渲染。
 *
 * 数据来自两处：get_messages 的历史（AgentMessage[]）与 RPC 事件流（增量）。
 * 渲染策略是"就地更新"：每个消息块、每个内容部件（文本 / 思考 / 工具调用）都持有自己的 DOM 节点，
 * 流式增量只改动对应节点——文本走 StreamingMarkdown（块级增量、只重绘末尾块），
 * 工具与思考块更新文字而不重建，因此折叠状态不会丢，也不会整段闪烁。
 */
import { type App, type Component, MarkdownRenderer } from "obsidian";
import type { AgentMessage, AssistantDelta, AssistantMessage, CustomMessage, TextContent, ToolResultMessage, UserMessage } from "./rpc/types.ts";
import { SmoothPlainText } from "./smooth-reveal.ts";
import { StreamingMarkdown } from "./streaming-markdown.ts";

export type TextPart = { type: "text"; text: string; el?: HTMLElement; md?: StreamingMarkdown };
export type ThinkingPart = { type: "thinking"; text: string; el?: HTMLDetailsElement; body?: HTMLElement; summary?: HTMLElement; smooth?: SmoothPlainText };
export type ToolPart = {
	type: "tool";
	id: string;
	name: string;
	args: unknown;
	argsText: string;
	result?: string;
	isError?: boolean;
	done: boolean;
	el?: HTMLDetailsElement;
	summary?: HTMLElement;
	argsEl?: HTMLElement;
	resultEl?: HTMLElement;
	/** 完成时已自动展开过（只做一次，之后尊重用户的折叠） */
	autoOpened?: boolean;
};
export type AssistantPart = TextPart | ThinkingPart | ToolPart;

export type Block =
	| { kind: "user"; text: string; el?: HTMLElement }
	| { kind: "command"; text: string; el?: HTMLElement }
	| { kind: "assistant"; parts: AssistantPart[]; streaming: boolean; role?: string; error?: string; el?: HTMLElement; roleEl?: HTMLElement; bodyEl?: HTMLElement; errorEl?: HTMLElement }
	| { kind: "note"; text: string; el?: HTMLElement }
	| { kind: "custom"; customType: string; text: string; el?: HTMLElement }
	| { kind: "system"; text: string; level: "info" | "warning" | "error"; el?: HTMLElement };

type AssistantBlock = Extract<Block, { kind: "assistant" }>;

export class Transcript {
	blocks: Block[] = [];
	private current: AssistantBlock | null = null;
	/** 历史批量重建时关闭进入动画，只有增量新块做淡入 */
	private animate = true;

	constructor(
		private app: App,
		private component: Component,
		private container: HTMLElement,
		/** 取当前角色名；消息开始时快照到块上（历史消息不记录角色，重载后无从追溯，故只标注新消息） */
		private roleName?: () => string | undefined,
		/** 角色名 → 徽章外观；查不到则不画徽章只显示名字 */
		private badge?: (roleLabel: string) => { hue: number; glyph: string } | undefined,
		/** 重发一条用户消息（失败回合的「重试」按钮）；未提供则不渲染重试 */
		private onRetry?: (text: string) => void,
	) {}

	clear(): void {
		for (const b of this.blocks) detachDom(b); // 顺带取消流式揭示的 rAF 循环
		this.blocks = [];
		this.current = null;
		this.container.empty();
	}

	// ---------- 历史 ----------

	loadHistory(messages: AgentMessage[]): void {
		// 会话切换的核对是异步的：若此刻正有助手消息在流式生成，重载后把它接回末尾
		const inflight = this.current?.streaming ? this.current : null;
		this.clear();
		const toolIndex = new Map<string, ToolPart>();
		for (const m of messages) {
			switch (m.role) {
				case "user":
					this.push({ kind: "user", text: userText(m as UserMessage) });
					break;
				case "assistant": {
					const am = m as AssistantMessage;
					const parts = am.content.map((c): AssistantPart => {
						if (c.type === "text") return { type: "text", text: c.text };
						if (c.type === "thinking") return { type: "thinking", text: c.thinking };
						const tp: ToolPart = { type: "tool", id: c.id, name: c.name, args: c.arguments, argsText: safeJson(c.arguments), done: false };
						toolIndex.set(c.id, tp);
						return tp;
					});
					const err = am.stopReason === "error" || am.stopReason === "aborted" ? (am.errorMessage ?? am.stopReason) : undefined;
					this.push({ kind: "assistant", parts, streaming: false, error: err });
					break;
				}
				case "toolResult": {
					const tr = m as ToolResultMessage;
					const tp = toolIndex.get(tr.toolCallId);
					if (tp) {
						tp.result = contentText(tr.content);
						tp.isError = tr.isError;
						tp.done = true;
					}
					break;
				}
				case "custom": {
					const cm = m as CustomMessage;
					if (cm.display) this.push({ kind: "custom", customType: cm.customType, text: typeof cm.content === "string" ? cm.content : contentText(cm.content) });
					break;
				}
				default:
					break;
			}
		}
		if (inflight) {
			// 重新挂载：丢弃旧 DOM 引用，按当前数据重建
			detachDom(inflight);
			this.push(inflight);
			this.current = inflight;
		}
		this.renderAll();
	}

	// ---------- 本地追加 ----------

	addUser(text: string): void {
		this.push({ kind: "user", text });
		this.renderLast();
	}
	addCommand(text: string): void {
		this.push({ kind: "command", text });
		this.renderLast();
	}
	addSystem(text: string, level: "info" | "warning" | "error" = "info"): void {
		this.push({ kind: "system", text, level });
		this.renderLast();
	}
	addNote(text: string): void {
		this.push({ kind: "note", text });
		this.renderLast();
	}

	// ---------- 事件流 ----------

	onMessageStart(m: AgentMessage): void {
		if (m.role === "assistant") {
			this.current = { kind: "assistant", parts: [], streaming: true, role: this.roleName?.() };
			this.push(this.current);
			this.renderLast();
		} else if (m.role === "user") {
			const text = userText(m as UserMessage);
			const last = this.blocks[this.blocks.length - 1];
			if (last && last.kind === "user" && last.text === text) return; // 本地发送时已回显
			this.push({ kind: "user", text });
			this.renderLast();
		} else if (m.role === "custom") {
			const cm = m as CustomMessage;
			if (cm.display) {
				this.push({ kind: "custom", customType: cm.customType, text: typeof cm.content === "string" ? cm.content : contentText(cm.content) });
				this.renderLast();
			}
		}
	}

	onDelta(d: AssistantDelta): void {
		const cur = this.current;
		if (!cur) return;
		const i = d.contentIndex;
		switch (d.type) {
			case "text_start":
				cur.parts[i] = { type: "text", text: "" };
				// 正文开始后把前面自动展开的思考块收起
				for (const p of cur.parts) if (p && p.type === "thinking" && p.el) p.el.open = false;
				break;
			case "text_delta": {
				const p = cur.parts[i];
				if (p && p.type === "text") p.text += d.delta;
				else cur.parts[i] = { type: "text", text: d.delta };
				break;
			}
			case "text_end": {
				const p = cur.parts[i];
				if (p && p.type === "text") p.text = d.content;
				else cur.parts[i] = { type: "text", text: d.content };
				break;
			}
			case "thinking_start":
				cur.parts[i] = { type: "thinking", text: "" };
				break;
			case "thinking_delta": {
				const p = cur.parts[i];
				if (p && p.type === "thinking") p.text += d.delta;
				else cur.parts[i] = { type: "thinking", text: d.delta };
				break;
			}
			case "thinking_end": {
				const p = cur.parts[i];
				if (p && p.type === "thinking") p.text = d.content;
				else cur.parts[i] = { type: "thinking", text: d.content };
				break;
			}
			case "toolcall_start":
				cur.parts[i] = { type: "tool", id: "", name: "…", args: undefined, argsText: "", done: false };
				break;
			case "toolcall_delta": {
				const p = cur.parts[i];
				if (p && p.type === "tool") p.argsText += d.delta;
				break;
			}
			case "toolcall_end": {
				const prev = cur.parts[i];
				const tp: ToolPart = { type: "tool", id: d.toolCall.id, name: d.toolCall.name, args: d.toolCall.arguments, argsText: safeJson(d.toolCall.arguments), done: false };
				if (prev && prev.type === "tool") Object.assign(prev, tp);
				else cur.parts[i] = tp;
				break;
			}
		}
		this.renderAssistant(cur);
	}

	onMessageEnd(m: AgentMessage): void {
		if (m.role !== "assistant") return;
		const am = m as AssistantMessage;
		let cur = this.current;
		if (!cur) {
			cur = { kind: "assistant", parts: [], streaming: true, role: this.roleName?.() };
			this.push(cur);
		}
		// 以最终消息为准；尽量复用已有部件的 DOM，保留工具结果
		const results = new Map<string, ToolPart>();
		for (const p of cur.parts) if (p && p.type === "tool" && p.id) results.set(p.id, p);
		const next: AssistantPart[] = am.content.map((c, i): AssistantPart => {
			const prev = cur.parts[i];
			if (c.type === "text") {
				if (prev && prev.type === "text") {
					prev.text = c.text;
					return prev;
				}
				return { type: "text", text: c.text };
			}
			if (c.type === "thinking") {
				if (prev && prev.type === "thinking") {
					prev.text = c.thinking;
					return prev;
				}
				return { type: "thinking", text: c.thinking };
			}
			const old = results.get(c.id) ?? (prev && prev.type === "tool" ? prev : undefined);
			if (old) {
				Object.assign(old, { id: c.id, name: c.name, args: c.arguments, argsText: safeJson(c.arguments) });
				return old;
			}
			return { type: "tool", id: c.id, name: c.name, args: c.arguments, argsText: safeJson(c.arguments), done: false };
		});
		// 被丢弃的旧部件移除其 DOM
		for (const p of cur.parts) if (p && !next.includes(p)) partEl(p)?.remove();
		cur.parts = next;
		cur.streaming = false;
		if (am.stopReason === "error" || am.stopReason === "aborted") cur.error = am.errorMessage ?? am.stopReason;
		this.current = null;
		this.renderAssistant(cur);
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		const hit = this.findTool(toolCallId);
		if (hit) {
			hit.part.name = toolName;
			hit.part.args = args;
			hit.part.argsText = safeJson(args);
			this.renderAssistant(hit.block);
		}
	}

	onToolEnd(toolCallId: string, text: string, isError: boolean): void {
		const hit = this.findTool(toolCallId);
		if (hit) {
			hit.part.result = text;
			hit.part.isError = isError;
			hit.part.done = true;
			this.renderAssistant(hit.block);
		}
	}

	/** 流式中断（abort / 进程退出） */
	finishStreaming(note?: string): void {
		if (this.current) {
			this.current.streaming = false;
			if (note) this.current.error = note;
			this.renderAssistant(this.current);
			this.current = null;
		}
	}

	// ---------- 渲染 ----------

	private push(b: Block): void {
		this.blocks.push(b);
	}

	private findTool(id: string): { block: AssistantBlock; part: ToolPart } | undefined {
		for (let i = this.blocks.length - 1; i >= 0; i--) {
			const b = this.blocks[i];
			if (b.kind !== "assistant") continue;
			for (const p of b.parts) if (p && p.type === "tool" && p.id === id) return { block: b, part: p };
		}
		return undefined;
	}

	renderAll(): void {
		this.container.empty();
		this.animate = false;
		try {
			for (const b of this.blocks) {
				detachDom(b);
				this.renderBlock(b);
			}
		} finally {
			this.animate = true;
		}
		this.scrollToBottom();
	}

	private renderLast(): void {
		const b = this.blocks[this.blocks.length - 1];
		if (b) this.renderBlock(b);
	}

	private renderBlock(b: Block): void {
		if (b.kind === "assistant") {
			this.renderAssistant(b);
			return;
		}
		const stick = this.isNearBottom();
		const fresh = !b.el;
		const el = b.el ?? this.container.createDiv();
		b.el = el;
		el.empty();
		el.className = `pi-learning-block pi-learning-${b.kind}`;
		if (fresh && this.animate) el.addClass("pi-learning-enter");
		switch (b.kind) {
			case "user": {
				// 不显示标题，靠右对齐即可辨识用户消息
				// 扩展加在消息前面的标记（[mode: hint]、[begin-session]、[grade] 等）显示为小标签
				const { tags, rest } = splitLeadingTags(b.text);
				if (tags.length) {
					const row = el.createDiv({ cls: "pi-learning-tags" });
					for (const t of tags) row.createSpan({ cls: "pi-learning-tag", text: t });
				}
				if (rest.trim()) {
					const body = el.createDiv({ cls: "pi-learning-md pi-learning-user-md markdown-rendered" });
					void MarkdownRenderer.render(this.app, rest, body, "", this.component);
				}
				break;
			}
			case "command":
				el.createSpan({ cls: "pi-learning-command", text: b.text });
				break;
			case "system":
				el.addClass(`pi-learning-system-${b.level}`);
				el.setText(b.text);
				break;
			case "note":
				el.createDiv({ cls: "pi-learning-role", text: "黑板" });
				el.createEl("pre", { cls: "pi-learning-note-text", text: b.text });
				break;
			case "custom": {
				el.createDiv({ cls: "pi-learning-role", text: b.customType });
				const body = el.createDiv({ cls: "pi-learning-md markdown-rendered" });
				void MarkdownRenderer.render(this.app, b.text, body, "", this.component);
				break;
			}
		}
		if (stick) this.scrollToBottom();
	}

	/** 助手块：容器与部件节点都只创建一次，之后就地更新 */
	private renderAssistant(b: AssistantBlock): void {
		const stick = this.isNearBottom();
		if (!b.el) {
			b.el = this.container.createDiv({ cls: "pi-learning-block pi-learning-assistant" });
			if (this.animate) b.el.addClass("pi-learning-enter");
			b.roleEl = b.el.createDiv({ cls: "pi-learning-role" });
			b.bodyEl = b.el.createDiv({ cls: "pi-learning-assistant-body" });
		}
		b.el.toggleClass("pi-learning-streaming", b.streaming);
		b.roleEl!.empty();
		if (b.role) {
			const badge = this.badge?.(b.role);
			if (badge) {
				const g = b.roleEl!.createSpan({ cls: "pi-learning-glyph", text: badge.glyph });
				g.style.setProperty("--pi-role-h", String(badge.hue));
				b.el.style.setProperty("--pi-role-h", String(badge.hue));
				b.el.addClass("pi-learning-has-role");
			}
			b.roleEl!.createSpan({ cls: "pi-learning-role-name", text: b.role });
		}
		if (b.streaming) b.roleEl!.createSpan({ cls: "pi-learning-dots", text: b.role ? " · 生成中" : "生成中" });
		// 历史消息不记录角色：既无角色也不在生成时整行隐藏
		b.roleEl!.toggleClass("pi-learning-hidden", !b.role && !b.streaming);

		const body = b.bodyEl!;
		let anchor: Node | null = null; // 维持部件顺序：逐个 insertAfter
		for (const p of b.parts) {
			if (!p) continue;
			const el = this.ensurePartEl(p, body);
			// 顺序校正（新部件通常在末尾；历史重载时按顺序创建）
			if (anchor ? el.previousSibling !== anchor : body.firstChild !== el) {
				if (anchor) (anchor as ChildNode).after(el);
				else body.prepend(el);
			}
			anchor = el;
			this.updatePart(p, b);
		}
		if (b.error) {
			if (!b.errorEl) b.errorEl = b.el.createDiv({ cls: "pi-learning-error" });
			b.errorEl.empty();
			b.errorEl.createSpan({ text: `中断：${b.error}` });
			const retryText = this.onRetry ? this.retryTextFor(b) : undefined;
			if (retryText) {
				const btn = b.errorEl.createEl("button", { cls: "pi-learning-retry", text: "重试" });
				btn.addEventListener("click", () => this.onRetry?.(retryText));
			}
		} else if (b.errorEl) {
			b.errorEl.remove();
			b.errorEl = undefined;
		}
		if (stick) this.scrollToBottom();
	}

	private ensurePartEl(p: AssistantPart, body: HTMLElement): HTMLElement {
		const existing = partEl(p);
		if (existing) return existing;
		if (p.type === "text") {
			p.el = body.createDiv({ cls: "pi-learning-md markdown-rendered" });
			p.md = new StreamingMarkdown(this.app, this.component, p.el, undefined, () => {
				if (this.isNearBottom()) this.scrollToBottom();
			});
			return p.el;
		}
		if (p.type === "thinking") {
			p.el = body.createEl("details", { cls: "pi-learning-thinking" });
			p.summary = p.el.createEl("summary");
			p.body = p.el.createEl("pre");
			p.smooth = new SmoothPlainText(p.body);
			return p.el;
		}
		p.el = body.createEl("details", { cls: "pi-learning-tool" });
		p.summary = p.el.createEl("summary");
		p.argsEl = p.el.createEl("pre", { cls: "pi-learning-tool-args" });
		p.resultEl = p.el.createEl("pre", { cls: "pi-learning-tool-result" });
		return p.el;
	}

	private updatePart(p: AssistantPart, b: AssistantBlock): void {
		if (p.type === "text") {
			if (b.streaming) p.md!.update(p.text);
			else if (p.md!.text !== p.text || b.streaming === false) p.md!.finish(p.text);
			return;
		}
		if (p.type === "thinking") {
			const streamingThis = b.streaming && isLastPart(b, p);
			p.el!.toggleClass("pi-learning-hidden", !p.text.trim() && !streamingThis);
			p.summary!.setText(streamingThis ? "思考中" : `思考（${p.text.length} 字）`);
			p.summary!.toggleClass("pi-learning-dots", streamingThis);
			if (streamingThis && !p.el!.open) p.el!.open = true;
			// 生成中经匀速揭示上屏并带末尾光标；结束（或轮到后面的部件）后定稿
			if (streamingThis) p.smooth!.update(p.text);
			else p.smooth!.finish(p.text);
			return;
		}
		const isBb = p.name.startsWith("bb_");
		p.el!.toggleClass("pi-learning-tool-bb", isBb);
		p.el!.toggleClass("pi-learning-tool-error", !!p.isError);
		p.el!.toggleClass("pi-learning-tool-running", !p.done);
		const status = p.done ? (p.isError ? "失败" : "完成") : "执行中";
		p.summary!.setText(`${isBb ? "黑板工具" : "工具"} ${p.name} · ${status}`);
		p.summary!.toggleClass("pi-learning-dots", !p.done);
		const argsText = p.argsText ? truncate(p.argsText, isBb ? 4000 : 1200) : "";
		setTextIfChanged(p.argsEl!, argsText);
		p.argsEl!.toggleClass("pi-learning-hidden", !argsText);
		const resultText = p.result !== undefined ? truncate(p.result, isBb ? 6000 : 1500) : "";
		setTextIfChanged(p.resultEl!, resultText);
		p.resultEl!.toggleClass("pi-learning-hidden", !resultText);
		// bb_* 是工作流的回执：首次完成时自动展开一次；之后尊重用户的折叠
		if (isBb && p.done && !p.autoOpened) {
			p.el!.open = true;
			p.autoOpened = true;
		}
	}

	/** 触发该助手回合的用户输入：向前找最近的 user / command 块 */
	private retryTextFor(b: AssistantBlock): string | undefined {
		for (let i = this.blocks.indexOf(b) - 1; i >= 0; i--) {
			const prev = this.blocks[i];
			if (prev.kind === "user" || prev.kind === "command") return prev.text;
			if (prev.kind === "assistant") return undefined; // 中间隔了别的回合就不猜
		}
		return undefined;
	}

	private isNearBottom(): boolean {
		const c = this.container;
		return c.scrollHeight - c.scrollTop - c.clientHeight < 80;
	}
	scrollToBottom(): void {
		this.container.scrollTop = this.container.scrollHeight;
	}
}

// ---------- 辅助 ----------

function partEl(p: AssistantPart): HTMLElement | undefined {
	return p.el;
}
function isLastPart(b: AssistantBlock, p: AssistantPart): boolean {
	for (let i = b.parts.length - 1; i >= 0; i--) if (b.parts[i]) return b.parts[i] === p;
	return false;
}
function setTextIfChanged(el: HTMLElement, text: string): void {
	if (el.textContent !== text) el.setText(text);
}
/** 丢弃一个块上的所有 DOM 引用（重载历史时重新创建），并停掉挂在其上的动画循环 */
function detachDom(b: Block): void {
	b.el = undefined;
	if (b.kind === "assistant") {
		b.roleEl = b.bodyEl = b.errorEl = undefined;
		for (const p of b.parts) {
			if (!p) continue;
			p.el = undefined;
			if (p.type === "text") {
				p.md?.destroy();
				p.md = undefined;
			} else if (p.type === "thinking") {
				p.smooth?.destroy();
				p.body = p.summary = p.smooth = undefined;
			} else p.summary = p.argsEl = p.resultEl = undefined;
		}
	}
}

/** 取出消息开头连续的 [标记]，其余为正文 */
export function splitLeadingTags(text: string): { tags: string[]; rest: string } {
	const tags: string[] = [];
	let rest = text.trimStart();
	const re = /^\[([^\]\n]{1,40})\]\s*/;
	let m: RegExpExecArray | null;
	while ((m = re.exec(rest))) {
		tags.push(m[1]);
		rest = rest.slice(m[0].length);
	}
	return { tags, rest };
}

export function userText(m: UserMessage): string {
	return typeof m.content === "string" ? m.content : contentText(m.content);
}
export function contentText(content: Array<{ type: string; text?: string }>): string {
	return (content ?? [])
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
function safeJson(v: unknown): string {
	if (v === undefined) return "";
	try {
		return JSON.stringify(v, null, 1);
	} catch {
		return String(v);
	}
}
function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s;
}
