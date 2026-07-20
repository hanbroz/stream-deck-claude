import { action } from "@elgato/streamdeck";

import { UsageAction } from "./usage-action";

@action({ UUID: "com.hanbroz.claude-usage.five-hour" })
export class FiveHourUsageAction extends UsageAction {
  constructor() {
    super("fiveHour");
  }
}
