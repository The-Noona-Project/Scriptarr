/** @file Retention selection for seven daily and four weekly immutable snapshots. */

/** Return the Monday UTC date identifying a timestamp's calendar week. */
export function weekOf(timestamp) {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** Keep the latest run per day/week, then preserve the newest daily/weekly sets. */
export function retainedSnapshots(snapshots, daily = 7, weekly = 4) {
  const ordered = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const days = new Map();
  const weeks = new Map();
  for (const item of ordered) {
    if (!Number.isFinite(Date.parse(item.createdAt))) throw new Error("Invalid snapshot timestamp.");
    const day = item.createdAt.slice(0, 10);
    const week = weekOf(item.createdAt);
    if (!days.has(day)) days.set(day, item.id);
    if (!weeks.has(week)) weeks.set(week, item.id);
  }
  return new Set([...days.values()].slice(0, daily).concat([...weeks.values()].slice(0, weekly)));
}
