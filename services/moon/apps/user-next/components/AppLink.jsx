/** @file User-app links that preserve the separate reader/admin runtime boundary. */
import Link from "next/link";
import {crossesAppBoundary} from "../lib/appNavigation.js";

/**
 * Navigate normally across applications while retaining user-app client navigation.
 * @param {import("react").AnchorHTMLAttributes<HTMLAnchorElement> & {href: string}} props
 * @returns {import("react").ReactNode}
 */
export const AppLink = ({href, ...props}) => crossesAppBoundary(href)
  ? <a href={href} {...props} />
  : <Link href={href} {...props} />;

export default AppLink;
