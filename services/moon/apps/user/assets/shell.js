import {escapeHtml} from "./dom.js";
import {getPrimaryUserRoutes} from "./routes.js";

/**
 * Render the Moon user app shell.
 *
 * @param {{
 *   route: ReturnType<import("./routes.js").matchUserRoute>,
 *   content: string,
 *   user: {username: string, role: string} | null,
 *   loginUrl: string,
 *   bootstrap: {ownerClaimed?: boolean, superuserId?: string} | null,
 *   flash: {tone: string, text: string} | null
 * }} options
 * @returns {string}
 */
export const renderUserShell = ({route, content, user, loginUrl, bootstrap, flash}) => `
  <div class="user-shell">
    <header class="user-topbar">
      <div class="brand-area">
        <a class="brand-lockup" href="/" data-link>
          <span class="brand-kicker">Moon Reader</span>
          <strong class="brand-name">Scriptarr</strong>
        </a>
        <p class="brand-copy">${escapeHtml(route.description)}</p>
      </div>
      <nav class="primary-nav">
        ${getPrimaryUserRoutes().map((navRoute) => `
          <a class="nav-pill ${navRoute.path === route.path ? "is-active" : ""}" href="${navRoute.path}" data-link>${escapeHtml(navRoute.navLabel)}</a>
        `).join("")}
        <a class="nav-pill admin-link" href="/admin" target="_self">Admin</a>
      </nav>
      <div class="session-panel">
        <div class="session-kicker">Session</div>
        <strong>${escapeHtml(user?.username || "Not signed in")}</strong>
        <span>${escapeHtml(user?.role || (bootstrap?.ownerClaimed ? "Use Discord login to sign in." : `First owner: ${bootstrap?.superuserId || "missing"}`))}</span>
        <div class="session-actions">
          ${user ? "" : `<a class="solid-button" href="${escapeHtml(loginUrl || "#")}">Discord login</a>`}
        </div>
      </div>
    </header>
    ${flash ? `<div class="flash-banner ${escapeHtml(flash.tone)}">${escapeHtml(flash.text)}</div>` : ""}
    <main class="user-stage">${content}</main>
  </div>
`;

export default renderUserShell;
