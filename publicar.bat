@echo off
REM ============================================================
REM  publicar.bat — build + commit + push en un solo comando
REM  Guardalo en la raiz de tu proyecto (CRM-Vinos) y corré:
REM      publicar.bat
REM  (o hacele doble clic desde el Explorador de Windows)
REM ============================================================

echo.
echo === 1/3: Generando el instalador (npm run dist) ===
call npm run dist
if errorlevel 1 (
  echo.
  echo *** ERROR en el build. Se cancela antes de subir nada. ***
  pause
  exit /b 1
)

echo.
set /p MSG="Mensaje del commit (Enter para usar uno automatico): "
if "%MSG%"=="" set MSG=Actualizacion %date% %time%

echo.
echo === 2/3: Guardando cambios en git ===
git add .
git commit -m "%MSG%"

echo.
echo === 3/3: Subiendo a GitHub ===
git push origin main

echo.
echo === Listo! ===
pause
