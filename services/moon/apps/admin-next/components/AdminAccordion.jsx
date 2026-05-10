"use client";

/**
 * @file Lightweight admin accordion primitive for the status endpoint matrix.
 */

/**
 * Render one controlled accordion group.
 *
 * @param {{title: string, open?: boolean, onToggle?: () => void, children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const AdminAccordion = ({title, open = false, onToggle, children}) => (
  <section className={`admin-local-accordion ${open ? "is-open" : ""}`.trim()}>
    <button
      aria-expanded={open}
      className="admin-local-accordion-trigger"
      type="button"
      onClick={onToggle}
    >
      <span>{title}</span>
      <strong aria-hidden="true">{open ? "-" : "+"}</strong>
    </button>
    {open ? <div className="admin-local-accordion-content">{children}</div> : null}
  </section>
);

export default AdminAccordion;
