package com.icomon.icbodyfatalgorithms;

import java.util.HashMap;
import java.util.Map;

/** 用设备上的算法库批量生成参考向量，给纯代码实现对账用。
 *
 *  输入是确定性的合成网格（不是真人读数），覆盖三档系数表、两种性别、两种体型。
 *  每行一条 JSON。用法见同目录 README.md。 */
public class Vectors {

    static final int[] HEIGHTS = {150, 164, 175, 190};
    static final int[] AGES = {18, 30, 45, 60};
    static final double[] WEIGHTS = {45.0, 62.0, 78.5, 95.0};
    // 三组阻抗，(前五之和/身高) 分别落在 <9 / 9-12 / >=12 三档
    static final double[][] IMPS = {
        {30.0, 330.0, 315.0, 285.0, 265.0, 25.0, 290.0, 275.0, 245.0, 230.0},
        {40.0, 420.0, 405.0, 390.0, 375.0, 35.0, 380.0, 365.0, 350.0, 335.0},
        {60.0, 560.0, 545.0, 530.0, 515.0, 50.0, 500.0, 485.0, 470.0, 455.0},
    };

    static final String[] OUT = {
        "bmi", "bfr", "muscle", "subcutfat", "vfal", "water", "sm", "bone",
        "protein", "bmr", "age", "bodyScore",
        "leftArmBodyfatMass", "leftArmBodyfatPercentage", "leftArmMuscleMass", "leftArmMuscle",
        "rightArmBodyfatMass", "rightArmBodyfatPercentage", "rightArmMuscleMass", "rightArmMuscle",
        "leftLegBodyfatMass", "leftLegBodyfatPercentage", "leftLegMuscleMass", "leftLegMuscle",
        "rightLegBodyfatMass", "rightLegBodyfatPercentage", "rightLegMuscleMass", "rightLegMuscle",
        "trunkBodyfatMass", "trunkBodyfatPercentage", "trunkMuscleMass", "trunkMuscle",
    };

    public static void main(String[] args) {
        System.load(args[0]);
        int algType = args.length > 1 ? Integer.parseInt(args[1]) : 36;

        for (int hi = 0; hi < HEIGHTS.length; hi++) {
            for (int ai = 0; ai < AGES.length; ai++) {
                for (int wi = 0; wi < WEIGHTS.length; wi++) {
                    for (int zi = 0; zi < IMPS.length; zi++) {
                        for (int sex = 0; sex <= 1; sex++) {
                            for (int people = 0; people <= 1; people++) {
                                emit(WEIGHTS[wi], HEIGHTS[hi], AGES[ai], sex, algType,
                                     people, IMPS[zi]);
                            }
                        }
                    }
                }
            }
        }
    }

    static void emit(double w, int h, int age, int sex, int algType, int people, double[] z) {
        HashMap<String, Object> r;
        try {
            r = ICBodyFatAlgorithms.native_calc(Main.params(w, h, age, sex, algType, people, z));
        } catch (Throwable e) {
            return;
        }
        if (r == null || r.isEmpty()) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("{\"w\":").append(w).append(",\"h\":").append(h)
          .append(",\"age\":").append(age).append(",\"sex\":").append(sex)
          .append(",\"p\":").append(people).append(",\"z\":[");
        for (int i = 0; i < z.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(z[i]);
        }
        sb.append("],\"out\":{");
        boolean first = true;
        for (String k : OUT) {
            Object v = r.get(k);
            if (!(v instanceof Number)) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(k).append("\":").append(((Number) v).doubleValue());
        }
        sb.append("}}");
        System.out.println(sb);
    }
}

/* 结果里 code != 0 的行由算法自己判定为无效输入，上面直接跳过。 */
