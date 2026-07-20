import { action } from "@elgato/streamdeck";

import { UsageAction } from "./usage-action";

@action({ UUID: "com.hanbroz.claude-usage.weekly" })
export class WeeklyUsageAction extends UsageAction {
  constructor() {
    super("sevenDay");
  }
}
