@echo off
setlocal
cd /d "%~dp0.."
set "SYMETRIQ_SERVER_PORT=3001"
call npm.cmd run start:production
