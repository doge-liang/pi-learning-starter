/**
 * streaming-markdown.ts —— 用 Obsidian 自带的 MarkdownRenderer 做增量流式渲染。
 *
 * 思路：把已到达的文本切成"已完成的块"与"末尾未完成的块"。块的边界是围栏代码之外的空行。
 * 已完成的块只渲染一次并固定在 DOM 里；每次增量只重绘末尾块，并对其中未闭合的代码围栏临时补全。
 * 这样既保留 Obsidian 的渲染保真度（主题、数学、代码高亮、callout、wikilink），又没有整段重绘的闪烁。
 *
 * 到达的增量先经 SmoothReveal 匀速揭示（按积压自适应的打字机推进），再进入渲染；
 * 每次尾块重绘后，把最近揭示的字符包进渐入 span（负 animation-delay 保持相位），
 * 于是文字以稳定的节奏浮现，而不是一批一批地蹦出来。
 */
import { type App, type Component, MarkdownRenderer } from "obsidian";
import { closeOpenFence, splitBlocks } from "./markdown-blocks.ts";
import { FADE_MS, type RevealSegment, SmoothReveal, wrapTrailingFades } from "./smooth-reveal.ts";

interface Segment {
	text: string;
	el: HTMLElement;
}

export class StreamingMarkdown {
	private stable: Segment[] = [];
	private tailEl: HTMLElement;
	private cursorEl: HTMLElement | null = null;
	private tailText = "";
	private lastRendered = "";
	private pendingFrame: number | null = null;
	private lastPaint = 0;
	private finished = false;
	private hasStreamed = false;
	/** 已揭示并交给渲染的文本（目标全文的前缀）；finish 时用于校验与全量重绘 */
	private source = "";
	private reveal: SmoothReveal;
	/** 最近揭示的字符段（渐入包裹用），超过动画时长的会被清掉 */
	private recent: RevealSegment[] = [];
	/** 消息已定稿但揭示尚未追平：记住终稿，追平后再走 finish */
	private pendingFinish: string | null = null;

	constructor(
		private app: App,
		private component: Component,
		private container: HTMLElement,
		private minIntervalMs = 45,
		/** 每次尾块上屏后调用（揭示让文字在 RPC 事件之间持续长高，滚动跟随要挂在这里） */
		private onPainted?: () => void,
	) {
		this.container.addClass("pi-learning-stream");
		this.tailEl = this.container.createDiv({ cls: "pi-learning-stream-tail" });
		this.reveal = new SmoothReveal(
			(prefix, delta) => this.ingest(prefix, delta),
			() => this.onDrained(),
		);
	}

	/** 流式期间调用：传入迄今为止的完整文本 */
	update(fullText: string): void {
		if (this.finished || this.pendingFinish !== null) return;
		this.hasStreamed = true;
		this.reveal.update(fullText);
	}

	/** 流式结束：以最终文本为准。剩余积压加速走完后定稿，避免结尾整段跳出 */
	finish(fullText: string): void {
		if (this.finished && fullText === this.source) return; // 已经定稿，重复调用无事可做
		if (this.pendingFinish !== null) {
			this.pendingFinish = fullText;
			return;
		}
		// 从未流式过（历史加载）：整段一次渲染，保留跨空行的结构（松散列表等）
		if (!this.hasStreamed) {
			this.renderAllAtOnce(fullText);
			return;
		}
		this.pendingFinish = fullText;
		this.reveal.update(fullText);
		this.reveal.hurry();
		if (this.reveal.pending === 0) this.onDrained();
	}

	/** 非流式（历史加载）：一次渲染 */
	renderAllAtOnce(fullText: string): void {
		this.finished = true;
		this.source = fullText;
		for (const s of this.stable) s.el.remove();
		this.stable = [];
		this.tailEl.empty();
		this.showCursor(false);
		const el = this.container.createDiv({ cls: "pi-learning-stream-block" });
		this.container.insertBefore(el, this.tailEl);
		this.stable.push({ text: fullText, el });
		void MarkdownRenderer.render(this.app, fullText, el, "", this.component);
	}

	get text(): string {
		return this.source;
	}

	destroy(): void {
		this.reveal.cancel();
		if (this.pendingFrame !== null) {
			cancelAnimationFrame(this.pendingFrame);
			this.pendingFrame = null;
		}
	}

	/** 揭示循环的回调：把已揭示前缀切块、追加稳定块、安排尾块重绘 */
	private ingest(prefix: string, delta: string): void {
		this.source = prefix;
		if (delta) this.recent.push({ len: delta.length, ts: performance.now() });
		const { blocks, tail } = splitBlocks(prefix);
		// 已稳定的前缀不会改变；只追加新完成的块
		for (let i = this.stable.length; i < blocks.length; i++) {
			const el = this.container.createDiv({ cls: "pi-learning-stream-block" });
			this.container.insertBefore(el, this.tailEl);
			this.stable.push({ text: blocks[i], el });
			void MarkdownRenderer.render(this.app, blocks[i], el, "", this.component);
		}
		this.tailText = tail;
		this.schedulePaint();
		if (!this.finished && this.pendingFinish === null) this.showCursor(true);
	}

	/** 揭示追平且消息已定稿：走真正的 finish */
	private onDrained(): void {
		if (this.pendingFinish === null) return;
		const fullText = this.pendingFinish;
		this.pendingFinish = null;
		this.finished = true;
		this.showCursor(false);
		if (this.pendingFrame !== null) {
			cancelAnimationFrame(this.pendingFrame);
			this.pendingFrame = null;
		}
		// 流式累积的文本应当是最终文本的前缀；否则（极少）整体重绘一次
		if (!fullText.startsWith(this.source)) {
			this.renderAllAtOnce(fullText);
			return;
		}
		this.source = fullText;
		const { blocks, tail } = splitBlocks(fullText);
		for (let i = this.stable.length; i < blocks.length; i++) {
			const el = this.container.createDiv({ cls: "pi-learning-stream-block" });
			this.container.insertBefore(el, this.tailEl);
			this.stable.push({ text: blocks[i], el });
			void MarkdownRenderer.render(this.app, blocks[i], el, "", this.component);
		}
		this.tailText = tail;
		this.paintTail(true);
	}

	private schedulePaint(): void {
		if (this.pendingFrame !== null) return;
		const due = Math.max(0, this.minIntervalMs - (performance.now() - this.lastPaint));
		const run = () => {
			this.pendingFrame = requestAnimationFrame(() => {
				this.pendingFrame = null;
				this.paintTail(false);
			});
		};
		if (due > 0) window.setTimeout(run, due);
		else run();
	}

	private paintTail(final: boolean): void {
		this.lastPaint = performance.now();
		const display = final ? this.tailText : closeOpenFence(this.tailText);
		if (display === this.lastRendered && !final) return;
		this.lastRendered = display;
		// 先渲染到离屏节点，渲染完成后一次性替换，避免清空到填充之间的空白闪烁
		const fresh = createDiv({ cls: "pi-learning-stream-tail" });
		if (display.trim()) {
			void MarkdownRenderer.render(this.app, display, fresh, "", this.component).then(() => {
				if (this.lastRendered !== display && !final) return; // 已有更新的内容在路上
				this.tailEl.replaceWith(fresh);
				this.tailEl = fresh;
				if (!final) this.applyFades(fresh);
				this.attachCursor();
				this.onPainted?.();
			});
		} else {
			this.tailEl.replaceWith(fresh);
			this.tailEl = fresh;
			this.attachCursor();
			this.onPainted?.();
		}
	}

	/** 给最近揭示的字符补渐入；重绘销毁了上一帧的动画，负 delay 让它从原相位继续 */
	private applyFades(root: HTMLElement): void {
		const now = performance.now();
		this.recent = this.recent.filter((s) => now - s.ts < FADE_MS);
		if (!this.recent.length) return;
		wrapTrailingFades(
			root,
			this.recent.map((s) => ({ len: s.len, ageMs: now - s.ts })),
		);
	}

	private showCursor(on: boolean): void {
		if (on) {
			if (!this.cursorEl) {
				this.cursorEl = createSpan({ cls: "pi-learning-cursor" });
				this.attachCursor();
			}
		} else if (this.cursorEl) {
			this.cursorEl.remove();
			this.cursorEl = null;
		}
	}

	/** 把光标挂到末尾块最后一个段落末尾（没有则挂在 tail 容器末尾） */
	private attachCursor(): void {
		if (!this.cursorEl || this.finished) return;
		const last = lastTextHost(this.tailEl) ?? this.tailEl;
		last.appendChild(this.cursorEl);
	}
}

/** 找到 tail 里最后一个可承载行内光标的元素（段落、列表项、标题等），跳过代码块 */
function lastTextHost(root: HTMLElement): HTMLElement | null {
	const candidates = root.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6, td, blockquote > p");
	let last: HTMLElement | null = null;
	candidates.forEach((c) => {
		if (!c.closest("pre")) last = c;
	});
	return last;
}
