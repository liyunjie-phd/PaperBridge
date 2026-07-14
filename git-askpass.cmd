@echo off
echo %~1| findstr /I "username" >nul
if %errorlevel%==0 (echo %PAPERBRIDGE_GIT_USERNAME%) else (echo %PAPERBRIDGE_GIT_TOKEN%)
