"use client";

/**
 * @file Shared Once UI app shell for Moon's Next-based user experience.
 */

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {Flex, MegaMenu, MobileMegaMenu} from "@once-ui-system/core";
import {loadMoonChromeContext} from "../lib/api.js";
import {buildLibraryPath, classifyPathname, getLibraryTypes} from "../lib/routes.js";
import MoonChromeContext from "./MoonChromeContext.jsx";
import ProfileMenu from "./ProfileMenu.jsx";
import SiteFooter from "./SiteFooter.jsx";

/**
 * Build MegaMenu groups for the Moon user shell.
 *
 * @param {string} pathname
 * @returns {import("@once-ui-system/core").MenuGroup[]}
 */
const buildMenuGroups = (pathname) => {
  const active = classifyPathname(pathname);
  const librarySections = [
    {
      links: getLibraryTypes().map((entry) => ({
        label: entry.label,
        href: buildLibraryPath(entry.slug),
        selected: pathname === buildLibraryPath(entry.slug)
      }))
    }
  ];

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
 * Wrap every user page in Moon's Once UI shell.
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
    loginUrl: "",
    installAvailable: false,
    promptInstall: async () => false
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);

  useEffect(() => {
    let active = true;
    void loadMoonChromeContext().then((nextValue) => {
      if (active) {
        setChrome(nextValue);
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

  const menuGroups = useMemo(() => buildMenuGroups(pathname), [pathname]);
  const title = chrome.branding?.siteName || "Scriptarr";
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
            <Link className="moon-brandmark" href="/"><strong>{title}</strong></Link>
            <Flex gap="16" vertical="center" className="moon-header-actions">
              <div className="moon-nav-desktop">
                <MegaMenu menuGroups={menuGroups} />
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
                    <MobileMegaMenu menuGroups={menuGroups} onClose={() => setMobileMenuOpen(false)} />
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
