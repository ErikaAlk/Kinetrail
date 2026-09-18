package com.icomon.icbodyfatalgorithms;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** 调用沃莱的体成分算法：喂 P3 解出来的体重和阻抗，拿回 App 显示的那套指标。
 *
 *  用法见同目录 README.md。algType 传 -1 表示扫描 0..60，用来给新秤定算法号。 */
public class Main {

    static HashMap<String, Object> params(double weight, int height, int age, int sex,
                                          int algType, int peopleType, double[] imps) {
        HashMap<String, Object> m = new HashMap<>();
        m.put("weight", weight);
        m.put("height", height);
        m.put("age", age);
        m.put("sex", sex);
        m.put("algType", algType);
        m.put("peopleType", peopleType);
        m.put("standard", 0);
        m.put("enableGirth", 0);
        List<Double> list = new ArrayList<>();
        for (double z : imps) list.add(z);
        m.put("imps", list);
        m.put("impCount", list.size());
        for (int i = 0; i < 5 && i < imps.length; i++) m.put("imp" + (i + 1), imps[i]);
        return m;
    }

    static double num(Map<String, Object> r, String k) {
        Object v = r.get(k);
        return v instanceof Number ? ((Number) v).doubleValue() : Double.NaN;
    }

    public static void main(String[] args) {
        if (args.length < 7) {
            System.err.println("usage: Main <so路径> <体重kg> <身高cm> <年龄> <性别 1=男>"
                    + " <algType，-1 扫描> <体型 0普通/1运动员> <阻抗...>");
            System.exit(2);
        }
        System.load(args[0]);
        double weight = Double.parseDouble(args[1]);
        int height = Integer.parseInt(args[2]);
        int age = Integer.parseInt(args[3]);
        int sex = Integer.parseInt(args[4]);
        int algType = Integer.parseInt(args[5]);
        int peopleType = Integer.parseInt(args[6]);
        double[] imps = new double[args.length - 7];
        for (int i = 0; i < imps.length; i++) imps[i] = Double.parseDouble(args[7 + i]);

        if (algType >= 0) {
            HashMap<String, Object> r = ICBodyFatAlgorithms.native_calc(
                    params(weight, height, age, sex, algType, peopleType, imps));
            for (Map.Entry<String, Object> e : new TreeMap<>(r).entrySet()) {
                System.out.println(e.getKey() + " = " + e.getValue());
            }
            return;
        }

        // 扫描：新秤不知道算法号时，逐个试，拿 bfr 跟 App 显示的体脂率比对。
        System.out.println("algType  bfr   muscle  water   sm     bone");
        for (int t = 0; t <= 60; t++) {
            HashMap<String, Object> r;
            try {
                r = ICBodyFatAlgorithms.native_calc(
                        params(weight, height, age, sex, t, peopleType, imps));
            } catch (Throwable e) { continue; }
            double bfr = num(r, "bfr");
            if (Double.isNaN(bfr) || bfr == 0.0) continue;
            System.out.printf("%5d %7.1f %7.1f %7.1f %6.1f %6.1f%n", t, bfr,
                    num(r, "muscle"), num(r, "water"), num(r, "sm"), num(r, "bone"));
        }
    }
}
