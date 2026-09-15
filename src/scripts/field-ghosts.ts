import { ghostPhrases, ghostWords } from "../data/ghosts";
import {
  LAYOUT_SEED,
  assignGhosts,
  type FieldLayout,
  type GhostAssignment,
} from "../lib/field-layout";
import { hashString, mulberry32, type Pt } from "../lib/geometry";

const GHOST_BOOST = 2.4;
const GHOST_SEED = Math.floor(Math.random() * 0x100000000);

/** Owns ghost placement, typing, rotation, and all associated DOM work. */
export function createFieldGhosts(
  root: HTMLElement,
  ctx: CanvasRenderingContext2D,
  reduceMotion: boolean,
  isSettled: () => boolean,
) {
  const ghostHost = root.querySelector<HTMLElement>(".field-ghosts");
  let w = 0;
  let h = 0;
  /** Placed ghost labels with cached centroids for the light's boost. */
  let ghosts: {
    el: HTMLElement;
    cell: number;
    x: number;
    y: number;
    boost: number;
  }[] = [];
  let ghostLayout: FieldLayout | null = null;
  let ghostRound = 0;
  const ghostVisits = new Map<number, number>();
  const ghostTimers = new Map<HTMLElement, Set<number>>();

  /** Keep the fitted goal separate from the visible, gradually typed text. */
  function renderGhost(
    el: HTMLElement,
    choice: GhostAssignment,
    seed: number,
  ): void {
    const ellipsis =
      !reduceMotion && choice.immature && mulberry32(seed)() < 0.2;
    el.className = `ghost ghost-${ellipsis ? "word" : choice.kind}`;
    el.style.setProperty("--ghost-max", `${choice.maxWidth.toFixed(0)}px`);
    el.style.whiteSpace = "pre";
    el.dataset.ghostGoal = choice.text;
    el.dataset.ghostMode = choice.immature ? "typing" : "steady";
    el.dataset.ghostText = ellipsis ? "..." : choice.lines.join("\n");
    el.textContent =
      reduceMotion || !choice.immature ? choice.lines.join("\n") : "";
  }

  function clearGhostTimers(el?: HTMLElement): void {
    for (const [host, timers] of ghostTimers) {
      if (el && host !== el) continue;
      for (const timer of timers) window.clearTimeout(timer);
      ghostTimers.delete(host);
    }
  }

  /** At most a typing callback and a future erase callback per ghost. */
  function ghostAfter(
    el: HTMLElement,
    delay: number,
    action: () => void,
  ): void {
    const timers = ghostTimers.get(el) ?? new Set<number>();
    ghostTimers.set(el, timers);
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (
        !el.isConnected ||
        document.hidden ||
        root.dataset.state !== "settled"
      )
        return;
      action();
    }, delay);
    timers.add(timer);
  }

  function typeGhostCycle(el: HTMLElement): void {
    clearGhostTimers(el);
    if (reduceMotion) return;
    el.classList.remove("ghost-erasing");
    if (el.dataset.ghostMode === "steady") {
      el.textContent = el.dataset.ghostText ?? "";
      return;
    }
    el.textContent = "";
    const text = el.dataset.ghostText ?? "";
    const period = Number(el.dataset.ghostPeriod) || 28000;
    const rng = mulberry32(hashString(text) ^ GHOST_SEED ^ ghostRound);
    let length = 0;
    let typing = true;
    let hesitated = false;
    const hesitate = text !== "..." && text.length >= 3 && rng() < 0.85;
    const hesitationAt = Math.min(
      text.length - 1,
      Math.max(2, Math.floor(text.length * 0.65)),
    );
    const type = (): void => {
      if (!typing) return;
      el.textContent = text.slice(0, ++length);
      if (hesitate && !hesitated && length === hesitationAt) {
        hesitated = true;
        // A brief correction reads as typing: “wri” → “wr” → “write”.
        ghostAfter(el, 280 + rng() * 180, () => {
          if (!typing) return;
          el.textContent = text.slice(0, --length);
          ghostAfter(el, 160 + rng() * 140, type);
        });
      } else if (length < text.length) ghostAfter(el, 120 + rng() * 90, type);
      else ghostAfter(el, 1000 + rng() * 600, erase);
    };
    const erase = (): void => {
      typing = false;
      length = Math.max(0, length - 1);
      el.textContent = text.slice(0, length);
      if (length > 0) ghostAfter(el, 80 + rng() * 40, erase);
    };
    ghostAfter(el, period * 0.12, type);
  }

  function onGhostStart(event: AnimationEvent): void {
    const ghost = ghosts.find((entry) => entry.el === event.target);
    if (ghost && !document.hidden) typeGhostCycle(ghost.el);
  }

  /** Select an unoccupied host, balancing separation with rotation through
   * the pool. The best-spaced half are eligible; least-used wins there. */
  function chooseGhostHost(
    choices: GhostAssignment[],
    moving?: (typeof ghosts)[number],
  ): GhostAssignment | undefined {
    const occupied = new Set(ghosts.map((ghost) => ghost.cell));
    const others = ghosts.filter((ghost) => ghost !== moving);
    const rng = mulberry32(GHOST_SEED + ghostRound * 7919 + ghosts.length);
    const sameMode = moving
      ? choices.filter(
          (choice) =>
            choice.immature === (moving.el.dataset.ghostMode === "typing"),
        )
      : choices;
    const preferred = sameMode.length ? sameMode : choices;
    const candidates = preferred.filter((choice) => !occupied.has(choice.cell));
    const ranked = candidates
      .map((choice) => {
        const c = choice.center;
        const distance = others.length
          ? Math.min(
              ...others.map((other) =>
                Math.hypot((c.x - other.x) / w, (c.y - other.y) / h),
              ),
            )
          : rng();
        return {
          choice,
          distance,
          visits: ghostVisits.get(choice.cell) ?? 0,
          tie: rng(),
        };
      })
      .sort((a, b) => b.distance - a.distance);
    return (
      ranked
        .slice(0, Math.max(1, Math.ceil(ranked.length / 2)))
        .sort((a, b) => a.visits - b.visits || a.tie - b.tie)[0]?.choice ??
      choices.find((choice) => choice.cell === moving?.cell)
    );
  }

  /** Measure the actual loaded face, including italic overhang. Tracking is
   * added by assignGhosts; no average-width assumption for a wide W. */
  function measureGhostText(
    text: string,
    kind: GhostAssignment["kind"],
    size: number,
  ): number {
    ctx.save();
    ctx.font =
      kind === "word" ? `600 ${size}px "Syne"` : `italic 400 ${size}px "Lora"`;
    const metrics = ctx.measureText(text);
    ctx.restore();
    return Math.max(
      metrics.width,
      metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
    );
  }

  /** Refit all choices against the current polygons whenever layout changes. */
  function place(field: FieldLayout, width: number, height: number): void {
    w = width;
    h = height;
    clearGhostTimers();
    ghosts = [];
    ghostLayout = field;
    ghostRound = Math.floor(Math.random() * 0x100000000);
    ghostVisits.clear();
    if (!ghostHost) return;
    ghostHost.replaceChildren();
    root.toggleAttribute("data-ghosts-paused", document.hidden);
    const rng = mulberry32(GHOST_SEED ^ ghostRound ^ LAYOUT_SEED);
    const pool = assignGhosts(
      field,
      w,
      GHOST_SEED ^ ghostRound,
      ghostWords,
      ghostPhrases,
      measureGhostText,
    );
    const slots = Math.min(field.wide ? 3 : 2, pool.length);
    for (let slot = 0; slot < slots; slot++) {
      // Keep ordinary fading and unfinished typing represented when both fit.
      const preferred =
        slot === 0
          ? pool.filter((choice) => !choice.immature)
          : slot === 1
            ? pool.filter((choice) => choice.immature)
            : pool;
      const ghost = chooseGhostHost(preferred.length ? preferred : pool);
      if (!ghost) break;
      const el = document.createElement("span");
      renderGhost(el, ghost, GHOST_SEED ^ (ghost.cell * 7919));
      el.style.setProperty("--cx", `${ghost.center.x.toFixed(2)}px`);
      el.style.setProperty("--cy", `${ghost.center.y.toFixed(2)}px`);
      el.style.setProperty("--ghost-max", `${ghost.maxWidth.toFixed(0)}px`);
      const period = 22 + rng() * 14;
      el.dataset.ghostPeriod = String(period * 1000);
      el.style.setProperty("--ghost-period", `${period.toFixed(2)}s`);
      el.style.setProperty("--ghost-delay", `${(rng() * 9).toFixed(2)}s`);
      ghostHost.appendChild(el);
      ghosts.push({
        el,
        cell: ghost.cell,
        x: ghost.center.x,
        y: ghost.center.y,
        boost: 1,
      });
      ghostVisits.set(ghost.cell, 1);
    }
  }

  /** Every CSS cycle ends fully transparent. Swap only there, using the
   * same polygon fit checks as first placement and excluding visible text. */
  function onGhostIteration(event: AnimationEvent): void {
    if (reduceMotion || !ghostLayout || document.hidden || !isSettled()) return;
    const ghost = ghosts.find((entry) => entry.el === event.target);
    if (!ghost) return;
    const occupied = new Set(ghosts.map((entry) => entry.el.dataset.ghostGoal));
    ghostRound = Math.floor(Math.random() * 0x100000000);
    const choices = assignGhosts(
      ghostLayout,
      w,
      GHOST_SEED ^ ghostRound,
      ghostWords.filter((text) => !occupied.has(text)),
      ghostPhrases.filter((text) => !occupied.has(text)),
      measureGhostText,
    );
    const next = chooseGhostHost(choices, ghost);
    if (next) {
      ghost.cell = next.cell;
      ghost.x = next.center.x;
      ghost.y = next.center.y;
      ghost.boost = 1;
      ghost.el.style.removeProperty("--ghost-boost");
      ghost.el.style.setProperty("--cx", `${ghost.x.toFixed(2)}px`);
      ghost.el.style.setProperty("--cy", `${ghost.y.toFixed(2)}px`);
      ghostVisits.set(next.cell, (ghostVisits.get(next.cell) ?? 0) + 1);
      renderGhost(
        ghost.el,
        next,
        GHOST_SEED + ghostRound * 104729 + ghost.cell,
      );
    }
    typeGhostCycle(ghost.el);
  }

  /** Ghosts near the light brighten with the same falloff; a handful of
   * style writes, no layout reads. */
  function boost(lightPoint: Pt | null, lightR: number): void {
    if (reduceMotion) return;
    const R = lightR;
    for (const gh of ghosts) {
      let boost = 1;
      if (lightPoint) {
        const d = Math.hypot(lightPoint.x - gh.x, lightPoint.y - gh.y);
        if (d < R) boost = 1 + (GHOST_BOOST - 1) * (1 - d / R) ** 2;
      }
      if (Math.abs(boost - gh.boost) < 0.01) continue;
      gh.boost = boost;
      if (boost === 1) gh.el.style.removeProperty("--ghost-boost");
      else gh.el.style.setProperty("--ghost-boost", boost.toFixed(3));
    }
  }

  function pause(): void {
    clearGhostTimers();
    if (!reduceMotion) for (const ghost of ghosts) ghost.el.textContent = "";
    root.toggleAttribute("data-ghosts-paused", document.hidden);
  }

  let destroyed = false;
  void document.fonts.ready.then(() => {
    if (!destroyed && root.isConnected && ghostLayout) place(ghostLayout, w, h);
  });
  ghostHost?.addEventListener("animationiteration", onGhostIteration);
  ghostHost?.addEventListener("animationstart", onGhostStart);

  function destroy(): void {
    destroyed = true;
    clearGhostTimers();
    ghostHost?.removeEventListener("animationiteration", onGhostIteration);
    ghostHost?.removeEventListener("animationstart", onGhostStart);
    ghostHost?.replaceChildren();
    ghostLayout = null;
    ghosts = [];
    ghostVisits.clear();
    root.removeAttribute("data-ghosts-paused");
  }
  return { place, boost, pause, clearTimers: clearGhostTimers, destroy };
}
