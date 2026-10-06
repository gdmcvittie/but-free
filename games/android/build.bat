@echo off
setlocal

echo ===================================================
echo   FREEPLAY - Android Mobile Client Builder
echo ===================================================

if not defined TOOLCHAIN set "TOOLCHAIN=%~dp0..\..\toolchain"
if not exist "%TOOLCHAIN%" set "TOOLCHAIN=C:\_code\___MY-TV\my-tv\toolchain"
set "JAVA_HOME=%TOOLCHAIN%\jdk"
set "ANDROID_HOME=%TOOLCHAIN%\android-sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%JAVA_HOME%\bin;%PATH%"

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

echo [1/2] Building the cloud web app for the bundled offline library...
pushd "%~dp0..\server"
call npm run build
if errorlevel 1 (
    popd
    exit /b 1
)
popd

echo [Build] Compiling the Android app and bundled emulator cores...
call "%TOOLCHAIN%\gradle\bin\gradle.bat" assembleDebug %*
if errorlevel 1 exit /b %ERRORLEVEL%

echo.
echo [SUCCESS] APK: app\build\outputs\apk\debug\app-debug.apk
