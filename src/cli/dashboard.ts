/**
 * Dashboard HTML.
 *
 * The markup lives in `dashboard.html` so it can be edited as plain HTML.
 * Bun's text loader embeds the file into the bundle, so the built `bin/tq`
 * remains a single self-contained executable.
 */
import dashboardHtml from "./dashboard.html" with { type: "text" };

// bun-types declares `*.html` as Bun's HTMLBundle; the text loader returns a
// plain string at runtime.
const html = dashboardHtml as unknown as string;

export function getDashboardHtml(): string {
  return html;
}
