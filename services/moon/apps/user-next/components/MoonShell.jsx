"use client";

/**
 * @file Shared app shell for Moon's Next-based user experience.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {buildMoonLoginHref, loadMoonChromeContext, requestJson} from "../lib/api.js";
import {normalizeBrowseType} from "../lib/browse.js";
import {startUserLiveInvalidation} from "../lib/live.js";
import {buildLibraryPath, classifyPathname, getLibraryTypes} from "../lib/navigationRoutes.js";
import {Flex} from "./UiPrimitives.jsx";
import {DesktopNavigation, MobileNavigation} from "./LocalNavigation.jsx";
import MoonChromeContext from "./MoonChromeContext.jsx";
import ProfileMenu from "./ProfileMenu.jsx";
import SiteFooter from "./SiteFooter.jsx";

/**
 * Build navigation groups for the Moon user shell.
 *
 * @param {string} pathname
 * @param {Array<{slug: string, label: string}>} libraryTypes
 * @param {string} activeType
 * @returns {Array<Record<string, any>>}
 */
const buildMenuGroups = (pathname, libraryTypes = [], activeType = "") => {
  const active = classifyPathname(pathname);
  const libraryLinks = libraryTypes.map((entry) => ({
    label: entry.label,
    href: buildLibraryPath(entry.slug),
    selected: active === "library" && entry.slug === activeType
  }));
  const librarySections = libraryLinks.length ? [{links: libraryLinks}] : [];

  return [
    {
      id: "home",
      label: "Home",
      href: "/",
      selected: active === "home"
    },
    {
      id: "library",
      label: "Library",
      href: "/library",
      selected: active === "library" || active === "title" || active === "reader",
      sections: librarySections
    },
    {
      id: "requests",
      label: "Requests",
      href: "/myrequests",
      selected: active === "requests"
    },
    {
      id: "following",
      label: "Following",
      href: "/following",
      selected: active === "following"
    }
  ];
};

const AuthResolvingSurface = ({label = "Checking session."}) => (
  <div className="moon-auth-resolving" role="status" aria-live="polite">
    <span>{label}</span>
  </div>
);

const CHROME_RETRY_DELAYS_MS = [1000, 2500, 5000, 10000];

const UserLiveSync = ({enabled}) => {
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return startUserLiveInvalidation();
  }, [enabled]);
  return null;
};

const mergeMoonChromeResult = (current, nextValue, localLoginUrl) => {
  const brokerDelayed = Boolean(nextValue.authError || nextValue.bootstrapError);
  const auth = nextValue.auth || (brokerDelayed ? current.auth : null);
  return {
    ...current,
    ...nextValue,
    auth,
    branding: nextValue.branding || current.branding,
    bootstrap: nextValue.bootstrap || current.bootstrap,
    libraryTypes: nextValue.libraryTypes?.length ? nextValue.libraryTypes : current.libraryTypes,
    loaded: true,
    loginUrl: auth ? "" : nextValue.loginUrl || localLoginUrl
  };
};

/**
 * Wrap every user page in Moon's local Next shell.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const MoonShell = ({children}) => {
  const pathname = usePathname();
  const publicPathname = pathname || "/";
  const isLoginRoute = publicPathname === "/login";
  const [queryType, setQueryType] = useState("");
  const [chrome, setChrome] = useState({
    branding: {siteName: "Scriptarr"},
    auth: null,
    loaded: false,
    bootstrap: null,
    libraryTypes: [],
    authError: "",
    bootstrapError: "",
    loginUrl: buildMoonLoginHref(publicPathname),
    installAvailable: false,
    promptInstall: async () => false
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const libraryTypesLoadingRef = useRef(false);
  const chromeRetryCountRef = useRef(0);
  const sessionDelayed = Boolean(chrome.authError) || Boolean(chrome.bootstrapError);
  const syncQueryTypeFromLocation = useCallback(() => {
    try {
      const nextType = String(new URLSearchParams(window.location.search).get("type") || "").trim();
      setQueryType(nextType ? normalizeBrowseType(nextType) : "");
    } catch {
      setQueryType("");
    }
  }, []);

  useEffect(() => {
    let active = true;
    const currentRoute = typeof window === "undefined"
      ? publicPathname
      : `${window.location.pathname}${window.location.search}`;
    const localLoginUrl = buildMoonLoginHref(currentRoute);
    setChrome((current) => current.auth ? current : {...current, loginUrl: localLoginUrl});
    void loadMoonChromeContext(currentRoute).then((nextValue) => {
      if (active) {
        if (!nextValue.authError && !nextValue.bootstrapError) {
          chromeRetryCountRef.current = 0;
        }
        setChrome((current) => mergeMoonChromeResult(current, nextValue, localLoginUrl));
      }
    });

    return () => {
      active = false;
    };
  }, [publicPathname]);

  useEffect(() => {
    if (!chrome.loaded || !sessionDelayed) {
      return undefined;
    }
    let cancelled = false;
    let timer = 0;
    const retryChrome = () => {
      const currentRoute = `${window.location.pathname}${window.location.search}`;
      const localLoginUrl = buildMoonLoginHref(currentRoute);
      void loadMoonChromeContext(currentRoute).then((nextValue) => {
        if (cancelled) {
          return;
        }
        if (!nextValue.authError && !nextValue.bootstrapError) {
          chromeRetryCountRef.current = 0;
        }
        setChrome((current) => mergeMoonChromeResult(current, nextValue, localLoginUrl));
        if (nextValue.authError || nextValue.bootstrapError) {
          scheduleRetry();
        }
      });
    };
    const scheduleRetry = () => {
      const delay = CHROME_RETRY_DELAYS_MS[Math.min(chromeRetryCountRef.current, CHROME_RETRY_DELAYS_MS.length - 1)];
      chromeRetryCountRef.current += 1;
      timer = window.setTimeout(retryChrome, delay);
    };
    scheduleRetry();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chrome.authError, chrome.bootstrapError, chrome.loaded, isLoginRoute, sessionDelayed]);

  useEffect(() => {
    if (isLoginRoute || !chrome.loaded || chrome.auth || sessionDelayed) {
      return;
    }
    window.location.replace(buildMoonLoginHref(`${window.location.pathname}${window.location.search}`));
  }, [chrome.auth, chrome.loaded, isLoginRoute, sessionDelayed]);

  useEffect(() => {
    syncQueryTypeFromLocation();
    window.addEventListener("popstate", syncQueryTypeFromLocation);
    return () => {
      window.removeEventListener("popstate", syncQueryTypeFromLocation);
    };
  }, [pathname, syncQueryTypeFromLocation]);

  const ensureLibraryTypes = useCallback(() => {
    if (!chrome.auth || chrome.libraryTypes.length || libraryTypesLoadingRef.current) {
      return;
    }
    libraryTypesLoadingRef.current = true;
    void requestJson("/api/moon-v3/user/library?view=card&pageSize=1").then((result) => {
      if (result.ok) {
        setChrome((current) => ({
          ...current,
          libraryTypes: getLibraryTypes(result.payload?.counts?.byType)
        }));
      }
    }).finally(() => {
      libraryTypesLoadingRef.current = false;
    });
  }, [chrome.auth, chrome.libraryTypes.length]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  const activeType = useMemo(() => {
    if (queryType) {
      return queryType;
    }
    const pathMatch = String(pathname || "").match(/^\/library\/([^/?#]+)/);
    if (pathMatch?.[1]) {
      try {
        return normalizeBrowseType(decodeURIComponent(pathMatch[1]));
      } catch {
        return normalizeBrowseType(pathMatch[1]);
      }
    }
    return "";
  }, [pathname, queryType]);
  const menuGroups = useMemo(() => buildMenuGroups(pathname, chrome.libraryTypes, activeType), [activeType, chrome.libraryTypes, pathname]);
  const title = chrome.branding?.siteName || "Scriptarr";
  const logoUrl = chrome.branding?.logo?.urls?.chrome || "";
  const promptInstall = useMemo(() => async () => {
    if (!installPrompt) {
      return false;
    }
    await installPrompt.prompt();
    setInstallPrompt(null);
    return true;
  }, [installPrompt]);
  const chromeContextValue = useMemo(() => ({
    ...chrome,
    installAvailable: Boolean(installPrompt),
    promptInstall
  }), [chrome, installPrompt, promptInstall]);

  return (
    <MoonChromeContext.Provider value={chromeContextValue}>
      <UserLiveSync enabled={Boolean(chrome.auth)} />
      {isLoginRoute ? (
        <div className="moon-login-shell">
          <main className="moon-login-stage">{children}</main>
        </div>
      ) : !chrome.loaded || !chrome.auth ? (
        <AuthResolvingSurface label={sessionDelayed ? "Session check is delayed. Retrying." : chrome.loaded ? "Opening login." : "Checking session."} />
      ) : (
        <div className="moon-app-shell">
          <header className="moon-header">
            <div className="moon-header-top">
              <Link className="moon-brandmark" href="/">
                {logoUrl ? <img src={logoUrl} alt="" /> : null}
                <strong>{title}</strong>
              </Link>
              <Flex gap="16" vertical="center" className="moon-header-actions">
                <div className="moon-nav-desktop">
                  <DesktopNavigation menuGroups={menuGroups} onGroupOpen={(group) => {
                    if (group?.id === "library") {
                      syncQueryTypeFromLocation();
                      ensureLibraryTypes();
                    }
                  }} />
                </div>
                <div className="moon-nav-mobile">
                  <button
                    className="moon-mobile-menu-trigger"
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen((value) => {
                        const nextValue = !value;
                        if (nextValue) {
                          ensureLibraryTypes();
                        }
                        return nextValue;
                      });
                    }}
                  >
                    {mobileMenuOpen ? "Close" : "Menu"}
                  </button>
                  {mobileMenuOpen ? (
                    <div className="moon-mobile-menu-surface">
                      <MobileNavigation
                        menuGroups={menuGroups}
                        onClose={() => setMobileMenuOpen(false)}
                        onGroupOpen={(group) => {
                          if (group?.id === "library") {
                            syncQueryTypeFromLocation();
                            ensureLibraryTypes();
                          }
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                <ProfileMenu user={chrome.auth} loginUrl={chrome.loginUrl} />
              </Flex>
            </div>
          </header>
          <main className="moon-main-stage">{children}</main>
          <SiteFooter siteName={title} />
        </div>
      )}
    </MoonChromeContext.Provider>
  );
};

export default MoonShell;
