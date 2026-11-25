// Pure input policy for the Android reader.
const CLICK_DEDUPE_MS = 500;
export function decideMobileGesture(origin, end, now, width, canPage) {
  if (!origin || !end || !width || origin.x < 24 || origin.x > width - 24) return null;
  const dx = end.x - origin.x;
  const dy = end.y - origin.y;
  const elapsed = now - origin.at;
  if (canPage && elapsed < 700 && Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    return { type: "swipe", forward: dx < 0 };
  }
  if (elapsed < 350 && Math.hypot(dx, dy) < 10) return { type: "tap", x: end.x, y: end.y };
  return null;
}
export function classifyVisibleTap(x, y, bounds, canPage) {
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top ||
      x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  const fraction = (x - bounds.left) / (bounds.right - bounds.left);
  if (fraction >= 0.25 && fraction <= 0.75) return "center";
  return canPage ? (fraction > 0.75 ? "next" : "prev") : null;
}
export function shouldUseClickFallback(recentTouchAt, now, defaultPrevented, blocked) {
  return !defaultPrevented && !blocked && (!recentTouchAt || now - recentTouchAt > CLICK_DEDUPE_MS);
}
