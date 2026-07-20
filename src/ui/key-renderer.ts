import type { RateLimitKind, UsageDisplayState } from "../domain/rate-limits";

const LABELS: Record<RateLimitKind, string> = {
  fiveHour: "5 HOURS",
  sevenDay: "WEEKLY"
};

function colorForPercentage(percentage: number): string {
  if (percentage >= 85) {
    return "#ff5c6c";
  }
  if (percentage >= 60) {
    return "#ffb84d";
  }
  return "#42d7a0";
}

function shell(label: string, body: string, accent = "#8190a5"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="22" fill="#0d1420"/>
  <rect x="1.5" y="1.5" width="141" height="141" rx="20.5" fill="none" stroke="#243247" stroke-width="3"/>
  <text x="72" y="25" text-anchor="middle" fill="#aebbd0" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="1.5">${label}</text>
  ${body}
  <circle cx="127" cy="17" r="5" fill="${accent}"/>
</svg>`;
}

export function renderUsageKey(kind: RateLimitKind, state: UsageDisplayState): string {
  const label = LABELS[kind];

  if (state.kind === "ready") {
    const color = colorForPercentage(state.percentage);
    const progress = Math.round((108 * state.percentage) / 100);
    return shell(
      label,
      `<text x="72" y="70" text-anchor="middle" fill="#f7f9fc" font-family="Arial, sans-serif" font-size="42" font-weight="800">${state.percentage}%</text>
  <rect x="18" y="84" width="108" height="10" rx="5" fill="#26344a"/>
  <rect x="18" y="84" width="${progress}" height="10" rx="5" fill="${color}"/>
  <text x="72" y="118" text-anchor="middle" fill="#dbe3ef" font-family="Arial, sans-serif" font-size="15" font-weight="700">RESET ${state.remaining}</text>`,
      color
    );
  }

  if (state.kind === "setup") {
    return shell(
      label,
      `<text x="72" y="70" text-anchor="middle" fill="#ffb84d" font-family="Arial, sans-serif" font-size="28" font-weight="800">SETUP</text>
  <text x="72" y="107" text-anchor="middle" fill="#dbe3ef" font-family="Arial, sans-serif" font-size="11" font-weight="700">PRESS TO SETUP</text>`,
      "#ffb84d"
    );
  }

  if (state.kind === "waiting") {
    return shell(
      label,
      `<text x="72" y="67" text-anchor="middle" fill="#6cc7ff" font-family="Arial, sans-serif" font-size="24" font-weight="800">NO DATA</text>
  <text x="72" y="105" text-anchor="middle" fill="#dbe3ef" font-family="Arial, sans-serif" font-size="14" font-weight="700">RUN CLAUDE</text>`,
      "#6cc7ff"
    );
  }

  if (state.kind === "expired") {
    return shell(
      label,
      `<text x="72" y="68" text-anchor="middle" fill="#ffb84d" font-family="Arial, sans-serif" font-size="24" font-weight="800">RESET DUE</text>
  <text x="72" y="106" text-anchor="middle" fill="#dbe3ef" font-family="Arial, sans-serif" font-size="16" font-weight="700">${state.remaining}</text>`,
      "#ffb84d"
    );
  }

  return shell(
    label,
    `<text x="72" y="70" text-anchor="middle" fill="#ff5c6c" font-family="Arial, sans-serif" font-size="26" font-weight="800">ERROR</text>
  <text x="72" y="106" text-anchor="middle" fill="#dbe3ef" font-family="Arial, sans-serif" font-size="13" font-weight="700">CHECK LOG</text>`,
    "#ff5c6c"
  );
}

export function renderUsageKeyImage(kind: RateLimitKind, state: UsageDisplayState): string {
  return `data:image/svg+xml,${encodeURIComponent(renderUsageKey(kind, state))}`;
}
