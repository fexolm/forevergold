# Подключает аддон к игре и ставит обновление цен AHledger каждые 30 минут.
# Запуск из PowerShell (без прав администратора):
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -AddOnsPath "C:\...\_forever_\Interface\AddOns"
param(
    [Parameter(Mandatory = $true)]
    [string]$AddOnsPath
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $repo "ForeverGold"
$link = Join-Path $AddOnsPath "ForeverGold"

if (-not (Test-Path $AddOnsPath)) {
    throw "Папка не найдена: $AddOnsPath"
}

# Ссылка вместо копии: git pull в репозитории сразу обновляет аддон в игре.
if (Test-Path $link) {
    Write-Host "Уже есть: $link"
} else {
    New-Item -ItemType Junction -Path $link -Target $source | Out-Null
    Write-Host "Аддон подключён: $link -> $source"
}

$sync = Join-Path $PSScriptRoot "ahledger-sync.ps1"
& $sync

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$sync`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ForeverGold AHledger sync" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Задача 'ForeverGold AHledger sync' будет обновлять цены каждые 30 минут"
