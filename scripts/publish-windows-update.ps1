param(
  [string]$Repository = 'thaophamce/nhayen-zalo-updates'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectRoot 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$distPath = Join-Path $projectRoot 'dist'

if (-not $version) { throw 'package.json không có version.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Chưa cài GitHub CLI (gh).' }

Push-Location $projectRoot
try {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'Kiểm thử thất bại; dừng phát hành.' }

  npm run build -- --publish never
  if ($LASTEXITCODE -ne 0) { throw 'Build Windows thất bại; dừng phát hành.' }

  $setup = Get-ChildItem -LiteralPath $distPath -Filter "Nha-Yen-Zalo-Setup-$version.exe" -File | Select-Object -First 1
  $blockmap = Get-ChildItem -LiteralPath $distPath -Filter "Nha-Yen-Zalo-Setup-$version.exe.blockmap" -File | Select-Object -First 1
  $latest = Join-Path $distPath 'latest.yml'
  if (-not $setup -or -not $blockmap -or -not (Test-Path -LiteralPath $latest)) {
    throw 'Thiếu setup, blockmap hoặc latest.yml sau khi build.'
  }

  gh release view $tag --repo $Repository *> $null
  if ($LASTEXITCODE -eq 0) { throw "Release $tag đã tồn tại trong $Repository." }

  gh release create $tag --repo $Repository --title "Nhà Yến Zalo $version" --generate-notes $setup.FullName $blockmap.FullName $latest
  if ($LASTEXITCODE -ne 0) { throw 'Không thể tạo GitHub Release.' }
  Write-Host "Đã phát hành $tag: https://github.com/$Repository/releases/tag/$tag"
} finally {
  Pop-Location
}
