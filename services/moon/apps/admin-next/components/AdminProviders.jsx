"use client";

/**
 * @file Shared Once UI providers and auth context for Moon admin.
 */

import {createContext, useContext, useEffect, useMemo, useState} from "react";
import {usePathname, useSearchParams} from "next/navigation";
import {DataThemeProvider, LayoutProvider, ThemeProvider} from "@once-ui-system/core";
import {canAccessAdmin} from "../lib/access.js";
import {loadAdminChromeContext} from "../lib/api.js";
import {AdminToastProvider} from "./AdminToasts.jsx";

const AdminChromeContext = createContext({
  branding: {siteName: "Scriptarr"},
  user: null,
  bootstrap: null,
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
 * Mount Once UI and Moon admin auth providers.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const AdminProviders = ({children}) => (
  <ThemeProvider
    theme="dark"
    neutral="slate"
    brand="orange"
    accent="cyan"
    solid="contrast"
    solidStyle="flat"
    border="rounded"
    surface="filled"
    transition="all"
    scaling="95"
  >
    <DataThemeProvider>
      <LayoutProvider>
        <AdminChromeProvider>{children}</AdminChromeProvider>
      </LayoutProvider>
    </DataThemeProvider>
  </ThemeProvider>
);

const AdminChromeProvider = ({children}) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [chrome, setChrome] = useState({
    branding: {siteName: "Scriptarr"},
    user: null,
    bootstrap: null,
    loginUrl: "",
    loading: true
  });

  const refreshChrome = useMemo(() => async () => {
    const query = searchParams?.toString();
    const publicPathname = toPublicAdminPath(pathname);
    const returnTo = query ? `${publicPathname}?${query}` : publicPathname;
    setChrome((current) => ({...current, loading: true}));
    const nextChrome = await loadAdminChromeContext(returnTo);
    setChrome({
      ...nextChrome,
      loading: false
    });
  }, [pathname, searchParams]);

  useEffect(() => {
    let active = true;
    const query = searchParams?.toString();
    const publicPathname = toPublicAdminPath(pathname);
    const returnTo = query ? `${publicPathname}?${query}` : publicPathname;
    setChrome((current) => ({...current, loading: true}));
    void loadAdminChromeContext(returnTo).then((nextChrome) => {
      if (active) {
        setChrome({
          ...nextChrome,
          loading: false
        });
      }
    });

    return () => {
      active = false;
    };
  }, [pathname, searchParams]);

  const value = useMemo(() => ({
    ...chrome,
    canAccessAdmin: canAccessAdmin(chrome.user),
    refreshChrome
  }), [chrome, refreshChrome]);

  return (
    <AdminChromeContext.Provider value={value}>
      <AdminToastProvider user={chrome.user}>{children}</AdminToastProvider>
    </AdminChromeContext.Provider>
  );
};

export default AdminProviders;
