import type { PluginTheme } from "@getpaseo/plugin";
import type { UsageProviderSnapshot } from "../shared/limits.shared";
import { ClaudeBankedResetAction } from "./claude-reset.client";
import { CodexBankedResetAction } from "./codex-reset.client";

/** The saved-reset control for whichever vendor the provider's preset can redeem against. */
export function BankedResetAction(props: {
  provider: UsageProviderSnapshot;
  theme: PluginTheme;
  compact: boolean;
}) {
  switch (props.provider.bankedReset) {
    case "codex":
      return <CodexBankedResetAction {...props} />;
    case "claude":
      return <ClaudeBankedResetAction {...props} />;
    default:
      return null;
  }
}
