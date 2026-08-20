/**
 * library.test.ts —— 馆藏的三个执行面：下载、Zotero 入库、网盘入库。
 *
 * 全部用注入的 fetch 与临时目录，不触网、不调用模型；断言的是请求序列、落盘位置与字段映射。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Source } from "../.pi/extensions/learning/blackboard.ts";
import { secret } from "../.pi/extensions/learning/config.ts";
import { download, downloadableUrl, withTimeout } from "../.pi/extensions/learning/library.ts";
import { pushToRemote, remoteRelPath } from "../.pi/extensions/learning/remote.ts";
import { saveToZotero, toCslJson, toZoteroItem } from "../.pi/extensions/learning/zotero.ts";

const SOURCE: Source = {
	id: "prml-ch5",
	title: "Pattern Recognition and Machine Learning, Ch. 5",
	type: "textbook",
	locator: "Bishop, 2006, ch. 5.3",
	covers: ["backward"],
	for_units: ["u02"],
	est_minutes: 120,
	quality_note: "反向传播的标准推导",
	access: "open",
	tags: ["教材"],
	meta: { authors: ["Christopher M. Bishop"], year: 2006, publisher: "Springer", isbn: "978-0387310732", url: "https://example.invalid/prml.pdf" },
};

/** 记录每次调用的假 fetch；responses 按顺序消费，用尽后回落到 200 空响应 */
function fakeFetch(responses: Array<Response | (() => Response)>) {
	const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
		const next = responses.shift();
		return typeof next === "function" ? next() : (next ?? new Response(null, { status: 200 }));
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("馆藏：题录映射", () => {
	it("toZoteroItem 按资料类型映射条目类型，并把 pi-learning 的 id 写进 extra", () => {
		const item = toZoteroItem(SOURCE, "COLL1234");
		assert.equal(item.itemType, "book");
		assert.equal(item.title, SOURCE.title);
		assert.deepEqual(item.creators, [{ creatorType: "author", name: "Christopher M. Bishop" }]);
		assert.equal(item.date, "2006");
		assert.equal(item.publisher, "Springer");
		assert.equal(item.ISBN, "978-0387310732");
		assert.match(item.extra ?? "", /pi-learning-source: prml-ch5/);
		assert.match(item.extra ?? "", /pi-learning-units: u02/);
		assert.deepEqual(item.tags, [{ tag: "教材" }, { tag: "concept:backward" }]);
		assert.deepEqual(item.collections, ["COLL1234"]);
		assert.equal(toZoteroItem({ ...SOURCE, type: "paper" }).itemType, "journalArticle");
		assert.equal(toZoteroItem({ ...SOURCE, type: undefined }).itemType, "document", "类型缺失时退到 document");
	});

	it("toCslJson 用 CSL 的字段名，缺失的字段一律不写出", () => {
		const csl = toCslJson(SOURCE);
		assert.equal(csl.type, "book");
		assert.deepEqual(csl.author, [{ literal: "Christopher M. Bishop" }]);
		assert.deepEqual(csl.issued, { "date-parts": [[2006]] });
		assert.equal(csl.ISBN, "978-0387310732");
		assert.equal(csl.URL, "https://example.invalid/prml.pdf");
		assert.equal("container-title" in csl, false, "没有 container 就不写 container-title");
		assert.match(String(csl.note), /定位：Bishop, 2006, ch. 5.3/);
	});

	it("secret 解析 env: 前缀；未设置的变量按未配置处理", () => {
		process.env.PI_LEARNING_TEST_KEY = "abc123";
		assert.equal(secret("env:PI_LEARNING_TEST_KEY"), "abc123");
		assert.equal(secret("env:PI_LEARNING_TEST_MISSING"), undefined);
		assert.equal(secret("literal"), "literal");
		assert.equal(secret(undefined), undefined);
		delete process.env.PI_LEARNING_TEST_KEY;
	});
});

describe("馆藏：下载", () => {
	let cwd = "";
	before(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-learning-lib-"));
	});
	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("downloadableUrl 的优先级：meta.url → locator 里的 URL → DOI；付费与纸质不给直链", () => {
		assert.equal(downloadableUrl(SOURCE), "https://example.invalid/prml.pdf");
		assert.equal(downloadableUrl({ ...SOURCE, meta: {}, locator: "https://cs231n.github.io/x/" }), "https://cs231n.github.io/x/");
		assert.equal(downloadableUrl({ ...SOURCE, meta: { doi: "10.1000/xyz" } }), "https://doi.org/10.1000/xyz");
		assert.equal(downloadableUrl({ ...SOURCE, meta: {}, locator: "Bishop, 2006, ch. 5" }), undefined);
		assert.equal(downloadableUrl({ ...SOURCE, access: "campus" }), "https://example.invalid/prml.pdf");
		assert.equal(downloadableUrl({ ...SOURCE, access: undefined }), "https://example.invalid/prml.pdf");
		for (const access of ["paid", "physical", "unavailable"] as const) {
			assert.equal(downloadableUrl({ ...SOURCE, access }), undefined, access);
		}
	});

	it("后缀依次取自 Content-Disposition、URL 路径、Content-Type", async () => {
		const cases: Array<[Record<string, string>, string, string]> = [
			[{ "content-type": "application/pdf", "content-disposition": 'attachment; filename="bishop-ch5.pdf"' }, "https://x.invalid/download?id=7", ".pdf"],
			[{ "content-type": "application/octet-stream" }, "https://x.invalid/notes.epub", ".epub"],
			[{ "content-type": "text/html" }, "https://x.invalid/page", ".html"],
			[{ "content-type": "application/octet-stream" }, "https://x.invalid/page", ".bin"],
		];
		for (const [headers, url, ext] of cases) {
			const { impl } = fakeFetch([new Response("body", { status: 200, headers })]);
			const d = await download(url, { cwd, id: "s1", fetchImpl: impl });
			assert.equal(d.rel, `blackboard/library/s1${ext}`, url);
			assert.ok(existsSync(d.abs));
		}
	});

	it("HTML 响应标记为可能的落地页；非 http 与超限直接拒绝", async () => {
		const { impl } = fakeFetch([new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } })]);
		assert.equal((await download("https://x.invalid/p", { cwd, id: "s2", fetchImpl: impl })).looksLikeLandingPage, true);

		await assert.rejects(download("ftp://x.invalid/a.pdf", { cwd, id: "s3" }), /只支持 http\/https/);

		const big = fakeFetch([new Response("x", { status: 200, headers: { "content-type": "application/pdf", "content-length": String(200 * 1024 * 1024) } })]);
		await assert.rejects(download("https://x.invalid/big.pdf", { cwd, id: "s4", fetchImpl: big.impl }), /超过上限/);

		const bad = fakeFetch([new Response(null, { status: 403, statusText: "Forbidden" })]);
		await assert.rejects(download("https://x.invalid/paywall.pdf", { cwd, id: "s5", fetchImpl: bad.impl }), /HTTP 403/);
	});

	it("withTimeout 到点自行中止，也透传外部中止", async () => {
		const t = withTimeout(10);
		await new Promise((done) => setTimeout(done, 40));
		assert.equal(t.signal.aborted, true);
		assert.match(String((t.signal.reason as Error).message), /请求超时/);
		t.done();

		const outer = new AbortController();
		const t2 = withTimeout(60_000, outer.signal);
		assert.equal(t2.signal.aborted, false);
		outer.abort(new Error("会话中止"));
		assert.equal(t2.signal.aborted, true);
		t2.done();
	});
});

describe("馆藏：Zotero 入库", () => {
	let cwd = "";
	before(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-learning-zot-"));
	});
	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("file 模式（默认）写出 CSL-JSON，不发任何请求", async () => {
		const { impl, calls } = fakeFetch([]);
		const r = await saveToZotero(SOURCE, { cwd, fetchImpl: impl });
		assert.equal(r.mode, "file");
		assert.equal(r.file, "blackboard/library/zotero/prml-ch5.json");
		assert.deepEqual(calls, []);
		const parsed = JSON.parse(readFileSync(join(cwd, r.file ?? ""), "utf8"));
		assert.equal(parsed[0].id, "prml-ch5");
	});

	it("connector 模式打本地端点；连接不上时报出可操作的原因", async () => {
		const ok = fakeFetch([new Response("[]", { status: 201 })]);
		const r = await saveToZotero(SOURCE, { cwd, cfg: { mode: "connector" }, fetchImpl: ok.impl });
		assert.equal(r.mode, "connector");
		assert.equal(ok.calls[0].url, "http://127.0.0.1:23119/connector/saveItems");
		assert.equal(ok.calls[0].headers["X-Zotero-Connector-API-Version"], "2");
		const body = JSON.parse(String(ok.calls[0].body));
		assert.equal(body.items[0].itemType, "book");
		assert.deepEqual(body.items[0].attachments, [{ title: SOURCE.title, url: SOURCE.meta?.url }]);

		const down = fakeFetch([new Response(null, { status: 503 })]);
		await assert.rejects(saveToZotero(SOURCE, { cwd, cfg: { mode: "connector" }, fetchImpl: down.impl }), /Zotero 桌面端正在运行/);
	});

	it("web 模式：建条目后按三步流程上传附件", async () => {
		process.env.PI_LEARNING_ZOTERO_KEY = "test-key";
		const local = join(cwd, "prml.pdf");
		writeFileSync(local, "PDF BYTES", "utf8");
		const { impl, calls } = fakeFetch([
			new Response(JSON.stringify({ successful: { 0: { key: "ITEM1" } } }), { status: 200 }),
			new Response(JSON.stringify({ successful: { 0: { key: "ATT1" } } }), { status: 200 }),
			new Response(JSON.stringify({ url: "https://storage.invalid/put", contentType: "multipart/form-data", prefix: "P", suffix: "S", uploadKey: "UP1" }), { status: 200 }),
			new Response(null, { status: 201 }),
			new Response(null, { status: 204 }),
		]);
		const r = await saveToZotero(SOURCE, {
			cwd,
			cfg: { mode: "web", user_id: "42", api_key: "env:PI_LEARNING_ZOTERO_KEY" },
			localAbs: local,
			fetchImpl: impl,
		});
		assert.equal(r.mode, "web");
		assert.equal(r.key, "ITEM1");
		assert.match(r.message, /附件 prml.pdf 已上传/);
		assert.deepEqual(
			calls.map((c) => c.url),
			[
				"https://api.zotero.org/users/42/items",
				"https://api.zotero.org/users/42/items",
				"https://api.zotero.org/users/42/items/ATT1/file",
				"https://storage.invalid/put",
				"https://api.zotero.org/users/42/items/ATT1/file",
			],
		);
		assert.equal(calls[0].headers["Zotero-API-Key"], "test-key");
		assert.match(String(calls[2].body), /filesize=9/);
		assert.equal(calls[3].headers["Content-Type"], "multipart/form-data");
		assert.match(String(calls[4].body), /upload=UP1/);
		delete process.env.PI_LEARNING_ZOTERO_KEY;
	});

	it("web 模式缺凭据时不发请求，直接说明缺什么", async () => {
		const { impl, calls } = fakeFetch([]);
		await assert.rejects(saveToZotero(SOURCE, { cwd, cfg: { mode: "web", user_id: "42" }, fetchImpl: impl }), /zotero.api_key/);
		assert.deepEqual(calls, []);
	});
});

describe("馆藏：网盘入库", () => {
	let cwd = "";
	let local = "";
	before(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-learning-remote-"));
		local = join(cwd, "prml-ch5.pdf");
		writeFileSync(local, "PDF BYTES", "utf8");
	});
	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("默认按单元建子目录，layout=flat 时平铺", () => {
		assert.equal(remoteRelPath(SOURCE, local, undefined), "u02/prml-ch5.pdf");
		assert.equal(remoteRelPath(SOURCE, local, { layout: "flat" }), "prml-ch5.pdf");
		assert.equal(remoteRelPath({ ...SOURCE, for_units: [] }, local, {}), "prml-ch5.pdf");
	});

	it("folder 模式复制到同步目录；未配置目录时说明缺什么", async () => {
		const dir = join(cwd, "网盘同步");
		mkdirSync(dir, { recursive: true });
		const r = await pushToRemote(SOURCE, local, { cfg: { mode: "folder", dir } });
		assert.equal(r.provider, "folder");
		assert.equal(readFileSync(join(dir, "u02", "prml-ch5.pdf"), "utf8"), "PDF BYTES");
		await assert.rejects(pushToRemote(SOURCE, local, { cfg: { mode: "folder" } }), /remote.dir/);
		await assert.rejects(pushToRemote(SOURCE, local, { cfg: {} }), /remote.mode/);
	});

	it("webdav 模式先 MKCOL 再 PUT；目录已存在（405）不算失败", async () => {
		process.env.PI_LEARNING_TEST_DAV = "pw";
		const { impl, calls } = fakeFetch([new Response(null, { status: 405 }), new Response(null, { status: 201 })]);
		const r = await pushToRemote(SOURCE, local, {
			cfg: { mode: "webdav", url: "https://dav.invalid/学习资料/", user: "me", password: "env:PI_LEARNING_TEST_DAV" },
			fetchImpl: impl,
		});
		assert.equal(r.provider, "webdav");
		assert.equal(r.path, "u02/prml-ch5.pdf");
		assert.deepEqual(calls.map((c) => c.method), ["MKCOL", "PUT"]);
		assert.equal(calls[0].url, "https://dav.invalid/学习资料/u02");
		assert.equal(calls[1].url, "https://dav.invalid/学习资料/u02/prml-ch5.pdf");
		assert.equal(calls[1].headers.Authorization, `Basic ${Buffer.from("me:pw").toString("base64")}`);
		delete process.env.PI_LEARNING_TEST_DAV;

		const fail = fakeFetch([new Response(null, { status: 201 }), new Response(null, { status: 507, statusText: "Insufficient Storage" })]);
		await assert.rejects(pushToRemote(SOURCE, local, { cfg: { mode: "webdav", url: "https://dav.invalid/x" }, fetchImpl: fail.impl }), /HTTP 507/);
	});
});
