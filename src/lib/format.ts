const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(n: number): string {
  return n < 1000 ? String(n) : compact.format(n);
}
