"use client";

/**
 * @file Non-blocking loading overlay for Moon admin.
 */

/**
 * Render the non-blocking loading overlay for admin pages.
 *
 * @param {{active: boolean, label?: string}} props
 * @returns {import("react").ReactNode}
 */
export const GlobalLoadingOverlay = ({active, label = "Loading admin data."}) => {
  if (!active) {
    return null;
  }
  return (
    <div className="admin-global-loading-overlay" role="status" aria-live="polite" aria-label={label}>
      <div className="admin-global-loading-pill">
        <span className="admin-global-loading-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
};

export default GlobalLoadingOverlay;
