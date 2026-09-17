import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// 服务端地址不进仓库：写在 android/local.properties 的 kinetrail.origin（和 sdk.dir 同一个文件，git 忽略）。
val kinetrailOrigin: String = Properties()
    .apply { rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
    .getProperty("kinetrail.origin")?.trim()?.trimEnd('/')
    ?.takeIf { it.startsWith("https://") }
    ?: throw GradleException("android/local.properties 里要有 kinetrail.origin=https://<你的 Kinetrail 域名>")

android {
    namespace = "click.erikaalk.kinetrail.hc"
    compileSdk = 36

    defaultConfig {
        applicationId = "click.erikaalk.kinetrail.hc"
        // 只给本人手机（Android 16）用；34 起 HC 是系统模块，不用处理独立 HC App 的分支。
        minSdk = 34
        targetSdk = 36
        versionCode = 7
        versionName = "0.7.0"
        // 本人手机是 arm64；x86_64 留给模拟器验证识图。ML Kit 中文识别模型按 ABI 打包，不留其他架构。
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        buildConfigField("String", "KINETRAIL_ORIGIN", "\"$kinetrailOrigin\"")
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")

    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    // 顶栏背后的真背景模糊（全局 4.6 不许手写采样）。1.7+ 用 Kotlin 2.3 编译，与 2.2.20 不兼容。
    implementation("dev.chrisbanes.haze:haze:1.6.10")

    // 报告识图：打包进 APK 的中文模型，离线运行，图片不出手机。
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")

    testImplementation("junit:junit:4.13.2")
    // 单测里解析日历响应用的 org.json 实现；Android 自带的那份在 JVM 单测里是会抛异常的桩。
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.2.20")
}
