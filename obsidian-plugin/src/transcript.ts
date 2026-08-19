/**
 * transcript.ts —— 对话记录的数据模型与渲染。
 *
 * 数据来自两处：get_messages 的历史（AgentMessage[]）与 RPC 事件流（增量）。
 * 渲染到一个滚动容器；助手文本用 Obsidian 的 MarkdownRenderer，工具调用折叠显示，
 * 学习扩展的 learning-note 条目（/learn、/events 的输出）以"黑板"卡片显示。
 */
import { type App, type Component, MarkdownRenderer } from "obsidian";
import type { AgentMessage, AssistantDelta, AssistantMessage, CustomMessage, TextContent, ToolResultMessage, UserMessage } from "./rpc/types.ts";

export type ToolPart = { type: "tool"; id: string; name: string; args: unknown; argsText: string; result?: string; isError?: boolean; done: boolean };
export type AssistantPart = { type: "text"; text: string } | { type: "thinking"; text: string } | ToolPart;

export type Block =
	| { kind: "user"; text: string; el?: HTMLElement }
	| { kind: "command"; text: string; el?: HTMLElement }
	| { kind: "assistant"; parts: AssistantPart[]; streaming: boolean; error?: string; el?: HTMLElement }
	| { kind: "note"; text: string; el?: HTMLElement }
	| { kind: "custom"; customType: string; text: string; el?: HTMLElement }
	| { kind: "system"; text: string; level: "info" | "warning" | "error"; el?: HTMLElement };

export class Transcript {
	blocks: Block[] = [];
	private current: Extract<Block, { kind: "assistant" }> | null = null;
	private renderTimer: number | null = null;

	constructor(
		private app: App,
		private component: Component,
		private container: HTMLElement,
	) {}

	clear(): void {
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
			this.current = { kind: "assistant", parts: [], streaming: true };
			this.push(this.current);
			this.renderLast();
		} else if (m.role === "user") {
			const text = userText(m as UserMessage);
			// 本地发送时已追加过同文本的用户块则不重复
			const last = this.blocks[this.blocks.length - 1];
			if (last && last.kind === "user" && last.text === text) return;
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
		const at = (i: number) => cur.parts[i];
		switch (d.type) {
			case "text_start":
				cur.parts[d.contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta": {
				const p = at(d.contentIndex);
				if (p && p.type === "text") p.text += d.delta;
				else cur.parts[d.contentIndex] = { type: "text", text: d.delta };
				break;
			}
			case "text_end":
				cur.parts[d.contentIndex] = { type: "text", text: d.content };
				break;
			case "thinking_start":
				cur.parts[d.contentIndex] = { type: "thinking", text: "" };
				break;
			case "thinking_delta": {
				const p = at(d.contentIndex);
				if (p && p.type === "thinking") p.text += d.delta;
				else cur.parts[d.contentIndex] = { type: "thinking", text: d.delta };
				break;
			}
			case "thinking_end":
				cur.parts[d.contentIndex] = { type: "thinking", text: d.content };
				break;
			case "toolcall_start":
				cur.parts[d.contentIndex] = { type: "tool", id: "", name: "…", args: undefined, argsText: "", done: false };
				break;
			case "toolcall_delta": {
				const p = at(d.contentIndex);
				if (p && p.type === "tool") p.argsText += d.delta;
				break;
			}
			case "toolcall_end":
				cur.parts[d.contentIndex] = { type: "tool", id: d.toolCall.id, name: d.toolCall.name, args: d.toolCall.arguments, argsText: safeJson(d.toolCall.arguments), done: false };
				break;
		}
		this.scheduleRender(cur);
	}

	onMessageEnd(m: AgentMessage): void {
		if (m.role !== "assistant") return;
		const am = m as AssistantMessage;
		const cur = this.current ?? (() => {
			const b: Extract<Block, { kind: "assistant" }> = { kind: "assistant", parts: [], streaming: true };
			this.push(b);
			return b;
		})();
		// 以最终消息为准，但保留已到达的工具结果
		const results = new Map<string, ToolPart>();
		for (const p of cur.parts) if (p.type === "tool" && p.id) results.set(p.id, p);
		cur.parts = am.content.map((c): AssistantPart => {
			if (c.type === "text") return { type: "text", text: c.text };
			if (c.type === "thinking") return { type: "thinking", text: c.thinking };
			const prev = results.get(c.id);
			return { type: "tool", id: c.id, name: c.name, args: c.arguments, argsText: safeJson(c.arguments), result: prev?.result, isError: prev?.isError, done: prev?.done ?? false };
		});
		cur.streaming = false;
		if (am.stopReason === "error" || am.stopReason === "aborted") cur.error = am.errorMessage ?? am.stopReason;
		this.current = null;
		this.renderBlock(cur);
	}

	onToolStart(toolCallId: string, toolName: string, args: unknown): void {
		const tp = this.findTool(toolCallId);
		if (tp) {
			tp.name = toolName;
			tp.args = args;
			tp.argsText = safeJson(args);
		}
		this.scheduleRender(this.current ?? this.lastAssistant());
	}

	onToolEnd(toolCallId: string, text: string, isError: boolean): void {
		const tp = this.findTool(toolCallId);
		if (tp) {
			tp.result = text;
			tp.isError = isError;
			tp.done = true;
		}
		const b = this.current ?? this.lastAssistant();
		if (b) this.renderBlock(b);
	}

	/** 流式中断（abort / 进程退出） */
	finishStreaming(note?: string): void {
		if (this.current) {
			this.current.streaming = false;
			if (note) this.current.error = note;
			this.renderBlock(this.current);
			this.current = null;
		}
	}

	// ---------- 渲染 ----------

	private push(b: Block): void {
		this.blocks.push(b);
	}

	private findTool(id: string): ToolPart | undefined {
		for (let i = this.blocks.length - 1; i >= 0; i--) {
			const b = this.blocks[i];
			if (b.kind !== "assistant") continue;
			for (const p of b.parts) if (p.type === "tool" && p.id === id) return p;
		}
		return undefined;
	}
	private lastAssistant(): Extract<Block, { kind: "assistant" }> | null {
		for (let i = this.blocks.length - 1; i >= 0; i--) {
			const b = this.blocks[i];
			if (b.kind === "assistant") return b;
		}
		return null;
	}

	private scheduleRender(b: Block | null): void {
		if (!b) return;
		if (this.renderTimer !== null) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			this.renderBlock(b);
		}, 120);
	}

	renderAll(): void {
		this.container.empty();
		for (const b of this.blocks) {
			b.el = undefined;
			this.renderBlock(b);
		}
	}

	private renderLast(): void {
		const b = this.blocks[this.blocks.length - 1];
		if (b) this.renderBlock(b);
	}

	private renderBlock(b: Block): void {
		const stick = this.isNearBottom();
		const el = b.el ?? this.container.createDiv();
		b.el = el;
		el.empty();
		el.className = `pi-learning-block pi-learning-${b.kind}`;
		switch (b.kind) {
			case "user":
				el.createDiv({ cls: "pi-learning-role", text: "你" });
				el.createDiv({ cls: "pi-learning-text", text: b.text });
				break;
			case "command":
				el.createSpan({ cls: "pi-learning-command", text: b.text });
				break;
			case "system":
				el.addClass(`pi-learning-system-${b.level}`);
				el.setText(b.text);
				break;
			case "note": {
				el.createDiv({ cls: "pi-learning-role", text: "黑板" });
				el.createEl("pre", { cls: "pi-learning-note-text", text: b.text });
				break;
			}
			case "custom": {
				el.createDiv({ cls: "pi-learning-role", text: b.customType });
				const body = el.createDiv({ cls: "pi-learning-md" });
				this.md(b.text, body);
				break;
			}
			case "assistant": {
				el.createDiv({ cls: "pi-learning-role", text: b.streaming ? "角色 · 生成中" : "角色" });
				for (const p of b.parts) {
					if (!p) continue;
					if (p.type === "text") {
						const body = el.createDiv({ cls: "pi-learning-md" });
						this.md(p.text, body);
					} else if (p.type === "thinking") {
						if (!p.text.trim()) continue;
						const d = el.createEl("details", { cls: "pi-learning-thinking" });
						d.createEl("summary", { text: "思考" });
						d.createEl("pre", { text: p.text });
					} else {
						this.renderTool(el, p);
					}
				}
				if (b.error) el.createDiv({ cls: "pi-learning-error", text: `中断：${b.error}` });
				break;
			}
		}
		if (stick) this.scrollToBottom();
	}

	private renderTool(parent: HTMLElement, p: ToolPart): void {
		const isBb = p.name.startsWith("bb_");
		const d = parent.createEl("details", { cls: `pi-learning-tool ${isBb ? "pi-learning-tool-bb" : ""} ${p.isError ? "pi-learning-tool-error" : ""}` });
		// bb_* 是工作流的"回执"，默认展开；read/grep 等折叠
		if (isBb && p.done) d.setAttr("open", "");
		const status = p.done ? (p.isError ? "失败" : "完成") : "执行中";
		d.createEl("summary", { text: `${isBb ? "黑板工具" : "工具"} ${p.name} · ${status}` });
		if (p.argsText && !isBb) d.createEl("pre", { cls: "pi-learning-tool-args", text: truncate(p.argsText, 1200) });
		if (isBb && p.args && typeof p.args === "object") {
			d.createEl("pre", { cls: "pi-learning-tool-args", text: truncate(p.argsText, 4000) });
		}
		if (p.result !== undefined) d.createEl("pre", { cls: "pi-learning-tool-result", text: truncate(p.result, isBb ? 6000 : 1500) });
	}

	private md(text: string, el: HTMLElement): void {
		void MarkdownRenderer.render(this.app, text, el, "", this.component);
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
