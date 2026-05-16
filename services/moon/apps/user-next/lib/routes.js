/**
 * @file Compatibility barrel for Moon's Next-based user route helpers.
 */

import {
  buildLibraryPath,
  buildProfilePath,
  canAccessAdmin,
  classifyPathname,
  formatTypeLabel,
  getLibraryTypes
} from "./navigationRoutes.js";
import {
  buildReaderPath,
  buildReaderPathForTitle,
  buildReaderPathForTitleTarget,
  buildTitlePath,
  buildTitlePathForTitle,
  resolveTitleTypeSlug
} from "./titleRoutes.js";

export {
  buildLibraryPath,
  buildProfilePath,
  buildReaderPath,
  buildReaderPathForTitle,
  buildReaderPathForTitleTarget,
  buildTitlePath,
  buildTitlePathForTitle,
  canAccessAdmin,
  classifyPathname,
  formatTypeLabel,
  getLibraryTypes,
  resolveTitleTypeSlug
};

export default {
  buildProfilePath,
  buildLibraryPath,
  buildReaderPath,
  buildReaderPathForTitle,
  buildReaderPathForTitleTarget,
  buildTitlePath,
  buildTitlePathForTitle,
  canAccessAdmin,
  classifyPathname,
  formatTypeLabel,
  getLibraryTypes,
  resolveTitleTypeSlug
};
