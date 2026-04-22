"use client";

/**
 * @file Shared Once UI providers for Moon's Next user app.
 */

import {DataThemeProvider, LayoutProvider, ThemeProvider} from "@once-ui-system/core";

/**
 * Mount Once UI theme providers around the Moon user app.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const UserProviders = ({children}) => (
  <ThemeProvider
    theme="system"
    neutral="slate"
    brand="orange"
    accent="indigo"
    solid="contrast"
    solidStyle="flat"
    border="rounded"
    surface="translucent"
    transition="all"
    scaling="100"
  >
    <DataThemeProvider>
      <LayoutProvider>{children}</LayoutProvider>
    </DataThemeProvider>
  </ThemeProvider>
);

export default UserProviders;
