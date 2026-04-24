@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo [Albion Bot] Closing old processes...
taskkill /IM electron.exe /F >nul 2>&1
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM python.exe /F >nul 2>&1

if not exist ".venv\Scripts\python.exe" (
  echo [Albion Bot] Creating Python virtual environment...
  python -m venv .venv
  if errorlevel 1 goto :error
)

if not exist "node_modules\.bin\electron.cmd" (
  echo [Albion Bot] Installing Node dependencies...
  npm install
  if errorlevel 1 goto :error
)

if not exist ".venv\Lib\site-packages\albion_overlay_foundation-0.1.0.dist-info" (
  echo [Albion Bot] Installing Python backend dependencies...
  ".venv\Scripts\python.exe" -m pip install -e .[dev]
  if errorlevel 1 goto :error
)

echo [Albion Bot] Launching dashboard...
start "" /D "%~dp0" "cmd.exe" /c "npm run electron:dev"
exit /b 0

:error
echo.
echo [Albion Bot] Startup failed.
echo Please check Python/Node/npm are installed and try again.
pause
exit /b 1
