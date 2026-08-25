import { mockServices } from '@backstage/backend-test-utils';
import { AuthorIndex, normaliseName } from './identity';
import { CompositeOwnershipResolver } from './CompositeOwnershipResolver';
import type { OwnershipProposal, OwnershipResolver } from './types';

const SINCE = new Date('2026-05-27T12:00:00.000Z');
const WINDOW = 90;

function resolver(
  source: string,
  proposal: Partial<OwnershipProposal> | Error,
  onPrepare?: () => void,
): OwnershipResolver {
  return {
    source,
    prepare: async () => {
      onPrepare?.();
    },
    resolve: async () => {
      if (proposal instanceof Error) throw proposal;
      return {
        candidates: [],
        windowCommits: 0,
        windowDays: WINDOW,
        ...proposal,
      };
    },
  };
}

const ADA = { name: 'Ada Lovelace', email: 'ada@demandai.co', commits: 5 };
const ALAN = { name: 'Alan Turing', email: 'alan@demandai.co', commits: 3 };

describe('normaliseName', () => {
  it('reduces a display name to a comparable form', () => {
    expect(normaliseName('Sreenivas Dasam')).toBe('sreenivas-dasam');
    expect(normaliseName('Gurudutt .')).toBe('gurudutt');
    expect(normaliseName('Amey Sunil khurdekar')).toBe('amey-sunil-khurdekar');
  });

  it('returns empty for a name with nothing usable in it', () => {
    expect(normaliseName('...')).toBe('');
  });
});

describe('AuthorIndex', () => {
  it('matches a display name to the email of the same person', () => {
    const index = new AuthorIndex([
      { name: 'Sreenivas Dasam', email: 'sreenivas.dasam@demandai.co' },
    ]);

    expect(index.emailFor('Sreenivas Dasam')).toBe(
      'sreenivas.dasam@demandai.co',
    );
  });

  it('matches through the address when the display name differs', () => {
    // `Gurudutt .` carries a trailing dot the address does not.
    const index = new AuthorIndex([
      { name: 'Gurudutt', email: 'gurudutt@demandai.co' },
    ]);

    expect(index.emailFor('Gurudutt .')).toBe('gurudutt@demandai.co');
  });

  it('matches a dotted address against a spaced name', () => {
    const index = new AuthorIndex([{ email: 'makarand.prabhu@demandai.co' }]);

    expect(index.emailFor('Makarand Prabhu')).toBe(
      'makarand.prabhu@demandai.co',
    );
  });

  it('returns undefined for somebody who never committed', () => {
    // Two of this estate's 16 admins are in exactly this position.
    const index = new AuthorIndex([{ email: 'ada@demandai.co' }]);

    expect(index.emailFor('Amey Sunil khurdekar')).toBeUndefined();
  });

  it('does not let a later namesake take over an address', () => {
    const index = new AuthorIndex([
      { name: 'Ada Lovelace', email: 'ada.lovelace@demandai.co' },
      { name: 'Ada Lovelace', email: 'impostor@demandai.co' },
    ]);

    expect(index.emailFor('Ada Lovelace')).toBe('ada.lovelace@demandai.co');
  });

  it('tolerates an empty index', () => {
    expect(new AuthorIndex().emailFor('Anyone')).toBeUndefined();
    expect(new AuthorIndex().size).toBe(0);
  });
});

describe('CompositeOwnershipResolver', () => {
  const build = (resolvers: OwnershipResolver[]) =>
    new CompositeOwnershipResolver({
      resolvers,
      logger: mockServices.logger.mock(),
    });

  it('refuses to be built with nothing to try', () => {
    expect(() => build([])).toThrow(/at least one resolver/);
  });

  it('takes the first source that names somebody', async () => {
    const composite = build([
      resolver('repository-admin', { candidates: [ADA], proposed: ADA }),
      resolver('commit-history', { candidates: [ALAN], proposed: ALAN }),
    ]);

    const proposal = await composite.resolve(1, SINCE, WINDOW);

    expect(proposal.proposed).toBe(ADA);
    expect(composite.source).toBe('repository-admin');
  });

  it('falls through to the next source when the first names nobody', async () => {
    // 17 repositories have no admin configured. Commit history answers 7.
    const composite = build([
      resolver('repository-admin', { candidates: [] }),
      resolver('commit-history', { candidates: [ALAN], proposed: ALAN }),
    ]);

    const proposal = await composite.resolve(1, SINCE, WINDOW);

    expect(proposal.proposed).toBe(ALAN);
    expect(composite.source).toBe('commit-history');
  });

  it('keeps the first source that at least found people', async () => {
    // A contested repository should still show its candidates rather than
    // nothing at all.
    const composite = build([
      resolver('repository-admin', { candidates: [ADA, ALAN] }),
      resolver('commit-history', { candidates: [] }),
    ]);

    const proposal = await composite.resolve(1, SINCE, WINDOW);

    expect(proposal.proposed).toBeUndefined();
    expect(proposal.candidates).toEqual([ADA, ALAN]);
    expect(composite.source).toBe('repository-admin');
  });

  it('carries on when one source throws', async () => {
    // A 403 on permissions must not cost the repository commit history too.
    const composite = build([
      resolver('repository-admin', new Error('403 Forbidden')),
      resolver('commit-history', { candidates: [ALAN], proposed: ALAN }),
    ]);

    const proposal = await composite.resolve(1, SINCE, WINDOW);

    expect(proposal.proposed).toBe(ALAN);
    expect(composite.source).toBe('commit-history');
  });

  it('returns an empty proposal when every source fails', async () => {
    const composite = build([
      resolver('repository-admin', new Error('boom')),
      resolver('commit-history', new Error('boom')),
    ]);

    await expect(composite.resolve(1, SINCE, WINDOW)).resolves.toMatchObject({
      candidates: [],
      windowDays: WINDOW,
    });
  });

  it('prepares every source, not just the first', async () => {
    const prepared: string[] = [];
    const composite = build([
      resolver('repository-admin', { candidates: [] }, () =>
        prepared.push('admin'),
      ),
      resolver('commit-history', { candidates: [] }, () =>
        prepared.push('commits'),
      ),
    ]);

    await composite.prepare('demandai');

    expect(prepared).toEqual(['admin', 'commits']);
  });

  it('reports the leading source before anything has resolved', async () => {
    const composite = build([resolver('repository-admin', { candidates: [] })]);

    expect(composite.source).toBe('repository-admin');
  });
});
