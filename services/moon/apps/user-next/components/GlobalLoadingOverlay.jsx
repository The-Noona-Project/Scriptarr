"use client";

/**
 * @file Non-blocking loading overlay for the Moon user app.
 */

/**
 * Render the non-blocking loading overlay for user pages.
 *
 * @param {{active: boolean, label?: string}} props
 * @returns {import("react").ReactNode}
 */
export const GlobalLoadingOverlay = ({active, label = "Loading page."}) => {
  if (!active) {
    return null;
  }
  return (
    <div className="moon-global-loading-overlay" role="status" aria-live="polite" aria-label={label}>
      <div className="moon-global-loading-pill">
        <span className="moon-global-loading-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
};

export default GlobalLoadingOverlay;
