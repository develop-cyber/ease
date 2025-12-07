// Monthly "grace change" tokens: 3 per calendar month.
export const LATE_MIN = 15; // if change is within 15 min of window start, it's "late"

const KEY = "ease.grace.v1";
const monthKey = () => new Date().toISOString().slice(0, 7); // "YYYY-MM"

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (!s || s.month !== monthKey()) return { month: monthKey(), tokens: 3 };
    return s;
  } catch {
    return { month: monthKey(), tokens: 3 };
  }
}
function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }

export function getGraceTokens() {
  const s = load();
  if (s.month !== monthKey()) { save({ month: monthKey(), tokens: 3 }); return 3; }
  return s.tokens;
}
export function consumeGraceToken() {
  const s = load();
  if (s.month !== monthKey()) s.tokens = 3;
  if (s.tokens <= 0) return 0;
  s.tokens -= 1; save(s); return s.tokens;
}
export function canLateChange(windowStartISO) {
  const start = new Date(windowStartISO);
  const diffMin = (start - new Date()) / 60000;
  const late = diffMin <= LATE_MIN;
  const tokens = getGraceTokens();
  return { allowed: !late || tokens > 0, late, tokens };
}
