@echo off
set "TOOLCHAIN=C:\_code\___MY-TV\my-tv\toolchain"
set "JAVA_HOME=%TOOLCHAIN%\jdk"
set "ANDROID_HOME=%TOOLCHAIN%\android-sdk"
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "DRAWABLE=%~dp0app\src\main\res\drawable"
if exist "%DRAWABLE%\512.png" (
    copy /y "%DRAWABLE%\512.png" "%DRAWABLE%\ic_launcher.png" >nul
    copy /y "%DRAWABLE%\512.png" "%DRAWABLE%\icon_512.png" >nul
    del "%DRAWABLE%\512.png" >nul 2>&1
)
if exist "%DRAWABLE%\192.png" (
    if not exist "%DRAWABLE%\icon_512.png" copy /y "%DRAWABLE%\192.png" "%DRAWABLE%\ic_launcher.png" >nul
    copy /y "%DRAWABLE%\192.png" "%DRAWABLE%\icon_192.png" >nul
    del "%DRAWABLE%\192.png" >nul 2>&1
)

call "%TOOLCHAIN%\gradle\bin\gradle.bat" %*
