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

export function renderCodeStartKey(
  projectName: string,
  state: CodeStartDisplayState
): string {
  if (state.kind === "closed") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="22" fill="#17130f"/>
  <rect x="1.5" y="1.5" width="141" height="141" rx="20.5" fill="none" stroke="#40342b" stroke-width="3"/>
  <text x="72" y="53" text-anchor="middle" fill="#fffaf5" font-family="Arial, sans-serif" font-size="25" font-weight="800"${projectFitAttributes(projectName)}>${projectLabel(projectName)}</text>
  <text x="72" y="91" text-anchor="middle" fill="#ff6b74" font-family="Arial, sans-serif" font-size="20" font-weight="800">Closed</text>
</svg>`;
  }

  const percentage = state.kind === "ready"
    ? Math.round(Math.min(100, Math.max(0, state.percentage)))
    : undefined;
  const progress = percentage === undefined ? 0 : Math.round((108 * percentage) / 100);
  const contextColor = activityColor(state.activity);
  const progressColor = percentage === undefined ? "#74675e" : usageColor(percentage);
  const contextText = percentage === undefined ? "CTX --%" : `CTX ${percentage}%`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="22" fill="#17130f"/>
  <rect x="1.5" y="1.5" width="141" height="141" rx="20.5" fill="none" stroke="#40342b" stroke-width="3"/>
  <text x="72" y="53" text-anchor="middle" fill="#fffaf5" font-family="Arial, sans-serif" font-size="25" font-weight="800"${projectFitAttributes(projectName)}>${projectLabel(projectName)}</text>
  <text data-role="context-text" x="72" y="84" text-anchor="middle" fill="${contextColor}" font-family="Arial, sans-serif" font-size="17" font-weight="800">${contextText}</text>
  <rect data-role="context-track" x="18" y="101" width="108" height="12" rx="6" fill="#493a30"/>
  <rect data-role="context-fill" x="18" y="101" width="${progress}" height="12" rx="6" fill="${progressColor}"/>
</svg>`;
}

export function renderCodeStartKeyImage(
  projectName: string,
  state: CodeStartDisplayState
): string {
  return `data:image/svg+xml,${encodeURIComponent(renderCodeStartKey(projectName, state))}`;
}
