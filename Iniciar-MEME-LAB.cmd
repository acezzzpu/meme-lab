@echo off
setlocal
cd /d "%~dp0"
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>24||(a===24&&b>=19)?0:1)" >nul 2>&1
if errorlevel 1 (
  echo Instala Node.js 24.19 o superior desde https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 goto error
)
call npm run build:standalone
if errorlevel 1 goto error
echo Abri http://localhost:8787 y usa el contenido de .runtime\admin-token.
echo Esta consola debe quedar abierta. Cerrar Chrome no detiene el motor.
node --env-file-if-exists=.env runtime/server.mjs
goto end
:error
echo No se pudo iniciar. Revisa el error mostrado arriba.
:end
pause
