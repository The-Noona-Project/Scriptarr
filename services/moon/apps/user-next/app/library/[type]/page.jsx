import LibraryPageClient from "../../../components/pages/LibraryPageClient.jsx";

export default async function LibraryTypePage({params, searchParams}) {
  const resolved = await params;
  return <LibraryPageClient typeSlug={resolved.type} initialSearchParams={await searchParams} />;
}
