import streamDeck from "@elgato/streamdeck";

import { FiveHourUsageAction } from "./actions/five-hour-usage";
import { CodeStartAction } from "./actions/code-start";
import { WeeklyUsageAction } from "./actions/weekly-usage";

streamDeck.logger.setLevel("info");
streamDeck.actions.registerAction(new FiveHourUsageAction());
streamDeck.actions.registerAction(new WeeklyUsageAction());
streamDeck.actions.registerAction(new CodeStartAction());
streamDeck.logger.info("Claude actions registered; connecting to Stream Deck.");
await streamDeck.connect();
streamDeck.logger.info("Claude connected to Stream Deck.");
