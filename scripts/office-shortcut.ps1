# Ярлык «WB Офис» на Рабочем столе Windows: `npm run office:shortcut`.
#
# Двойной щелчок по ярлыку открывает окно, в нём запускается `npm run office:web`
# в папке набора, а через 3 секунды браузер открывает http://localhost:3000.
# Закрыли окно — офис остановился.
#
# Без прав администратора и без скачивания: ярлык .lnk создаётся встроенным
# в Windows объектом WScript.Shell. Запускать повторно можно — ярлык перезапишется.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# GetFolderPath учитывает Рабочий стол, перенесённый в OneDrive.
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'WB Офис.lnk'

# Браузер открываем отдельным свёрнутым окном через 3 секунды: ping вместо timeout,
# потому что timeout падает, если у окна нет обычного ввода с клавиатуры.
$cmdArgs = '/k title WB Офис & ' +
  '(start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3000") & ' +
  'npm run office:web'

try {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $lnk.Arguments = $cmdArgs
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'WB Офис: 3D-офис магазина на http://localhost:3000'
  $lnk.WindowStyle = 1
  $lnk.Save()
} catch {
  Write-Host "Не удалось создать ярлык: $($_.Exception.Message)"
  Write-Host "Можно запускать офис без ярлыка: откройте папку набора в терминале и выполните npm run office:web"
  exit 1
}

Write-Host "Готово: на Рабочем столе ярлык «WB Офис»."
Write-Host "Двойной щелчок — офис запустится и откроется в браузере (http://localhost:3000)."
Write-Host "Остановить — закрыть чёрное окно «WB Офис»."
Write-Host "Если папку набора перенесёте — запустите npm run office:shortcut ещё раз."
