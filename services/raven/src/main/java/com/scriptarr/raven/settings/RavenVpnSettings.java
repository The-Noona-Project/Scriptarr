package com.scriptarr.raven.settings;

public record RavenVpnSettings(
    boolean enabled,
    String region,
    String piaUsername,
    String piaPassword
) {
}

