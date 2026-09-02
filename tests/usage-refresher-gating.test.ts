import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.fn();
vi.mock("node:https", () => ({ default: { request: requestMock } }));
vi.mock("@elgato/streamdeck", () => ({
  streamDeck: { logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }
}));

type FakeResponse = { statusCode: number; headers: Record<string, string>; body: string };

function respondWith(response: FakeResponse) {
  requestMock.mockImplementation((_options: unknown, onResponse: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & FakeResponse;
      res.statusCode = response.statusCode;
      res.headers = response.headers;
      onResponse(res);
      queueMicrotask(() => {
        res.emit("data", response.body);
        res.emit("end");
      });
    };
    req.destroy = () => undefined;
    return req;
  });
}

describe("maybeRefreshUsageViaApi gating", () => {
  beforeEach(() => {
    vi.resetModules();
    requestMock.mockReset();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
  });

  it("does not call the API while usage.json is fresh", async () => {
    const { maybeRefreshUsageViaApi } = await import("../src/services/usage-refresher");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "refresher-"));
    const nowMs = 1_788_319_000_000;
    await maybeRefreshUsageViaApi(dataDir, nowMs, { localCapturedAt: nowMs - 60_000 });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("honours Retry-After on 429 and stays quiet until it passes", async () => {
    const { maybeRefreshUsageViaApi } = await import("../src/services/usage-refresher");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "refresher-"));
    const nowMs = 1_788_319_000_000;
    respondWith({ statusCode: 429, headers: { "retry-after": "1200" }, body: "" });
    await maybeRefreshUsageViaApi(dataDir, nowMs, { localCapturedAt: nowMs - 60 * 60 * 1000 });
    expect(requestMock).toHaveBeenCalledTimes(1);

    // The 1200 s retry-after is measured from wall-clock time at the failure;
    // 10 minutes later (in the caller's clock) it has not passed.
    await maybeRefreshUsageViaApi(dataDir, Date.now() + 10 * 60 * 1000, {});
    expect(requestMock).toHaveBeenCalledTimes(1);
    await maybeRefreshUsageViaApi(dataDir, Date.now() + 21 * 60 * 1000, {});
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("writes a successful response and a mid-body error does not throw", async () => {
    const { maybeRefreshUsageViaApi } = await import("../src/services/usage-refresher");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "refresher-"));
    respondWith({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({
        five_hour: { utilization: 12, resets_at: "2027-01-01T00:00:00Z" },
        seven_day: { utilization: 3, resets_at: "2027-01-05T00:00:00Z" }
      })
    });
    await maybeRefreshUsageViaApi(dataDir, 1_788_319_000_000, {});
    const written = JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8"));
    expect(written.rateLimits.fiveHour.usedPercentage).toBe(12);

    requestMock.mockImplementation((_options: unknown, onResponse: (res: EventEmitter) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object };
        res.statusCode = 200;
        res.headers = {};
        onResponse(res);
        queueMicrotask(() => res.emit("error", new Error("socket hang up")));
      };
      req.destroy = () => undefined;
      return req;
    });
    await expect(maybeRefreshUsageViaApi(dataDir, Date.now() + 60 * 60 * 1000, {})).resolves.toBeUndefined();
  });
});
