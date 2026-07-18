export function rewardGrantId(
  roomInstanceId: string,
  sourceMonsterId: string,
  defeatSequence: number,
  characterId: string,
): string {
  return `reward:${roomInstanceId}:${sourceMonsterId}:${String(defeatSequence)}:${characterId}`;
}
