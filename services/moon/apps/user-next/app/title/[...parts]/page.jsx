import {notFound} from "next/navigation";

import TitlePageClient from "../../../components/pages/TitlePageClient.jsx";

export default async function TitlePage({params}) {
  const resolved = await params;
  const parts = Array.isArray(resolved.parts) ? resolved.parts.filter(Boolean) : [];
  if (parts.length === 1) {
    return <TitlePageClient titleId={parts[0]} />;
  }
  if (parts.length === 2) {
    return <TitlePageClient titleId={parts[1]} typeSlug={parts[0]} />;
  }
  notFound();
}
