package com.scriptarr.raven.settings;

import java.io.IOException;

/** An HTTP broker rejection whose status survives wrapping and checkpoint recovery. */
public final class BrokerRequestException extends IOException {
    private final int status;

    /** @param status HTTP result @param message bounded broker diagnostic */
    public BrokerRequestException(int status, String message) { super(message); this.status = status; }

    /** @return authoritative HTTP status, independent of response text */
    public int status() { return status; }

    /** @return whether this rejection can represent a temporarily unavailable broker */
    public boolean transientFailure() { return status == 502 || status == 503 || status == 504; }
}
