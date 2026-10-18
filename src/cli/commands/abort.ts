/**
 * `tq abort <queue>` command.
 *
 * Aborts running instances, returns them to PENDING, leaves queue STOPPED.
 * Requires a running daemon (uses HTTP API).
 */

export async function commandAbort(
  daemonPort: number | null,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
  _dataDir: string,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq abort <queue>");
    return 2;
  }

  if (daemonPort === null) {
    console.error("Error: daemon is not running. Start it with `tq daemon` first.");
    return 1;
  }

  try {
    const res = await fetch(
      `http://localhost:${daemonPort}/api/queues/${encodeURIComponent(queueId)}/abort`,
      { method: "POST" },
    );
    if (res.ok) {
      const body = (await res.json()) as { success: boolean; message: string; state: string; returnedToPending: number[] };
      console.log(body.message);
      if (body.returnedToPending?.length) {
        console.log(`Returned ${body.returnedToPending.length} instance(s) to PENDING`);
      }
      return 0;
    }
    const errBody = await res.text();
    console.error(`Daemon returned ${res.status}: ${errBody}`);
    return 3;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}
