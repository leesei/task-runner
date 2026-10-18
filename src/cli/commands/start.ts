/**
 * `tq start <queue>` command.
 */

export async function commandStart(
  _daemonPort: number,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq start <queue>");
    return 2;
  }
  console.log(`Start command stub for queue: ${queueId}`);
  return 0;
}
