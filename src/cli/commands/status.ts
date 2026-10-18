/**
 * `tq status` command.
 */

export async function commandStatus(
  _dataDir: string,
  _daemonPort: number | null,
  _flags: Record<string, string | true>,
): Promise<number> {
  console.log("Queue    State       Concurrency  Running  Pending");
  console.log("----     -----       -----------  -------  -------");
  console.log("(no queues — stub, real implementation in ticket 04/09)");
  return 0;
}
