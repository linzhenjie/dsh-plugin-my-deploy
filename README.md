# my-deploy

A **Grafana observability page** for the DeepSeek Harness Web UI. It adds one
sidebar panel whose data comes from a Grafana **MCP** server that you configure
and watch from the page itself.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Grafana 观测      [ 监控 | 日志 | 链路追踪 ]        ● 已连接  [ MCP 连接 ] │
│  服务 [ checkout ▾ ]   时间范围 [ 最近 1 小时 ▾ ]              [ 刷新 ]   │
├──────────────────────────────────────────────────────────────────────────┤
│  CPU 使用  0.47 核                    │  内存占用  1.2 GiB                 │
│  ╭──────╮ 面积折线 + 维度列表         │  ╭──────╮ 面积折线 + 维度列表       │
│  ╰──────╯                             │  ╰──────╯                          │
│                                                                          │
│  ── 日志 ──────────────────────────────  对话查询 ───────────────────────  │
│  12:03:01  ERROR  payment gateway …      [你] 最近有哪些 error 日志？      │
│  12:03:02  WARN   retrying charge …      [助手] checkout 有 1 条 error …   │
│                                          [ 输入一句话… ]        [ 发送 ]   │
└──────────────────────────────────────────────────────────────────────────┘
```

## What it does

| Area | Behaviour |
|---|---|
| **Right-hand connection control** | A status pill (`未配置 / 连接中 / 已连接 / 未连接 / 连接失败`) that opens the MCP configuration drawer. The pill polls the Host's own state, so it reflects reality without MCP traffic. |
| **Tabs** | `监控` (monitor), `日志` (logs), `链路追踪` (traces). The active tab is remembered per browser. |
| **Top filter** | A `service_name` select filled from the MCP server's label values, plus the time range (`5m / 15m / 1h / 6h / 24h`) and a refresh action. |
| **Monitor** | Two cards, CPU and memory, each with the current value, an area chart, average/peak, and the busiest dimensions (`pod`, `instance`, …). |
| **Logs** | Log rows (time, level chip, message); clicking a row reveals its labels. |
| **Traces** | Trace rows (root span, trace id, service, duration bar, span count); clicking a row expands the span tree with per-span durations. |
| **Chat** | Under both logs and traces: a question goes to the Harness default model with every discovered MCP tool attached; the model calls the tools, the Host executes them, and the answer plus the rows it fetched land in the list above. |
| **MCP drawer** | Transport (Streamable HTTP or stdio), endpoint or command, request headers, server name, auto-connect, the datasource UID, and the four query templates. Shows server name/version, protocol revision, connection time, the discovered tool list, and the last error. |

## Requirements

- A DSH Web profile (`dsh web`).
- An MCP server that offers Grafana query tools. The page classifies discovered
  tools by name, so **any** of these families works:
  - metrics: `query_prometheus`, `query_prometheus_*`, `*prometheus*query*`
  - logs: `query_loki_logs`, `*loki*log*`, `query_logs`
  - traces: `query_tempo_trace`, `*tempo*trace*`, `find_traces`, `get_trace`
  - service filter: `list_loki_label_values`, `*label_values*`
- Optional: a configured default model. Without one the chat still answers, by
  calling the tool the active tab implies and summarising its result.

The plugin speaks MCP `2025-06-18` (negotiated), over Streamable HTTP with JSON
or SSE replies, or over stdio with newline-delimited JSON-RPC.

## Install

```powershell
# from the DSH plugin manager, pointing at this package directory:
#   action: install_bundle, target: C:\path\to\my-deploy
```

The bundle patch inserts one row named `my-deploy`; the Host half registers the
routes, the Client half registers the sidebar entry and the main panel. Then
**reload the Web page** — the index injects the client bundle at load time.

## Configure

Open the pill in the page header. For a local Grafana MCP server started over
Streamable HTTP:

| Field | Example |
|---|---|
| Transport | `Streamable HTTP` |
| Endpoint | `http://127.0.0.1:8000/mcp` or `https://<stack>.grafana.net/api/mcp` |
| Headers | `Authorization: Bearer <service-account-token>` |
| Server name | `grafana` |

For a local process (e.g. the Docker image):

| Field | Example |
|---|---|
| Transport | `本地进程 (stdio)` |
| Command | `docker` |
| Arguments | `run`<br>`-i`<br>`--rm`<br>`-e`<br>`GRAFANA_URL=...`<br>`-e`<br>`GRAFANA_API_KEY=...`<br>`mcp/grafana`<br>`-t`<br>`stdio` |

Notes

- Header values are **masked** on the way back to the page (`Authorization: ••••••`).
  A value you do not retype keeps its stored secret; a new value replaces it.
- `Connect` saves the draft and dials immediately; `Saved` saves without dialing;
  `Disconnect` closes the session and the page will not redial it until you save
  or connect again.
- Settings live in `%DSH_HOME%\storages\my-deploy.json` (mode 0600). The token is
  only ever on the local disk and in the local page↔Host request.
- A stdio command inherits this Harness's environment; pass credentials as
  arguments (or their own `-e` flags) rather than relying on ambient variables.

## Default queries

Grafana deployments label things differently, so the four templates are editable
in the drawer's advanced section. `$SERVICE` expands to a `service_name="…"`
matcher (and disappears when no service is chosen), `$SERVICE_VALUE` to the bare
value.

| Template | Default |
|---|---|
| CPU | `sum by (pod) (rate(container_cpu_usage_seconds_total{$SERVICE,container!=""}[5m]))` |
| Memory | `sum by (pod) (container_memory_working_set_bytes{$SERVICE,container!=""})` |
| Logs (LogQL) | `{service_name="$SERVICE_VALUE"}` |
| Traces (TraceQL) | `{ resource.service.name = "$SERVICE_VALUE" }` |

If your stack uses `job`/`service` instead of `service_name`, edit the templates
once — the values are stored with the connection. All arguments are synthesized
from each tool's own `inputSchema` (`expr` vs `query`, `startTime` vs `start`,
`stepSeconds` vs `step`, …), so an unfamiliar server spelling still works.

## Host routes

All under `/api/my-deploy`, behind the Web composition's request gate
(`ctx.connection.requestRejection`) with a same-origin rule for writes.

| Route | Method | Purpose |
|---|---|---|
| `/state` | GET | Settings (masked), connection view, service list, storage path |
| `/config` | PUT | Save settings; `connect: true` also dials |
| `/connect` | POST | Dial the stored endpoint |
| `/disconnect` | POST | Close the session |
| `/services` | GET | Refresh the `service_name` values |
| `/metrics` | GET | CPU + memory series for `service` and `range` |
| `/logs` | GET | Log rows for `service` and `range` |
| `/traces` | GET | Trace rows (with spans) for `service` and `range` |
| `/chat` | POST | `{question, tab, service, range, history}` → answer + fetched rows |

A domain failure (no endpoint, no matching tool, failed query) answers `200` with
`{ok: false, reason}` so the page renders an empty state; transport or trust
failures keep their HTTP status.

## Layout

```
index.js            Host entry: routes, connection lifecycle, chat exchange
lib/store.js        settings file, masking, defaults
lib/mcp-client.js   MCP client (Streamable HTTP + stdio)
lib/grafana.js      tool classification, argument synthesis, result parsing
lib/agent.js        model + tool loop, deterministic fallback
client.js           Client entry: dictionaries, styles, slots
client.utils.js     formatting helpers
client.model.js     state shape, tab/range registries, normalization
client.data.js      the HTTP exchange
client.ui.js        icons, chart, cards, lists, chat, MCP drawer
client.page.js      the page: header, filters, loads, actions
src/config/*.json   zh/en dictionaries   → client.i18n.js   (generated)
src/styles.css      page styles          → client.styles.js (generated)
```

`node build.mjs` regenerates the two content chunks; `node build.mjs --check`
fails when they are stale. Every chunk and the locale key sets are validated by
the same script.

## Verification

Author's local checks (the Harness Web UI needs no browser control for these):

- `node build.mjs` — chunks parse, locale keys agree, entry resolves every chunk.
- A mock Grafana MCP server (`initialize` → `tools/list` → `tools/call`) driven
  through `lib/mcp-client.js`: both JSON and SSE replies, tool discovery,
  metric/log/trace parsing, service label values.
- The real `apply(ctx)` and route handler in-process: save → connect → metrics →
  logs → traces → services → chat (scripted model with a real tool round trip,
  and the no-model fallback) → disconnect → refused writes.
- Live composition: the `my-deploy` row reports `fiberPhase: active`, and the
  Client registers both `sidebar.panellist` (id `my-deploy`) and `main`
  (key `my-deploy`).

Not verifiable without browser control: the rendered page. Reload the Web UI and
open the panel to see it.

## Limits

- No OAuth flow: paste a service-account token into the headers.
- No resource reads or prompt templates; only `initialize`, `tools/list`, and
  `tools/call` are used.
- One MCP connection per page instance (one live session in the Host).
- Chat relies on the Harness default model accepting tool definitions; when it
  does not, the deterministic fallback answers from a single tool call.
