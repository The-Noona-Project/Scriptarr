import LibraryPageClient from "../../../components/pages/LibraryPageClient.jsx";

export default async function LibraryTypePage({params}) {
  const resolved = await params;
  return <LibraryPageClient typeSlug={resolved.type} />;
}
