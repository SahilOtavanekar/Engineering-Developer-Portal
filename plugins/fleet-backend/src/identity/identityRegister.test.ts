import { ConfigReader } from '@backstage/config';
import { mockServices } from '@backstage/backend-test-utils';
import {
  isNotAPerson,
  normaliseAddress,
  readIdentityRegister,
  resolveEngineer,
  unregisteredAddresses,
} from './identityRegister';

const logger = () => mockServices.logger.mock();

/** The real shape of this estate: five people with more than one address. */
const register = () =>
  readIdentityRegister(
    new ConfigReader({
      people: {
        'makarand-prabhu': {
          name: 'Makarand Prabhu',
          email: 'makarand.prabhu@demandai.co',
          aliases: [
            'makarand.r.prabhu@gmail.com',
            'makarandprabhu@users.noreply.bitbucket.org',
          ],
        },
        'shalvi-mishra': {
          name: 'Shalvi Mishra',
          email: 'shalvi.mishra@demandai.co',
        },
        'brijesh-gupta': {
          name: 'Brijesh Gupta',
          email: 'brijesh.gupta@demandai.co',
        },
      },
      notPeople: ['noreply@anthropic.com'],
    }),
    logger(),
  );

describe('normaliseAddress', () => {
  it('strips the smart quotes a bad git config wrapped an address in', () => {
    // 259 of Shalvi Mishra's commits carry this form. Aggregating raw addresses
    // would split her almost five to one against her clean address.
    expect(normaliseAddress('“shalvi.mishra@demandai.co”')).toBe(
      'shalvi.mishra@demandai.co',
    );
  });

  it('strips angle brackets and straight quotes too', () => {
    expect(normaliseAddress('<jo@demandai.co>')).toBe('jo@demandai.co');
    expect(normaliseAddress('"jo@demandai.co"')).toBe('jo@demandai.co');
  });

  it('lowercases and trims', () => {
    expect(normaliseAddress('  Jo.Bloggs@DemandAI.co  ')).toBe(
      'jo.bloggs@demandai.co',
    );
  });

  it('keeps the characters that are legal in an address', () => {
    expect(normaliseAddress('first.last+tag_1%x-y@sub.demandai.co')).toBe(
      'first.last+tag_1%x-y@sub.demandai.co',
    );
  });

  it('returns empty for nothing, rather than throwing', () => {
    expect(normaliseAddress(undefined)).toBe('');
    expect(normaliseAddress('')).toBe('');
    expect(normaliseAddress('   ')).toBe('');
  });
});

describe('readIdentityRegister', () => {
  it('resolves every alias to the same person', () => {
    // Makarand commits under three addresses; raw aggregation would report
    // three engineers with 111, 6 and 1 commits.
    const r = register();

    for (const address of [
      'makarand.prabhu@demandai.co',
      'makarand.r.prabhu@gmail.com',
      'makarandprabhu@users.noreply.bitbucket.org',
    ]) {
      expect(resolveEngineer(r, address)?.key).toBe('makarand-prabhu');
    }
  });

  it('merges a mangled address on normalisation alone, with no alias entry', () => {
    const r = register();

    expect(resolveEngineer(r, '“shalvi.mishra@demandai.co”')?.key).toBe(
      'shalvi-mishra',
    );
  });

  it('counts one person per human, not one per address', () => {
    expect(register().people.map(p => p.key)).toEqual([
      'makarand-prabhu',
      'shalvi-mishra',
      'brijesh-gupta',
    ]);
  });

  it('knows an address that belongs to nobody', () => {
    // An AI agent has 32 commits on this estate. It must not appear in a league
    // table of engineers.
    const r = register();

    expect(isNotAPerson(r, 'noreply@anthropic.com')).toBe(true);
    expect(resolveEngineer(r, 'noreply@anthropic.com')).toBeUndefined();
    expect(isNotAPerson(r, 'brijesh.gupta@demandai.co')).toBe(false);
  });

  it('skips a person missing a name or an email', () => {
    const r = readIdentityRegister(
      new ConfigReader({
        people: {
          good: { name: 'Good', email: 'good@demandai.co' },
          nameless: { email: 'nameless@demandai.co' },
        },
      }),
      logger(),
    );

    expect(r.people.map(p => p.key)).toEqual(['good']);
    expect(resolveEngineer(r, 'nameless@demandai.co')).toBeUndefined();
  });

  it('refuses to let a second person claim an address already taken', () => {
    // A typo must not quietly reassign somebody's commits.
    const r = readIdentityRegister(
      new ConfigReader({
        people: {
          first: { name: 'First', email: 'shared@demandai.co' },
          second: {
            name: 'Second',
            email: 'second@demandai.co',
            aliases: ['shared@demandai.co'],
          },
        },
      }),
      logger(),
    );

    expect(resolveEngineer(r, 'shared@demandai.co')?.key).toBe('first');
    expect(resolveEngineer(r, 'second@demandai.co')?.key).toBe('second');
  });

  it('treats an address listed as both a person and not a person as a person', () => {
    const r = readIdentityRegister(
      new ConfigReader({
        people: { jo: { name: 'Jo', email: 'jo@demandai.co' } },
        notPeople: ['jo@demandai.co'],
      }),
      logger(),
    );

    expect(isNotAPerson(r, 'jo@demandai.co')).toBe(false);
    expect(resolveEngineer(r, 'jo@demandai.co')?.key).toBe('jo');
  });

  it('drops a person whose every address was already claimed', () => {
    const r = readIdentityRegister(
      new ConfigReader({
        people: {
          first: { name: 'First', email: 'shared@demandai.co' },
          ghost: { name: 'Ghost', email: 'shared@demandai.co' },
        },
      }),
      logger(),
    );

    expect(r.people.map(p => p.key)).toEqual(['first']);
  });

  it('treats an absent register as empty rather than failing', () => {
    const r = readIdentityRegister(undefined);

    expect(r.people).toEqual([]);
    expect(resolveEngineer(r, 'anyone@demandai.co')).toBeUndefined();
    expect(isNotAPerson(r, 'anyone@demandai.co')).toBe(false);
  });
});

describe('unregisteredAddresses', () => {
  it('reports a real human the register has never heard of', () => {
    // So a pass can say "342 commits from 3 unregistered addresses" instead of
    // leaving them silently out of the totals.
    const unknown = unregisteredAddresses(register(), [
      'brijesh.gupta@demandai.co',
      'newjoiner@demandai.co',
      'noreply@anthropic.com',
    ]);

    expect(unknown).toEqual(['newjoiner@demandai.co']);
  });

  it('counts an excluded address as accounted for, not unregistered', () => {
    expect(
      unregisteredAddresses(register(), ['noreply@anthropic.com']),
    ).toEqual([]);
  });

  it('deduplicates and normalises before reporting', () => {
    const unknown = unregisteredAddresses(register(), [
      'New.Joiner@demandai.co',
      '“new.joiner@demandai.co”',
      undefined,
      '',
    ]);

    expect(unknown).toEqual(['new.joiner@demandai.co']);
  });
});
