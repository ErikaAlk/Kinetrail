pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "KinetrailHc"

include(":app")

// 设计库 coloros-ui-kit：界面的唯一设计来源（全局 DESIGN.md 第 1 章），要和 Kinetrail 并排放在 code/ 下。
// worktree 在 .claude/worktrees/ 里，要多往上找几层，所以逐级往上找，不写死相对路径。
includeBuild(
    generateSequence(rootDir) { it.parentFile }
        .map { it.resolve("coloros-ui-kit/android") }
        .firstOrNull { it.isDirectory }
        ?: error("找不到设计库 coloros-ui-kit，它要和 Kinetrail 并排放在 code/ 下"),
)
