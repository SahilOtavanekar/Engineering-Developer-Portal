import { TranslationBlueprint } from '@backstage/plugin-app-react';
import { createTranslationMessages } from '@backstage/frontend-plugin-api';
import { userSettingsTranslationRef } from '@backstage/plugin-user-settings';

/**
 * Rewrites the strings in the Settings pages that name Backstage.
 *
 * The user-settings plugin hardcodes "Backstage" into several visible labels --
 * most obviously the "Backstage Identity" card on Settings > General. They come
 * from the plugin's own translation ref, so they cannot be reached by editing
 * config or by any app-config `extensions:` override; supplying replacement
 * messages for that ref is the supported way to change them.
 *
 * `full` is left unset, so this is a partial override: every key not listed here
 * keeps the plugin's own wording, and a key the plugin later renames falls back
 * to its default rather than breaking the page.
 */
export const userSettingsMessages = createTranslationMessages({
  ref: userSettingsTranslationRef,
  messages: {
    'identityCard.title': 'Demand AI Identity',
    'identityCard.noIdentityTitle': 'No Demand AI Identity',
    // Shown when no auth providers are configured. Upstream reads
    // "...Authentication Providers to Backstage which allows...".
    'emptyProviders.description':
      'You can add Authentication Providers to the portal which allows you to use these providers to authenticate yourself.',
    // Shown when no feature flags are registered. Upstream reads
    // "...register features in Backstage for users to opt into...".
    'featureFlags.emptyFlags.description':
      'Feature Flags make it possible for plugins to register features in the portal for users to opt into. You can use this to split out logic in your code for manual A/B testing, etc.',
  },
});

export const userSettingsTranslations = TranslationBlueprint.make({
  name: 'user-settings',
  params: { resource: userSettingsMessages },
});
