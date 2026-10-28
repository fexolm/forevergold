# Ставит ForeverGold: подключает аддон к игре и запускает демон forevergold.exe при входе в Windows.
# Запуск из PowerShell в папке репозитория (без прав администратора):
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -WowPath "C:\Program Files (x86)\World of Warcraft\_forever_"
param(
    [Parameter(Mandatory = $true)]
    [string]$WowPath,
    # Путь к forevergold.exe. По умолчанию ищется в bin\ репозитория.
    [string]$Exe = ""
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$addOns = Join-Path $WowPath "Interface\AddOns"
if (-not (Test-Path $addOns)) {
    throw "Не найдена папка $addOns. WowPath должен указывать на папку клиента Forever (где лежат Interface и WTF)."
}

# 1. Аддон: ссылка вместо копии, чтобы git pull сразу обновлял его в игре.
$link = Join-Path $addOns "ForeverGold"
if (Test-Path $link) {
    Write-Host "Аддон уже подключён: $link"
} else {
    New-Item -ItemType Junction -Path $link -Target (Join-Path $repo "ForeverGold") | Out-Null
    Write-Host "Аддон подключён: $link"
}

# 2. Демон: копируем exe в %LOCALAPPDATA%\ForeverGold, там же база, конфиг и лог.
if ($Exe -eq "") {
    $Exe = Join-Path $repo "bin\forevergold.exe"
}
if (-not (Test-Path $Exe)) {
    throw "Нет $Exe. Скачайте forevergold.exe из Releases репозитория в папку bin\ или соберите: cd daemon; go build -ldflags -H=windowsgui -o ..\bin\forevergold.exe .\cmd\forevergold"
}
$dataDir = Join-Path $env:LOCALAPPDATA "ForeverGold"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$target = Join-Path $dataDir "forevergold.exe"
Get-Process forevergold -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item -Force $Exe $target

# 3. Автозапуск при входе. Старую задачу синка PowerShell-скриптом убираем.
Unregister-ScheduledTask -TaskName "ForeverGold AHledger sync" -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $target -Argument "-wow `"$WowPath`"" -WorkingDirectory $dataDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ForeverGold" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Start-Process -FilePath $target -ArgumentList "-wow `"$WowPath`" -open" -WorkingDirectory $dataDir
Write-Host "Демон запущен и будет стартовать при входе в Windows. Интерфейс: http://localhost:8765"
