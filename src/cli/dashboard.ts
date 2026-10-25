export function getDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>tq dashboard</title>
    <style>
      :root {
        --bg: #0f172a;
        --panel: #111827;
        --border: #1f2937;
        --text: #e5e7eb;
        --muted: #9ca3af;
        --accent: #38bdf8;
        --success: #22c55e;
        --failed: #f87171;
        --running: #f59e0b;
        --pending: #94a3b8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.5;
      }
      header {
        padding: 16px 24px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      header h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }
      header .status {
        font-size: 12px;
        color: var(--muted);
      }
      main {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
        padding: 16px 24px 32px;
      }
      section {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
      }
      section header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
      }
      section header h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th, td {
        text-align: left;
        padding: 8px 16px;
        border-bottom: 1px solid var(--border);
      }
      th {
        color: var(--muted);
        font-weight: 500;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      tbody tr:hover {
        background: rgba(56, 189, 248, 0.05);
        cursor: pointer;
      }
      tbody tr:last-child td {
        border-bottom: none;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 11px;
        border: 1px solid var(--border);
        color: var(--muted);
      }
      .badge.running { color: var(--running); border-color: rgba(245, 158, 11, 0.4); }
      .badge.success { color: var(--success); border-color: rgba(34, 197, 94, 0.4); }
      .badge.failed { color: var(--failed); border-color: rgba(248, 113, 113, 0.4); }
      .badge.pending { color: var(--pending); }
      .badge.processing { color: var(--accent); }
      .badge.stopped { color: var(--muted); }
      .badge.idle { color: var(--muted); }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
      }
      .log-panel {
        padding: 16px;
        max-height: 420px;
        overflow: auto;
        background: #0b1026;
        font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .log-line {
        display: flex;
        gap: 12px;
      }
      .log-line .ts { color: var(--muted); }
      .log-line.stderr .text { color: var(--failed); }
      .hidden { display: none; }
      a.link { color: var(--accent); text-decoration: none; }
    </style>
  </head>
  <body>
    <header>
      <h1>tq dashboard</h1>
      <div class="status" id="connection-status">connecting...</div>
    </header>
    <main>
      <section>
        <header>
          <h2>Queues</h2>
        </header>
        <table id="queues-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Category</th>
              <th>State</th>
              <th>Concurrency</th>
              <th>Running</th>
              <th>Pending</th>
              <th>Succeeded</th>
              <th>Failed</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </section>
      <section id="instances-section" class="hidden">
        <header>
          <h2>Instances · <span id="instances-queue"></span></h2>
        </header>
        <table id="instances-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>State</th>
              <th>Exit code</th>
              <th>Duration</th>
              <th>Enqueue time</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </section>
      <section id="log-section" class="hidden">
        <header>
          <h2>Instance log · <span id="log-instance"></span></h2>
        </header>
        <div class="log-panel" id="log-panel"></div>
      </section>
    </main>
    <script>
      const state = {
        queues: new Map(),
        tasks: new Map(),
        selectedQueue: null,
        selectedInstance: null,
      };

      const queuesTableBody = document.querySelector("#queues-table tbody");
      const instancesSection = document.querySelector("#instances-section");
      const instancesQueue = document.querySelector("#instances-queue");
      const instancesTableBody = document.querySelector("#instances-table tbody");
      const logSection = document.querySelector("#log-section");
      const logInstance = document.querySelector("#log-instance");
      const logPanel = document.querySelector("#log-panel");
      const connectionStatus = document.querySelector("#connection-status");

      function formatDuration(ms) {
        if (ms === null || ms === undefined) return "-";
        if (ms < 1000) return ms + "ms";
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return seconds + "s";
        const minutes = Math.floor(seconds / 60);
        const rem = seconds % 60;
        if (minutes < 60) return minutes + "m" + (rem ? " " + rem + "s" : "");
        const hours = Math.floor(minutes / 60);
        const rmin = minutes % 60;
        return hours + "h" + (rmin ? " " + rmin + "m" : "");
      }

      function formatTime(ts) {
        if (!ts) return "-";
        try {
          const d = new Date(ts);
          return d.toLocaleString();
        } catch {
          return ts;
        }
      }

      async function loadSnapshot() {
        try {
          const [queuesRes, tasksRes] = await Promise.all([
            fetch("/api/queues"),
            fetch("/api/tasks"),
          ]);
          const queues = await queuesRes.json();
          const tasks = await tasksRes.json();
          for (const task of tasks) {
            state.tasks.set(task.id, task);
          }
          queuesTableBody.innerHTML = "";
          for (const q of queues) {
            state.queues.set(q.id, q);
            const task = state.tasks.get(q.id);
            const tr = document.createElement("tr");
            tr.innerHTML = \`
              <td><a class="link" href="#">\${q.id}</a></td>
              <td>\${task?.name || "-"}</td>
              <td>\${task?.category || "-"}</td>
              <td><span class="badge \${q.state.toLowerCase()}">\${q.state}</span></td>
              <td>\${q.concurrency}</td>
              <td>\${q.running}</td>
              <td>\${q.pending}</td>
              <td>\${q.succeeded}</td>
              <td>\${q.failed}</td>
            \`;
            tr.addEventListener("click", (ev) => {
              ev.preventDefault();
              selectQueue(q.id);
            });
            queuesTableBody.appendChild(tr);
          }
        } catch (err) {
          console.error(err);
        }
      }

      async function selectQueue(queueId) {
        state.selectedQueue = queueId;
        instancesQueue.textContent = queueId;
        instancesSection.classList.remove("hidden");
        logSection.classList.add("hidden");
        state.selectedInstance = null;
        try {
          const res = await fetch(\`/api/queues/\${encodeURIComponent(queueId)}/instances\`);
          const instances = await res.json();
          instancesTableBody.innerHTML = "";
          for (const inst of instances) {
            const tr = document.createElement("tr");
            const duration = inst.duration_ms;
            tr.innerHTML = \`
              <td>\${inst.id}</td>
              <td><span class="badge \${inst.state.toLowerCase()}">\${inst.state}</span></td>
              <td>\${inst.exit_code === null || inst.exit_code === undefined ? "-" : inst.exit_code}</td>
              <td>\${formatDuration(duration)}</td>
              <td>\${formatTime(inst.created_at)}</td>
            \`;
            tr.addEventListener("click", (ev) => {
              ev.stopPropagation();
              selectInstance(inst.id);
            });
            instancesTableBody.appendChild(tr);
          }
        } catch (err) {
          console.error(err);
        }
      }

      async function selectInstance(instanceId) {
        state.selectedInstance = instanceId;
        logInstance.textContent = instanceId;
        logSection.classList.remove("hidden");
        logPanel.innerHTML = "";
        // The log stream replays existing records and then tails the file, so
        // it is the single source of log lines. Fetching /log first would
        // duplicate every line.
        if (window._logSource) {
          window._logSource.close();
        }
        const es = new EventSource(\`/api/instances/\${instanceId}/log/stream\`);
        window._logSource = es;
        es.onmessage = (ev) => {
          try {
            const rec = JSON.parse(ev.data);
            appendLogLine(rec);
          } catch {}
        };
      }

      function appendLogLine(rec) {
        const div = document.createElement("div");
        div.className = "log-line" + (rec.stream === "stderr" ? " stderr" : "");
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = rec.timestamp || "";
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = rec.text || "";
        div.appendChild(ts);
        div.appendChild(text);
        logPanel.appendChild(div);
        logPanel.scrollTop = logPanel.scrollHeight;
      }

      function connectEvents() {
        const es = new EventSource("/api/events");
        es.onopen = () => {
          connectionStatus.textContent = "live";
        };
        es.onerror = () => {
          connectionStatus.textContent = "reconnecting...";
        };
        es.addEventListener("instanceStateChanged", () => {
          loadSnapshot();
          if (state.selectedQueue) {
            selectQueue(state.selectedQueue);
          }
          if (state.selectedInstance) {
            // refresh log section state if needed
          }
        });
        es.addEventListener("queueStateChanged", () => {
          loadSnapshot();
          if (state.selectedQueue) {
            selectQueue(state.selectedQueue);
          }
        });
        es.addEventListener("instancesCleared", () => {
          loadSnapshot();
          if (state.selectedQueue) {
            selectQueue(state.selectedQueue);
          }
        });
      }

      loadSnapshot();
      connectEvents();
    </script>
  </body>
</html>`;
}
