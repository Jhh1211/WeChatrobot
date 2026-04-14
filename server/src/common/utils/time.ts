export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function secondsBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 1000);
}
