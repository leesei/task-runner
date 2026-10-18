/**
 * `tq abort <queue>` command.
 */

export async function commandAbort(
  _daemonPort: number,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq abort <queue>");
    return 2;
  }
  console.log(`Abort command stub for queue: ${queueId}`);
  return 0;
}
