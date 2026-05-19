import {notFound} from "next/navigation";
import {headers} from "next/headers";

import ReaderAppClient from "../../components/ReaderAppClient.jsx";
import ReaderLanding from "../../components/ReaderLanding.jsx";

const READER_BOOT_PAGE_SIZE = 18;

const readerApiBase = () => {
  const configured = String(process.env.SCRIPTARR_MOON_INTERNAL_BASE_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const port = String(process.env.SCRIPTARR_MOON_PORT || process.env.PORT || "3000").trim();
  return `http://127.0.0.1:${port}`;
};

const readHeaderValue = (headerList, name) => {
  const value = headerList.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const fetchReaderJson = async (path, headerList) => {
  const cookie = readHeaderValue(headerList, "cookie");
  if (!cookie) {
    return null;
  }
  const host = readHeaderValue(headerList, "x-forwarded-host") || readHeaderValue(headerList, "host");
  const proto = readHeaderValue(headerList, "x-forwarded-proto") || "http";
  const requestHeaders = {
    accept: "application/json",
    cookie
  };
  if (host) {
    requestHeaders.host = host;
    requestHeaders["x-forwarded-host"] = host;
  }
  if (proto) {
    requestHeaders["x-forwarded-proto"] = proto;
  }
  try {
    const response = await fetch(`${readerApiBase()}${path}`, {
      cache: "no-store",
      headers: requestHeaders
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
};

const loadReaderBootData = async ({titleId, chapterId}) => {
  const headerList = await headers();
  const sessionPath = `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(chapterId)}/session`;
  const session = await fetchReaderJson(sessionPath, headerList);
  if (!session?.chapter?.id) {
    return {initialSessionData: null, initialPagesData: null};
  }
  const params = new URLSearchParams({
    cursor: "0",
    pageSize: String(READER_BOOT_PAGE_SIZE)
  });
  if (session.pageRevision) {
    params.set("rev", session.pageRevision);
  }
  const pagesPath = `/api/moon-v3/user/reader/title/${encodeURIComponent(titleId)}/chapter/${encodeURIComponent(session.chapter.id)}/pages?${params.toString()}`;
  const pages = await fetchReaderJson(pagesPath, headerList);
  return {
    initialSessionData: session,
    initialPagesData: pages?.pages ? pages : null
  };
};

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
    const bootData = await loadReaderBootData({titleId: parts[0], chapterId: parts[1]});
    return <ReaderAppClient titleId={parts[0]} chapterId={parts[1]} {...bootData} />;
  }
  if (parts.length === 3) {
    const bootData = await loadReaderBootData({titleId: parts[1], chapterId: parts[2]});
    return <ReaderAppClient titleId={parts[1]} chapterId={parts[2]} typeSlug={parts[0]} {...bootData} />;
  }
  notFound();
}
