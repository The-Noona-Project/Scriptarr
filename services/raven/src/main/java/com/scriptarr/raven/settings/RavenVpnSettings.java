package com.scriptarr.raven.settings;

/**
 * Normalized Raven VPN settings loaded from Vault plus secrets.
 *
 * @param enabled whether VPN-backed downloads should be attempted
 * @param region configured PIA region slug
 * @param piaUsername PIA account username
 * @param piaPassword PIA account password
 */
public record RavenVpnSettings(
    boolean enabled,
    String region,
    String piaUsername,
    String piaPassword
) {
}
