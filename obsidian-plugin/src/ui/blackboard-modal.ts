/**
 * blackboard-modal.ts —— 黑板浏览器。
 *
 * Obsidian 的文件列表隐藏点开头的目录，且不显示 .json / .jsonl，黑板在库里因此「不可见」。
 * 这里绕开文件列表直接读项目目录：左侧文件清单（核心文件置顶），右侧内容——
 * markdown 走 Obsidian 渲染器，JSON 统一缩进美化，其余原样。只读，不提供编辑。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type App, Component, MarkdownRenderer, Modal, Notice } from "obsidian";
import { type BlackboardFile, listBlackboardFiles, prettyBlackboardText } from "../project.ts";

const MAX_SHOW = 200_000;

export class BlackboardModal extends Modal {
	/** MarkdownRenderer 需要的生命周期宿主，随弹窗开关加载 / 卸载 */
	private comp = new Component();
	private navEl!: HTMLElement;
	private contentPane!: HTMLElement;
	private files: BlackboardFile[] = [];
	private selected: string | null = null;
	private projectDir: string;

	constructor(app: App, projectDir: string) {
		super(app);
		this.projectDir = projectDir;
	}

	onOpen(): void {
		this.comp.load();
		this.modalEl.addClass("pi-learning-bb-modal");
		this.titleEl.setText("黑板");
		const { contentEl } = this;
		contentEl.empty();

		const head = contentEl.createDiv({ cls: "pi-learning-bb-head" });
		head.createSpan({ cls: "pi-learning-bb-path", text: join(this.projectDir, "blackboard") });
		const actions = head.createDiv({ cls: "pi-learning-bb-actions" });
		const refresh = actions.createEl("button", { text: "刷新" });
		refresh.addEventListener("click", () => this.reload());
		const reveal = actions.createEl("button", { text: "文件管理器" });
		reveal.addEventListener("click", () => this.revealInSystem());

		const body = contentEl.createDiv({ cls: "pi-learning-bb-body" });
		this.navEl = body.createDiv({ cls: "pi-learning-bb-nav" });
		this.contentPane = body.createDiv({ cls: "pi-learning-bb-content" });
		this.reload();
	}

	onClose(): void {
		this.comp.unload();
		this.contentEl.empty();
	}

	private reload(): void {
		this.files = listBlackboardFiles(this.projectDir);
		this.renderNav();
		const keep = this.selected && this.files.some((f) => f.rel === this.selected) ? this.selected : (this.files[0]?.rel ?? null);
		this.show(keep);
	}

	private renderNav(): void {
		this.navEl.empty();
		if (!this.files.length) {
			this.navEl.createDiv({ cls: "pi-learning-bb-nav-empty", text: "黑板目录不存在或为空。" });
			return;
		}
		for (const f of this.files) {
			const btn = this.navEl.createEl("button", { cls: "pi-learning-bb-file", attr: { title: f.rel } });
			btn.createSpan({ cls: "pi-learning-bb-file-name", text: f.rel });
			btn.createSpan({ cls: "pi-learning-bb-size", text: fmtSize(f.size) });
			btn.addEventListener("click", () => this.show(f.rel));
		}
	}

	private show(rel: string | null): void {
		this.selected = rel;
		for (const el of Array.from(this.navEl.children)) el.toggleClass("is-selected", (el as HTMLElement).getAttr("title") === rel);
		this.contentPane.empty();
		if (!rel) return;
		let raw: string;
		try {
			raw = readFileSync(join(this.projectDir, "blackboard", rel), "utf8");
		} catch (e) {
			this.contentPane.createDiv({ cls: "pi-learning-bb-muted", text: `读取失败：${(e as Error).message}` });
			return;
		}
		if (!raw.trim()) {
			this.contentPane.createDiv({ cls: "pi-learning-bb-muted", text: "（空文件）" });
			return;
		}
		let text = prettyBlackboardText(rel, raw);
		if (text.length > MAX_SHOW) text = `${text.slice(0, MAX_SHOW)}\n…（已截断，共 ${text.length} 字符）`;
		if (rel.endsWith(".md")) {
			const md = this.contentPane.createDiv({ cls: "pi-learning-bb-md markdown-rendered" });
			void MarkdownRenderer.render(this.app, text, md, "", this.comp);
		} else {
			this.contentPane.createEl("pre", { text });
		}
	}

	private revealInSystem(): void {
		try {
			// 桌面端的渲染进程带 window.require("electron")；取不到（移动端等）时提示而非报错
			const electron = (window as unknown as { require?: (m: string) => { shell?: { openPath?: (p: string) => Promise<string> } } }).require?.("electron");
			const shell = electron?.shell;
			if (shell?.openPath) void shell.openPath(join(this.projectDir, "blackboard"));
			else new Notice("当前环境无法调用系统文件管理器");
		} catch {
			new Notice("当前环境无法调用系统文件管理器");
		}
	}
}

function fmtSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
	return `${(n / 1024 / 1024).toFixed(1)} M`;
}
