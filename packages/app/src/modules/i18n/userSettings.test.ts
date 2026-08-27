import { userSettingsMessages } from './userSettings';

describe('user settings string overrides', () => {
  it('targets the user-settings translation ref', () => {
    expect(userSettingsMessages.id).toBe('user-settings');
  });

  it('is a partial override, so unlisted strings keep the plugin wording', () => {
    // A full override would have to restate every message in the ref, and any
    // message the plugin adds later would render blank.
    expect(userSettingsMessages.full).toBeFalsy();
  });

  it('renames the identity card', () => {
    // The phrase the whole module exists for: Settings > General showed
    // "Backstage Identity".
    expect(userSettingsMessages.messages['identityCard.title']).toBe(
      'Demand AI Identity',
    );
    expect(userSettingsMessages.messages['identityCard.noIdentityTitle']).toBe(
      'No Demand AI Identity',
    );
  });

  it('leaves no override still naming Backstage', () => {
    const offenders = Object.entries(userSettingsMessages.messages)
      .filter(([, value]) => /backstage/i.test(String(value)))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});
