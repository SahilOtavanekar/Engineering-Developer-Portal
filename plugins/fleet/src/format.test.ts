import { formatBytes, timeAgo } from './format';

describe('timeAgo', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  const ago = (iso: string) => timeAgo(iso, now);

  it('returns undefined when there is no timestamp', () => {
    expect(timeAgo(undefined, now)).toBeUndefined();
  });

  it('returns undefined for an unparseable timestamp', () => {
    expect(timeAgo('not a date', now)).toBeUndefined();
  });

  it('collapses anything under a minute to "just now"', () => {
    expect(ago('2026-08-21T11:59:30.000Z')).toBe('just now');
  });

  it('reports minutes, hours and days', () => {
    expect(ago('2026-08-21T11:30:00.000Z')).toBe('30 minutes ago');
    expect(ago('2026-08-21T09:00:00.000Z')).toBe('3 hours ago');
    expect(ago('2026-08-18T12:00:00.000Z')).toBe('3 days ago');
  });

  it('reports weeks, months and years', () => {
    expect(ago('2026-08-07T12:00:00.000Z')).toBe('2 weeks ago');
    expect(ago('2026-05-21T12:00:00.000Z')).toBe('3 months ago');
    expect(ago('2024-08-21T12:00:00.000Z')).toBe('2 years ago');
  });

  it('singularises a value of one', () => {
    expect(ago('2026-08-20T12:00:00.000Z')).toBe('1 day ago');
    expect(ago('2026-08-21T11:00:00.000Z')).toBe('1 hour ago');
  });
});

describe('formatBytes', () => {
  it('returns undefined when the size is unknown', () => {
    expect(formatBytes(undefined)).toBeUndefined();
  });

  it('leaves small values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('scales through the units', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(13_780_800)).toBe('13 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('drops the decimal once the value is large enough not to need it', () => {
    expect(formatBytes(52_428_800)).toBe('50 MB');
  });

  it('refuses a negative size rather than inventing one', () => {
    expect(formatBytes(-1)).toBeUndefined();
  });
});
