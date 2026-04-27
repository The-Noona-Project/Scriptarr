/**
 * @file Catch-all Moon admin route for the Next admin application.
 */

import AdminPageRouter from "../../components/AdminPageRouter.jsx";

/**
 * Render any known Moon admin path through the shared Next admin router.
 *
 * @param {{params: Promise<{segments?: string[]}>}} props
 * @returns {import("react").ReactNode}
 */
export default async function AdminCatchAllPage({params}) {
  const resolvedParams = await params;
  const segments = Array.isArray(resolvedParams?.segments) ? resolvedParams.segments : [];
  const pathname = `/admin${segments.length ? `/${segments.join("/")}` : ""}`;

  return <AdminPageRouter pathname={pathname} />;
}
