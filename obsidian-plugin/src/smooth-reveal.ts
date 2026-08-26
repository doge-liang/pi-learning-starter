/**
 * smooth-reveal.ts —— 流式文本的匀速揭示与渐入。
 *
 * RPC 增量按网络批次到达，直接上屏会整句整段地蹦出来。这里加一层缓冲：
 * 收到的全文只作为「目标」，实际显示的前缀由 rAF 循环按积压量自适应地匀速推进；
 * 每一步新揭示的字符区间被记录下来，渲染层据此给这些字符加短促的透明度渐入，
 * 动画相位取自揭示时刻（负 animation-delay），因此尾块整体重绘不会打断渐入。
 * 步进速率与切点计算是纯函数，可在 Node 里测试。
 */

/** 常速下限：低于此值的推进在中文阅读节奏下会显得拖沓 */
export const MIN_CPS = 90;
/** 速率上限：历史追赶、大段粘贴时避免长时间空转 */
export const MAX_CPS = 6000;
/** 追平时限（秒）：速率 ≈ 积压 / CATCHUP_S，积压越多走得越快 */
export const CATCHUP_S = 0.45;
/** 定稿加速：消息结束时把剩余积压在约 120ms 内走完，而不是瞬间跳出 */
export const HURRY_CATCHUP_S = 0.12;
export const HURRY_MIN_CPS = 600;
/** 渐入动画时长（毫秒），与 styles.css 的 pi-learning-fresh-in 保持一致 */
export const FADE_MS = 260;

/** 本帧应推进的字符数（可为小数，由调用方累积取整） */
export function revealStep(backlog: number, dtMs: number, hurry = false): number {
	const minCps = hurry ? HURRY_MIN_CPS : MIN_CPS;
	const catchup = hurry ? HURRY_CATCHUP_S : CATCHUP_S;
	const rate = Math.min(MAX_CPS, Math.max(minCps, backlog / catchup));
	return (rate * dtMs) / 1000;
}

/** UTF-16 代理对安全的切点：切在高位代理后面会劈开 emoji，向前退一格 */
export function safeCut(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const c = text.charCodeAt(end - 1);
	return c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
}

/** 一次揭示的字符段：长度与揭示时刻（performance.now()） */
export interface RevealSegment {
	len: number;
	ts: number;
}

export class SmoothReveal {
	private target = "";
	private shown = 0;
	/** 步进的小数累积，保证低速率下也能均匀走字 */
	private fraction = 0;
	private raf: number | null = null;
	private lastTs = 0;
	private hurried = false;
	private onText: (prefix: string, delta: string) => void;
	private onIdle?: () => void;

	constructor(onText: (prefix: string, delta: string) => void, onIdle?: () => void) {
		this.onText = onText;
		this.onIdle = onIdle;
	}

	/** 流式期间调用：传入迄今为止的完整目标文本 */
	update(fullText: string): void {
		// 已揭示的前缀被改写（text_end 归一化等罕见情形）：放弃平滑，直接对齐
		if (!fullText.startsWith(this.target.slice(0, this.shown))) {
			this.target = fullText;
			this.shown = fullText.length;
			this.fraction = 0;
			this.onText(fullText, "");
			this.onIdle?.();
			return;
		}
		this.target = fullText;
		this.schedule();
	}

	/** 定稿加速：以更高速率走完剩余积压，追平后触发 onIdle */
	hurry(): void {
		this.hurried = true;
		this.schedule();
	}

	cancel(): void {
		if (this.raf !== null) cancelAnimationFrame(this.raf);
		this.raf = null;
	}

	get pending(): number {
		return this.target.length - this.shown;
	}

	private schedule(): void {
		if (this.raf !== null || this.pending <= 0) return;
		this.lastTs = performance.now();
		const loop = (ts: number) => {
			this.raf = null;
			// 页签失焦等原因 rAF 暂停很久时，别把暂停时长折成一次巨幅跳进
			const dt = Math.min(100, Math.max(0, ts - this.lastTs));
			this.lastTs = ts;
			this.fraction += revealStep(this.pending, dt, this.hurried);
			const step = Math.floor(this.fraction);
			this.fraction -= step;
			if (step > 0) {
				const next = safeCut(this.target, Math.min(this.target.length, this.shown + step));
				if (next > this.shown) {
					const prefix = this.target.slice(0, next);
					const delta = this.target.slice(this.shown, next);
					this.shown = next;
					this.onText(prefix, delta);
				}
			}
			if (this.pending > 0) this.raf = requestAnimationFrame(loop);
			else this.onIdle?.();
		};
		this.raf = requestAnimationFrame(loop);
	}
}

/**
 * 给最近揭示的字符补渐入：从最后一个文本节点向前，按段把尾部字符包进
 * span.pi-learning-fresh，animation-delay 取负的段龄使动画从正确相位继续。
 * 渲染源字符数与可见字符数并不一一对应（markdown 语法字符被渲染吃掉），
 * 按「末尾 N 个可见字符」近似即可，误差只影响渐入范围的边缘。
 */
export function wrapTrailingFades(root: HTMLElement, segments: Array<{ len: number; ageMs: number }>): void {
	if (!segments.length) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	while (walker.nextNode()) nodes.push(walker.currentNode as Text);
	let ni = nodes.length - 1;
	for (let si = segments.length - 1; si >= 0 && ni >= 0; si--) {
		let need = segments[si].len;
		while (need > 0 && ni >= 0) {
			const node = nodes[ni];
			const text = node.data;
			if (!text.length) {
				ni--;
				continue;
			}
			const cut = safeCut(text, Math.max(0, text.length - need));
			const take = text.length - cut;
			if (take <= 0) {
				ni--;
				continue;
			}
			const span = document.createElement("span");
			span.className = "pi-learning-fresh";
			span.style.animationDelay = `-${Math.round(segments[si].ageMs)}ms`;
			span.textContent = text.slice(cut);
			if (cut > 0) {
				node.data = text.slice(0, cut);
				node.after(span); // 紧跟在残余文本后，仍在更新段落的 span 之前，顺序自然正确
			} else {
				node.replaceWith(span);
				ni--;
			}
			need -= take;
		}
	}
}

/**
 * 纯文本宿主（思考 <pre>）的匀速揭示：定稿部分放开头的文本节点，
 * 新揭示的文字按段追加渐入 span，段多了并回定稿节点；末尾维持一枚闪烁光标，
 * 且在内容超高时自动贴底（除非使用者已向上滚动）。
 */
export class SmoothPlainText {
	private host: HTMLElement;
	private settled: Text;
	private spans: HTMLSpanElement[] = [];
	private cursor: HTMLElement;
	private reveal: SmoothReveal;
	private done = false;
	private finalText = "";
	private lastStick = 0;

	constructor(host: HTMLElement) {
		this.host = host;
		this.settled = document.createTextNode("");
		host.appendChild(this.settled);
		this.cursor = document.createElement("span");
		this.cursor.className = "pi-learning-cursor";
		this.reveal = new SmoothReveal((prefix, delta) => this.apply(prefix, delta));
	}

	update(full: string): void {
		if (this.done) return;
		if (!this.cursor.isConnected) this.host.appendChild(this.cursor);
		this.reveal.update(full);
	}

	finish(full: string): void {
		if (this.done && full === this.finalText) return;
		this.done = true;
		this.finalText = full;
		this.reveal.cancel();
		for (const s of this.spans) s.remove();
		this.spans = [];
		this.settled.data = full;
		this.cursor.remove();
	}

	destroy(): void {
		this.reveal.cancel();
	}

	private apply(prefix: string, delta: string): void {
		if (delta) {
			const span = document.createElement("span");
			span.className = "pi-learning-fresh";
			span.textContent = delta;
			this.host.insertBefore(span, this.cursor.isConnected ? this.cursor : null);
			this.spans.push(span);
			if (this.spans.length > 48) this.consolidate();
		} else {
			// 目标被改写：直接对齐
			for (const s of this.spans) s.remove();
			this.spans = [];
			this.settled.data = prefix;
		}
		this.stick();
	}

	/** 渐入早已结束的旧 span 并回定稿节点，避免 DOM 无限增长 */
	private consolidate(): void {
		const keep = 12;
		const merge = this.spans.splice(0, this.spans.length - keep);
		let text = "";
		for (const s of merge) {
			text += s.textContent ?? "";
			s.remove();
		}
		this.settled.data += text;
	}

	private stick(): void {
		// 读 scrollHeight 会强制同步布局，逐帧读会拖垮主线程：节流到人眼跟得上的频率
		const now = performance.now();
		if (now - this.lastStick < 150) return;
		this.lastStick = now;
		const h = this.host;
		if (h.scrollHeight - h.scrollTop - h.clientHeight < 48) h.scrollTop = h.scrollHeight;
	}
}
