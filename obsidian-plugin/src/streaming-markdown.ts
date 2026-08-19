/**
 * streaming-markdown.ts —— 用 Obsidian 自带的 MarkdownRenderer 做增量流式渲染。
 *
 * 思路：把已到达的文本切成"已完成的块"与"末尾未完成的块"。块的边界是围栏代码之外的空行。
 * 已完成的块只渲染一次并固定在 DOM 里；每次增量只重绘末尾块，并对其中未闭合的代码围栏临时补全。
 * 这样既保留 Obsidian 的渲染保真度（主题、数学、代码高亮、callout、wikilink），又没有整段重绘的闪烁。
 */
import { type App, type Component, MarkdownRenderer } from "obsidian";
import { closeOpenFence, splitBlocks } from "./markdown-blocks.ts";

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
	/** 源文本；finish 时用于校验与全量重绘 */
	private source = "";

	constructor(
		private app: App,
		private component: Component,
		private container: HTMLElement,
		private minIntervalMs = 60,
	) {
		this.container.addClass("pi-learning-stream");
		this.tailEl = this.container.createDiv({ cls: "pi-learning-stream-tail" });
	}

	/** 流式期间调用：传入迄今为止的完整文本 */
	update(fullText: string): void {
		if (this.finished) return;
		this.hasStreamed = true;
		this.source = fullText;
		const { blocks, tail } = splitBlocks(fullText);
		// 已稳定的前缀不会改变；只追加新完成的块
		for (let i = this.stable.length; i < blocks.length; i++) {
			const el = this.container.createDiv({ cls: "pi-learning-stream-block" });
			this.container.insertBefore(el, this.tailEl);
			this.stable.push({ text: blocks[i], el });
			void MarkdownRenderer.render(this.app, blocks[i], el, "", this.component);
		}
		this.tailText = tail;
		this.schedulePaint();
		this.showCursor(true);
	}

	/** 流式结束：以最终文本为准。若与流式累积不一致则整体重绘一次 */
	finish(fullText: string): void {
		if (this.finished && fullText === this.source) return; // 已经定稿，重复调用无事可做
		// 从未流式过（历史加载）：整段一次渲染，保留跨空行的结构（松散列表等）
		if (!this.hasStreamed) {
			this.renderAllAtOnce(fullText);
			return;
		}
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
				this.attachCursor();
			});
		} else {
			this.tailEl.replaceWith(fresh);
			this.tailEl = fresh;
			this.attachCursor();
		}
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
