"use client";

/**
 * @file Canonical library route wrapper for the unified catalogue.
 */

import CataloguePageClient from "./CataloguePageClient.jsx";

/**
 * Render the canonical `/library` catalogue, optionally seeded by a legacy type route.
 *
 * @param {{typeSlug?: string, initialSearchParams?: Record<string, string | string[] | undefined>}} props
 * @returns {import("react").ReactNode}
 */
export const LibraryPageClient = ({typeSlug = "", initialSearchParams = {}} = {}) => (
  <CataloguePageClient initialSearchParams={initialSearchParams} initialTypeSlug={typeSlug} entry="library" />
);

export default LibraryPageClient;
