"use client";

/**
 * @file Compatibility wrapper for the legacy browse route.
 */

import CataloguePageClient from "./CataloguePageClient.jsx";

/**
 * Render the legacy `/browse` entrypoint through the canonical catalogue.
 *
 * @param {{initialSearchParams?: Record<string, string | string[] | undefined>}} props
 * @returns {import("react").ReactNode}
 */
export const BrowsePageClient = ({initialSearchParams = {}} = {}) => (
  <CataloguePageClient initialSearchParams={initialSearchParams} entry="browse" />
);

export default BrowsePageClient;
