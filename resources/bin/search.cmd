@echo off
setlocal EnableDelayedExpansion

rem Windows counterpart of resources/bin/search — see resources/bin/ai.cmd
rem for why the prompt goes through a temp file instead of an inline arg.

set "provider=ollama"
set "raw=%*"

if /I "%~1"=="--lms" (
  set "provider=lmstudio"
  set "raw=!raw:*--lms =!"
)

if not defined raw (
  echo usage: search [--lms] ^<query^> 1>&2
  exit /b 64
)

if not defined EDEX_AI_PORT (
  echo search is available only inside eDEX-UI BK 1>&2
  exit /b 1
)
if not defined EDEX_AI_TOKEN (
  echo search bridge token is unavailable 1>&2
  exit /b 1
)

set "edex_ai_tmp=%TEMP%\edex-search-%RANDOM%%RANDOM%.txt"
> "%edex_ai_tmp%" (<nul set /p "=!raw!")

curl.exe -s -N --request POST ^
  --header "Authorization: Bearer %EDEX_AI_TOKEN%" ^
  --header "X-eDEX-Provider: %provider%" ^
  --data-binary "@%edex_ai_tmp%" ^
  "http://127.0.0.1:%EDEX_AI_PORT%/search"
set "edex_ai_status=%ERRORLEVEL%"

del "%edex_ai_tmp%" >nul 2>&1
endlocal & exit /b %edex_ai_status%
