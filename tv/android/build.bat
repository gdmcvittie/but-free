@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   FREEVEE - Android Mobile Client Builder
echo ===================================================

if not defined TOOLCHAIN set "TOOLCHAIN=%~dp0..\..\toolchain"
if not exist "%TOOLCHAIN%" set "TOOLCHAIN=C:\_code\___MY-TV\my-tv\toolchain"
set "JAVA_HOME=%TOOLCHAIN%\jdk"
set "ANDROID_HOME=%TOOLCHAIN%\android-sdk"
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "DRAWABLE=%~dp0app\src\main\res\drawable"
if exist "%DRAWABLE%\512.png" (
    echo [Icons] Updating launcher icon from 512x512 icon...
    copy /y "%DRAWABLE%\512.png" "%DRAWABLE%\ic_launcher.png" >nul
    copy /y "%DRAWABLE%\512.png" "%DRAWABLE%\icon_512.png" >nul
    del "%DRAWABLE%\512.png" >nul 2>&1
)
if exist "%DRAWABLE%\192.png" (
    echo [Icons] Updating 192x192 icon...
    if not exist "%DRAWABLE%\icon_512.png" copy /y "%DRAWABLE%\192.png" "%DRAWABLE%\ic_launcher.png" >nul
    copy /y "%DRAWABLE%\192.png" "%DRAWABLE%\icon_192.png" >nul
    del "%DRAWABLE%\192.png" >nul 2>&1
)

if not exist "%JAVA_HOME%\bin\java.exe" (
    echo [ERROR] JDK not found at %JAVA_HOME%
    exit /b 1
)

if not exist "%ANDROID_HOME%" (
    echo [ERROR] Android SDK not found at %ANDROID_HOME%
    exit /b 1
)

if not exist "%TOOLCHAIN%\gradle\bin\gradle.bat" (
    echo [ERROR] Gradle not found at %TOOLCHAIN%\gradle\bin\gradle.bat
    exit /b 1
)

echo [1/2] Toolchain verified:
echo   JDK:        %JAVA_HOME%
echo   Android SDK:%ANDROID_HOME%
echo   Gradle:     %TOOLCHAIN%\gradle\bin\gradle.bat
echo.
echo [2/2] Running Gradle assembleDebug...

call "%TOOLCHAIN%\gradle\bin\gradle.bat" assembleDebug %*

if %ERRORLEVEL% equ 0 (
    echo.
    echo ===================================================
    echo   [SUCCESS] APK built successfully!
    echo   Output: app\build\outputs\apk\debug\app-debug.apk
    echo ===================================================
    exit /b 0
) else (
    echo.
    echo ===================================================
    echo   [ERROR] Build failed with exit code %ERRORLEVEL%
    echo ===================================================
    exit /b %ERRORLEVEL%
)
