import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createCredentialResolver,
  type CredentialAdapters,
  type UsageCredentialResolver,
} from "./credentials.server";
import {
  UsageConfigError,
  UsageCredentialMissingError,
  UsageRateLimitedError,
  UsageSourceError,
} from "./errors.server";
import type { UsageProviderEntry } from "./registry.server";
import type { UsageHttpRequest, UsageSourceAdapters } from "./source.server";
import type {
  ClaudeBankedResetDetails,
  ClaudeBankedResetKind,
  ClaudeBankedResetOption,
  ClaudeBankedResetOutcome,
} from "../shared/claude-reset.shared";

const API_BASE = "https://api.anthropic.com";
// `skip_spend` drops the extra-usage block this read has no use for.
const GRANTS_URL = `${API_BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`;
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const KIND_ORDER: readonly ClaudeBankedResetKind[] = ["session", "weekly", "fable", "full"];

const GrantSchema = z.object({
  id: z.string().regex(GRANT_ID),
  label: z.string().nullable().optional(),
  resets_left: z.number().int().nonnegative(),
  ends_at: z.string().nullable().optional(),
  paused: z.boolean().optional(),
  usable_now: z.boolean().optional(),
  clears: z.array(z.unknown()).optional(),
  type: z.unknown().optional(),
  gives_back_weekly: z.boolean().optional(),
});
type Grant = z.infer<typeof GrantSchema>;

const CedarEmberSchema = z.object({
  eligible: z.boolean(),
  grants: z.array(z.unknown()).optional(),
});

const UsageDocumentSchema = z.object({ cedar_ember: z.unknown().optional() });

const ClaimSchema = z.object({
  result: z.enum(["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]),
});

const CLAIM_OUTCOMES: Record<
  Exclude<z.infer<typeof ClaimSchema>["result"], "unavailable">,
  ClaudeBankedResetOutcome
> = {
  reset: "reset",
  not_limited: "nothing_to_reset",
  already_used: "already_redeemed",
  ineligible: "no_credit",
  cooldown: "cooldown",
};

function grantKind(grant: Grant): ClaudeBankedResetKind {
  if (grant.gives_back_weekly === true) return "fable";
  if (grant.type === "session" || grant.type === "weekly" || grant.type === "full") {
    return grant.type;
  }
  const clears = grant.clears ?? [];
  const session = clears.includes("five_hour");
  const other = clears.some((limit) => limit !== "five_hour");
  return session && !other ? "session" : other && !session ? "weekly" : "full";
}

/** A grant with an unreadable or past end date is not offered: spending it would fail. */
function isLive(grant: Grant, nowMs: number): boolean {
  if (grant.paused === true || grant.usable_now !== true || grant.resets_left === 0) return false;
  if (grant.ends_at === null || grant.ends_at === undefined) return true;
  return COMPLETE_TIMESTAMP.test(grant.ends_at) && Date.parse(grant.ends_at) > nowMs;
}

/**
 * The grants Claude would let you spend right now, grouped by kind. Exported
 * for tests; `null` from an ineligible account or a block that did not parse
 * reads the same as no grants.
 */
export function claudeBankedResetOptions(block: unknown, nowMs: number): ClaudeBankedResetOption[] {
  const parsed = CedarEmberSchema.safeParse(block);
  if (!parsed.success || !parsed.data.eligible) return [];
  const byKind = new Map<ClaudeBankedResetKind, Grant[]>();
  for (const raw of parsed.data.grants ?? []) {
    const grant = GrantSchema.safeParse(raw);
    if (!grant.success || !isLive(grant.data, nowMs)) continue;
    const kind = grantKind(grant.data);
    byKind.set(kind, [...(byKind.get(kind) ?? []), grant.data]);
  }
  return KIND_ORDER.flatMap((kind): ClaudeBankedResetOption[] => {
    const grants = byKind.get(kind);
    const first = grants?.[0];
    if (grants === undefined || first === undefined) return [];
    return [
      {
        creditId: first.id,
        kind,
        title: first.label?.trim() || null,
        availableCount: grants.reduce((sum, grant) => sum + grant.resets_left, 0),
        expiresAt: first.ends_at ?? null,
      },
    ];
  });
}

export interface ClaudeBankedResetService {
  read(providerId: string): Promise<ClaudeBankedResetDetails>;
  consume(input: {
    providerId: string;
    creditId: string;
    redeemRequestId: string;
  }): Promise<{ outcome: ClaudeBankedResetOutcome }>;
}

export interface ClaudeBankedResetServiceInput {
  entries: readonly UsageProviderEntry[];
  source: UsageSourceAdapters;
  credentials: CredentialAdapters;
  createRequestId?: () => string;
}

interface ClaudeLogin {
  token: string;
  /** Where Claude Code keeps `oauthAccount`, beside the login the token came from. */
  accountFile: string;
}

/**
 * Only Claude Code's own login is spent against, because the organization id
 * has to come from the same login as the token. A token borrowed from
 * opencode or omp says nothing about which `.claude.json` it belongs to.
 */
function claudeLogin(resolver: UsageCredentialResolver, env: NodeJS.ProcessEnv): ClaudeLogin {
  const token = resolver.resolve("token");
  const source = resolver.resolvedSource("token");
  const ownedByClaude =
    (source?.kind === "jsonFile" || source?.kind === "keychain") && source.refreshedBy === "claude";
  if (!ownedByClaude) {
    throw new UsageConfigError(
      "Banked resets need Claude Code's own login. Run `claude` to sign in.",
    );
  }
  const fromConfigDir =
    source.kind === "jsonFile"
      ? source.file.startsWith("${CLAUDE_CONFIG_DIR}")
      : (env.CLAUDE_CONFIG_DIR ?? "") !== "";
  return {
    token,
    accountFile: fromConfigDir ? "${CLAUDE_CONFIG_DIR}/.claude.json" : "~/.claude.json",
  };
}

export function createClaudeBankedResetService(
  input: ClaudeBankedResetServiceInput,
): ClaudeBankedResetService {
  const createRequestId = input.createRequestId ?? randomUUID;

  function loginFor(providerId: string): ClaudeLogin {
    const entry = input.entries.find((candidate) => candidate.id === providerId);
    if (!entry?.provider) {
      throw new UsageConfigError(`Usage provider "${providerId}" is not configured`);
    }
    if (entry.provider.bankedReset !== "claude") {
      throw new UsageConfigError(
        `Usage provider "${providerId}" does not support Claude banked resets`,
      );
    }
    return claudeLogin(
      createCredentialResolver(entry.provider.credentials, input.credentials),
      input.credentials.env,
    );
  }

  /** Reads one string out of `.claude.json`; null when it is not there. */
  function accountValue(accountFile: string, path: string): string | null {
    const resolver = createCredentialResolver(
      { value: [{ kind: "jsonFile", file: accountFile, path }] },
      input.credentials,
    );
    try {
      return resolver.resolve("value");
    } catch (error) {
      if (error instanceof UsageCredentialMissingError) return null;
      throw error;
    }
  }

  function headersFor(login: ClaudeLogin): Record<string, string> {
    // Claude Code sends its own version; an unknown one is left out rather than guessed.
    const version = accountValue(login.accountFile, "lastReleaseNotesSeen");
    return {
      Authorization: `Bearer ${login.token}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      ...(version === null ? {} : { "User-Agent": `claude-cli/${version} (external, cli)` }),
    };
  }

  async function read(providerId: string): Promise<ClaudeBankedResetDetails> {
    const login = loginFor(providerId);
    const document = await input.source.fetchJson({
      url: GRANTS_URL,
      method: "GET",
      headers: headersFor(login),
    });
    const parsed = UsageDocumentSchema.safeParse(document);
    if (!parsed.success) {
      throw new UsageSourceError("Claude returned invalid banked reset details");
    }
    const options = claudeBankedResetOptions(
      parsed.data.cedar_ember,
      input.credentials.now().getTime(),
    );
    const availableCount = options.reduce((sum, option) => sum + option.availableCount, 0);
    return {
      availableCount,
      options,
      redeemRequestId: availableCount > 0 ? createRequestId() : null,
    };
  }

  async function consume({
    providerId,
    creditId,
    redeemRequestId,
  }: {
    providerId: string;
    creditId: string;
    redeemRequestId: string;
  }): Promise<{ outcome: ClaudeBankedResetOutcome }> {
    if (!GRANT_ID.test(creditId)) {
      throw new UsageSourceError("Claude returned a malformed reset credit");
    }
    const login = loginFor(providerId);
    const organization = accountValue(login.accountFile, "oauthAccount.organizationUuid");
    if (organization === null) {
      throw new UsageConfigError(
        "Claude Code's account file names no organization. Run `claude` to sign in.",
      );
    }
    const request: UsageHttpRequest = {
      url: `${API_BASE}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
      method: "POST",
      headers: { ...headersFor(login), "Content-Type": "application/json" },
      body: { program: PROGRAM, grant_id: creditId, request_id: redeemRequestId },
    };
    let document: unknown;
    try {
      document = await input.source.fetchJson(request);
    } catch (error) {
      if (error instanceof UsageRateLimitedError) return { outcome: "rate_limited" };
      if (error instanceof UsageSourceError && (error.status === 401 || error.status === 403)) {
        throw new UsageConfigError("Claude rejected the login. Run `claude` to sign in again.");
      }
      throw error;
    }
    const parsed = ClaimSchema.safeParse(document);
    if (!parsed.success) {
      throw new UsageSourceError("Claude returned an invalid banked reset result");
    }
    // Claude took the claim but cannot say how it ended; the same request id
    // is what lets a retry ask about this claim rather than make another.
    if (parsed.data.result === "unavailable") {
      throw new UsageSourceError(
        "Claude could not confirm the reset. If you are still limited in a moment, try again.",
      );
    }
    return { outcome: CLAIM_OUTCOMES[parsed.data.result] };
  }

  return { read, consume };
}
