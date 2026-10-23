/**
 * Shared text-table rendering for CLI commands.
 */

import { table } from "table";

export function formatTable(rows: string[][]): string {
  return table(rows, {
    // Only draw the outer frame and the separator under the header row.
    drawHorizontalLine: (index, size) =>
      index === 0 || index === 1 || index === size,
  }).trimEnd();
}
