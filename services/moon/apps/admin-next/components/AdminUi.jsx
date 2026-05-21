"use client";

/**
 * @file Shared dense admin UI primitives for Next-backed Moon admin pages.
 */

const toneClass = (tone = "") => tone ? ` ${tone}` : "";

/**
 * @param {{children: import("react").ReactNode, tone?: string}} props
 * @returns {import("react").ReactNode}
 */
export const AdminStatusBadge = ({children, tone = ""}) => (
  <span className={`admin-badge${toneClass(tone)}`}>{children}</span>
);

/**
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const AdminFilterBar = ({children}) => (
  <div className="admin-filter-bar">{children}</div>
);

/**
 * @param {{children: import("react").ReactNode, tone?: "good" | "bad" | "warning" | ""}} props
 * @returns {import("react").ReactNode}
 */
export const AdminActionBanner = ({children, tone = ""}) => (
  <div className={`admin-action-banner${toneClass(tone)}`}>{children}</div>
);

/**
 * @param {{
 *   columns: Array<{key: string, label: string, className?: string, render?: (row: any, index: number) => import("react").ReactNode}>,
 *   rows: any[],
 *   empty?: import("react").ReactNode,
 *   getKey?: (row: any, index: number) => string,
 *   onRowClick?: (row: any) => void,
 *   selectedKey?: string
 * }} props
 * @returns {import("react").ReactNode}
 */
export const AdminDenseTable = ({
  columns,
  rows,
  empty = "Nothing to show right now.",
  getKey = (_row, index) => String(index),
  onRowClick,
  selectedKey = ""
}) => {
  if (!rows.length) {
    return <div className="admin-empty">{empty}</div>;
  }

  return (
    <div className="admin-table-wrap">
      <table className="admin-dense-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th className={column.className || ""} key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = getKey(row, index);
            return (
              <tr
                className={key && key === selectedKey ? "is-selected" : ""}
                key={key}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <td className={column.className || ""} key={column.key}>
                    {column.render ? column.render(row, index) : row[column.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/**
 * @param {{open: boolean, title: string, kicker?: string, onClose: () => void, children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const AdminDrawer = ({open, title, kicker = "", onClose, children}) => {
  if (!open) {
    return null;
  }

  return (
    <div className="admin-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="admin-drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="admin-section-heading">
          <div>
            {kicker ? <div className="admin-kicker">{kicker}</div> : null}
            <h2>{title}</h2>
          </div>
          <button className="admin-button ghost" type="button" onClick={onClose}>Close</button>
        </div>
        {children}
      </aside>
    </div>
  );
};

/**
 * @param {{
 *   confirmation: string,
 *   value: string,
 *   onChange: (value: string) => void,
 *   children?: import("react").ReactNode
 * }} props
 * @returns {import("react").ReactNode}
 */
export const AdminConfirmPanel = ({confirmation, value, onChange, children}) => (
  <div className="admin-confirm-panel">
    <div>
      <div className="admin-kicker">Confirmation</div>
      <strong>Type {confirmation} before installing updates.</strong>
      {children ? <p className="admin-muted">{children}</p> : null}
    </div>
    <input
      aria-label="Confirmation text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={confirmation}
    />
  </div>
);

export default {
  AdminActionBanner,
  AdminConfirmPanel,
  AdminDenseTable,
  AdminDrawer,
  AdminFilterBar,
  AdminStatusBadge
};
