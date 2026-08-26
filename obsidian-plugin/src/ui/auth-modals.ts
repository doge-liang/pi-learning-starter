/**
 * ui/auth-modals.ts —— pi-ai 登录交互协议（AuthInteraction）的 Obsidian 驱动器。
 *
 * 一个登录流程 = 一个常驻模态框：事件（说明、OAuth 链接、设备码、进度）追加显示，
 * 提问（文本 / 密钥 / 选择 / 回填授权码）在框内就地渲染输入行。关闭模态框即中止整个流程。
 * 密钥输入用 password 框，值只交给 pi-ai 的官方流程，不落日志、不回显。
 */
import { type App, Modal, Setting } from "obsidian";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "../auth.ts";

class AuthFlowModal extends Modal {
	private logEl!: HTMLElement;
	private promptEl!: HTMLElement;
	private abort = new AbortController();
	/** 流程结束前关闭模态框 → 中止登录 */
	private finished = false;

	constructor(
		app: App,
		private title: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.addClass("pi-learning-modal");
		this.logEl = this.contentEl.createDiv({ cls: "pi-learning-auth-log" });
		this.promptEl = this.contentEl.createDiv();
	}

	onClose(): void {
		if (!this.finished) this.abort.abort(new Error("登录已取消。"));
		this.contentEl.empty();
	}

	finish(): void {
		this.finished = true;
		this.close();
	}

	/** 流程抛错时区分「用户关闭 / 取消」与真实失败：中止信号已触发即视为取消 */
	abortedByClose(_e: unknown): boolean {
		return this.abort.signal.aborted;
	}

	interaction(): AuthInteraction {
		return {
			signal: this.abort.signal,
			notify: (e) => this.renderEvent(e),
			prompt: (p) => this.renderPrompt(p),
		};
	}

	private renderEvent(e: AuthEvent): void {
		switch (e.type) {
			case "info": {
				const row = this.logEl.createDiv({ cls: "pi-learning-auth-info" });
				row.createSpan({ text: e.message });
				for (const l of e.links ?? []) {
					row.createSpan({ text: " " });
					row.createEl("a", { text: l.label ?? l.url, attr: { href: l.url } });
				}
				break;
			}
			case "progress":
				this.logEl.createDiv({ cls: "pi-learning-auth-progress pi-learning-dots", text: e.message });
				break;
			case "auth_url": {
				const row = this.logEl.createDiv({ cls: "pi-learning-auth-url" });
				row.createDiv({ text: e.instructions ?? "在浏览器中完成授权：" });
				const btn = row.createEl("button", { cls: "mod-cta", text: "打开授权页面" });
				btn.addEventListener("click", () => window.open(e.url));
				row.createEl("a", { cls: "pi-learning-auth-link", text: e.url, attr: { href: e.url } });
				window.open(e.url);
				break;
			}
			case "device_code": {
				const row = this.logEl.createDiv({ cls: "pi-learning-auth-device" });
				row.createDiv({ text: `打开 ${e.verificationUri} 并输入验证码：` });
				row.createDiv({ cls: "pi-learning-auth-code", text: e.userCode });
				const btn = row.createEl("button", { cls: "mod-cta", text: "打开验证页面" });
				btn.addEventListener("click", () => window.open(e.verificationUri));
				window.open(e.verificationUri);
				break;
			}
		}
	}

	private renderPrompt(p: AuthPrompt): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			this.promptEl.empty();
			let settled = false;
			const done = (v: string | undefined, err?: Error) => {
				if (settled) return;
				settled = true;
				this.promptEl.empty();
				if (v !== undefined) resolve(v);
				else reject(err ?? new Error("已取消。"));
			};
			const onAbort = () => done(undefined, new Error("登录已取消。"));
			this.abort.signal.addEventListener("abort", onAbort, { once: true });
			p.signal?.addEventListener("abort", onAbort, { once: true });

			this.promptEl.createDiv({ cls: "pi-learning-auth-prompt-msg", text: p.message });
			if (p.type === "select") {
				for (const opt of p.options ?? []) {
					const row = this.promptEl.createEl("button", { cls: "pi-learning-auth-option" });
					row.createDiv({ cls: "pi-learning-auth-option-label", text: opt.label });
					if (opt.description) row.createDiv({ cls: "pi-learning-auth-option-desc", text: opt.description });
					row.addEventListener("click", () => done(opt.id));
				}
				return;
			}
			const input = this.promptEl.createEl("input", {
				type: p.type === "secret" ? "password" : "text",
				cls: "pi-learning-input",
				attr: { placeholder: p.placeholder ?? "", autocomplete: "off", spellcheck: "false" },
			});
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					done(input.value);
				}
			});
			new Setting(this.promptEl).addButton((b) =>
				b
					.setButtonText("确定")
					.setCta()
					.onClick(() => done(input.value)),
			);
			window.setTimeout(() => input.focus(), 0);
		});
	}
}

/**
 * 运行一个登录流程：打开常驻模态框，把 interaction 交给 run；成功返回 true。
 * 取消（关闭模态框）返回 false；其余错误向上抛。
 */
export async function runAuthFlow(app: App, title: string, run: (interaction: AuthInteraction) => Promise<void>): Promise<boolean> {
	const modal = new AuthFlowModal(app, title);
	modal.open();
	try {
		await run(modal.interaction());
		return true;
	} catch (e) {
		if (modal.abortedByClose(e)) return false;
		throw e;
	} finally {
		modal.finish();
	}
}
