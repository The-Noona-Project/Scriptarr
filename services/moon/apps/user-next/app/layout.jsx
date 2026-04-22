/**
 * @file Root App Router layout for Moon's Once UI-powered user app.
 */

import "@once-ui-system/core/css/tokens.css";
import "@once-ui-system/core/css/styles.css";
import "./globals.css";
import {ThemeInit} from "@once-ui-system/core";
import UserProviders from "../components/UserProviders.jsx";
import MoonShell from "../components/MoonShell.jsx";

export const metadata = {
  title: "Scriptarr",
  description: "Moon's reading-first user surface built on Once UI."
};

const themeConfig = {
  theme: "system",
  brand: "orange",
  accent: "indigo",
  neutral: "slate",
  solid: "contrast",
  "solid-style": "flat",
  border: "rounded",
  surface: "translucent",
  transition: "all",
  scaling: "100",
  "viz-style": "categorical"
};

/**
 * Mount the Moon user layout.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export default function RootLayout({children}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeInit config={themeConfig} />
        <UserProviders>
          <MoonShell>{children}</MoonShell>
        </UserProviders>
      </body>
    </html>
  );
}
