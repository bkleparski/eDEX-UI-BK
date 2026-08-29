@echo off
setlocal EnableDelayedExpansion

rem Windows counterpart of resources/bin/ai (see that file for the protocol
rem this mirrors: POST to the local CLI bridge, Bearer token, streamed plain
rem text back). cmd.exe has no reliable way to pass arbitrary text through a
rem quoted command-line argument (unescaped %, ^, &, |, " all break it), so
rem the prompt is written to a temp file and sent via curl's @file form
rem instead of inlining it — safer, but still not bulletproof for every
rem possible character combination. Needs real-Windows verification.

set "provider=ollama"
set "raw=%*"

if /I "%~1"=="--lms" (
  set "provider=lmstudio"
  set "raw=!raw:*--lms =!"
)

if not defined raw (
  echo usage: ai [--lms] ^<prompt^> 1>&2
  exit /b 64
)

if not defined EDEX_AI_PORT (
  echo ai is available only inside eDEX-UI BK 1>&2
  exit /b 1
)
if not defined EDEX_AI_TOKEN (
  echo ai bridge token is unavailable 1>&2
  exit /b 1
)

set "edex_ai_tmp=%TEMP%\edex-ai-%RANDOM%%RANDOM%.txt"
> "%edex_ai_tmp%" (<nul set /p "=!raw!")

curl.exe -s -N --request POST ^
  --header "Authorization: Bearer %EDEX_AI_TOKEN%" ^
  --header "X-eDEX-Provider: %provider%" ^
  --data-binary "@%edex_ai_tmp%" ^
  "http://127.0.0.1:%EDEX_AI_PORT%/ai"
set "edex_ai_status=%ERRORLEVEL%"

del "%edex_ai_tmp%" >nul 2>&1
endlocal & exit /b %edex_ai_status%
