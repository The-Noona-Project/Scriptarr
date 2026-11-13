/** @file Navigation boundaries between Moon's independently mounted Next applications. */

/**
 * Reader and admin routes require a new document instead of the user app's RSC router.
 * @param {unknown} href Link destination.
 * @returns {boolean} Whether navigation crosses into a separate embedded application.
 */
export const crossesAppBoundary = href => typeof href === "string"
  && /^\/(reader|admin)(?:[/?#]|$)/.test(href);
