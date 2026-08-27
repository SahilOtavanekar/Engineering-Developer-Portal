import { ConfigReader } from '@backstage/config';
import { mockServices } from '@backstage/backend-test-utils';
import { readOwnershipRegister } from './ownershipRegister';

const logger = () => mockServices.logger.mock();

describe('readOwnershipRegister', () => {
  it('reads people and repositories', () => {
    const register = readOwnershipRegister(
      new ConfigReader({
        people: {
          mangesh: { name: 'Mangesh Gaikwad', email: 'mangesh@demandai.co' },
          brijesh: { name: 'Brijesh Gupta', email: 'brijesh@demandai.co' },
        },
        repositories: { dxp: ['mangesh'], 'oxp-backend': ['brijesh'] },
      }),
    );

    expect(register.people.get('mangesh')).toEqual({
      name: 'Mangesh Gaikwad',
      email: 'mangesh@demandai.co',
    });
    expect(register.repositories.get('oxp-backend')).toEqual(['brijesh']);
  });

  it('keeps the register order, which is the answer', () => {
    // The document lists several owners per repository and the first is the one
    // that becomes the catalog owner, so the order is meaning, not decoration.
    const register = readOwnershipRegister(
      new ConfigReader({
        people: {
          a: { name: 'A', email: 'a@demandai.co' },
          b: { name: 'B', email: 'b@demandai.co' },
          c: { name: 'C', email: 'c@demandai.co' },
        },
        repositories: { 'oxp-backend': ['b', 'c', 'a'] },
      }),
    );

    expect(register.repositories.get('oxp-backend')).toEqual(['b', 'c', 'a']);
  });

  it('drops an owner name it cannot resolve rather than guessing', () => {
    // The register names people by first name and this estate holds both a
    // Subham Jain and a Shubham Sharma. A wrong owner is worse than none.
    const register = readOwnershipRegister(
      new ConfigReader({
        people: { vivek: { name: 'Vivek M', email: 'vivek@demandai.co' } },
        repositories: { 'website-tracking': ['vivek', 'shubham'] },
      }),
      logger(),
    );

    expect(register.repositories.get('website-tracking')).toEqual(['vivek']);
  });

  it('omits a repository entirely when no owner resolves', () => {
    // So the composite resolver falls through to the derived sources instead of
    // the repository looking confirmed-but-ownerless.
    const register = readOwnershipRegister(
      new ConfigReader({
        people: {},
        repositories: { 'ux-designs': ['nobody'] },
      }),
      logger(),
    );

    expect(register.repositories.has('ux-designs')).toBe(false);
  });

  it('skips a person missing a name or an email', () => {
    const register = readOwnershipRegister(
      new ConfigReader({
        people: {
          good: { name: 'Good', email: 'good@demandai.co' },
          noEmail: { name: 'No Email' },
        },
        repositories: {},
      }),
      logger(),
    );

    expect([...register.people.keys()]).toEqual(['good']);
  });

  it('survives owners that are not a list', () => {
    // Hand-maintained reference data; a typo in it must not take the backend
    // down, and must not take the other 88 repositories with it.
    const register = readOwnershipRegister(
      new ConfigReader({
        people: { mangesh: { name: 'M', email: 'm@demandai.co' } },
        repositories: { dxp: 'mangesh', crm: ['mangesh'] },
      }),
      logger(),
    );

    expect(register.repositories.has('dxp')).toBe(false);
    expect(register.repositories.get('crm')).toEqual(['mangesh']);
  });

  it('treats an absent register as empty rather than failing', () => {
    const register = readOwnershipRegister(undefined);

    expect(register.repositories.size).toBe(0);
    expect(register.people.size).toBe(0);
  });
});
