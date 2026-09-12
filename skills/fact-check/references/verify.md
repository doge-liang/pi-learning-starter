# 免密钥的核查渠道

以下渠道都是公开、只读、不需要密钥的 HTTP GET，用 `bash` 工具经 `curl` 查询（Windows 自带 `curl.exe`，Git Bash 也带）。学习目录 `AGENTS.md` 安全边界清单内的这些渠道不必逐条征得同意；清单之外的域名、非 GET 请求、把响应存成文件，仍须先说明。

统一参数：`curl -sL --max-time 15 -D - "<URL>" | head -c 4000`。`-L` 跟随跳转，`-D -` 把响应头（含 HTTP 状态行）放在输出最前面，截断后仍能看到状态码——429、503 是服务限流或故障，不是「查不到」，换渠道或稍后再试，不据此下结论。

**参数里不要出现中文。** Windows 原生的 Git Bash 会把 `curl.exe` 的参数按 ANSI 代码页转换，中文会变成乱码而请求失败。中文标题先做 UTF-8 百分号编码：

```bash
enc=$(printf '%s' '斯托克斯定理' | od -An -tx1 | tr -d '\n' | tr ' ' '%')
curl -sL --max-time 15 -D - "https://zh.wikipedia.org/api/rest_v1/page/summary/${enc}" | head -c 3000
```

## 一、文献归属：标题、作者、年份、期刊、DOI

**Crossref**（期刊与会议论文、DOI 权威源）：

```bash
curl -sL --max-time 15 -D - "https://api.crossref.org/works?query.bibliographic=Attention+Is+All+You+Need&rows=3" | head -c 4000
```

返回的 `message.items[]` 里核对 `title`（数组）、`author[].family`、`issued.date-parts`、`container-title`、`DOI`。已知 DOI 时直接查 `https://api.crossref.org/works/<DOI>`。

**OpenAlex**（覆盖论文、作者、机构，含引用数；返回 503 或 429 时改用 Crossref）：

```bash
curl -sL --max-time 15 -D - "https://api.openalex.org/works?search=differential+forms+stokes&per-page=3" | head -c 4000
```

**arXiv**（预印本，返回 Atom XML）：

```bash
curl -sL --max-time 15 -D - "https://export.arxiv.org/api/query?search_query=all:%22scaling+laws%22&max_results=3" | head -c 4000
```

**Semantic Scholar**（无密钥有速率限制，429 即稍后再试或改用 Crossref）：

```bash
curl -sL --max-time 15 -D - "https://api.semanticscholar.org/graph/v1/paper/search?query=lottery+ticket+hypothesis&limit=3&fields=title,authors,year,venue,externalIds" | head -c 4000
```

判定规则：标题与至少一位作者姓氏、年份三者同时对上才算「文献归属已核实」；只对上标题记「部分核实」；查不到记「未核验」，绝不据此编造，也不把「查不到」当作「不存在」的证据。

## 二、术语、人物、机构、日期、定义

**Wikipedia 摘要**（中文标题先按上文编码；英文用下划线连接）：

```bash
curl -sL --max-time 15 -D - "https://en.wikipedia.org/api/rest_v1/page/summary/Stokes%27_theorem" | head -c 3000
```

百科只能核实「通行说法」，不能核实原始数据；涉及数字与统计时仍须找原始来源。

## 三、软件版本、包与规范

**npm**：`curl -sL --max-time 15 -D - "https://registry.npmjs.org/<包名>/latest" | head -c 1500`；**PyPI**：`curl -sL --max-time 15 -D - "https://pypi.org/pypi/<包名>/json" | head -c 1500`；**GitHub 发布**：`curl -sL --max-time 15 -D - "https://api.github.com/repos/<owner>/<repo>/releases/latest" | head -c 1500`（未登录每小时 60 次；只查元数据，不下载文件）。

## 四、一般网页搜索

上述渠道之外的实证性断言（新闻、政策、非学术数据）需要通用搜索。若已安装 `brave-search` 技能（见 README「可选增强」），按其说明检索并给出来源类型；未安装时不要猜，标注「未核验」并说明应查证的资料类型。

## 五、来源分级与写法

原始文献或官方文档为一等来源；综述、教材、百科为二等；一般网页为三等。给出结论时写明来源等级与检索日期；来源相互矛盾时如实并列，不择一。
