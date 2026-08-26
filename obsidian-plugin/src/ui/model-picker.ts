/**
 * ui/model-picker.ts —— 两级模型选择：先选供应商，再选模型。
 *
 * 第一级按供应商列出：认证状态徽记（OAuth / API key / 未登录）、可用模型数、目录规模；
 * 已登录的排前。选中未登录的供应商即进入登录流程（见 auth.ts / auth-modals.ts），
 * 登录成功由调用方重启实例后再回来选模型。pi-ai 加载失败时退化为「仅已认证供应商」。
 */
import { type App, FuzzySuggestModal, type FuzzyMatch, Notice } from "obsidian";
import type { PiAuth, ProviderStatus } from "../auth.ts";
import { runAuthFlow } from "./auth-modals.ts";

export interface RpcModel {
	provider: string;
	id: string;
	name?: string;
}

interface ProviderRow {
	id: string;
	name: string;
	cred?: "api_key" | "oauth";
	available: RpcModel[];
	catalogCount: number;
	oauthLabel?: string;
	apiKeyLabel?: string;
}

export type ModelPickResult = { kind: "model"; provider: string; id: string } | { kind: "logged_in"; provider: string } | undefined;

/** 合并 RPC 可用模型与 pi-ai 供应商目录为第一级行 */
function providerRows(available: RpcModel[], auth?: PiAuth): ProviderRow[] {
	const byProvider = new Map<string, RpcModel[]>();
	for (const m of available) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
	const statuses: ProviderStatus[] = auth?.listProviders() ?? [];
	const rows: ProviderRow[] = statuses.map((s) => ({
		id: s.id,
		name: s.name,
		cred: s.cred,
		available: byProvider.get(s.id) ?? [],
		catalogCount: s.models.length,
		oauthLabel: s.oauthLabel,
		apiKeyLabel: s.apiKeyLabel,
	}));
	// RPC 里有、目录里没有的（models.json 自定义供应商）也要能选
	for (const [id, models] of byProvider) {
		if (!rows.some((r) => r.id === id)) rows.push({ id, name: id, cred: "api_key", available: models, catalogCount: models.length });
	}
	return rows.sort((a, b) => (b.available.length ? 1 : 0) - (a.available.length ? 1 : 0) || (b.cred ? 1 : 0) - (a.cred ? 1 : 0) || b.catalogCount - a.catalogCount || a.name.localeCompare(b.name));
}

function credText(r: ProviderRow): string {
	if (r.cred === "oauth") return "已登录 · OAuth";
	if (r.cred === "api_key") return "已登录 · API key";
	const ways = [r.oauthLabel && "OAuth", r.apiKeyLabel && "API key"].filter(Boolean);
	return ways.length ? `未登录 · 支持 ${ways.join(" / ")}` : "未登录";
}

class ProviderModal extends FuzzySuggestModal<ProviderRow> {
	constructor(
		app: App,
		private rows: ProviderRow[],
		private forLogin: boolean,
		private done: (row: ProviderRow | undefined) => void,
	) {
		super(app);
		this.setPlaceholder(forLogin ? "选择要登录的供应商…" : "选择供应商（未登录的选中即登录）…");
	}
	getItems(): ProviderRow[] {
		return this.forLogin ? this.rows.filter((r) => r.oauthLabel || r.apiKeyLabel) : this.rows;
	}
	getItemText(r: ProviderRow): string {
		return `${r.name} ${r.id}`;
	}
	renderSuggestion(match: FuzzyMatch<ProviderRow>, el: HTMLElement): void {
		const r = match.item;
		el.addClass("pi-learning-provider-item");
		const head = el.createDiv({ cls: "pi-learning-provider-head" });
		head.createSpan({ cls: "pi-learning-provider-name", text: r.name });
		head.createSpan({ cls: `pi-learning-provider-cred${r.cred ? " pi-learning-provider-cred-ok" : ""}`, text: credText(r) });
		const sub = el.createDiv({ cls: "pi-learning-provider-sub" });
		sub.setText(`${r.id} · ${r.available.length ? `${r.available.length} 个可用模型` : `目录 ${r.catalogCount} 个模型`}`);
	}
	onChooseItem(r: ProviderRow): void {
		this.done(r);
	}
	onClose(): void {
		super.onClose();
		window.setTimeout(() => this.done(undefined), 0);
	}
}

class ModelModal extends FuzzySuggestModal<RpcModel> {
	constructor(
		app: App,
		private models: RpcModel[],
		title: string,
		private done: (m: RpcModel | undefined) => void,
	) {
		super(app);
		this.setPlaceholder(title);
	}
	getItems(): RpcModel[] {
		return this.models;
	}
	getItemText(m: RpcModel): string {
		return `${m.id} ${m.name ?? ""}`;
	}
	renderSuggestion(match: FuzzyMatch<RpcModel>, el: HTMLElement): void {
		const m = match.item;
		el.createDiv({ text: m.id });
		if (m.name && m.name !== m.id) el.createDiv({ cls: "pi-learning-provider-sub", text: m.name });
	}
	onChooseItem(m: RpcModel): void {
		this.done(m);
	}
	onClose(): void {
		super.onClose();
		window.setTimeout(() => this.done(undefined), 0);
	}
}

function pickProvider(app: App, rows: ProviderRow[], forLogin: boolean): Promise<ProviderRow | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		new ProviderModal(app, rows, forLogin, (r) => {
			if (settled) return;
			settled = true;
			resolve(r);
		}).open();
	});
}

function pickModelOf(app: App, row: ProviderRow): Promise<RpcModel | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		new ModelModal(app, row.available, `${row.name} 的模型（当前可用）`, (m) => {
			if (settled) return;
			settled = true;
			resolve(m);
		}).open();
	});
}

/** 未登录供应商：选择登录方式（只有一种则直接用）并运行官方登录流程；成功返回 true */
async function loginProvider(app: App, auth: PiAuth, row: ProviderRow): Promise<boolean> {
	const ways: Array<{ kind: "oauth" | "api_key"; label: string }> = [];
	if (row.oauthLabel) ways.push({ kind: "oauth", label: row.oauthLabel });
	if (row.apiKeyLabel) ways.push({ kind: "api_key", label: `${row.apiKeyLabel}（手动粘贴）` });
	if (!ways.length) {
		new Notice(`${row.name} 没有可用的登录方式；请在终端运行 pi 并 /login，或配置环境变量。`, 8000);
		return false;
	}
	let kind = ways[0].kind;
	if (ways.length > 1) {
		const picked = await new Promise<string | undefined>((resolve) => {
			let settled = false;
			const m = new (class extends FuzzySuggestModal<{ kind: string; label: string }> {
				getItems() {
					return ways;
				}
				getItemText(w: { label: string }) {
					return w.label;
				}
				onChooseItem(w: { kind: string }) {
					if (!settled) {
						settled = true;
						resolve(w.kind);
					}
				}
				onClose() {
					super.onClose();
					window.setTimeout(() => {
						if (!settled) {
							settled = true;
							resolve(undefined);
						}
					}, 0);
				}
			})(app);
			m.setPlaceholder(`登录 ${row.name}：选择方式`);
			m.open();
		});
		if (!picked) return false;
		kind = picked as "oauth" | "api_key";
	}
	return runAuthFlow(app, `登录 ${row.name}`, (interaction) => auth.login(row.id, kind, interaction));
}

/**
 * 两级选择入口。返回选中的模型、或「刚登录完（需要重启实例）」、或 undefined（取消）。
 */
export async function pickProviderModel(app: App, opts: { available: RpcModel[]; auth?: PiAuth }): Promise<ModelPickResult> {
	const rows = providerRows(opts.available, opts.auth);
	if (!rows.length) {
		new Notice("没有可选的供应商：请在终端运行 pi 并 /login，或配置 API key 环境变量。", 8000);
		return undefined;
	}
	const row = await pickProvider(app, rows, false);
	if (!row) return undefined;
	if (row.available.length) {
		const m = await pickModelOf(app, row);
		return m ? { kind: "model", provider: m.provider, id: m.id } : undefined;
	}
	if (!opts.auth) {
		new Notice(`${row.name} 尚未登录；请在终端运行 pi 并 /login。`, 8000);
		return undefined;
	}
	const ok = await loginProvider(app, opts.auth, row);
	return ok ? { kind: "logged_in", provider: row.id } : undefined;
}

/** 设置页入口：只做登录（不选模型）。成功返回供应商 id。 */
export async function pickProviderForLogin(app: App, auth: PiAuth): Promise<string | undefined> {
	const rows = providerRows([], auth);
	const row = await pickProvider(app, rows, true);
	if (!row) return undefined;
	const ok = await loginProvider(app, auth, row);
	return ok ? row.id : undefined;
}
