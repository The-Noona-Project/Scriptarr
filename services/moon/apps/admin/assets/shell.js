import {escapeHtml} from "./dom.js";
import {getAdminNavigationGroups} from "./routes.js";

/**
 * Render the Arr-style Moon admin shell.
 *
 * @param {{
 *   route: import("./routes.js").AdminRoute,
 *   content: string,
 *   user: {username: string, role: string} | null,
 *   flash: {tone: string, text: string} | null,
 *   loginUrl: string,
 *   bootstrap: {ownerClaimed?: boolean, superuserId?: string} | null
 * }} options
 * @returns {string}
 */
export const renderAdminShell = ({route, content, user, flash, loginUrl, bootstrap}) => {
  const groups = getAdminNavigationGroups();
  const authSummary = user
    ? `
      <div class="identity-card">
        <div class="identity-kicker">Admin session</div>
        <strong>${escapeHtml(user.username)}</strong>
        <span>${escapeHtml(user.role)}</span>
      </div>
    `
    : `
      <div class="identity-card">
        <div class="identity-kicker">Admin session</div>
        <strong>Not signed in</strong>
        <span>${bootstrap?.ownerClaimed ? "Use Discord login or a dev claim session." : `First owner: ${escapeHtml(bootstrap?.superuserId || "missing")}`}</span>
      </div>
    `;

  return `
    <div class="admin-shell">
      <aside class="admin-sidebar">
        <a class="brand-lockup" href="/admin" data-link>
          <span class="brand-mark">S</span>
          <span>
            <span class="brand-kicker">Moon Admin</span>
            <strong class="brand-name">Scriptarr</strong>
          </span>
        </a>
        <nav class="nav-groups">
          ${groups.map((group) => `
            <section class="nav-group">
              <div class="nav-label">${escapeHtml(group.label)}</div>
              ${group.routes.map((navRoute) => `
                <a class="nav-link ${navRoute.path === route.path ? "is-active" : ""}" href="${navRoute.path}" data-link>
                  <span>${escapeHtml(navRoute.navLabel)}</span>
                </a>
              `).join("")}
            </section>
          `).join("")}
        </nav>
      </aside>
      <div class="admin-stage">
        <header class="admin-topbar">
          <div>
            <div class="topbar-kicker">${escapeHtml(route.group)}</div>
            <h1>${escapeHtml(route.title)}</h1>
            <p>${escapeHtml(route.description)}</p>
          </div>
          <div class="topbar-actions">
            ${authSummary}
            <div class="header-buttons">
              <a class="ghost-button" href="/" target="_self">Open user app</a>
              ${user ? "" : `<a class="solid-button" href="${escapeHtml(loginUrl || "#")}">Discord login</a>`}
              ${user ? "" : `<button class="ghost-button" type="button" data-action="claim-dev-session">Claim dev session</button>`}
            </div>
          </div>
        </header>
        ${flash ? `<div class="flash-banner ${escapeHtml(flash.tone)}">${escapeHtml(flash.text)}</div>` : ""}
        <main class="page-surface">${content}</main>
      </div>
    </div>
  `;
};

export default renderAdminShell;
