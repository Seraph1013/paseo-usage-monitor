import { describe, expect, test } from "vitest";
import type { ClaudeBankedResetDetails } from "../shared/claude-reset.shared";
import type { UsageProviderSnapshot } from "../shared/limits.shared";
import { bankedResetAvailableCount } from "./codex-reset.client";
import {
  CLAUDE_RESET_IDLE,
  claudeResetOutcomeMessage,
  claudeResetReducer,
} from "./claude-reset.client";

const DETAILS: ClaudeBankedResetDetails = {
  availableCount: 1,
  options: [
    {
      creditId: "grant_weekly_1",
      kind: "weekly",
      availableCount: 1,
      expiresAt: "2026-12-20T00:00:00Z",
    },
  ],
  redeemRequestId: "73b51db4-7cc9-4a3e-a0bf-924688484c4c",
};

function balance(id: string, remaining: number | null) {
  return {
    kind: "balance" as const,
    id,
    label: id,
    group: null,
    unit: "credits" as const,
    remaining,
    total: null,
    percentRemaining: null,
    currency: null,
  };
}

function claude(readings: UsageProviderSnapshot["readings"]): UsageProviderSnapshot {
  return {
    providerId: "claude",
    label: "Claude",
    description: null,
    unverified: false,
    live: false,
    bankedReset: "claude",
    status: "ok",
    readings,
    error: null,
    fetchedAt: "2026-11-25T10:00:00Z",
    notice: null,
    authRefreshCommand: null,
    display: {},
    icon: null,
  };
}

describe("Claude banked reset control", () => {
  test("counts every per-kind reading and nothing else", () => {
    expect(
      bankedResetAvailableCount(
        claude([
          balance("banked-resets-weekly", 1),
          balance("banked-resets-session", 2),
          balance("banked-resetsish", 9),
          balance("credits", 5),
        ]),
      ),
    ).toBe(3);
    expect(bankedResetAvailableCount(claude([]))).toBe(0);
  });

  test("a failed claim keeps the chosen grant and its request id for the retry", () => {
    const choosing = claudeResetReducer(CLAUDE_RESET_IDLE, { type: "prepared", details: DETAILS });
    const consuming = claudeResetReducer(choosing, {
      type: "consume",
      creditId: "grant_weekly_1",
    });
    const failed = claudeResetReducer(consuming, { type: "failed", message: "Network failed" });

    expect(choosing.status).toBe("choosing");
    expect(failed).toMatchObject({
      status: "error",
      creditId: "grant_weekly_1",
      details: { redeemRequestId: DETAILS.redeemRequestId },
    });
  });

  test("any answer ends the attempt so the next one reads a fresh request id", () => {
    const consuming = claudeResetReducer(
      claudeResetReducer(CLAUDE_RESET_IDLE, { type: "prepared", details: DETAILS }),
      { type: "consume", creditId: "grant_weekly_1" },
    );
    const done = claudeResetReducer(consuming, {
      type: "complete",
      message: claudeResetOutcomeMessage("cooldown"),
    });
    expect(done).toEqual({
      status: "done",
      details: null,
      creditId: null,
      message: claudeResetOutcomeMessage("cooldown"),
    });
  });

  test("nothing to choose is reported rather than offered", () => {
    expect(
      claudeResetReducer(CLAUDE_RESET_IDLE, {
        type: "prepared",
        details: { availableCount: 0, options: [], redeemRequestId: null },
      }),
    ).toMatchObject({ status: "done", message: "No banked reset is available." });
  });

  test("says the grant is kept whenever Claude did not spend it", () => {
    for (const outcome of ["nothing_to_reset", "cooldown", "rate_limited"] as const) {
      expect(claudeResetOutcomeMessage(outcome)).toContain("remains available");
    }
  });
});
