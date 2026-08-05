import type {
  CodeSessionActivity,
  CodeStartDisplayState
} from "../domain/context-session";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function projectLabel(projectName: string): string {
  const normalized = projectName.trim() || "PROJECT";
  const characters = Array.from(normalized);
  const truncated = characters.length > 12 ? `${characters.slice(0, 11).join("")}…` : normalized;
  return escapeXml(truncated);
}

function projectFitAttributes(projectName: string): string {
  const normalized = projectName.trim() || "PROJECT";
  const estimatedWidthUnits = Array.from(normalized).reduce((total, character) => {
    if (/[A-Za-z0-9]/u.test(character)) {
      return total + 1;
    }
    if (/\s/u.test(character)) {
      return total + 0.55;
    }
    return total + 1.7;
  }, 0);
  return estimatedWidthUnits > 8
    ? ' textLength="108" lengthAdjust="spacingAndGlyphs"'
    : "";
}

function modelFitAttributes(value: string): string {
  const estimatedWidthUnits = Array.from(value).reduce((total, character) => {
    if (/[A-Za-z0-9]/u.test(character)) {
      return total + 1;
    }
    if (/\s/u.test(character)) {
      return total + 0.55;
    }
    return total + 1.7;
  }, 0);
  return estimatedWidthUnits > 11
    ? ' textLength="108" lengthAdjust="spacingAndGlyphs"'
    : "";
}

function usageColor(percentage: number): string {
  if (percentage >= 85) {
    return "#ff6b74";
  }
  if (percentage >= 60) {
    return "#f3b55f";
  }
  return "#60d3a3";
}

function activityColor(activity: CodeSessionActivity): string {
  if (activity === "waiting") {
    return "#70c7ff";
  }
  if (activity === "running") {
    return "#60d3a3";
  }
  return "#ff6b74";
}

/**
 * Waiting-for-input flashes the whole key body to a pastel blue. `frame`
 * ticks once per second, so the blink is a calm 1s-on/1s-off. The flash
 * lives in the body rather than the border because the Stream Deck bezel
 * crops the outer edge at shallow viewing angles, which made a blinking
 * border look clipped. Text flips dark during the light phase so both
 * phases stay readable.
 */
function waitingPulseOn(activity: CodeSessionActivity, frame: number): boolean {
  return activity === "waiting" && ((frame % 2) + 2) % 2 === 0;
}

/**
 * A bright segment that sweeps along the context track while the session is
 * actively generating. The plugin repaints keys once per second, so `frame`
 * (any monotonically growing integer, e.g. seconds) advances the sweep and
 * makes "this session is working right now" visible at a glance.
 */
function runningSweep(activity: CodeSessionActivity, frame: number): string {
  if (activity !== "running") {
    return "";
  }
  const steps = 6;
  const phase = ((frame % steps) + steps) % steps;
  const sweepWidth = 26;
  const x = 18 + Math.round((108 - sweepWidth) * (phase / (steps - 1)));
  return `\n  <rect data-role="context-sweep" x="${x}" y="101" width="${sweepWidth}" height="12" rx="6" fill="#ffffff" opacity="0.32"/>`;
}

export function renderCodeStartKey(
  projectName: string,
  state: CodeStartDisplayState,
  frame = 0
): string {
  if (state.kind === "closed") {
    // A closed key carries the project name ALONE: no status word, no model, no
    // track. On a full page of keys the difference has to register without
    // reading — live keys are the ones with colour and a bar under the name.
    //
    // y=81 centres a 25px cap height in the 144px key (72 + 25 * 0.716 / 2).
    // The name is grey and the border is pulled toward the background so the
    // whole key recedes rather than just losing a line of text.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="22" fill="#17130f"/>
  <rect x="1.5" y="1.5" width="141" height="141" rx="20.5" fill="none" stroke="#2a231d" stroke-width="3"/>
  <text x="72" y="81" text-anchor="middle" fill="#6f6a66" font-family="Arial, sans-serif" font-size="25" font-weight="800"${projectFitAttributes(projectName)}>${projectLabel(projectName)}</text>
</svg>`;
  }

  const percentage = state.kind === "ready"
    ? Math.round(Math.min(100, Math.max(0, state.percentage)))
    : undefined;
  const progress = percentage === undefined ? 0 : Math.round((108 * percentage) / 100);
  const pulseOn = waitingPulseOn(state.activity, frame);
  const bgColor = pulseOn ? "#aacfe6" : "#17130f";
  const projectColor = pulseOn ? "#1d2b36" : "#fffaf5";
  const trackColor = pulseOn ? "#87aec6" : "#493a30";
  const statusColor = pulseOn ? "#175d84" : activityColor(state.activity);
  const progressColor = percentage === undefined ? "#74675e" : usageColor(percentage);
  const statusText = state.model?.displayName ?? "MODEL --";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect data-role="key-bg" width="144" height="144" rx="22" fill="${bgColor}"/>
  <rect x="1.5" y="1.5" width="141" height="141" rx="20.5" fill="none" stroke="#40342b" stroke-width="3"/>
  <text x="72" y="53" text-anchor="middle" fill="${projectColor}" font-family="Arial, sans-serif" font-size="25" font-weight="800"${projectFitAttributes(projectName)}>${projectLabel(projectName)}</text>
  <text data-role="model-text" x="72" y="84" text-anchor="middle" fill="${statusColor}" font-family="Arial, sans-serif" font-size="17" font-weight="800"${modelFitAttributes(statusText)}>${escapeXml(statusText)}</text>
  <rect data-role="context-track" x="18" y="101" width="108" height="12" rx="6" fill="${trackColor}"/>
  <rect data-role="context-fill" x="18" y="101" width="${progress}" height="12" rx="6" fill="${progressColor}"/>${runningSweep(state.activity, frame)}
</svg>`;
}

export function renderCodeStartKeyImage(
  projectName: string,
  state: CodeStartDisplayState,
  frame = 0
): string {
  return `data:image/svg+xml,${encodeURIComponent(renderCodeStartKey(projectName, state, frame))}`;
}
