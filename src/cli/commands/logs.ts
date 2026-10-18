/**
 * `tq logs <instance-id>` command.
 */

export async function commandLogs(
  _dataDir: string,
  _daemonPort: number | null,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: tq logs <instance-id>");
    return 2;
  }

  const instanceId = args[0];
  console.log(`Log for instance ${instanceId}:`);
  console.log("(no logs — stub, real implementation in ticket 05/09)");
  return 0;
}
