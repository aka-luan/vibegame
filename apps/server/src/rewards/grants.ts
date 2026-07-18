export function rewardGrantId(
  sourceMonsterId: string,
  defeatSequence: number,
  characterId: string,
): string {
  return `reward:${sourceMonsterId}:${String(defeatSequence)}:${characterId}`;
}
