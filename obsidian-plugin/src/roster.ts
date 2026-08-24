/**
 * roster.ts —— hub 花名册：八个常驻角色实例的标识、页签标签与 @ 别名，以及输入的寻址解析。
 * 解析是纯代码：@ 后的记号查别名表，不经模型。角色 id 与扩展的 LEARN_ROLE 一致。
 */
export interface RoleSpec {
	/** 扩展的角色名，同时是实例的 LEARN_ROLE */
	role: string;
	/** 页签与模态框标注 */
	label: string;
	/** @ 别名（含 label 本身；解析时精确匹配整个记号） */
	aliases: string[];
}

export const ROSTER: RoleSpec[] = [
	{ role: "concierge", label: "前台", aliases: ["前台", "concierge"] },
	{ role: "placement", label: "水平测试官", aliases: ["水平测试官", "测试官", "placement"] },
	{ role: "planner", label: "领域专家", aliases: ["领域专家", "规划者", "规划", "planner"] },
	{ role: "critic", label: "提案评审员", aliases: ["提案评审员", "critic"] },
	{ role: "librarian", label: "资料管理员", aliases: ["资料管理员", "馆员", "librarian"] },
	{ role: "tutor", label: "陪读老师", aliases: ["陪读老师", "老师", "导师", "tutor"] },
	{ role: "reviewer", label: "评审员", aliases: ["评审员", "reviewer"] },
	{ role: "assessor", label: "复盘老师", aliases: ["复盘老师", "考评官", "assessor"] },
];

export function roleSpec(role: string): RoleSpec | undefined {
	return ROSTER.find((r) => r.role === role);
}

const BY_ALIAS = new Map<string, string>();
for (const r of ROSTER) for (const a of r.aliases) BY_ALIAS.set(a.toLowerCase(), r.role);

export interface Address {
	/** 消息开头点名的角色（去重、保持出现顺序）；为空即无寻址 */
	roles: string[];
	/** 去掉寻址记号后的正文 */
	body: string;
	/** 消息开头无法识别的 @ 记号（原样，供提示）；出现即停止解析，其后内容全部归入 body */
	unknown?: string;
}

/**
 * 解析消息开头的 @ 寻址。只认开头连续的 @记号（记号 = 到下一个空白为止）；
 * 第一个不认识的 @ 记号使解析停止并整体归入正文——宁可少路由，不吞正文。
 */
export function parseAddress(text: string): Address {
	let rest = text.trim();
	const roles: string[] = [];
	let unknown: string | undefined;
	for (;;) {
		const m = /^@(\S+)\s*/.exec(rest);
		if (!m) break;
		const role = BY_ALIAS.get(m[1].toLowerCase());
		if (!role) {
			unknown = m[1];
			break;
		}
		if (!roles.includes(role)) roles.push(role);
		rest = rest.slice(m[0].length);
	}
	return { roles, body: rest.trim(), unknown };
}
