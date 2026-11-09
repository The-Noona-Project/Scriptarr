package com.scriptarr.raven.library;

import java.util.LinkedHashMap;
import java.util.Map;

/** Preserve scheduler attribution and priority without mutating frozen intake requests. */
public final class IngestExecutionContext implements AutoCloseable {
    private static final ThreadLocal<Map<String, Object>> CURRENT = new ThreadLocal<>();
    private final Map<String, Object> previous;

    /** @param kind interactive, bulk or migration @param attribution durable parent identities */
    private IngestExecutionContext(String kind, Map<String, Object> attribution) {
        previous = CURRENT.get(); Map<String, Object> next = new LinkedHashMap<>(attribution); next.put("kind", kind); CURRENT.set(Map.copyOf(next));
    }

    /** @param kind scheduler class @param attribution parent identities @return scoped immutable thread attribution */
    public static IngestExecutionContext enter(String kind, Map<String, Object> attribution) {
        if (!java.util.Set.of("interactive", "bulk", "migration").contains(kind)) throw new IllegalArgumentException("Invalid conversion priority.");
        return new IngestExecutionContext(kind, attribution);
    }

    /** @return current attribution or interactive default */
    public static Map<String, Object> current() { return CURRENT.get() == null ? Map.of("kind", "interactive") : CURRENT.get(); }

    /** Restore the previous scheduler context without leaking one user's attribution to another execution. */
    @Override public void close() { if (previous == null) CURRENT.remove(); else CURRENT.set(previous); }
}
