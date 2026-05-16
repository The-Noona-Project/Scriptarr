"use client";

/**
 * @file Shared app shell for Moon's Next-based user experience.
 */

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {loadMoonChromeContext, loadMoonLoginUrl, requestJson} from "../lib/api.js";
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
 * @returns {Array<Record<string, any>>}
 */
const buildMenuGroups = (pathname, libraryTypes = []) => {
  const active = classifyPathname(pathname);
  const libraryLinks = libraryTypes.map((entry) => ({
    label: entry.label,
    href: buildLibraryPath(entry.slug),
    selected: pathname === buildLibraryPath(entry.slug)
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
      id: "browse",
      label: "Browse",
      href: "/browse",
      selected: active === "browse"
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

/**
 * Wrap every user page in Moon's local Next shell.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const MoonShell = ({children}) => {
  const pathname = usePathname();
  const [chrome, setChrome] = useState({
    branding: {siteName: "Scriptarr"},
    auth: null,
    bootstrap: null,
    libraryTypes: [],
    loginUrl: "",
    installAvailable: false,
    promptInstall: async () => false
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);

  useEffect(() => {
    let active = true;
    const query = typeof window === "undefined" ? "" : window.location.search || "";
    const currentRoute = query ? `${pathname}${query}` : pathname;
    void loadMoonChromeContext(currentRoute).then((nextValue) => {
      if (active) {
        setChrome(nextValue);
      }
      if (active && nextValue.auth) {
        void requestJson("/api/moon-v3/user/library?view=card&pageSize=1").then((result) => {
          if (active && result.ok) {
            setChrome((current) => ({
              ...current,
              libraryTypes: getLibraryTypes(result.payload?.counts?.byType)
            }));
          }
        });
      }
      if (active && !nextValue.auth) {
        void loadMoonLoginUrl(currentRoute).then((loginUrl) => {
          if (active && loginUrl) {
            setChrome((current) => current.auth ? current : {...current, loginUrl});
          }
        });
      }
    });

    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  const menuGroups = useMemo(() => buildMenuGroups(pathname, chrome.libraryTypes), [chrome.libraryTypes, pathname]);
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
      <div className="moon-app-shell">
        <header className="moon-header">
          <div className="moon-header-top">
            <Link className="moon-brandmark" href="/">
              {logoUrl ? <img src={logoUrl} alt="" /> : null}
              <strong>{title}</strong>
            </Link>
            <Flex gap="16" vertical="center" className="moon-header-actions">
              <div className="moon-nav-desktop">
                <DesktopNavigation menuGroups={menuGroups} />
              </div>
              <div className="moon-nav-mobile">
                <button
                  className="moon-mobile-menu-trigger"
                  type="button"
                  onClick={() => setMobileMenuOpen((value) => !value)}
                >
                  {mobileMenuOpen ? "Close" : "Menu"}
                </button>
                {mobileMenuOpen ? (
                  <div className="moon-mobile-menu-surface">
                    <MobileNavigation menuGroups={menuGroups} onClose={() => setMobileMenuOpen(false)} />
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
    </MoonChromeContext.Provider>
  );
};

export default MoonShell;
