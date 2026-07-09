// Pure, framework-agnostic matching logic for SpareMatch NZ.
// No data import here: callers pass the parts array (from parts.json).

const norm = (v) => (v == null ? "" : String(v).trim());

// Distinct non-empty values for a field, with counts, sorted by count desc.
function distinct(parts, field) {
  const m = new Map();
  for (const p of parts) {
    const v = norm(p[field]);
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function listBrands(parts) {
  return distinct(parts, "brand").map((b) => ({ brand: b.value, count: b.count }));
}

// Apply selected filters (exact match on non-empty selections).
export function applyFilters(parts, sel = {}) {
  return parts.filter((p) =>
    Object.entries(sel).every(([f, v]) => !v || norm(p[f]) === norm(v))
  );
}

// The narrowing questions, in priority order.
const QUESTIONS = [
  { field: "category", label: "What kind of part is it?" },
  { field: "valveType", label: "What type of valve / mechanism?" },
  { field: "dimension", label: "What size? (cartridge diameter, thread, etc.)" },
];

// Returns the next best question to ask, or null if nothing further narrows the set.
export function nextQuestion(parts, sel = {}) {
  const remaining = applyFilters(parts, sel);
  for (const q of QUESTIONS) {
    if (sel[q.field]) continue; // already answered
    const opts = distinct(remaining, q.field);
    // Only ask if this field actually splits the remaining candidates.
    if (opts.length > 1) {
      return { field: q.field, label: q.label, options: opts, remaining: remaining.length };
    }
  }
  return null;
}

// Convenience: run the whole flow given a full selection, returning matches + next question.
export function evaluate(parts, sel = {}) {
  const matches = applyFilters(parts, sel);
  const question = nextQuestion(parts, sel);
  return { matches, question, count: matches.length };
}
