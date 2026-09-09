/**
 * quiz/logic.mjs —— 选择题工具的纯逻辑：打乱选项、附加「我不知道」、判定。
 * 与 pi 无关，可在 Node 里直接测试；index.ts 只负责接 pi 的工具与 UI。
 */
export const IDK = "我不知道";

/** Fisher–Yates；rng 可注入以便测试 */
export function shuffle(items, rng = Math.random) {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * 生成呈现给学习者的选项：原始选项随机重排并编号，最后固定附加「我不知道」。
 * order[k] 是第 k 个显示项对应的原始下标；display 是带编号的文本。
 */
export function buildQuiz({ options, correct }, rng = Math.random) {
	if (!Array.isArray(options) || options.length < 2) throw new Error("至少需要两个选项");
	if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new Error("correct 必须是 options 的合法下标");
	const order = shuffle(options.map((_, i) => i), rng);
	const display = order.map((orig, k) => `${k + 1}. ${options[orig]}`);
	display.push(`${order.length + 1}. ${IDK}`);
	return { order, display, correct, options };
}

/** 学习者选中的显示文本 → 判定。选「我不知道」记为 unknown（知识空白，不当作猜错） */
export function judge(quiz, picked) {
	const k = quiz.display.indexOf(picked);
	if (k === -1) return { status: "cancelled" };
	if (k === quiz.order.length) return { status: "unknown", correctText: quiz.options[quiz.correct] };
	const orig = quiz.order[k];
	return {
		status: orig === quiz.correct ? "correct" : "wrong",
		pickedText: quiz.options[orig],
		correctText: quiz.options[quiz.correct],
	};
}
