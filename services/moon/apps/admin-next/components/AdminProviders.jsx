"use client";

/**
 * @file Shared auth context and browser providers for Moon admin.
 */

import {createContext, useContext, useEffect, useMemo, useState} from "react";
import {usePathname, useSearchParams} from "next/navigation";
import {canAccessAdmin} from "../lib/access.js";
import {AdminEventStreamProvider, buildAdminLoginHref, loadAdminChromeContext, useAdminEventSubscription} from "../lib/api.js";
import {AdminToastProvider} from "./AdminToasts.jsx";

const AdminChromeContext = createContext({
  branding: {siteName: "Scriptarr"},
  user: null,
  bootstrap: null,
  authError: "",
  bootstrapError: "",
  loginUrl: "",
  loading: true,
  canAccessAdmin: false,
  refreshChrome: async () => {}
});

const toPublicAdminPath = (pathname) => {
  const normalized = pathname || "/";
  if (normalized.startsWith("/admin")) {
    return normalized;
  }
  return `/admin${normalized === "/" ? "" : normalized}`;
};

/**
 * Read the admin chrome context.
 *
 * @returns {React.ContextType<typeof AdminChromeContext>}
 */
export const useAdminChrome = () => useContext(AdminChromeContext);

/**
 * Mount Moon admin auth providers.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const AdminProviders = ({children}) => (
  <AdminChromeProvider>{children}</AdminChromeProvider>
);

const AdminChromeEventSync = ({enabled, onRefresh}) => {
  useAdminEventSubscription({
    domains: ["auth", "users", "access"],
    enabled,
    onEvent: () => {
      void onRefresh?.();
    }
  });
  return null;
};

const AdminChromeProvider = ({children}) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchQuery = searchParams?.toString() || "";
  const publicPathname = toPublicAdminPath(pathname);
  const returnTo = useMemo(
    () => searchQuery ? `${publicPathname}?${searchQuery}` : publicPathname,
    [publicPathname, searchQuery]
  );
  const [chrome, setChrome] = useState({
    branding: {siteName: "Scriptarr"},
    user: null,
    bootstrap: null,
    authError: "",
    bootstrapError: "",
    loginUrl: buildAdminLoginHref(returnTo),
    loading: true
  });

  const refreshChrome = useMemo(() => async () => {
    const localLoginUrl = buildAdminLoginHref(returnTo);
    setChrome((current) => ({...current, loading: true, loginUrl: current.user ? "" : localLoginUrl}));
    const nextChrome = await loadAdminChromeContext(returnTo);
    setChrome({
      ...nextChrome,
      loginUrl: nextChrome.user ? "" : nextChrome.loginUrl || localLoginUrl,
      loading: false
    });
  }, [returnTo]);

  useEffect(() => {
    let active = true;
    const localLoginUrl = buildAdminLoginHref(returnTo);
    setChrome((current) => ({...current, loading: true, loginUrl: current.user ? "" : localLoginUrl}));
    void loadAdminChromeContext(returnTo).then((nextChrome) => {
      if (active) {
        setChrome({
          ...nextChrome,
          loginUrl: nextChrome.user ? "" : nextChrome.loginUrl || localLoginUrl,
          loading: false
        });
      }
    });

    return () => {
      active = false;
    };
  }, [returnTo]);

  useEffect(() => {
    if (typeof window === "undefined" || chrome.loading || chrome.user || chrome.authError || !chrome.loginUrl) {
      return;
    }
    window.location.replace(chrome.loginUrl);
  }, [chrome.authError, chrome.loading, chrome.loginUrl, chrome.user]);

  const value = useMemo(() => ({
    ...chrome,
    canAccessAdmin: canAccessAdmin(chrome.user),
    refreshChrome
  }), [chrome, refreshChrome]);

  return (
    <AdminChromeContext.Provider value={value}>
      <AdminEventStreamProvider user={chrome.user}>
        <AdminChromeEventSync enabled={Boolean(chrome.user)} onRefresh={refreshChrome} />
        <AdminToastProvider user={chrome.user}>{children}</AdminToastProvider>
      </AdminEventStreamProvider>
    </AdminChromeContext.Provider>
  );
};

export default AdminProviders;
