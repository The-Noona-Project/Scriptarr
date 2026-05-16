import {notFound} from "next/navigation";

import ReaderAppClient from "../../components/ReaderAppClient.jsx";
import ReaderLanding from "../../components/ReaderLanding.jsx";

/**
 * Route every dedicated reader URL through the fullscreen reader program.
 *
 * @param {{params: Promise<{parts?: string[]}>}} props
 * @returns {Promise<import("react").ReactNode>}
 */
export default async function ReaderPage({params}) {
  const resolved = await params;
  const parts = Array.isArray(resolved.parts) ? resolved.parts.filter(Boolean) : [];
  if (parts.length === 0) {
    return <ReaderLanding />;
  }
  if (parts.length === 2) {
    return <ReaderAppClient titleId={parts[0]} chapterId={parts[1]} />;
  }
  if (parts.length === 3) {
    return <ReaderAppClient titleId={parts[1]} chapterId={parts[2]} typeSlug={parts[0]} />;
  }
  notFound();
}
