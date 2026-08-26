/**
 * blackboard-modal.ts —— 黑板浏览器与编辑器。
 *
 * Obsidian 的文件列表隐藏点开头的目录，且不显示 .json / .jsonl，黑板在库里因此「不可见」。
 * 这里绕开文件列表直接读项目目录：左侧文件清单（核心文件置顶），右侧内容——
 * markdown 走 Obsidian 渲染器，JSON 统一缩进美化，其余原样。
 *
 * 编辑带护栏：JSON 保存前校验合法性；保存时核对 mtime，编辑期间被角色的工具写入过
 * 则要求二次确认（强制保存）才覆盖；超过展示上限的大文件不开编辑（截断保存会毁文件）。
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
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
	/** 编辑态：进入时的原文与 mtime（保存前校验并发写入）；null 即浏览态 */
	private editor: { rel: string; original: string; mtimeMs: number; overrideConflict: boolean } | null = null;
	private editorEl: HTMLTextAreaElement | null = null;

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

	private filePath(rel: string): string {
		return join(this.projectDir, "blackboard", rel);
	}

	private dirty(): boolean {
		return !!(this.editor && this.editorEl && this.editorEl.value !== this.editor.original);
	}

	/** 有未保存修改时拦下动作；否则顺带退出编辑态。返回 true 表示被拦 */
	private guardEditing(): boolean {
		if (this.dirty()) {
			new Notice("有未保存的修改：请先保存或取消。");
			return true;
		}
		this.editor = null;
		this.editorEl = null;
		return false;
	}

	private reload(): void {
		if (this.guardEditing()) return;
		this.files = listBlackboardFiles(this.projectDir);
		this.renderNav();
		const keep = this.selected && this.files.some((f) => f.rel === this.selected) ? this.selected : (this.files[0]?.rel ?? null);
		this.select(keep);
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
			btn.addEventListener("click", () => this.select(f.rel));
		}
	}

	private select(rel: string | null): void {
		if (rel !== this.selected && this.guardEditing()) return;
		this.selected = rel;
		for (const el of Array.from(this.navEl.children)) el.toggleClass("is-selected", (el as HTMLElement).getAttr("title") === rel);
		this.renderSelected();
	}

	private renderSelected(): void {
		// 编辑中重渲染（冲突后按钮换文案等）须保留正在输入的内容
		const pendingValue = this.editor && this.editorEl ? this.editorEl.value : null;
		this.contentPane.empty();
		this.editorEl = null;
		const rel = this.selected;
		if (!rel) return;
		let raw: string;
		try {
			raw = readFileSync(this.filePath(rel), "utf8");
		} catch (e) {
			this.contentPane.createDiv({ cls: "pi-learning-bb-muted", text: `读取失败：${(e as Error).message}` });
			return;
		}

		const bar = this.contentPane.createDiv({ cls: "pi-learning-bb-toolbar" });
		bar.createSpan({ cls: "pi-learning-bb-toolbar-name", text: rel });
		const btns = bar.createDiv({ cls: "pi-learning-bb-actions" });
		const editingThis = this.editor?.rel === rel;

		if (editingThis) {
			const save = btns.createEl("button", { cls: "mod-cta", text: this.editor!.overrideConflict ? "强制保存" : "保存" });
			save.addEventListener("click", () => this.save());
			const cancel = btns.createEl("button", { text: "取消" });
			cancel.addEventListener("click", () => {
				this.editor = null;
				this.renderSelected();
			});
			this.editorEl = this.contentPane.createEl("textarea", { cls: "pi-learning-bb-editor", attr: { spellcheck: "false" } });
			this.editorEl.value = pendingValue ?? this.editor!.original;
			return;
		}

		if (raw.length <= MAX_SHOW) {
			const edit = btns.createEl("button", { text: "编辑" });
			edit.addEventListener("click", () => {
				const st = statSync(this.filePath(rel));
				// JSON 以美化后的形态进编辑器；保存的就是编辑器里的文本
				this.editor = { rel, original: prettyBlackboardText(rel, raw), mtimeMs: st.mtimeMs, overrideConflict: false };
				this.renderSelected();
			});
		}

		if (!raw.trim()) {
			this.contentPane.createDiv({ cls: "pi-learning-bb-muted", text: "（空文件）" });
			return;
		}
		let text = prettyBlackboardText(rel, raw);
		if (text.length > MAX_SHOW) text = `${text.slice(0, MAX_SHOW)}\n…（已截断，共 ${text.length} 字符；过大的文件不提供编辑）`;
		if (rel.endsWith(".md")) {
			const md = this.contentPane.createDiv({ cls: "pi-learning-bb-md markdown-rendered" });
			void MarkdownRenderer.render(this.app, text, md, "", this.comp);
		} else {
			this.contentPane.createEl("pre", { text });
		}
	}

	private save(): void {
		if (!this.editor || !this.editorEl) return;
		const { rel } = this.editor;
		const value = this.editorEl.value;
		if (rel.endsWith(".json")) {
			try {
				JSON.parse(value);
			} catch (e) {
				new Notice(`不是合法 JSON，未保存：${(e as Error).message}`, 8000);
				return;
			}
		}
		try {
			const st = statSync(this.filePath(rel));
			if (st.mtimeMs !== this.editor.mtimeMs && !this.editor.overrideConflict) {
				this.editor.overrideConflict = true;
				new Notice("文件在你编辑期间被写入（可能是某个角色的工具）。确认要覆盖就再点「强制保存」。", 10000);
				this.renderSelected();
				return;
			}
			writeFileSync(this.filePath(rel), value, "utf8");
		} catch (e) {
			new Notice(`保存失败：${(e as Error).message}`, 8000);
			return;
		}
		new Notice("已保存。各实例下一回合读黑板时即见新内容。");
		this.editor = null;
		this.editorEl = null;
		this.reload();
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
