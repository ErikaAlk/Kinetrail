package com.icomon.icbodyfatalgorithms;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Same package + class name as the app's, so JNI resolves
 *  Java_com_icomon_icbodyfatalgorithms_ICBodyFatAlgorithms_native_1calc.
 *  The two helpers are called back BY the native code to walk the map. */
public class ICBodyFatAlgorithms {
    public static native HashMap<String, Object> native_calc(HashMap<String, Object> map);

    public static List<String> getKeysFromMap(Map<String, Object> map) {
        return new ArrayList<>(map.keySet());
    }

    public static int getObjectType(Object obj) {
        if (obj instanceof Integer) return 1;
        if (obj instanceof Double) return 2;
        if (obj instanceof String) return 3;
        if (obj instanceof List) return 4;
        if (obj instanceof Map) return 5;
        if (obj instanceof byte[]) return 6;
        if (obj instanceof Long) return 7;
        if (obj instanceof Float) return 8;
        if (obj instanceof Byte) return 9;
        return obj instanceof Short ? 10 : 0;
    }
}
