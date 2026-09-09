<#
.SYNOPSIS
把仓库 skills\ 下的全部技能（teach-cn、quiz-cn、viz-cn、fact-check-cn）装进 pi 的全局技能目录；可选建立学习目录并放入 AGENTS.md。

.DESCRIPTION
全局技能目录取 $env:PI_CODING_AGENT_DIR\skills，未设置时为 $HOME\.pi\agent\skills（pi 的默认）。
本脚本只管理与仓库 skills\ 同名的目录：安装前先删除同名旧目录，保证被移除的文件不残留；
其它技能不动。学习目录中已有的 AGENTS.md 默认不覆盖，加 -ForceAgents 才覆盖；maps/、sessions/、
attachments/ 只在缺失时创建，既有内容不动。

.EXAMPLE
.\scripts\install.ps1
只安装技能。

.EXAMPLE
.\scripts\install.ps1 -LearnDir D:\Knowledge\PiLearn
安装技能，并在 Obsidian 库内建立学习目录。
#>
param(
    [string]$LearnDir,
    [switch]$ForceAgents
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME ".pi\agent" }
$skillsDir = Join-Path $agentDir "skills"
New-Item -ItemType Directory -Force $skillsDir | Out-Null

foreach ($skill in Get-ChildItem (Join-Path $root "skills") -Directory) {
    $name = $skill.Name
    $src = $skill.FullName
    $dst = Join-Path $skillsDir $name
    if (-not (Test-Path (Join-Path $src "SKILL.md"))) { throw "找不到技能源目录：$src" }
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse $src $dst
    Write-Host "已安装技能 $name -> $dst"
}

if ($LearnDir) {
    foreach ($sub in @("maps", "sessions", "attachments")) {
        New-Item -ItemType Directory -Force (Join-Path $LearnDir $sub) | Out-Null
    }
    $agents = Join-Path $LearnDir "AGENTS.md"
    if (-not (Test-Path $agents) -or $ForceAgents) {
        Copy-Item (Join-Path $root "AGENTS.md") $agents -Force
        Write-Host "已写入 $agents"
    } else {
        Write-Host "已存在 $agents，未覆盖（加 -ForceAgents 覆盖）"
    }
    Write-Host "学习目录就绪：$LearnDir。在该目录中运行 pi（pi 只向上查找 AGENTS.md，不要在库根启动）。"
}

Write-Host "完成。若 pi 正在运行，执行 /reload 使技能生效。"
