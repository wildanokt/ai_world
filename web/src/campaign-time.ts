export function campaignTime(minutes: number) {
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return `Day ${Math.floor(minutes / 1440) + 1} · ${twoDigits(Math.floor(minutes % 1440 / 60))}:${twoDigits(minutes % 60)}`;
}
