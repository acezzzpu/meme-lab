@echo off
setlocal
cd /d "%~dp0"
if not exist "core\copy\common.mjs" (
  echo Copia este archivo y la carpeta scripts dentro de tu carpeta actual de MEME LAB.
  pause
  exit /b 1
)
echo Consultando el RPC publico. Puede demorar unos segundos.
echo El bot puede seguir abierto. Este diagnostico no envia operaciones.
node "scripts\diagnose-copy-bnb.mjs"
pause
