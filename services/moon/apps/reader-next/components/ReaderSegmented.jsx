"use client";

/**
 * @file Small segmented controls used by the dedicated reader settings panel.
 */

/**
 * Render a segmented button group for reader settings.
 *
 * @param {{label: string, value: string, options: Array<string | {label: string, value: string}>, onChange: (value: string) => void}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderSegmented = ({label, value, options, onChange}) => (
  <label className="reader-control-group">
    <span>{label}</span>
    <div className="reader-segmented">
      {options.map((option) => {
        const entry = typeof option === "string" ? {label: option, value: option} : option;
        return (
          <button
            aria-pressed={entry.value === value}
            className={entry.value === value ? "is-active" : ""}
            key={entry.value}
            type="button"
            onClick={() => onChange(entry.value)}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  </label>
);

export default ReaderSegmented;
