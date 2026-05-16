import BrowsePageClient from "../../components/pages/BrowsePageClient.jsx";

export default async function BrowsePage({searchParams}) {
  return <BrowsePageClient initialSearchParams={await searchParams} />;
}
