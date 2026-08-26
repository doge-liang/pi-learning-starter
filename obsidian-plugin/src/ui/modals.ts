/**
 * ui/modals.ts —— 扩展 UI 子协议在 Obsidian 里的落地：
 * confirm → 确认框；select → 模糊选择；input → 单行输入；editor → 多行编辑器。
 * 每个都返回 Promise，关闭即视为取消（扩展收到 undefined / false）。
 */
import { type App, Component, FuzzySuggestModal, MarkdownRenderer, Modal, Setting } from "obsidian";

export function confirmModal(app: App, title: string, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: boolean) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const m = new (class extends Modal {
			onOpen() {
				this.titleEl.setText(title);
				this.contentEl.addClass("pi-learning-modal");
				const body = this.contentEl.createDiv({ cls: "pi-learning-modal-body" });
				body.setText(message);
				new Setting(this.contentEl)
					.addButton((b) =>
						b.setButtonText("取消").onClick(() => {
							done(false);
							this.close();
						}),
					)
					.addButton((b) =>
						b
							.setButtonText("确认")
							.setCta()
							.onClick(() => {
								done(true);
								this.close();
							}),
					);
				this.scope.register([], "Enter", () => {
					done(true);
					this.close();
					return false;
				});
			}
			onClose() {
				done(false);
				this.contentEl.empty();
			}
		})(app);
		m.open();
	});
}

export function inputModal(app: App, title: string, placeholder = "", initial = ""): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const m = new (class extends Modal {
			value = initial;
			onOpen() {
				this.titleEl.setText(title);
				this.contentEl.addClass("pi-learning-modal");
				const input = this.contentEl.createEl("input", { type: "text", cls: "pi-learning-input", attr: { placeholder } });
				input.value = initial;
				input.addEventListener("input", () => (this.value = input.value));
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						done(this.value);
						this.close();
					}
				});
				new Setting(this.contentEl)
					.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
					.addButton((b) =>
						b
							.setButtonText("确定")
							.setCta()
							.onClick(() => {
								done(this.value);
								this.close();
							}),
					);
				window.setTimeout(() => input.focus(), 0);
			}
			onClose() {
				done(undefined);
				this.contentEl.empty();
			}
		})(app);
		m.open();
	});
}

/** 多行编辑器：Ctrl/Cmd+Enter 保存，Esc 取消。
 * 标题很长或多行时（闭卷作答的整道题干走这里），标题行只留首行缩略，全文渲染为正文——
 * 题干里的代码块、公式、列表照常排版。 */
export function editorModal(app: App, title: string, prefill = ""): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const comp = new Component();
		const m = new (class extends Modal {
			onOpen() {
				comp.load();
				this.modalEl.addClass("pi-learning-editor-modal");
				const firstLine = title.split("\n")[0].trim();
				const compact = firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
				const longTitle = compact !== title.trim();
				this.titleEl.setText(compact);
				this.contentEl.addClass("pi-learning-modal");
				if (longTitle) {
					const prompt = this.contentEl.createDiv({ cls: "pi-learning-modal-prompt markdown-rendered" });
					void MarkdownRenderer.render(app, title, prompt, "", comp);
				}
				const ta = this.contentEl.createEl("textarea", { cls: "pi-learning-editor" });
				ta.value = prefill;
				ta.addEventListener("keydown", (e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
						e.preventDefault();
						done(ta.value);
						this.close();
					}
				});
				const foot = new Setting(this.contentEl).setDesc("Ctrl+Enter 保存，Esc 取消");
				foot.addButton((b) => b.setButtonText("取消").onClick(() => this.close()));
				foot.addButton((b) =>
					b
						.setButtonText("保存")
						.setCta()
						.onClick(() => {
							done(ta.value);
							this.close();
						}),
				);
				window.setTimeout(() => {
					ta.focus();
					ta.setSelectionRange(ta.value.length, ta.value.length);
				}, 0);
			}
			onClose() {
				comp.unload();
				done(undefined);
				this.contentEl.empty();
			}
		})(app);
		m.open();
	});
}

export function selectModal(app: App, title: string, options: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (v: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
		const m = new (class extends FuzzySuggestModal<string> {
			getItems() {
				return options;
			}
			getItemText(item: string) {
				return item;
			}
			onChooseItem(item: string) {
				done(item);
			}
			onClose() {
				super.onClose();
				// onChooseItem 先于 onClose 触发；未选择而关闭即取消
				window.setTimeout(() => done(undefined), 0);
			}
		})(app);
		m.setPlaceholder(title);
		m.open();
	});
}
