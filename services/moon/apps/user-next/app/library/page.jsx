import LibraryPageClient from "../../components/pages/LibraryPageClient.jsx";

export default async function LibraryPage({searchParams}) {
  return <LibraryPageClient initialSearchParams={await searchParams} />;
}
