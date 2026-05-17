"use client";

/**
 * @file Lightweight Moon navigation components for desktop and mobile chrome.
 */

import Link from "next/link";

/**
 * Render the user-app desktop navigation with an optional library flyout.
 *
 * @param {{menuGroups: Array<Record<string, any>>, onGroupOpen?: (group: Record<string, any>) => void}} props
 * @returns {import("react").ReactNode}
 */
export const DesktopNavigation = ({menuGroups = [], onGroupOpen}) => (
  <nav className="moon-local-nav" aria-label="Primary navigation">
    {menuGroups.map((group) => (
      <div
        className="moon-local-nav-item"
        key={group.id || group.href || group.label}
        onFocus={() => onGroupOpen?.(group)}
        onMouseEnter={() => onGroupOpen?.(group)}
      >
        <Link
          aria-haspopup={Array.isArray(group.sections) ? "menu" : undefined}
          className={group.selected ? "is-active" : ""}
          href={group.href || "/"}
        >
          {group.label}
        </Link>
        {Array.isArray(group.sections) && group.sections.length ? (
          <div className="moon-local-nav-flyout" role="menu" aria-label={`${group.label} menu`}>
            {group.sections.flatMap((section, sectionIndex) => (
              (Array.isArray(section.links) ? section.links : []).map((link) => (
                <Link
                  className={link.selected ? "is-active" : ""}
                  href={link.href || "/library"}
                  key={`${sectionIndex}:${link.href || link.label}`}
                >
                  {link.label}
                </Link>
              ))
            ))}
          </div>
        ) : null}
      </div>
    ))}
  </nav>
);

/**
 * Render the user-app mobile navigation drawer.
 *
 * @param {{menuGroups: Array<Record<string, any>>, onClose?: () => void, onGroupOpen?: (group: Record<string, any>) => void}} props
 * @returns {import("react").ReactNode}
 */
export const MobileNavigation = ({menuGroups = [], onClose, onGroupOpen}) => (
  <nav className="moon-local-mobile-nav" aria-label="Mobile navigation">
    {menuGroups.map((group) => (
      <div className="moon-local-mobile-group" key={group.id || group.href || group.label} onFocus={() => onGroupOpen?.(group)}>
        <Link
          className={group.selected ? "is-active" : ""}
          href={group.href || "/"}
          onClick={onClose}
        >
          {group.label}
        </Link>
        {Array.isArray(group.sections) && group.sections.length ? (
          <div className="moon-local-mobile-section">
            {group.sections.flatMap((section, sectionIndex) => (
              (Array.isArray(section.links) ? section.links : []).map((link) => (
                <Link
                  className={link.selected ? "is-active" : ""}
                  href={link.href || "/library"}
                  key={`${sectionIndex}:${link.href || link.label}`}
                  onClick={onClose}
                >
                  {link.label}
                </Link>
              ))
            ))}
          </div>
        ) : null}
      </div>
    ))}
  </nav>
);

export default {
  DesktopNavigation,
  MobileNavigation
};
