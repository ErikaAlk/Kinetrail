// 与设计库 coloros-ui-kit 同一代工具链：它经 includeBuild 进来，两边 AGP 不一致插件会被加载两次。
// 升级跟着设计库一起升（它的 CLAUDE.md 写着当前版本），别单独动某一个。
// AGP 9 内置 Kotlin：kotlin.android 在这里 apply false 只为把 KGP 顶到 2.4.20，app 模块不要再 apply 它。
plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
}
