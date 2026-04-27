"use client";

/**
 * @file Dense Arr-style shell for Moon's Next admin foundation.
 */

import {useEffect} from "react";
import {usePathname} from "next/navigation";
import {filterRoutesForUser} from "../lib/access.js";
import {getAdminNavigationGroups, matchAdminRoute} from "../lib/routes.js";
import {useAdminChrome} from "./AdminProviders.jsx";

const toPublicAdminPath = (pathname) => {
  const normalized = pathname || "/";
  if (normalized.startsWith("/admin")) {
    return normalized;
  }
  return `/admin${normalized === "/" ? "" : normalized}`;
};

/**
 * Render the user identity block.
 *
 * @param {{user: any, loginUrl: string, bootstrap: any}} props
 * @returns {import("react").ReactNode}
 */
const IdentityCard = ({user, loginUrl, bootstrap}) => {
  if (!user) {
    return (
      <div className="admin-identity">
        <div className="admin-avatar">?</div>
        <div>
          <span>Admin session</span>
          <strong>Not signed in</strong>
          <small>{bootstrap?.ownerClaimed ? "Discord login required" : `First owner: ${bootstrap?.superuserId || "missing"}`}</small>
        </div>
        {loginUrl ? <a className="admin-button solid" href={loginUrl}>Sign in</a> : null}
      </div>
    );
  }

  const initials = String(user.username || "Admin").slice(0, 2).toUpperCase();
  return (
    <div className="admin-identity">
      <a className="admin-avatar" href="/" aria-label="Open user app">
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials}
      </a>
      <div>
        <span>Admin session</span>
        <strong>{user.username || "Admin"}</strong>
        <small>{user.role || "staff"}</small>
      </div>
    </div>
  );
};

/**
 * Wrap admin routes in the shared shell, nav, and route guard.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const AdminShell = ({children}) => {
  const pathname = usePathname();
  const publicPathname = toPublicAdminPath(pathname);
  const route = matchAdminRoute(publicPathname);
  const chrome = useAdminChrome();
  const groups = getAdminNavigationGroups()
    .map((group) => ({
      ...group,
      routes: filterRoutesForUser(group.routes, chrome.user)
    }))
    .filter((group) => group.routes.length > 0);
  const activeNavId = route.id === "library-title" ? "library" : route.id === "settings-database" ? "settings" : route.id;
  const siteName = chrome.branding?.siteName || "Scriptarr";
  const logoUrl = chrome.branding?.logo?.urls?.chrome || "";

  useEffect(() => {
    if (!chrome.loading && chrome.user && !chrome.canAccessAdmin) {
      window.location.replace("/");
    }
  }, [chrome.canAccessAdmin, chrome.loading, chrome.user]);

  useEffect(() => {
    document.title = `${route.title} - ${siteName} Admin`;
  }, [route.title, siteName]);

  return (
    <div className="admin-next-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/admin">
          <span className="admin-brand-mark">{logoUrl ? <img src={logoUrl} alt="" /> : "S"}</span>
          <span>
            <small>Moon Admin</small>
            <strong>{siteName}</strong>
          </span>
        </a>
        <nav className="admin-nav" aria-label="Admin navigation">
          {groups.map((group) => (
            <section className="admin-nav-group" key={group.label}>
              <div className="admin-nav-label">{group.label}</div>
              {group.routes.map((navRoute) => (
                <a
                  className={navRoute.id === activeNavId ? "admin-nav-link is-active" : "admin-nav-link"}
                  href={navRoute.path}
                  key={navRoute.id}
                >
                  <span>{navRoute.navLabel}</span>
                  {navRoute.ported ? <em>live</em> : null}
                </a>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <div className="admin-stage">
        <header className="admin-topbar">
          <div>
            <div className="admin-kicker">{route.group}</div>
            <h1>{route.title}</h1>
            <p>{route.description}</p>
          </div>
          <div className="admin-topbar-actions">
            <IdentityCard user={chrome.user} loginUrl={chrome.loginUrl} bootstrap={chrome.bootstrap} />
            <a className="admin-button ghost" href="/">Open user app</a>
          </div>
        </header>
        <main className="admin-page-surface">{children}</main>
      </div>
    </div>
  );
};

export default AdminShell;
