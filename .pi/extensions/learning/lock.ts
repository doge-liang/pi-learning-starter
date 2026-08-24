/**
 * lock.ts —— 黑板的跨进程互斥锁。
 *
 * bb_* 工具的 executionMode: "sequential" 只在单个 pi 实例内成立；hub 模式下多个常驻实例
 * （以及 cron 出题与交互会话并用时）可能并发执行读改写序列，JSON 文件会互相覆盖。
 * 锁只包住短促的纯文件变更段，绝不包住对话框、下载等长时间操作；hub 侧的回合串行队列
 * 是第一道防线，这里是兜底。
 *
 * 实现：mkdir 的原子性做建议锁（非 recursive 的 mkdir 在目录已存在时抛错）。
 * 陈旧锁按 mtime 超龄回收，防止崩溃的进程永久锁死黑板。
 */
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LockOptions {
	/** 等待锁的上限；超时抛错（毫秒） */
	timeoutMs?: number;
	/** 锁目录超过此龄视为陈旧并回收（毫秒）；被锁住的都是毫秒级文件变更，60 秒已极保守 */
	staleMs?: number;
	/** 重试间隔（毫秒） */
	retryMs?: number;
}

export async function withBlackboardLock<T>(cwd: string, fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const staleMs = opts.staleMs ?? 60_000;
	const retryMs = opts.retryMs ?? 40;
	const parent = join(cwd, ".pi");
	const dir = join(parent, "blackboard.lock");
	mkdirSync(parent, { recursive: true });

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			mkdirSync(dir);
			break;
		} catch {
			try {
				const st = statSync(dir);
				if (Date.now() - st.mtimeMs > staleMs) {
					try {
						rmdirSync(dir);
					} catch {
						/* 别的进程刚回收掉；下一轮重试 */
					}
					continue;
				}
			} catch {
				continue; // 锁在探测间隙被释放；立即重试
			}
			if (Date.now() > deadline) throw new Error("黑板正被另一个会话写入（等待锁超时）；请稍后重试。");
			await sleep(retryMs);
		}
	}
	try {
		return await fn();
	} finally {
		try {
			rmdirSync(dir);
		} catch {
			/* 已被陈旧回收 */
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
