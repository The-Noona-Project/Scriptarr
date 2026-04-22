/**
 * @file Simple footer for Moon's Once UI user shell.
 */

import Link from "next/link";

/**
 * Render the Moon user-app footer.
 *
 * @param {{siteName: string}} props
 * @returns {import("react").ReactNode}
 */
export const SiteFooter = ({siteName}) => (
  <footer className="moon-footer">
    <div>
      <strong>{siteName}</strong>
      <p>Moon keeps reading, requests, follows, and Discord-driven library discovery in one place.</p>
    </div>
    <nav aria-label="Footer">
      <Link href="/">Home</Link>
      <Link href="/browse">Browse</Link>
      <Link href="/library">Library</Link>
      <Link href="/myrequests">Requests</Link>
      <Link href="/following">Following</Link>
    </nav>
  </footer>
);

export default SiteFooter;
