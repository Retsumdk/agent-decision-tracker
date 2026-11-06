export function fmtDate(ms: number): string {
  return new Date(ms).toISOString();
}
