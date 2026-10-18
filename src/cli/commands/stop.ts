/**
 * `tq stop <queue>` command.
 *
 * Stops a queue: no new instances launched, running instances finish.
 * Requires a running daemon (uses HTTP API).
 */

export async function commandStop(
  daemonPort: number | null,
  queueId: string | undefined,
  _flags: Record<string, string | true>,
  _dataDir: string,
): Promise<number> {
  if (!queueId) {
    console.error("Usage: tq stop <queue>");
    return 2;
  }

  if (daemonPort === null) {
    console.error("Error: daemon is not running. Start it with `tq daemon` first.");
    return 1;
  }

  try {
    const res = await fetch(
      `http://localhost:${daemonPort}/api/queues/${encodeURIComponent(queueId)}/stop`,
      { method: "POST" },
    );
    if (res.ok) {
      const body = (await res.json()) as { success: boolean; message: string; state: string };
      console.log(body.message);
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
