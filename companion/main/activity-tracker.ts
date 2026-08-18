import type { ClaudeEvent } from "../shared/claude-stream";
import type { CompanionActivity } from "./context-snapshot";

/**
 * Derives the key's activity from the conversation stream.
 *
 * Background agents outlive the reply that launched them: Claude reports
 * `end_turn` while its Task agents keep working inside the same held-open run.
 * Taking the phase alone published `waiting` there, so the Stream Deck key sat
 * blinking for input while five agents were still busy. A live agent outranks
 * the turn's own phase — the session IS working, whoever is doing the work.
 *
 * The run's exit closes every agent it still held (as `unknown`), so a killed
 * or backstopped run cannot leave the key pinned to "running".
 */
export function createActivityTracker(): (events: readonly ClaudeEvent[]) => CompanionActivity {
  const liveAgents = new Set<string>();
  let phaseActivity: CompanionActivity = "waiting";

  return (events) => {
    for (const event of events) {
      if (event.kind === "phase") {
        phaseActivity = event.phase === "waiting" || event.phase === "ready" ? "waiting" : "running";
      } else if (event.kind === "error" || event.kind === "login") {
        phaseActivity = "waiting";
      } else if (event.kind === "agent" && event.op === "start") {
        liveAgents.add(event.toolUseId);
      } else if (event.kind === "agent" && event.op === "end") {
        liveAgents.delete(event.toolUseId);
      }
    }
    return liveAgents.size > 0 ? "running" : phaseActivity;
  };
}
