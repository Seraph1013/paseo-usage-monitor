import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Claude Code groups its saved resets the same way: a grant that gives back
 * weekly usage is a Fable reset, otherwise its declared type, otherwise what
 * it clears.
 */
export const ClaudeBankedResetKindSchema = z.enum(["session", "weekly", "fable", "full"]);

export const ClaudeBankedResetOptionSchema = z.object({
  /** The grant redeemed when this option is chosen. */
  creditId: z.string(),
  kind: ClaudeBankedResetKindSchema,
  availableCount: z.number().int().positive(),
  expiresAt: z.string().nullable(),
});

export const ClaudeBankedResetDetailsSchema = z.object({
  availableCount: z.number().int().nonnegative(),
  /** One per kind on hand, in a fixed order: session, weekly, fable, full. */
  options: z.array(ClaudeBankedResetOptionSchema),
  /** Reused for every retry of this prepared attempt; null when nothing is on hand. */
  redeemRequestId: z.string().uuid().nullable(),
});

/**
 * `cooldown` and `rate_limited` are answers, not failures: Claude did not
 * spend the grant, and the next attempt prepares a fresh request id. A claim
 * Claude could not confirm is thrown instead, so a retry reuses the same id.
 */
export const ClaudeBankedResetOutcomeSchema = z.enum([
  "reset",
  "nothing_to_reset",
  "already_redeemed",
  "no_credit",
  "cooldown",
  "rate_limited",
]);

export const readClaudeBankedReset = defineRpc({
  name: "usage.claude.banked-reset.read",
  input: z.object({ providerId: z.string().min(1) }),
  output: ClaudeBankedResetDetailsSchema,
});

export const consumeClaudeBankedReset = defineRpc({
  name: "usage.claude.banked-reset.consume",
  input: z.object({
    providerId: z.string().min(1),
    creditId: z.string().min(1),
    redeemRequestId: z.string().uuid(),
  }),
  output: z.object({ outcome: ClaudeBankedResetOutcomeSchema }),
});

export type ClaudeBankedResetKind = z.infer<typeof ClaudeBankedResetKindSchema>;
export type ClaudeBankedResetOption = z.infer<typeof ClaudeBankedResetOptionSchema>;
export type ClaudeBankedResetDetails = z.infer<typeof ClaudeBankedResetDetailsSchema>;
export type ClaudeBankedResetOutcome = z.infer<typeof ClaudeBankedResetOutcomeSchema>;
