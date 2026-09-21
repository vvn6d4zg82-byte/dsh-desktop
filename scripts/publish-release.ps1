# 把 v0.2.0 的自动更新产物补传到 GitHub Release
#
# 为什么需要：现有 Release 里只有 Setup.exe，没有 latest.yml ——
# electron-updater 靠 latest.yml 判断"线上是什么版本、校验和是多少"，
# 缺了它，存量用户点检查更新会直接报错、拉不到新版本。
#
# 用法（在 dsh-desktop 目录下）：
#   $env:GH_TOKEN = "<你的 GitHub PAT>"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-release.ps1
#
# PAT 需要 repo 权限（公开仓库的 Release 上传走的是写接口，必须带 token）。

param(
  [string]$Version = "",
  [string]$Tag = "",
  [string]$Repo = "vvn6d4zg82-byte/dsh-desktop",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# 版本：默认从 package.json 读
if (-not $Version) {
  $Version = (Get-Content (Join-Path $PSScriptRoot "..\package.json") -Raw | ConvertFrom-Json).version
}
if (-not $Tag) { $Tag = "v$Version" }

$dist = Join-Path $PSScriptRoot "..\dist"
$exe      = Join-Path $dist "DSH-Desktop-Setup-$Version.exe"
$blockmap = "$exe.blockmap"
$yml      = Join-Path $dist "latest.yml"

Write-Host "=== 准备发布 v$Version (tag: $Tag) ===" -ForegroundColor Cyan

# --- 1. 检查三个文件是否齐全（缺一不可）---
$missing = @()
foreach ($f in @($exe, $blockmap, $yml)) {
  if (-not (Test-Path $f)) { $missing += (Split-Path $f -Leaf) }
}
if ($missing.Count -gt 0) {
  Write-Host "缺少文件，无法发布：" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  - $_" }
  Write-Host ""
  Write-Host "先跑：npx electron-builder --win" -ForegroundColor Yellow
  exit 1
}

Write-Host "三个文件齐全：" -ForegroundColor Green
Get-Item $exe, $blockmap, $yml | ForEach-Object {
  Write-Host ("  {0,-45} {1,8:N2} MB" -f $_.Name, ($_.Length / 1MB))
}

# --- 2. 校验 latest.yml 里的版本号与 package.json 一致 ---
$ymlText = Get-Content $yml -Raw
if ($ymlText -notmatch [regex]::Escape("version: $Version")) {
  Write-Host "latest.yml 里的版本号与 $Version 不一致：" -ForegroundColor Red
  Write-Host $ymlText
  exit 1
}
Write-Host "latest.yml 版本号校验通过" -ForegroundColor Green

# --- 3. token ---
if (-not $env:GH_TOKEN) {
  Write-Host "未设置 GH_TOKEN，无法上传。" -ForegroundColor Red
  Write-Host "  `$env:GH_TOKEN = `"<你的 GitHub PAT>`"" -ForegroundColor Yellow
  exit 1
}

$headers = @{
  Authorization          = "Bearer $($env:GH_TOKEN)"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "dsh-publish"
}

if ($DryRun) {
  Write-Host "(DryRun) 跳过上传" -ForegroundColor Yellow
  exit 0
}

# --- 4. 找 Release（没有就建）---
$api = "https://api.github.com/repos/$Repo"
$release = $null
try {
  $release = Invoke-RestMethod "$api/releases/tags/$Tag" -Headers $headers -TimeoutSec 30
  Write-Host "找到已存在的 Release: $Tag" -ForegroundColor Green
} catch {
  Write-Host "Release $Tag 不存在，创建新的…" -ForegroundColor Yellow
  $body = @{
    tag_name         = $Tag
    name             = "DSH Desktop $Version"
    draft            = $false
    prerelease       = $false
  } | ConvertTo-Json
  $release = Invoke-RestMethod "$api/releases" -Method Post -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 30
}

# --- 5. 上传（同名附件先删，避免重复/冲突）---
foreach ($f in @($exe, $blockmap, $yml)) {
  $name = Split-Path $f -Leaf
  $existing = $release.assets | Where-Object { $_.name -eq $name }
  if ($existing) {
    Write-Host "  删除旧附件 $name …" -ForegroundColor Yellow
    Invoke-RestMethod "$api/releases/assets/$($existing.id)" -Method Delete -Headers $headers -TimeoutSec 30 | Out-Null
  }

  Write-Host "  上传 $name …" -ForegroundColor Cyan
  $uploadUrl = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=$name"
  Invoke-RestMethod $uploadUrl -Method Post -Headers $headers `
    -ContentType "application/octet-stream" -InFile $f -TimeoutSec 1800 | Out-Null
  Write-Host "    ✓ $name" -ForegroundColor Green
}

# --- 6. 回读确认 ---
$after = Invoke-RestMethod "$api/releases/tags/$Tag" -Headers $headers -TimeoutSec 30
Write-Host ""
Write-Host "=== Release $Tag 现有附件 ===" -ForegroundColor Cyan
$after.assets | ForEach-Object { Write-Host ("  {0,-45} {1,8:N2} MB" -f $_.name, ($_.size / 1MB)) }

$need = @("latest.yml", "DSH-Desktop-Setup-$Version.exe", "DSH-Desktop-Setup-$Version.exe.blockmap")
$got = $after.assets.name
$ok = $true
foreach ($n in $need) { if ($got -notcontains $n) { Write-Host "  ✗ 缺少 $n" -ForegroundColor Red; $ok = $false } }
if ($ok) {
  Write-Host ""
  Write-Host "完成：三个文件都已就位，自动更新链路可用。" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "警告：附件不全，客户端可能拉不到更新。" -ForegroundColor Red
  exit 1
}
