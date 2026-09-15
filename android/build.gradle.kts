// 与本机其他 Android 项目同一套工具链版本（Gradle 8.14 / AGP 8.12.1 / Kotlin 2.2.20），缓存可直接复用。
plugins {
    id("com.android.application") version "8.12.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.20" apply false
}
