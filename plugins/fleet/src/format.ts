/** Rounded, human-readable age. Returns undefined for absent timestamps. */
export function timeAgo(
  iso: string | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return undefined;

  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const units: Array<[string, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];

  for (const [unit, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Bytes as a short human string. Bitbucket reports repository size in bytes. */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
