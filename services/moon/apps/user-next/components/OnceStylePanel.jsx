"use client";

/**
 * @file Lazy bridge for the profile-only Once UI style panel.
 */

import {StylePanel} from "@once-ui-system/core";

/**
 * Render the Once UI browser-local style panel outside the first-load shell.
 *
 * @returns {import("react").ReactNode}
 */
export const OnceStylePanel = () => <StylePanel />;

export default OnceStylePanel;
