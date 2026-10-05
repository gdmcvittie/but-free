@echo off
setlocal
cd /d "%~dp0\.."
echo Running butfree project migration...
node scripts/copy-projects.mjs
pause
