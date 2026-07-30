import streamDeck from "@elgato/streamdeck";
import { fileURLToPath } from "node:url";

import { FiveHourUsageAction } from "./actions/five-hour-usage";
import { CodeStartAction } from "./actions/code-start";
import { WeeklyUsageAction } from "./actions/weekly-usage";
import { pluginBuildLabel } from "./build-version";

streamDeck.logger.setLevel("info");
streamDeck.actions.registerAction(new FiveHourUsageAction());
streamDeck.actions.registerAction(new WeeklyUsageAction());
streamDeck.actions.registerAction(new CodeStartAction());
// Name the running build up front: a rebuilt bundle is only live after Stream
// Deck restarts the plugin, and this line is how that gets confirmed.
streamDeck.logger.info(
  `Claude actions registered: v${pluginBuildLabel(fileURLToPath(import.meta.url))}; connecting to Stream Deck.`
);
await streamDeck.connect();
streamDeck.logger.info("Claude connected to Stream Deck.");
