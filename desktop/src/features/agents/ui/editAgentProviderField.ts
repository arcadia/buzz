import {
  AUTO_PROVIDER_DROPDOWN_VALUE,
  BLOCK_BUILD_HIDDEN_PROVIDER_IDS,
  CUSTOM_PROVIDER_DROPDOWN_VALUE,
  getPersonaProviderOptions,
  type PersonaDropdownOption,
} from "./agentConfigOptions";
import {
  getBakedProviderInheritLabel,
  type InheritedDefault,
} from "./bakedEnvHelpers";

export function buildEditAgentProviderField({
  bakedEnvKeys,
  inheritedProviderDefault,
  isCustomProviderEditing,
  provider,
  runtimeId,
}: {
  bakedEnvKeys: readonly string[] | undefined;
  inheritedProviderDefault: InheritedDefault;
  isCustomProviderEditing: boolean;
  provider: string;
  runtimeId: string;
}) {
  const trimmedProvider = provider.trim();
  const hideProviderIds = (bakedEnvKeys ?? []).includes("BUZZ_AGENT_PROVIDER")
    ? BLOCK_BUILD_HIDDEN_PROVIDER_IDS
    : new Set<string>();
  const providerOptions = getPersonaProviderOptions(
    trimmedProvider,
    runtimeId,
    inheritedProviderDefault.source === "global"
      ? inheritedProviderDefault.value
      : "",
    hideProviderIds,
  );
  const providerSelectValue = isCustomProviderEditing
    ? CUSTOM_PROVIDER_DROPDOWN_VALUE
    : trimmedProvider || AUTO_PROVIDER_DROPDOWN_VALUE;
  const providerDropdownOptions: PersonaDropdownOption[] = [
    ...providerOptions.map((option) => ({
      label:
        option.id === "" && inheritedProviderDefault.source === "build"
          ? getBakedProviderInheritLabel(
              inheritedProviderDefault.value,
              providerOptions,
            )
          : option.label,
      value: option.id || AUTO_PROVIDER_DROPDOWN_VALUE,
    })),
    { label: "Custom provider...", value: CUSTOM_PROVIDER_DROPDOWN_VALUE },
  ];
  return { providerDropdownOptions, providerSelectValue };
}
