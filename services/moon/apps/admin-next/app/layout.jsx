/**
 * @file Root App Router layout for Moon's Next admin app.
 */

import "@once-ui-system/core/css/tokens.css";
import "@once-ui-system/core/css/styles.css";
import "./globals.css";
import {Suspense} from "react";
import AdminProviders from "../components/AdminProviders.jsx";
import AdminShell from "../components/AdminShell.jsx";

export const metadata = {
  title: "Scriptarr Admin",
  description: "Scriptarr's Arr-style admin surface."
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
        <Suspense>
          <AdminProviders>
            <AdminShell>{children}</AdminShell>
          </AdminProviders>
        </Suspense>
      </body>
    </html>
  );
}
