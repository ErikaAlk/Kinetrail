@echo off
REM Gradle 入口。Java 不在 PATH，用 Android Studio 自带的 JBR；
REM 在 Claude Code 的进程树里直接跑 gradlew 会连不上守护进程，需要用 WMI 把本脚本拉出进程树（见 android/README.md）。
REM 结束时输出 KT_BUILD_EXIT=<退出码>，供轮询日志。

set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
cd /d "%~dp0"
call gradlew.bat --console=plain %*
echo KT_BUILD_EXIT=%ERRORLEVEL%
