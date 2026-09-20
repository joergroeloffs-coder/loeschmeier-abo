@echo off
cd /d "%~dp0.."
echo Lege PayPal-Sandbox-Produkt und Preisplan an ...
echo.
python setup\paypal_plan_erstellen.py
echo.
pause
