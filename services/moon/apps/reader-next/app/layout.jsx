/**
 * @file Root App Router layout for Moon's dedicated reader app.
 */

import "./globals.css";
import ReaderProviders from "../components/ReaderProviders.jsx";

export const metadata = {
  title: "Scriptarr Reader",
  description: "Moon's fullscreen reader application."
};

/**
 * Mount the fullscreen reader app without the normal Moon library chrome.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export default function RootLayout({children}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ReaderProviders>{children}</ReaderProviders>
      </body>
    </html>
  );
}
