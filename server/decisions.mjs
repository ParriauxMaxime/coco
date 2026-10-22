// Shared by the server (notes bullet, timeline) and the Decisions tab (copy as markdown).
// A card with `rows` is a table of sub-decisions: its `options` are the columns, `choice` maps each row key to an option key.

const optionLabel = (d, key) => d.options.find((o) => o.key === key)?.label || key;

export const validChoice = (d, choice) =>
  d.rows ? Boolean(choice) && d.rows.every((r) => d.options.some((o) => o.key === choice[r.key])) : d.options.some((o) => o.key === choice);

export const decisionSummary = (d) => {
  if (!d.rows) return optionLabel(d, d.choice);
  return d.options.map((o) => [o.label, d.rows.filter((r) => d.choice?.[r.key] === o.key).length]).filter(([, n]) => n).map(([label, n]) => `${label} ${n}`).join(' · ');
};

// a rationale over several lines goes indented under the bullet so its markdown stays inside the list item
export const decisionBullet = (d) => {
  const head = d.rows ? `- ${d.title}` : `- ${d.title}: ${optionLabel(d, d.choice)}`;
  if (!d.rows && d.rationale && !d.rationale.includes('\n')) return `${head} (${d.rationale})`;
  const rows = (d.rows || []).map((r) => `  - ${r.label}: ${optionLabel(d, d.choice?.[r.key])}`);
  return [head, ...(d.rationale ? [d.rationale.replace(/^/gm, '  ')] : []), ...rows].join('\n');
};
