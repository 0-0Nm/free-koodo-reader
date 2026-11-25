import { decideMobileGesture, classifyVisibleTap, shouldUseClickFallback } from "../utils/mobileTapDecision";

test("classifies reader gestures and suppresses compatibility clicks", () => {
  function assert(value, message) { if (!value) throw new Error(message); }
  function equal(actual, expected, message) { assert(actual === expected, `${message}: ${actual} !== ${expected}`); }
  const origin = { x: 100, y: 200, at: 1000 };
  let action = decideMobileGesture(origin, { x: 100, y: 200 }, 1100, 600, true);
  equal(action.type, "tap", "real touch tap is decided at pointerup");
  equal(decideMobileGesture(origin, { x: 40, y: 200 }, 1200, 600, true).forward, true, "left swipe next");
  equal(decideMobileGesture(origin, { x: 160, y: 200 }, 1200, 600, true).forward, false, "right swipe previous");
  equal(decideMobileGesture(origin, { x: 40, y: 200 }, 1200, 600, false), null, "scroll/non-page format disables swipe");
  equal(decideMobileGesture(origin, { x: 120, y: 300 }, 1100, 600, true), null, "vertical native scroll ignored");
  equal(decideMobileGesture(origin, { x: 100, y: 200 }, 1400, 600, true), null, "long press ignored");
  equal(shouldUseClickFallback(0, 1000, false, false), true, "primary mouse click fallback");
  equal(shouldUseClickFallback(1000, 1100, false, false), false, "touch compatibility click deduped");
  equal(shouldUseClickFallback(1000, 1601, false, false), true, "delayed standalone click fallback");
  equal(shouldUseClickFallback(0, 1000, true, false), false, "defaultPrevented ignored");
  equal(shouldUseClickFallback(0, 1000, false, true), false, "selection/anchor/panel blocked");
  const nested = { left: 50, right: 650, top: 80, bottom: 900 };
  equal(classifyVisibleTap(50 + 500, 80 + 400, nested, true), "next", "nested frame right side");
  equal(classifyVisibleTap(50 + 300, 80 + 400, nested, true), "center", "nested frame center");
  equal(classifyVisibleTap(50 + 500, 80 + 400, nested, false), null, "nested side disabled");
  equal(classifyVisibleTap(20, 400, nested, true), null, "outside visible frame ignored");
});
