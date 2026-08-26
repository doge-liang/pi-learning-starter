/**
 * session-tree-modal.ts —— 会话树。
 *
 * pi 的回滚（fork）把根到落点的路径抄成新会话文件，头部 parentSession 指向旧文件：
 * 分支结构因此体现在会话文件之间。这里把项目的全部会话按派生关系画成森林，
 * 标注各实例当前所在的会话线；点击任意一条线即可把当前实例切换过去（旧线永不丢失）。
 */
import { type App, Modal, Notice } from "obsidian";
import { buildSessionTree, describeSession, listSessions, type SessionTreeNode } from "../sessions.ts";
import { resolve } from "node:path";

/** 一个实例的落点标注：当前所在会话文件与是否为活跃页签 */
export interface InstanceMark {
	label: string;
	glyph: string;
	hue: number;
	file?: string;
	active: boolean;
}

export class SessionTreeModal extends Modal {
	private bodyEl!: HTMLElement;
	private projectDir: string;
	private marks: () => InstanceMark[];
	private onPick: (path: string) => Promise<void>;
	private activeLabel: () => string;

	constructor(app: App, projectDir: string, marks: () => InstanceMark[], onPick: (path: string) => Promise<void>, activeLabel: () => string) {
		super(app);
		this.projectDir = projectDir;
		this.marks = marks;
		this.onPick = onPick;
		this.activeLabel = activeLabel;
	}

	onOpen(): void {
		this.modalEl.addClass("pi-learning-tree-modal");
		this.titleEl.setText("会话树");
		const { contentEl } = this;
		contentEl.empty();
		const head = contentEl.createDiv({ cls: "pi-learning-tree-head" });
		head.createSpan({ cls: "pi-learning-tree-hint", text: "缩进表示回滚（fork）产生的分支；点击一条会话线，把当前实例切换过去。旧线始终保留。" });
		const refresh = head.createEl("button", { text: "刷新" });
		refresh.addEventListener("click", () => this.render());
		this.bodyEl = contentEl.createDiv({ cls: "pi-learning-tree-body" });
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.bodyEl.empty();
		const sessions = listSessions(this.projectDir);
		if (!sessions.length) {
			this.bodyEl.createDiv({ cls: "pi-learning-tree-empty", text: "本项目还没有会话。" });
			return;
		}
		const marksByFile = new Map<string, InstanceMark[]>();
		for (const m of this.marks()) {
			if (!m.file) continue;
			const key = resolve(m.file);
			marksByFile.set(key, [...(marksByFile.get(key) ?? []), m]);
		}
		const renderNode = (node: SessionTreeNode, depth: number) => {
			const row = this.bodyEl.createDiv({ cls: "pi-learning-tree-row" });
			row.style.setProperty("--pi-tree-depth", String(depth));
			if (depth > 0) row.createSpan({ cls: "pi-learning-tree-elbow", text: "└" });
			const btn = row.createEl("button", { cls: "pi-learning-tree-node", attr: { title: node.session.path } });
			const title = btn.createDiv({ cls: "pi-learning-tree-title" });
			title.createSpan({ text: node.session.name ?? (node.session.firstMessage || "（空会话）") });
			const here = marksByFile.get(resolve(node.session.path)) ?? [];
			for (const m of here) {
				const chip = title.createSpan({ cls: "pi-learning-glyph pi-learning-tree-chip", text: m.glyph, attr: { title: `${m.label} 当前所在` } });
				chip.style.setProperty("--pi-role-h", String(m.hue));
				if (m.active) chip.addClass("is-active");
			}
			btn.createDiv({ cls: "pi-learning-tree-meta", text: describeSession(node.session) });
			btn.addEventListener("click", () => void this.pick(node.session.path));
			for (const c of node.children) renderNode(c, depth + 1);
		};
		for (const root of buildSessionTree(sessions)) renderNode(root, 0);
	}

	private async pick(path: string): Promise<void> {
		try {
			await this.onPick(path);
			new Notice(`已把「${this.activeLabel()}」切到该会话线。`);
		} catch (e) {
			new Notice((e as Error).message, 8000);
		}
		this.render(); // 徽章跟着实例挪
	}
}
