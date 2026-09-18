# 调用沃莱的体成分算法

秤只上报体重和阻抗，其余指标由 App 算。这里是最小调用壳：在一台安卓设备上直接调
`libICBodyFatAlgorithms.so`，喂 `decode.py` 解出来的数，拿回 FitDays+ 界面上的那套值。
背景和协议见 `../../P3.md`。

不需要 root，不需要装 App。

## 取 `.so`

`.so` 是沃莱的，不在本仓库里。从装了 FitDays+ 的手机上取：

```bash
adb shell pm path cn.icomon.fitdayspro
```

原生库在 `split_config.arm64_v8a.apk` 里，解压后取 `lib/arm64-v8a/libICBodyFatAlgorithms.so`。

## 编译并运行

`.so` 链的是 bionic，**必须在安卓设备上跑**（glibc 机器直接 `dlopen` 不行，见 `../../P3.md`
第 5 节）。用 `app_process` 跑，不用打包成 App：

```bash
javac --release 11 -d classes *.java
```

```bash
d8 --output . classes/com/icomon/icbodyfatalgorithms/*.class && jar cf harness.jar classes.dex
```

```bash
adb push harness.jar libICBodyFatAlgorithms.so /data/local/tmp/
```

```bash
adb shell "CLASSPATH=/data/local/tmp/harness.jar app_process /data/local/tmp com.icomon.icbodyfatalgorithms.Main /data/local/tmp/libICBodyFatAlgorithms.so 70.0 170 30 1 36 0 30 300 300 280 280 25 280 280 250 250"
```

参数依次是：`.so` 路径、体重 kg、身高 cm、年龄、性别（1 = 男）、`algType`、体型
（0 普通 / 1 运动员），后面跟 10 个阻抗。上面这组是合成值。

**P3 的 `algType` 是 36**（A7 帧里写的是 WLA 编号 37，Java 枚举序号比名字小 1）。
换别的秤不知道算法号时，`algType` 传 `-1` 会扫描 0..60，拿 `bfr` 跟 App 显示的体脂率比对。

## 为什么壳类要同包同名

`ICBodyFatAlgorithms.java` 必须是 `com.icomon.icbodyfatalgorithms.ICBodyFatAlgorithms`，
JNI 才能按 `Java_com_icomon_icbodyfatalgorithms_ICBodyFatAlgorithms_native_1calc` 找到符号。

里面那两个静态方法 `getKeysFromMap` 和 `getObjectType` 不是摆设：**native 靠回调它们遍历传进去的
map**。少了它们，`native_calc` 返回的 map 字段齐全但全是零，而且不抛任何异常。
