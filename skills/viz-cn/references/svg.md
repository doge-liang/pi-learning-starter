# SVG 规则

Obsidian 把 `![[attachments/xxx.svg]]` 当作图片嵌入，不会按主题改色，也不会重排文字，因此 SVG 必须自带背景并自行保证可读。

## 画布与字体

- `viewBox="0 0 640 400"` 为默认；内容多时放大到 `0 0 800 500`，不超过 `960 × 600`。不写 `width`、`height`，让 Obsidian 按列宽缩放。
- 第一个元素是白色背景：`<rect width="100%" height="100%" fill="#ffffff"/>`，深色主题下仍有对比。
- `font-family="sans-serif"`，正文 `font-size="16"`，标注 `14`，标题 `20`；不用 `foreignObject`，不用 CSS 类，样式全部写成属性。
- 线条 `stroke="#222222" stroke-width="2"`；辅助线 `stroke="#999999" stroke-dasharray="4 4"`；强调用 `#1f6feb`，第二强调 `#d9480f`，不超过两种彩色。

## 文字与布局

- 汉字宽约等于字号，拉丁字母与数字宽约为字号的 0.6 倍，空格约 0.3 倍：一段 16 号字的「切平面 T_pM」约 3 × 16 + 4 × 9.6 + 5 ≈ 91 单位宽；包围盒高约为字号的 1.4 倍。文字包围盒之间至少留 8 单位。
- `text-anchor` 用 `middle` 或 `start`，`dominant-baseline="middle"` 让文字与锚点对齐。
- 元素之间的间距至少 24 单位；四周留 32 单位边距。
- 数学记号写成普通文本（`x_1`、`∂f/∂x`、`⟨v, w⟩`），Unicode 上标下标可用；SVG 里没有 LaTeX。

## 箭头

在 `<defs>` 里定义一次箭头：

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/>
  </marker>
</defs>
```

线段用 `marker-end="url(#arrow)"`；`fill="context-stroke"` 让箭头颜色随线条的 `stroke`（Obsidian 的 Chromium 内核支持）；`refX="9"` 使箭尖落在线段终点附近，实际略超出约 1.6 单位，估算边距时可忽略。曲线用 `<path d="M x1 y1 Q cx cy x2 y2"/>`。

## 最小模板

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" font-family="sans-serif">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <defs>（箭头定义）</defs>
  <text x="320" y="36" font-size="20" text-anchor="middle">标题：这张图表达的一个关系</text>
  （元素）
</svg>
```

## 源码级自检清单

`write` 之后用 `read` 重读文件，逐项核对；任何一项不过就修改并重读，通过后才嵌入笔记。

1. 每个 `x`、`y`、`cx`、`cy`、`x2`、`y2` 以及 `path` 里的坐标都落在 `viewBox` 范围内，且不进入 32 单位边距。
2. 按字号与字符数估算每段文字的包围盒，两两之间不重叠，不与线条交叉。
3. 每个箭头的起点与终点对应说明里的方向；双向关系用两条线而不是一条无向线。
4. 元素总数不超过约七个（不含背景、标题、坐标轴）。
5. 文件以 `</svg>` 结尾，没有未闭合的标签；不含 `<script>`、`<foreignObject>`、外部引用。
