@echo off
rem Запуск утренней сводки по расписанию (npm run digest -- --schedule 08:00).
chcp 65001 >nul
cd /d "%~dp0.."
if not exist reports\digest mkdir reports\digest
call npm run digest -- --scheduled >> reports\digest\log.txt 2>&1
