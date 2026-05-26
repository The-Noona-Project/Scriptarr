"use client";

/**
 * @file Non-blocking loading overlay for reader metadata loads.
 */

/**
 * Render the non-blocking loading overlay for reader metadata loads.
 *
 * @param {{active: boolean, label?: string}} props
 * @returns {import("react").ReactNode}
 */
export const GlobalLoadingOverlay = ({active, label = "Loading reader state."}) => {
  if (!active) {
    return null;
  }
  return (
    <div className="reader-global-loading-overlay" role="status" aria-live="polite" aria-label={label}>
      <div className="reader-global-loading-pill">
        <span className="reader-global-loading-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
};

export default GlobalLoadingOverlay;
