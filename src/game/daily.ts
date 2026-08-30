export function dailyDateFromRoom(roomCode: string): string | undefined {
  const match = roomCode.match(/^daily-(\d{4})(\d{2})(\d{2})-[a-z0-9-]{3,8}$/u);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : undefined;
}
