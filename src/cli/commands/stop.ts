/**
 * `tq stop <queue>` command.
 */

export async function commandStop(
  _daemonPort: number,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq stop <queue>");
    return 2;
  }
  console.log(`Stop command stub for queue: ${queueId}`);
  return 0;
}
