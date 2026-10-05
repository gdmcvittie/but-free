import { useEffect, useRef } from 'react';

/**
 * Right-edge swipe-back gesture.
 *
 * Views that own a "back" action (album/artist drill-down, release details,
 * Car Mode...) register a handler while they are active; swiping leftward from
 * the right edge of the screen fires the most recently registered handler, the
 * same way the platform back gesture unwinds stacked UI. Handlers are kept in
 * a stack so an overlay opened over a drill-down takes precedence.
 */

const handlers = [];
let touchSurface = null;

function edgeZone() {
  const width = window.innerWidth || 360;
  return Math.max(48, Math.min(140, width * 0.18));
}

function fireTop() {
  const entry = handlers[handlers.length - 1];
  if (!entry) return false;
  entry.fn();
  return true;
}

function attach() {
  if (touchSurface) return;
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let fired = false;

  const onTouchStart = (e) => {
    if (e.touches.length !== 1 || handlers.length === 0) {
      tracking = false;
      return;
    }
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    tracking = startX >= (window.innerWidth || 360) - edgeZone();
    fired = false;
  };

  const onTouchMove = (e) => {
    if (!tracking || fired || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // A deliberate leftward swipe from the right edge: clearly horizontal and
    // far enough to not be a tap or a scroll that drifted sideways.
    if (dx < -44 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      fired = true;
      fireTop();
    } else if (dy > 28 && Math.abs(dy) > Math.abs(dx) * 1.5) {
      // Vertical scroll won the gesture; stop evaluating this touch.
      tracking = false;
    }
  };

  const onTouchEnd = () => {
    tracking = false;
    fired = false;
  };

  touchSurface = { onTouchStart, onTouchMove, onTouchEnd };
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });
}

/**
 * @param {boolean} active - whether this view's back target is on screen
 * @param {() => void} onBack - go back one level (must be stable-ish; read
 *   latest state via functional updates or refs)
 */
export function useSwipeBack(active, onBack) {
  const fnRef = useRef(onBack);

  useEffect(() => {
    fnRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!active) return undefined;
    attach();
    const entry = { fn: () => fnRef.current?.() };
    handlers.push(entry);
    return () => {
      const idx = handlers.indexOf(entry);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  }, [active]);
}
