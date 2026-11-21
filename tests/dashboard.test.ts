import { describe, expect, test } from "bun:test";
import { getDashboardHtml } from "../src/cli/dashboard.ts";

describe("dashboard", () => {
  test("shows one context panel for the selected instance", () => {
    const html = getDashboardHtml();

    expect(html).toContain('id="context-section"');
    expect(html).toContain('id="instance-grid"');
    expect(html).toContain("with-context");
    expect(html).toContain("Instance context");
    expect(html).toContain("Select an instance to see its context.");
    expect(html).toContain("table-scroll");
    expect(html).toContain("position: sticky");
    expect(html).toContain("renderInstanceContext");
    expect(html).toContain("JSON.stringify(inst.input, null, 2)");
    expect(html).toContain("Working directory:");
    expect(html).toContain("context-meta-label");
    expect(html).toContain("context-meta-path");
    expect(html).toContain("copy-btn");
    expect(html).toContain("Copy working directory");
    expect(html).not.toContain("expandedInstances");
    expect(html).not.toContain("context-row");
  });

  test("filters instances by user id and working directory", () => {
    const html = getDashboardHtml();

    expect(html).toContain('id="instances-search"');
    expect(html).toContain("Filter user id or working directory");
    expect(html).toContain("instanceMatchesSearch");
    expect(html).toContain("renderInstanceRows");
    expect(html).toContain(
      'instancesSearch.addEventListener("input", renderInstanceRows)',
    );
    expect(html).toContain("No instances match the filter.");
  });

  test("offers a delete action for instances in any state", () => {
    const html = getDashboardHtml();

    expect(html).toContain("<th>Actions</th>");
    expect(html).toContain("<th>User id</th>");
    expect(html).toContain("displayUserId");
    expect(html).toContain("inst.input.id");
    expect(html).toContain("delete-btn");
    expect(html).toContain('method: "DELETE"');
    expect(html).toContain("/api/instances/");
    expect(html).toContain("Delete running task instance");
    expect(html).not.toContain('inst.state === "SUCCESS" || inst.state === "FAILED"');
  });

  test("renders action buttons as icons with text tooltips", () => {
    const html = getDashboardHtml();

    expect(html).toContain("ACTION_ICONS");
    expect(html).toContain('Pause: "\\u23F8\\uFE0E"');
    expect(html).toContain('Resume: "\\u23F5\\uFE0E"');
    expect(html).toContain('Clear: "\\u{1F9F9}"');
    expect(html).toContain('"Clear all": "\\u{1F5D1}\\uFE0E"');
    expect(html).toContain('Delete: "\\u2715"');
    expect(html).toContain("button.title = label");
    expect(html).toContain('button.setAttribute("aria-label", label)');
    expect(html).toContain("setActionIcon(button, label)");
    expect(html).toContain("button.action-btn.danger");
    expect((html.match(/"danger"/g) ?? []).length).toBe(2);
  });

  test("offers a pause/resume toggle for each queue", () => {
    const html = getDashboardHtml();

    expect(html).toContain('const paused = q.state === "STOPPED"');
    expect(html).toContain('setActionIcon(toggle, paused ? "Resume" : "Pause")');
    expect(html).toContain('toggleQueue(q.id, current ? current.state !== "STOPPED" : true)');
    expect(html).toContain('const action = pause ? "stop" : "start"');
    expect(html).toContain("Pause this queue");
    expect(html).toContain("button.action-btn.resume");
    expect(html).toContain("button.action-btn.pause");
  });

  test("exposes selected queue actions in the instances header", () => {
    const html = getDashboardHtml();

    expect(html).toContain('id="instances-queue-actions"');
    expect(html).toContain("renderQueueActions");
    expect(html).toContain("state.queueActionsKey");
    expect(html).toContain("toggleQueue(queue.id, !paused)");
    expect(html).toContain("clearQueue(queue.id, false)");
    expect(html).toContain("clearQueue(queue.id, true)");
    const header = html.slice(
      html.indexOf('id="instances-section"'),
      html.indexOf('id="instances-table"'),
    );
    expect(header).toContain("instances-queue-actions");
    expect(header).toContain('id="instances-search"');
  });

  test("supports keyboard navigation over rows and the search box", () => {
    const html = getDashboardHtml();

    expect(html).toContain("enableRowKeyboard(queuesTableBody");
    expect(html).toContain("enableRowKeyboard(instancesTableBody");
    expect(html).toContain("function enableRowKeyboard");
    expect(html).toContain("function focusRow");
    expect(html).toContain("tr.tabIndex = 0");
    expect(html).toContain('"ArrowDown"');
    expect(html).toContain('"ArrowUp"');
    expect(html).toContain('"Home"');
    expect(html).toContain('"End"');
    expect(html).toContain("focusedRowKey");
    expect(html).toContain("restoreRowFocus");
    expect(html).toContain("tbody tr:focus-visible");
    expect(html).toContain("instancesSearch.select()");
    expect(html).toContain('instancesSearch.addEventListener("keydown"');
    expect(html).toContain('ev.key === "Escape"');
  });

  test("focuses regions with hotkeys and scrolls the log", () => {
    const html = getDashboardHtml();

    expect(html).toContain('case "q":');
    expect(html).toContain('case "i":');
    expect(html).toContain('case "l":');
    expect(html).toContain("focusQueueList");
    expect(html).toContain("focusInstanceList");
    expect(html).toContain("focusLogPanel");
    expect(html).toContain("enableLogKeyboard");
    expect(html).toContain("logPanel.scrollTop += 40");
    expect(html).toContain("activate(next)");
    expect(html).toContain("queueInstancesRequest");
    expect(html).toContain('id="log-panel" tabindex="0"');
    expect(html).toContain('class="hotkey"');
  });

  test("opens a shortcut help dialog with ?", () => {
    const html = getDashboardHtml();

    expect(html).toContain('id="help-overlay"');
    expect(html).toContain('id="help-open"');
    expect(html).toContain('id="help-close"');
    expect(html).toContain('case "?":');
    expect(html).toContain("openHelp");
    expect(html).toContain("closeHelp");
    expect(html).toContain("helpReturnFocus");
    expect(html).toContain("Keyboard shortcuts");
    expect(html).toContain("Focus the Queues table");
    expect(html).toContain("Focus the instance log");
  });

  test("updates tables in place instead of rebuilding them", () => {
    const html = getDashboardHtml();

    expect(html).toContain("createQueueRow");
    expect(html).toContain("updateQueueRow");
    expect(html).toContain("createInstanceRow");
    expect(html).toContain("updateInstanceRow");
    expect(html).not.toContain('queuesTableBody.innerHTML = ""');
    expect(html).not.toContain('instancesTableBody.innerHTML = ""');
    expect(html).toContain("scrollbar-gutter: stable");
    expect(html).toContain("state.contextKey");
    expect(html).toContain("sameInstance");
    expect(html).toContain("user-select: none");
    expect(html).toContain("queue-toggle");
  });

  test("offers clear actions for each queue", () => {
    const html = getDashboardHtml();

    expect(html).toContain("<th>Actions</th>");
    expect(html).toContain("makeActionButton");
    expect(html).toContain('"Clear all"');
    expect(html).toContain("clearQueue(q.id, false)");
    expect(html).toContain("clearQueue(q.id, true)");
    expect(html).toContain('?clear=${all ? "all" : "success"}');
  });
});
