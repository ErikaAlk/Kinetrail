@echo off
REM Gradle 入口。Java 不在 PATH，用 Android Studio 自带的 JBR。
REM JAVA_TOOL_OPTIONS 把 Gradle 守护进程的 Unix 域套接字放到 C:\Windows\Temp：在 Claude Code 的进程树里不设它会报
REM Unable to establish loopback connection。
REM 结束时输出 KT_BUILD_EXIT=<退出码>，供轮询日志。

set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\Windows\Temp"
cd /d "%~dp0"
call gradlew.bat --console=plain %*
echo KT_BUILD_EXIT=%ERRORLEVEL%
