/**
 * @file Root App Router layout for Moon's Once UI-powered admin app.
 */

import "@once-ui-system/core/css/tokens.css";
import "@once-ui-system/core/css/styles.css";
import "./globals.css";
import {Suspense} from "react";
import {ThemeInit} from "@once-ui-system/core";
import AdminProviders from "../components/AdminProviders.jsx";
import AdminShell from "../components/AdminShell.jsx";

export const metadata = {
  title: "Scriptarr Admin",
  description: "Moon's Arr-style admin surface for Scriptarr."
};

const themeConfig = {
  theme: "dark",
  brand: "orange",
  accent: "cyan",
  neutral: "slate",
  solid: "contrast",
  "solid-style": "flat",
  border: "rounded",
  surface: "filled",
  transition: "all",
  scaling: "95",
  "viz-style": "categorical"
};

/**
 * Mount the Moon admin layout.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export default function RootLayout({children}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeInit config={themeConfig} />
        <Suspense>
          <AdminProviders>
            <AdminShell>{children}</AdminShell>
          </AdminProviders>
        </Suspense>
      </body>
    </html>
  );
}
