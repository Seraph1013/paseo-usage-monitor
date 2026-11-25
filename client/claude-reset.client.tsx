import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer } from "react";
import { Pressable, Text, View } from "react-native";
import {
  consumeClaudeBankedReset,
  readClaudeBankedReset,
  type ClaudeBankedResetDetails,
  type ClaudeBankedResetKind,
  type ClaudeBankedResetOption,
  type ClaudeBankedResetOutcome,
} from "../shared/claude-reset.shared";
import {
  readUsageLimits,
  USAGE_LIMITS_QUERY_KEY,
  type UsageProviderSnapshot,
} from "../shared/limits.shared";
import {
  bankedResetAvailableCount,
  type BankedResetStyles,
  createBankedResetStyles,
  errorMessage,
  expirationLabel,
} from "./codex-reset.client";

export type ClaudeResetStatus = "idle" | "checking" | "choosing" | "consuming" | "done" | "error";

export interface ClaudeResetState {
  status: ClaudeResetStatus;
  details: ClaudeBankedResetDetails | null;
  /** The grant being spent, kept so "Try again" claims the same one. */
  creditId: string | null;
  message: string | null;
}

export const CLAUDE_RESET_IDLE: ClaudeResetState = {
  status: "idle",
  details: null,
  creditId: null,
  message: null,
};

export type ClaudeResetEvent =
  | { type: "check" }
  | { type: "prepared"; details: ClaudeBankedResetDetails }
  | { type: "consume"; creditId: string }
  | { type: "complete"; message: string }
  | { type: "failed"; message: string }
  | { type: "cancel" };

export function claudeResetReducer(
  state: ClaudeResetState,
  event: ClaudeResetEvent,
): ClaudeResetState {
  switch (event.type) {
    case "check":
      return { ...CLAUDE_RESET_IDLE, status: "checking" };
    case "prepared":
      return event.details.options.length > 0 && event.details.redeemRequestId !== null
        ? { status: "choosing", details: event.details, creditId: null, message: null }
        : { ...CLAUDE_RESET_IDLE, status: "done", message: "No banked reset is available." };
    case "consume":
      return state.details === null
        ? state
        : { status: "consuming", details: state.details, creditId: event.creditId, message: null };
    // Every answer Claude gives ends the attempt; the next one reads afresh and
    // so carries a new request id, which a cooldown or 429 needs.
    case "complete":
      return { ...CLAUDE_RESET_IDLE, status: "done", message: event.message };
    case "failed":
      return { ...state, status: "error", message: event.message };
    case "cancel":
      return CLAUDE_RESET_IDLE;
    default:
      return state;
  }
}

export const CLAUDE_RESET_KINDS: Record<
  ClaudeBankedResetKind,
  { label: string; description: string }
> = {
  session: { label: "5-hour reset", description: "Refills your 5-hour limit." },
  weekly: { label: "Weekly reset", description: "Refills your weekly limit." },
  fable: {
    label: "Fable reset",
    description:
      "Refills your Fable allowance and gives back what Fable used on your weekly limit. It doesn't reset your whole week.",
  },
  full: { label: "Full reset", description: "Refills your 5-hour and weekly limits." },
};

export function claudeResetOutcomeMessage(outcome: ClaudeBankedResetOutcome): string {
  switch (outcome) {
    case "reset":
      return "Banked reset applied to your Claude limits.";
    case "nothing_to_reset":
      return "You are not limited right now. Your banked reset remains available.";
    case "already_redeemed":
      return "This banked reset was already applied.";
    case "no_credit":
      return "No banked reset is available.";
    case "cooldown":
      return "Claude resets are cooling down. Your banked reset remains available; try again later.";
    case "rate_limited":
      return "Claude is rate limiting resets. Your banked reset remains available; try again soon.";
  }
}

const OPTION_STYLE = { gap: 4 };
const OPTION_BUSY = { busy: true, disabled: true };
const OPTION_DISABLED = { busy: false, disabled: true };
const OPTION_IDLE = { busy: false, disabled: false };

function ClaudeResetOptionRow({
  option,
  styles,
  busy,
  disabled,
  retry,
  onConsume,
}: {
  option: ClaudeBankedResetOption;
  styles: BankedResetStyles;
  busy: boolean;
  disabled: boolean;
  retry: boolean;
  onConsume: (creditId: string) => void;
}) {
  const kind = CLAUDE_RESET_KINDS[option.kind];
  const expires = expirationLabel(option.expiresAt);
  const press = useCallback(() => onConsume(option.creditId), [onConsume, option.creditId]);
  return (
    <View style={OPTION_STYLE}>
      <Text style={styles.detail}>
        {kind.description}
        {option.availableCount > 1 ? ` ${option.availableCount} on hand.` : ""}
        {expires === null ? "" : ` ${expires}.`}
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={busy ? OPTION_BUSY : disabled ? OPTION_DISABLED : OPTION_IDLE}
          disabled={disabled}
          onPress={press}
          style={[styles.button, styles.primaryButton, disabled ? styles.buttonDisabled : null]}
        >
          <Text style={styles.primaryButtonText}>
            {busy
              ? "Applying…"
              : retry
                ? `Try ${kind.label.toLowerCase()} again`
                : `Use ${kind.label.toLowerCase()}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ClaudeBankedResetAction({
  provider,
  theme,
  compact,
}: {
  provider: UsageProviderSnapshot;
  theme: PluginTheme;
  compact: boolean;
}) {
  const inspectReset = useRpc(readClaudeBankedReset);
  const consumeReset = useRpc(consumeClaudeBankedReset);
  const readSnapshot = useRpc(readUsageLimits);
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(claudeResetReducer, CLAUDE_RESET_IDLE);
  const styles = useMemo(() => createBankedResetStyles(theme, compact), [compact, theme]);
  const availableCount = bankedResetAvailableCount(provider);

  const refreshSnapshot = useCallback(() => {
    void (async () => {
      try {
        const snapshot = await readSnapshot({ refresh: true });
        queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, snapshot);
      } catch (error: unknown) {
        console.warn("[usage-monitor] post-banked-reset read failed", error);
      }
    })();
  }, [queryClient, readSnapshot]);

  const prepare = useCallback(() => {
    if (state.status === "checking" || state.status === "consuming") return;
    dispatch({ type: "check" });
    void (async () => {
      try {
        dispatch({
          type: "prepared",
          details: await inspectReset({ providerId: provider.providerId }),
        });
      } catch (error: unknown) {
        dispatch({ type: "failed", message: errorMessage(error) });
      }
    })();
  }, [inspectReset, provider.providerId, state.status]);

  const consume = useCallback(
    (creditId: string) => {
      const redeemRequestId = state.details?.redeemRequestId ?? null;
      if (redeemRequestId === null || state.status === "consuming") return;
      dispatch({ type: "consume", creditId });
      void (async () => {
        try {
          const { outcome } = await consumeReset({
            providerId: provider.providerId,
            creditId,
            redeemRequestId,
          });
          dispatch({ type: "complete", message: claudeResetOutcomeMessage(outcome) });
          if (outcome === "reset") refreshSnapshot();
        } catch (error: unknown) {
          dispatch({ type: "failed", message: errorMessage(error) });
        }
      })();
    },
    [consumeReset, provider.providerId, refreshSnapshot, state.details, state.status],
  );

  const cancel = useCallback(() => dispatch({ type: "cancel" }), []);

  if (availableCount === 0 && state.status === "idle") return null;
  const isConsuming = state.status === "consuming";
  const options = state.details?.options ?? [];
  // After a failed claim only the grant already tried is offered again.
  const offered =
    state.status === "error" && state.creditId !== null
      ? options.filter((option) => option.creditId === state.creditId)
      : options;

  return (
    <View style={styles.container}>
      {state.status === "idle" ? (
        <Pressable accessibilityRole="button" onPress={prepare} style={styles.button}>
          <Text style={styles.buttonText}>
            {availableCount === 1
              ? "Use banked reset"
              : `Use one of ${availableCount} banked resets`}
          </Text>
        </Pressable>
      ) : null}
      {state.status === "checking" ? (
        <Text style={styles.detail}>Checking reset details…</Text>
      ) : null}
      {state.details !== null &&
      (state.status === "choosing" || isConsuming || state.status === "error") ? (
        <>
          <Text style={styles.prompt}>Spend one banked reset now? This cannot be undone.</Text>
          {offered.map((option) => (
            <ClaudeResetOptionRow
              key={option.creditId}
              option={option}
              styles={styles}
              busy={isConsuming && state.creditId === option.creditId}
              disabled={isConsuming}
              retry={state.status === "error"}
              onConsume={consume}
            />
          ))}
          {state.message === null ? null : <Text style={styles.error}>{state.message}</Text>}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={isConsuming}
              onPress={cancel}
              style={[styles.button, isConsuming ? styles.buttonDisabled : null]}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {state.status === "done" ? <Text style={styles.detail}>{state.message}</Text> : null}
      {state.status === "error" && state.details === null ? (
        <>
          <Text style={styles.error}>{state.message}</Text>
          <Pressable accessibilityRole="button" onPress={prepare} style={styles.button}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
