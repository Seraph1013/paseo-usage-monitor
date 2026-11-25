import { describe, expect, test, vi } from "vitest";
import { UsageProviderOverridesSchema } from "../shared/limits.shared";
import { claudeBankedResetOptions, createClaudeBankedResetService } from "./claude-reset.server";
import { UsageRateLimitedError, UsageSourceError } from "./errors.server";
import { buildProviderRegistry } from "./registry.server";
import type { UsageHttpRequest } from "./source.server";

const HOME_DIR = "/home/tester";
const CREDENTIALS_PATH = `${HOME_DIR}/.claude/.credentials.json`;
const ACCOUNT_PATH = `${HOME_DIR}/.claude.json`;
const TOKEN = "claude-access-token";
const ORGANIZATION = "org-0000-1111";
const REQUEST_ID = "73b51db4-7cc9-4a3e-a0bf-924688484c4c";
const NOW = new Date("2026-11-25T10:00:00Z");

const WEEKLY_GRANT = {
  id: "grant_weekly_1",
  type: "weekly",
  resets_left: 1,
  usable_now: true,
  ends_at: "2026-12-20T00:00:00Z",
};

function createService(options: {
  respond: (request: UsageHttpRequest) => unknown;
  requests?: UsageHttpRequest[];
  files?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  preset?: string;
}) {
  const requests = options.requests ?? [];
  const files = options.files ?? {
    [CREDENTIALS_PATH]: { claudeAiOauth: { accessToken: TOKEN } },
    [ACCOUNT_PATH]: {
      lastReleaseNotesSeen: "2.1.327",
      oauthAccount: { organizationUuid: ORGANIZATION },
    },
  };
  const entries = buildProviderRegistry(
    UsageProviderOverridesSchema.parse({ claude: { preset: options.preset ?? "claude" } }),
  );
  return createClaudeBankedResetService({
    entries,
    source: {
      async fetchJson(request) {
        requests.push(request);
        return options.respond(request);
      },
      runCommand: vi.fn(),
    },
    credentials: {
      env: options.env ?? {},
      homeDir: HOME_DIR,
      readTextFile: (path) => (path in files ? JSON.stringify(files[path]) : null),
      now: () => NOW,
    },
    createRequestId: () => REQUEST_ID,
  });
}

describe("Claude banked reset grants", () => {
  const nowMs = NOW.getTime();

  test("groups usable grants by kind in a fixed order and sums what is left", () => {
    const options = claudeBankedResetOptions(
      {
        eligible: true,
        grants: [
          {
            id: "grant_full",
            clears: ["five_hour", "seven_day"],
            resets_left: 1,
            usable_now: true,
          },
          WEEKLY_GRANT,
          { id: "grant_weekly_2", clears: ["seven_day"], resets_left: 2, usable_now: true },
          { id: "grant_fable", gives_back_weekly: true, resets_left: 1, usable_now: true },
          { id: "grant_session", clears: ["five_hour"], resets_left: 1, usable_now: true },
        ],
      },
      nowMs,
    );
    expect(options).toEqual([
      { creditId: "grant_session", kind: "session", availableCount: 1, expiresAt: null },
      {
        creditId: "grant_weekly_1",
        kind: "weekly",
        availableCount: 3,
        expiresAt: "2026-12-20T00:00:00Z",
      },
      { creditId: "grant_fable", kind: "fable", availableCount: 1, expiresAt: null },
      { creditId: "grant_full", kind: "full", availableCount: 1, expiresAt: null },
    ]);
  });

  test("offers nothing paused, not usable now, spent, expired or malformed", () => {
    const options = claudeBankedResetOptions(
      {
        eligible: true,
        grants: [
          { ...WEEKLY_GRANT, id: "paused", paused: true },
          { ...WEEKLY_GRANT, id: "later", usable_now: false },
          { ...WEEKLY_GRANT, id: "spent", resets_left: 0 },
          { ...WEEKLY_GRANT, id: "expired", ends_at: "2026-11-01T00:00:00Z" },
          { ...WEEKLY_GRANT, id: "odd_date", ends_at: "next week" },
          { ...WEEKLY_GRANT, id: "Bad Id!" },
        ],
      },
      nowMs,
    );
    expect(options).toEqual([]);
  });

  test("an ineligible account or a missing block offers nothing", () => {
    expect(claudeBankedResetOptions({ eligible: false, grants: [WEEKLY_GRANT] }, nowMs)).toEqual(
      [],
    );
    expect(claudeBankedResetOptions(undefined, nowMs)).toEqual([]);
  });
});

describe("Claude banked reset service", () => {
  test("reads grants with Claude Code's login and prepares one request id", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({
      requests,
      respond: () => ({ cedar_ember: { eligible: true, grants: [WEEKLY_GRANT] } }),
    });

    await expect(service.read("claude")).resolves.toEqual({
      availableCount: 1,
      options: [
        {
          creditId: "grant_weekly_1",
          kind: "weekly",
          availableCount: 1,
          expiresAt: "2026-12-20T00:00:00Z",
        },
      ],
      redeemRequestId: REQUEST_ID,
    });
    expect(requests).toEqual([
      {
        url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
        method: "GET",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.327 (external, cli)",
        },
      },
    ]);
  });

  test("prepares no request id when nothing can be spent", async () => {
    const service = createService({ respond: () => ({ cedar_ember: { eligible: false } }) });
    await expect(service.read("claude")).resolves.toEqual({
      availableCount: 0,
      options: [],
      redeemRequestId: null,
    });
  });

  test("claims one grant against the login's organization", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({ requests, respond: () => ({ result: "reset" }) });

    await expect(
      service.consume({
        providerId: "claude",
        creditId: "grant_weekly_1",
        redeemRequestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ outcome: "reset" });
    expect(requests).toEqual([
      {
        url: `https://api.anthropic.com/api/organizations/${ORGANIZATION}/reset_rate_limits`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.327 (external, cli)",
          "Content-Type": "application/json",
        },
        body: { program: "cedar_ember", grant_id: "grant_weekly_1", request_id: REQUEST_ID },
      },
    ]);
  });

  test.each([
    ["reset", "reset"],
    ["not_limited", "nothing_to_reset"],
    ["already_used", "already_redeemed"],
    ["ineligible", "no_credit"],
    ["cooldown", "cooldown"],
  ])("maps Claude's %s answer to %s", async (result, outcome) => {
    const service = createService({ respond: () => ({ result }) });
    await expect(
      service.consume({ providerId: "claude", creditId: "grant_x", redeemRequestId: REQUEST_ID }),
    ).resolves.toEqual({ outcome });
  });

  test("a 429 is an answer that leaves the grant unspent", async () => {
    const service = createService({
      respond: () => {
        throw new UsageRateLimitedError("POST request to api.anthropic.com failed", 60_000);
      },
    });
    await expect(
      service.consume({ providerId: "claude", creditId: "grant_x", redeemRequestId: REQUEST_ID }),
    ).resolves.toEqual({ outcome: "rate_limited" });
  });

  test("an unconfirmed claim throws so a retry reuses the same request id", async () => {
    const service = createService({ respond: () => ({ result: "unavailable" }) });
    await expect(
      service.consume({ providerId: "claude", creditId: "grant_x", redeemRequestId: REQUEST_ID }),
    ).rejects.toThrow("Claude could not confirm the reset");
  });

  test("a rejected login asks for a new sign-in without naming the token", async () => {
    const service = createService({
      respond: () => {
        throw new UsageSourceError("POST request to api.anthropic.com failed with HTTP 401", {
          status: 401,
        });
      },
    });
    const attempt = service.consume({
      providerId: "claude",
      creditId: "grant_x",
      redeemRequestId: REQUEST_ID,
    });
    await expect(attempt).rejects.toThrow("Run `claude` to sign in again");
    await expect(attempt).rejects.not.toThrow(TOKEN);
  });

  test("refuses a token that is not Claude Code's own login", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({
      requests,
      respond: () => ({}),
      files: {
        [`${HOME_DIR}/.local/share/opencode/auth.json`]: { anthropic: { access: TOKEN } },
        [ACCOUNT_PATH]: { oauthAccount: { organizationUuid: ORGANIZATION } },
      },
    });
    await expect(service.read("claude")).rejects.toThrow("Claude Code's own login");
    expect(requests).toEqual([]);
  });

  test("reads the organization beside a login under CLAUDE_CONFIG_DIR", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({
      requests,
      env: { CLAUDE_CONFIG_DIR: "/work/claude" },
      respond: () => ({ result: "reset" }),
      files: {
        "/work/claude/.credentials.json": { claudeAiOauth: { accessToken: TOKEN } },
        "/work/claude/.claude.json": { oauthAccount: { organizationUuid: "org-work" } },
        [ACCOUNT_PATH]: { oauthAccount: { organizationUuid: ORGANIZATION } },
      },
    });
    await service.consume({
      providerId: "claude",
      creditId: "grant_x",
      redeemRequestId: REQUEST_ID,
    });
    expect(requests[0]?.url).toBe(
      "https://api.anthropic.com/api/organizations/org-work/reset_rate_limits",
    );
    // No version recorded there, so none is claimed.
    expect(requests[0]?.headers).not.toHaveProperty("User-Agent");
  });

  test("fails before any request when the account names no organization", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({
      requests,
      respond: () => ({ result: "reset" }),
      files: { [CREDENTIALS_PATH]: { claudeAiOauth: { accessToken: TOKEN } } },
    });
    await expect(
      service.consume({ providerId: "claude", creditId: "grant_x", redeemRequestId: REQUEST_ID }),
    ).rejects.toThrow("names no organization");
    expect(requests).toEqual([]);
  });

  test("only the built-in Claude preset may spend a grant", async () => {
    const service = createService({ preset: "claude-statusline", respond: () => ({}) });
    await expect(service.read("claude")).rejects.toThrow("does not support Claude banked resets");
  });
});
