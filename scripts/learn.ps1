<#
.SYNOPSIS
在学习目录里启动 pi，只带本套件的四个技能（系统提示不再混入库内与全局的其它技能）。

.DESCRIPTION
学习目录取 -LearnDir；未给时取环境变量 PI_LEARN_DIR；再没有则用当前目录。目录里必须已有 AGENTS.md
（由 install.ps1 -LearnDir 放入）。其余参数原样传给 pi，例如 -c 续上次会话、-r 选历史会话。
扩展是用户级的，不受 --no-skills 影响。

把下面两行加进 PowerShell 配置文件（notepad $PROFILE），之后在任何目录输入 learn 即可：
    $env:PI_LEARN_DIR = "D:\Knowledge\PiLearn"
    function learn { & "<本仓库路径>\scripts\learn.ps1" @args }

.EXAMPLE
learn
.EXAMPLE
learn -c
#>
param(
    [string]$LearnDir,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PiArgs
)

$ErrorActionPreference = "Stop"
$dir = if ($LearnDir) { $LearnDir } elseif ($env:PI_LEARN_DIR) { $env:PI_LEARN_DIR } else { (Get-Location).Path }
if (-not (Test-Path (Join-Path $dir "AGENTS.md"))) {
    throw "学习目录 $dir 里没有 AGENTS.md：先运行 scripts\install.ps1 -LearnDir <目录>，或设置 PI_LEARN_DIR"
}
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }
$skillsDir = Join-Path $agentDir "skills"
$flags = @("--no-skills")
foreach ($name in @("teach", "quiz", "viz", "fact-check")) {
    $p = Join-Path $skillsDir $name
    if (Test-Path (Join-Path $p "SKILL.md")) { $flags += @("--skill", $p) } else { Write-Warning "未安装技能 $name（先运行 scripts\install.ps1）" }
}
Set-Location $dir
& pi @flags @PiArgs
