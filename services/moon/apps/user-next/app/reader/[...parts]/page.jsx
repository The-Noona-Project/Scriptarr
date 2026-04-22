import {notFound} from "next/navigation";

import ReaderPageClient from "../../../components/pages/ReaderPageClient.jsx";

export default async function ReaderPage({params}) {
  const resolved = await params;
  const parts = Array.isArray(resolved.parts) ? resolved.parts.filter(Boolean) : [];
  if (parts.length === 2) {
    return <ReaderPageClient titleId={parts[0]} chapterId={parts[1]} />;
  }
  if (parts.length === 3) {
    return (
      <ReaderPageClient
        titleId={parts[1]}
        chapterId={parts[2]}
        typeSlug={parts[0]}
      />
    );
  }
  notFound();
}
