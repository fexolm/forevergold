# Скачивает таблицу цен AHledger и кладёт её в аддон (ForeverGold\AHLedgerPrices.lua).
# Игра подхватывает файл при входе или по /reload. Данные: https://ahledger.com
param(
    [string]$Market = "forever.normal.alliance.eu"
)

$ErrorActionPreference = "Stop"
$addon = Join-Path $PSScriptRoot "..\ForeverGold"
$target = Join-Path $addon "AHLedgerPrices.lua"
$etagFile = Join-Path $addon ".ahledger-etag"
$url = "https://api.ahledger.com/v1/pricetable/$Market"

$headers = @{}
if ((Test-Path $etagFile) -and (Test-Path $target)) {
    $headers["If-None-Match"] = (Get-Content $etagFile -Raw).Trim()
}

try {
    $resp = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing
} catch {
    $r = $_.Exception.Response
    if ($r -and [int]$r.StatusCode -eq 304) {
        Write-Host "AHledger: без изменений"
        exit 0
    }
    throw
}

$text = $resp.Content
if ($text -is [byte[]]) {
    $text = [System.Text.Encoding]::UTF8.GetString($text)
}
if (-not $text.StartsWith("AHL1")) {
    throw "AHledger вернул неожиданный ответ: $($text.Substring(0, [Math]::Min(200, $text.Length)))"
}

$lua = "-- Сгенерировано tools/ahledger-sync.ps1 $(Get-Date -Format s). Данные: https://ahledger.com`n" +
       "ForeverGold_AHLedgerRaw = [==[`n" + $text + "`n]==]`n"

# Пишем во временный файл и подменяем, чтобы игра не прочитала половину файла.
$tmp = "$target.tmp"
[System.IO.File]::WriteAllText($tmp, $lua, (New-Object System.Text.UTF8Encoding $false))
Move-Item -Force $tmp $target

if ($resp.Headers["ETag"]) {
    Set-Content -Path $etagFile -Value $resp.Headers["ETag"]
}
Write-Host "AHledger: сохранено, строк $(($text -split "`n").Count - 1)"
