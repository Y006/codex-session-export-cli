#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const outputPath = args[args.length - 1];
const sessionPaths = args.slice(0, -1);

if (!sessionPaths.length || !outputPath) {
  console.error("usage: node generate-codex-session-html.js <session-a.jsonl> [session-b.jsonl ...] <output.html>");
  process.exit(1);
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          type: "parse_error",
          timestamp: null,
          payload: {
            line: index + 1,
            error: error.message,
            raw: line
          }
        };
      }
    });
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function textFromBlock(block) {
  if (block == null) return "";
  if (typeof block === "string") return block;
  if (typeof block.text === "string") return block.text;
  if (typeof block.output_text === "string") return block.output_text;
  if (typeof block.input_text === "string") return block.input_text;
  if (typeof block.content === "string") return block.content;
  if (block.type === "input_image") {
    const imageRef = block.image_url?.url || block.file_path || block.path || block.file_id || "inline image";
    return `[图片附件: ${imageRef}]`;
  }
  return JSON.stringify(block);
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content.map(textFromBlock).filter(Boolean).join("\n\n");
}

function firstTextLine(text, fallback) {
  const line = String(text || "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return fallback;
  return line.length > 82 ? line.slice(0, 79) + "..." : line;
}

function getTurnId(record) {
  const payload = record.payload || {};
  return payload.turn_id ||
    payload.internal_chat_message_metadata_passthrough?.turn_id ||
    payload.item?.internal_chat_message_metadata_passthrough?.turn_id ||
    "";
}

function isoToMs(timestamp) {
  const value = Date.parse(timestamp || "");
  return Number.isFinite(value) ? value : 0;
}

function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

function redactRecord(record) {
  const cloned = JSON.parse(JSON.stringify(record));
  if (cloned.type === "session_meta" && cloned.payload) {
    if (cloned.payload.base_instructions) {
      cloned.payload.base_instructions = "[redacted: base instructions]";
    }
  }
  if (cloned.type === "response_item" && cloned.payload?.type === "message") {
    const role = cloned.payload.role;
    if (role === "developer" || role === "system") {
      cloned.payload.content = Array.isArray(cloned.payload.content)
        ? cloned.payload.content.map((block) => ({
          type: block?.type || "text",
          text: "[redacted: developer/system instruction content]"
        }))
        : "[redacted: developer/system instruction content]";
    }
  }
  if (cloned.type === "response_item" && cloned.payload?.type === "reasoning") {
    if (cloned.payload.encrypted_content) {
      cloned.payload.encrypted_content = "[redacted: encrypted reasoning content]";
    }
  }
  return cloned;
}

function recordSummary(record, index) {
  const payload = record.payload || {};
  const parts = [
    String(index + 1).padStart(3, "0"),
    record.type || "unknown"
  ];
  if (payload.type) parts.push(payload.type);
  if (payload.role) parts.push("role:" + payload.role);
  if (payload.phase) parts.push(payload.phase);
  if (payload.name) parts.push(payload.name);
  if (payload.namespace) parts.push(payload.namespace);
  if (payload.turn_id) parts.push(payload.turn_id.slice(0, 8));
  return parts.join(" / ");
}

function classifyRecord(record) {
  const payload = record.payload || {};
  if (record.type === "response_item") {
    if (payload.type === "message") return payload.role || "message";
    if (payload.type === "reasoning") return "reasoning";
    if (payload.type?.includes("tool") || payload.type?.includes("function") || payload.type?.includes("web_search")) return "tool";
  }
  if (record.type === "event_msg") {
    if (payload.type === "token_count") return "telemetry";
    if (payload.type?.includes("patch")) return "artifact";
    if (payload.type?.includes("error")) return "error";
    return "event";
  }
  if (record.type === "turn_context" || record.type === "session_meta") return "context";
  return "raw";
}

function reasoningText(payload) {
  const summary = payload?.summary;
  if (!Array.isArray(summary)) return "";
  return summary.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item?.text === "string") return item.text;
    if (typeof item?.summary === "string") return item.summary;
    return JSON.stringify(item);
  }).filter(Boolean).join("\n\n");
}

function buildSessionData(records, sourcePath, sessionIndex) {
  const sessionMeta = records.find((record) => record.type === "session_meta")?.payload || {};
  const turnBounds = new Map();

  records.forEach((record) => {
    const payload = record.payload || {};
    if (record.type !== "event_msg") return;
    if (payload.type === "task_started") {
      const turnId = payload.turn_id || `turn-${turnBounds.size + 1}`;
      const turn = turnBounds.get(turnId) || { id: turnId };
      turn.startedAt = record.timestamp;
      turn.startedMs = isoToMs(record.timestamp);
      turnBounds.set(turnId, turn);
    }
    if (payload.type === "task_complete") {
      const turnId = payload.turn_id || `turn-${turnBounds.size + 1}`;
      const turn = turnBounds.get(turnId) || { id: turnId };
      turn.completedAt = record.timestamp;
      turn.completedMs = isoToMs(record.timestamp);
      turn.durationMs = payload.duration_ms || payload.duration || null;
      turnBounds.set(turnId, turn);
    }
  });

  const sortedBounds = Array.from(turnBounds.values()).sort((a, b) => (a.startedMs || 0) - (b.startedMs || 0));

  function inferTurnId(record) {
    const direct = getTurnId(record);
    if (direct) return direct;
    const stamp = isoToMs(record.timestamp);
    const match = sortedBounds.find((turn) => {
      if (!turn.startedMs) return false;
      const end = turn.completedMs || Number.MAX_SAFE_INTEGER;
      return stamp >= turn.startedMs && stamp <= end;
    });
    return match?.id || "";
  }

  const turns = new Map();
  function ensureTurn(turnId, timestamp) {
    const id = turnId || `ungrouped-${turns.size + 1}`;
    if (!turns.has(id)) {
      const bound = turnBounds.get(id) || {};
      turns.set(id, {
        id,
        startedAt: bound.startedAt || timestamp || "",
        completedAt: bound.completedAt || "",
        userMessages: [],
        contextMessages: [],
        assistantFinal: [],
        assistantCommentary: [],
        reasoning: [],
        tools: [],
        events: [],
        rawIndexes: []
      });
    }
    return turns.get(id);
  }

  records.forEach((record, index) => {
    const turnId = inferTurnId(record);
    const turn = turnId ? ensureTurn(turnId, record.timestamp) : null;
    const payload = record.payload || {};
    if (turn) turn.rawIndexes.push(index);

    if (record.type === "turn_context") {
      ensureTurn(turnId, record.timestamp).contextMessages.push({
        timestamp: record.timestamp,
        title: "turn_context",
        text: payload.summary ? compactJson(payload.summary) : `cwd: ${payload.cwd || ""}\nmodel: ${payload.model || ""}`
      });
      return;
    }

    if (record.type === "event_msg") {
      if (turn && payload.type !== "token_count") {
        turn.events.push({
          timestamp: record.timestamp,
          type: payload.type,
          phase: payload.phase || "",
          durationMs: payload.duration_ms || payload.duration || null
        });
      }
      return;
    }

    if (record.type !== "response_item") return;

    if (payload.type === "message") {
      const text = contentText(payload.content);
      const targetTurn = ensureTurn(turnId, record.timestamp);
      if (payload.role === "developer" || payload.role === "system") {
        targetTurn.contextMessages.push({
          timestamp: record.timestamp,
          title: `${payload.role} message`,
          text: "[developer/system 指令内容已在对话视图中隐藏]"
        });
      } else if (payload.role === "user") {
        if (/^\s*<environment_context>/.test(text)) {
          targetTurn.contextMessages.push({
            timestamp: record.timestamp,
            title: "environment_context",
            text
          });
        } else {
          targetTurn.userMessages.push({
            timestamp: record.timestamp,
            role: payload.role,
            text
          });
        }
      } else if (payload.role === "assistant") {
        const item = {
          timestamp: record.timestamp,
          phase: payload.phase || "message",
          text
        };
        if (payload.phase === "final_answer") {
          targetTurn.assistantFinal.push(item);
        } else {
          targetTurn.assistantCommentary.push(item);
        }
      }
      return;
    }

    if (payload.type === "reasoning") {
      ensureTurn(turnId, record.timestamp).reasoning.push({
        timestamp: record.timestamp,
        text: reasoningText(payload)
      });
      return;
    }

    if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call" ||
      payload.type === "web_search_call" ||
      payload.type === "tool_search_call"
    ) {
      ensureTurn(turnId, record.timestamp).tools.push({
        timestamp: record.timestamp,
        kind: payload.type,
        callId: payload.call_id || payload.id || "",
        name: payload.name || payload.namespace || payload.action || "tool",
        arguments: payload.arguments || payload.input || payload.query || ""
      });
      return;
    }

    if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output" ||
      payload.type === "tool_search_output"
    ) {
      ensureTurn(turnId, record.timestamp).tools.push({
        timestamp: record.timestamp,
        kind: payload.type,
        callId: payload.call_id || "",
        name: "output",
        output: payload.output || payload.result || ""
      });
    }
  });

  const turnList = Array.from(turns.values())
    .sort((a, b) => isoToMs(a.startedAt) - isoToMs(b.startedAt))
    .map((turn, index) => {
      const title = firstTextLine(turn.userMessages.map((message) => message.text).join("\n"), `Turn ${index + 1}`);
      const toolCounts = countBy(turn.tools.filter((tool) => !tool.kind.includes("output")), (tool) => tool.name || tool.kind);
      return {
        ...turn,
        index: index + 1,
        title,
        toolCounts
      };
    });

  return {
    index: sessionIndex,
    sourcePath,
    id: sessionMeta.id || sessionMeta.session_id || path.basename(sourcePath, ".jsonl"),
    sessionId: sessionMeta.session_id || sessionMeta.id || "",
    cwd: sessionMeta.cwd || "",
    cliVersion: sessionMeta.cli_version || "",
    modelProvider: sessionMeta.model_provider || "",
    source: sessionMeta.source || "",
    threadSource: sessionMeta.thread_source || "",
    timestamp: sessionMeta.timestamp || "",
    turns: turnList,
    rawRecords: records.map((record, index) => ({
      index,
      timestamp: record.timestamp || "",
      summary: recordSummary(record, index),
      className: classifyRecord(record),
      data: redactRecord(record)
    }))
  };
}

function htmlTemplate(data) {
  const embedded = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="zh-CN" data-codex-session-export="true">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex 会话导出 ${data.sessions.length} sessions</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: #a7c080;
      --border: #9da9a0;
      --border-accent: #7fbbb3;
      --border-muted: #5c6a72;
      --warning: #dbbc7f;
      --error: #e67e80;
      --muted: #9da9a0;
      --dim: #859289;
      --text: #d3c6aa;
      --body-bg: #2d353b;
      --panel-bg: #343f44;
      --panel-bg-2: #374247;
      --panel-bg-3: #2f383e;
      --tool-bg: #2f3b32;
      --selected-bg: #425047;
      --hover-bg: #3c474d;
      --line-height: 18px;
      --font-bump: 2pt;
      --content-inset-x: 12px;
      --content-inset-y: 10px;
      --block-inset: 12px;
      --sidebar-width: 320px;
      --sidebar-min-width: 260px;
      --sidebar-max-width: 820px;
      --resizer-width: 6px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      background: var(--body-bg);
      color: var(--text);
      font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace;
      font-size: calc(12px + var(--font-bump));
      line-height: var(--line-height);
      letter-spacing: 0;
      overflow: hidden;
    }
    button, input { font: inherit; }
    button { cursor: pointer; }
    body.sidebar-resizing { cursor: col-resize; user-select: none; }

    #app { display: flex; height: 100vh; overflow: hidden; }
    #sidebar {
      width: var(--sidebar-width);
      min-width: var(--sidebar-width);
      max-width: var(--sidebar-width);
      height: 100vh;
      background: var(--panel-bg);
      border-right: 1px solid var(--border-muted);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
    }
    #sidebar-resizer {
      width: var(--resizer-width);
      flex: 0 0 var(--resizer-width);
      background: var(--body-bg);
      border-right: 1px solid var(--border-muted);
      cursor: col-resize;
    }
    #sidebar-resizer:hover,
    body.sidebar-resizing #sidebar-resizer {
      background: var(--selected-bg);
      border-right-color: var(--border-accent);
    }
    .sidebar-header { border-bottom: 1px solid var(--border-muted); flex-shrink: 0; }
    .sidebar-title {
      padding: 8px 12px 2px;
      color: var(--border-accent);
      font-weight: 700;
    }
    .sidebar-subtitle {
      padding: 0 12px 8px;
      color: var(--dim);
      font-size: calc(10px + var(--font-bump));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .view-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 8px 8px 4px;
    }
    .view-btn {
      padding: 3px 6px;
      background: transparent;
      border: 1px solid var(--border-muted);
      border-radius: 3px;
      color: var(--muted);
      font-size: calc(10px + var(--font-bump));
      line-height: 14px;
    }
    .view-btn:hover { color: var(--text); border-color: var(--border); background: var(--hover-bg); }
    .view-btn.active { background: var(--accent); border-color: var(--accent); color: var(--body-bg); }
    .search-wrap { padding: 4px 8px 8px; }
    #tree-search {
      width: 100%;
      padding: 4px 8px;
      background: var(--body-bg);
      border: 1px solid var(--dim);
      border-radius: 3px;
      color: var(--text);
      outline: none;
    }
    #tree-search:focus { border-color: var(--border-accent); }
    #tree { flex: 1; overflow: auto; padding: 6px 0; }
    .tree-node {
      display: flex;
      align-items: baseline;
      gap: 4px;
      width: 100%;
      padding: 1px 12px;
      border: 0;
      background: transparent;
      color: var(--text);
      text-align: left;
      white-space: nowrap;
      font-size: calc(11px + var(--font-bump));
      line-height: 15px;
    }
    .tree-node:hover,
    .tree-node.active { background: var(--selected-bg); }
    .tree-node.active .tree-content { font-weight: 700; }
    .tree-node.session-root { margin-top: 8px; }
    .tree-node.session-child { color: var(--dim); }
    .tree-prefix { color: var(--muted); flex: 0 0 auto; white-space: pre; }
    .tree-disclosure {
      width: 1ch;
      flex: 0 0 auto;
      color: var(--warning);
      font-weight: 700;
      text-align: center;
    }
    .tree-content { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tree-session { color: var(--warning); font-weight: 700; }
    .tree-user { color: var(--accent); }
    .tree-assistant { color: #e5e5e7; }
    .tree-tool { color: var(--muted); }
    .tree-raw { color: var(--dim); }
    .tree-status {
      flex-shrink: 0;
      padding: 4px 12px;
      border-top: 1px solid var(--border-muted);
      color: var(--muted);
      font-size: calc(10px + var(--font-bump));
    }

    #content {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      padding: var(--content-inset-y) var(--content-inset-x) calc(var(--content-inset-y) * 2);
    }
    .top-line {
      display: flex;
      align-items: center;
      margin-bottom: var(--content-inset-y);
      color: var(--warning);
      font-size: calc(11px + var(--font-bump));
      white-space: nowrap;
      overflow: hidden;
    }
    .header,
    .entry-block {
      width: 100%;
      background: var(--panel-bg);
      border-radius: 4px;
    }
    .header {
      padding: var(--block-inset);
      margin-bottom: var(--content-inset-y);
    }
    .header h1 {
      color: var(--border-accent);
      font-size: calc(12px + var(--font-bump));
      line-height: var(--line-height);
      margin-bottom: var(--line-height);
    }
    .kv {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr);
      gap: 0 8px;
      color: var(--dim);
      font-size: calc(11px + var(--font-bump));
    }
    .kv dt { font-weight: 700; }
    .kv dd { min-width: 0; color: var(--text); overflow-wrap: anywhere; }
    #conversation-view,
    #raw-view {
      display: flex;
      flex-direction: column;
      gap: var(--content-inset-y);
    }
    .hidden { display: none !important; }
    .session-section::before {
      content: "";
      display: block;
      border-top: 1px dashed var(--border-muted);
      margin: 0 0 var(--content-inset-y);
    }
    .session-heading {
      margin-bottom: var(--content-inset-y);
    }
    .session-heading .entry-block {
      background: var(--panel-bg-2);
      border: 1px solid var(--border-muted);
    }
    .session-heading-title {
      color: var(--border-accent);
      font-weight: 700;
    }
    .turn {
      padding-top: 0;
    }
    .turn + .turn {
      margin-top: var(--content-inset-y);
    }
    .timestamp {
      margin-bottom: 2px;
      color: var(--dim);
      font-size: calc(10px + var(--font-bump));
      opacity: 0.9;
    }
    .entry-block {
      padding: var(--block-inset);
      overflow-wrap: anywhere;
    }
    .entry-block.user { background: var(--panel-bg-2); }
    .entry-block.assistant { background: var(--panel-bg); color: #e5e5e7; }
    .entry-block.tool { background: var(--tool-bg); }
    .entry-block.context { background: var(--panel-bg-3); color: var(--muted); }
    .label { color: var(--muted); font-weight: 700; }
    .speaker-line {
      margin-bottom: calc(var(--line-height) / 2);
    }
    .turn-title {
      color: var(--border-accent);
      font-weight: 700;
      margin-bottom: calc(var(--line-height) / 2);
    }
    .turn-grid {
      display: flex;
      flex-direction: column;
      gap: calc(var(--content-inset-y) * 0.8);
    }
    .markdown { color: inherit; }
    .markdown p + p { margin-top: var(--line-height); }
    .markdown h1,
    .markdown h2,
    .markdown h3 {
      color: var(--border-accent);
      font-size: calc(12px + var(--font-bump));
      line-height: var(--line-height);
      margin: var(--line-height) 0 0;
    }
    .markdown ul,
    .markdown ol {
      margin: var(--line-height) 0 0;
      padding-left: calc(var(--line-height) * 2);
    }
    .markdown blockquote {
      margin-top: var(--line-height);
      padding-left: 10px;
      border-left: 2px solid var(--border-muted);
      color: var(--muted);
    }
    .markdown table {
      width: 100%;
      margin-top: var(--line-height);
      border-collapse: collapse;
      table-layout: fixed;
      font-size: calc(10px + var(--font-bump));
    }
    .markdown th,
    .markdown td {
      padding: 4px 6px;
      border: 1px solid var(--border-muted);
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    .markdown th {
      color: var(--muted);
      background: rgba(0, 0, 0, 0.12);
      text-align: left;
    }
    .markdown a { color: var(--border-accent); text-decoration: underline; text-underline-offset: 2px; }
    .markdown code,
    code {
      padding: 0 4px;
      border-radius: 3px;
      background: rgba(128, 128, 128, 0.2);
      color: var(--accent);
      font-family: inherit;
    }
    .markdown pre,
    pre {
      margin-top: var(--line-height);
      padding: 10px;
      border-radius: 4px;
      background: #273136;
      color: var(--text);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
    }
    details {
      background: rgba(0, 0, 0, 0.08);
      border-radius: 4px;
      padding: 6px 8px;
    }
    details + details { margin-top: 6px; }
    summary {
      color: var(--muted);
      cursor: pointer;
      font-weight: 700;
    }
    .detail-body { margin-top: 8px; }
    .compact-list {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 0 10px;
      margin-top: 8px;
      color: var(--dim);
    }
    .compact-list dt { font-weight: 700; }
    .compact-list dd { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
    .raw-record {
      padding-top: 0;
    }
    .raw-record + .raw-record {
      margin-top: 6px;
    }
    .raw-record summary {
      display: flex;
      gap: 12px;
      align-items: baseline;
      color: var(--text);
    }
    .raw-record .raw-kind { color: var(--border-accent); }
    .raw-record .raw-time { color: var(--dim); font-weight: 400; }
    .empty {
      padding: var(--block-inset);
      border-radius: 4px;
      background: var(--panel-bg);
      color: var(--muted);
    }

    @media (max-width: 900px) {
      body { overflow: auto; }
      #app { display: block; height: auto; overflow: visible; }
      #sidebar, #sidebar-resizer { display: none; }
      #content { min-height: 100vh; overflow: visible; }
    }
  </style>
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">Codex 会话导出</div>
        <div class="sidebar-subtitle">${data.sessions.length} 个 session</div>
        <div class="view-switch">
          <button class="view-btn active" data-view="conversation">对话内容</button>
          <button class="view-btn" data-view="raw">原始内容</button>
        </div>
        <div class="search-wrap">
          <input id="tree-search" type="search" placeholder="搜索当前视图..." autocomplete="off">
        </div>
      </div>
      <nav id="tree" aria-label="session tree"></nav>
      <div class="tree-status" id="tree-status">0 条记录可见</div>
    </aside>
    <div id="sidebar-resizer" aria-hidden="true"></div>
    <main id="content">
      <div class="top-line">
        <span>Codex Session Export</span>
      </div>
      <section class="header" id="collection-header"></section>
      <section id="conversation-view"></section>
      <section id="raw-view" class="hidden"></section>
    </main>
  </div>
  <script type="application/json" id="session-data">${embedded}</script>
  <script>
    (function () {
      const data = JSON.parse(document.getElementById("session-data").textContent);
      const state = {
        view: "conversation",
        query: "",
        activeId: "collection-header",
        collapsedSessions: new Set(data.sessions.map(function (session) { return session.id; }))
      };
      const tree = document.getElementById("tree");
      const content = document.getElementById("content");
      const treeStatus = document.getElementById("tree-status");
      const search = document.getElementById("tree-search");
      const conversationView = document.getElementById("conversation-view");
      const rawView = document.getElementById("raw-view");
      const sidebar = document.getElementById("sidebar");
      const resizer = document.getElementById("sidebar-resizer");
      const MIN_CONTENT_WIDTH = 320;

      function escapeHtml(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function safeUrl(value) {
        const url = String(value || "").trim();
        if (/^(https?:|file:|mailto:)/i.test(url)) return url.replace(/"/g, "%22");
        if (/^[./#]/.test(url)) return url.replace(/"/g, "%22");
        return "#";
      }

      function renderInline(value) {
        const stash = [];
        let text = String(value || "").replace(/\\\`([^\\\`]+)\\\`/g, function (_, code) {
          const index = stash.push("<code>" + escapeHtml(code) + "</code>") - 1;
          return "\\u0000" + index + "\\u0000";
        });
        text = escapeHtml(text);
        text = text.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)(?:\\s+&quot;[^&]*&quot;)?\\)/g, function (_, label, url) {
          return '<a href="' + safeUrl(url) + '" target="_blank" rel="noreferrer">' + label + "</a>";
        });
        text = text
          .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
          .replace(/__([^_]+)__/g, "<strong>$1</strong>")
          .replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
        text = text.replace(/\\u0000(\\d+)\\u0000/g, function (_, index) {
          return stash[Number(index)] || "";
        });
        return text;
      }

      function renderMarkdown(markdown) {
        const lines = String(markdown || "").replace(/\\r\\n/g, "\\n").split("\\n");
        const html = [];
        let paragraph = [];
        let list = null;
        let inCode = false;
        let codeLines = [];

        function flushParagraph() {
          if (!paragraph.length) return;
          html.push("<p>" + renderInline(paragraph.join(" ")) + "</p>");
          paragraph = [];
        }

        function closeList() {
          if (!list) return;
          html.push("</" + list + ">");
          list = null;
        }

        function openList(kind) {
          if (list === kind) return;
          closeList();
          flushParagraph();
          list = kind;
          html.push("<" + kind + ">");
        }

        function isTableSeparator(value) {
          return /^\\s*\\|?\\s*:?-{3,}:?\\s*(\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/.test(value || "");
        }

        function splitTableRow(value) {
          return String(value || "")
            .trim()
            .replace(/^\\|/, "")
            .replace(/\\|$/, "")
            .split("|")
            .map(function (cell) { return cell.trim(); });
        }

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const fence = line.match(/^\\s*\\\`\\\`\\\`(.*)$/);
          if (fence) {
            if (inCode) {
              html.push("<pre><code>" + escapeHtml(codeLines.join("\\n")) + "</code></pre>");
              codeLines = [];
              inCode = false;
            } else {
              flushParagraph();
              closeList();
              inCode = true;
            }
            continue;
          }
          if (inCode) {
            codeLines.push(line);
            continue;
          }
          if (!line.trim()) {
            flushParagraph();
            closeList();
            continue;
          }
          if (line.includes("|") && isTableSeparator(lines[i + 1])) {
            flushParagraph();
            closeList();
            const headers = splitTableRow(line);
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
              rows.push(splitTableRow(lines[i]));
              i += 1;
            }
            i -= 1;
            html.push("<table><thead><tr>" + headers.map(function (cell) {
              return "<th>" + renderInline(cell) + "</th>";
            }).join("") + "</tr></thead><tbody>" + rows.map(function (row) {
              return "<tr>" + headers.map(function (_, cellIndex) {
                return "<td>" + renderInline(row[cellIndex] || "") + "</td>";
              }).join("") + "</tr>";
            }).join("") + "</tbody></table>");
            continue;
          }
          const heading = line.match(/^(#{1,3})\\s+(.+)$/);
          if (heading) {
            flushParagraph();
            closeList();
            const level = heading[1].length;
            html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
            continue;
          }
          const unordered = line.match(/^\\s*[-*+]\\s+(.+)$/);
          if (unordered) {
            openList("ul");
            html.push("<li>" + renderInline(unordered[1]) + "</li>");
            continue;
          }
          const ordered = line.match(/^\\s*\\d+[.)]\\s+(.+)$/);
          if (ordered) {
            openList("ol");
            html.push("<li>" + renderInline(ordered[1]) + "</li>");
            continue;
          }
          const quote = line.match(/^>\\s?(.+)$/);
          if (quote) {
            flushParagraph();
            closeList();
            html.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
            continue;
          }
          paragraph.push(line.trim());
        }
        if (inCode) html.push("<pre><code>" + escapeHtml(codeLines.join("\\n")) + "</code></pre>");
        flushParagraph();
        closeList();
        return '<div class="markdown">' + html.join("\\n") + "</div>";
      }

      function formatTime(timestamp) {
        if (!timestamp) return "";
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return timestamp;
        return date.toISOString().replace("T", " ").replace(".000Z", "Z");
      }

      function jsonBlock(value) {
        return "<pre>" + escapeHtml(JSON.stringify(value, null, 2)) + "</pre>";
      }

      function renderHeader() {
        document.getElementById("collection-header").innerHTML = [
          "<h1>Codex 会话导出</h1>",
          '<dl class="kv">',
          "<dt>会话数量</dt><dd>" + escapeHtml(data.sessions.length + " 个 session") + "</dd>",
          "<dt>session id</dt><dd>" + escapeHtml(data.sessions.map(function (session) { return session.id; }).join(" / ")) + "</dd>",
          "<dt>导出时间</dt><dd>" + escapeHtml(formatTime(data.generatedAt)) + "</dd>",
          "</dl>"
        ].join("");
      }

      function sessionSectionId(session) {
        return "session-" + session.index + "-section";
      }

      function rawSessionSectionId(session) {
        return "raw-session-" + session.index + "-section";
      }

      function turnDomId(session, turn) {
        return "session-" + session.index + "-turn-" + turn.index;
      }

      function userDomId(session, turn, userIndex) {
        return turnDomId(session, turn) + "-user-" + userIndex;
      }

      function codexDomId(session, turn) {
        return turnDomId(session, turn) + "-codex";
      }

      function rawRecordDomId(session, record) {
        return "session-" + session.index + "-raw-" + record.index;
      }

      function renderConversation() {
        if (!data.sessions.some(function (session) { return session.turns.length; })) {
          conversationView.innerHTML = '<div class="empty">没有解析到 turn。</div>';
          return;
        }
        const sessionBlocks = [];
        data.sessions.forEach(function (session) {
          sessionBlocks.push('<section class="session-section" id="' + sessionSectionId(session) + '" data-session-id="' + escapeHtml(session.id) + '">');
          sessionBlocks.push('<div class="session-heading" id="session-' + session.index + '-body-header">');
          sessionBlocks.push('<div class="entry-block"><div class="session-heading-title">session ' + session.index + '</div>');
          sessionBlocks.push('<dl class="compact-list">');
          sessionBlocks.push("<dt>session id</dt><dd>" + escapeHtml(session.id) + "</dd>");
          sessionBlocks.push("<dt>工作目录</dt><dd>" + escapeHtml(session.cwd || "") + "</dd>");
          sessionBlocks.push("<dt>记录时间</dt><dd>" + escapeHtml(formatTime(session.timestamp)) + "</dd>");
          sessionBlocks.push("</dl></div></div>");
          sessionBlocks.push(session.turns.map(function (turn) {
            const blocks = [];
            blocks.push('<article class="turn" id="' + turnDomId(session, turn) + '" data-search="' + escapeHtml(searchTextForTurn(turn)) + '">');
            blocks.push('<div class="turn-title">turn ' + turn.index + " / " + escapeHtml(turn.title) + "</div>");
            blocks.push('<div class="turn-grid">');
            turn.userMessages.forEach(function (message, index) {
              blocks.push('<section class="entry-block user" id="' + userDomId(session, turn, index) + '">');
              blocks.push('<div class="timestamp">' + escapeHtml(formatTime(message.timestamp)) + ' / 用户</div>');
              blocks.push('<div class="speaker-line"><span class="label">用户</span></div>');
              blocks.push(renderMarkdown(message.text));
              blocks.push("</section>");
            });
            const finalText = turn.assistantFinal.map(function (message) { return message.text; }).join("\\n\\n");
            const fallbackText = turn.assistantCommentary.map(function (message) { return message.text; }).join("\\n\\n");
            blocks.push('<section class="entry-block assistant" id="' + codexDomId(session, turn) + '">');
            blocks.push('<div class="timestamp">' + escapeHtml(formatTime((turn.assistantFinal[0] || turn.assistantCommentary[0] || {}).timestamp)) + ' / 助手最终回答</div>');
            blocks.push('<div class="speaker-line"><span class="label">助手</span></div>');
            blocks.push(renderMarkdown(finalText || fallbackText || "[无助手正文]"));
            blocks.push("</section>");
            if (turn.assistantCommentary.length && finalText) {
              blocks.push(detailsBlock("过程消息 / " + turn.assistantCommentary.length + " 条", turn.assistantCommentary.map(function (message) {
                return '<div class="timestamp">' + escapeHtml(formatTime(message.timestamp)) + '</div>' + renderMarkdown(message.text);
              }).join("")));
            }
            if (turn.tools.length) {
              blocks.push(detailsBlock("工具调用 / " + turn.tools.length + " 条", renderTools(turn)));
            }
            if (turn.reasoning.some(function (item) { return item.text; })) {
              blocks.push(detailsBlock("推理摘要 / " + turn.reasoning.length + " 条", turn.reasoning.map(function (item) {
                return '<div class="timestamp">' + escapeHtml(formatTime(item.timestamp)) + '</div>' + renderMarkdown(item.text || "[空摘要]");
              }).join("")));
            }
            if (turn.contextMessages.length) {
              blocks.push(detailsBlock("上下文 / " + turn.contextMessages.length + " 条", turn.contextMessages.map(function (item) {
                return '<div class="timestamp">' + escapeHtml(formatTime(item.timestamp)) + " / " + escapeHtml(item.title) + "</div>" + jsonBlock(item.text);
              }).join("")));
            }
            blocks.push("</div></article>");
            return blocks.join("");
          }).join(""));
          sessionBlocks.push("</section>");
        });
        conversationView.innerHTML = sessionBlocks.join("");
      }

      function renderTools(turn) {
        const rows = [
          '<dl class="compact-list">',
          "<dt>汇总</dt><dd>" + escapeHtml(Object.entries(turn.toolCounts).map(function (pair) { return pair[0] + " x" + pair[1]; }).join(", ") || "仅输出") + "</dd>",
          "</dl>"
        ];
        turn.tools.forEach(function (tool) {
          rows.push("<details>");
          rows.push("<summary>" + escapeHtml(formatTime(tool.timestamp)) + " / " + escapeHtml(tool.kind) + " / " + escapeHtml(tool.name) + "</summary>");
          rows.push('<div class="detail-body">' + jsonBlock({
            call_id: tool.callId,
            arguments: tool.arguments,
            output: tool.output
          }) + "</div>");
          rows.push("</details>");
        });
        return rows.join("");
      }

      function detailsBlock(title, html) {
        return '<details class="entry-block context"><summary>' + escapeHtml(title) + '</summary><div class="detail-body">' + html + "</div></details>";
      }

      function searchTextForTurn(turn) {
        return [
          turn.title,
          turn.id,
          turn.userMessages.map(function (message) { return message.text; }).join(" "),
          turn.assistantFinal.map(function (message) { return message.text; }).join(" "),
          Object.keys(turn.toolCounts).join(" ")
        ].join(" ").toLowerCase();
      }

      function renderRaw() {
        const blocks = [];
        data.sessions.forEach(function (session) {
          blocks.push('<section class="session-section" id="' + rawSessionSectionId(session) + '" data-session-id="' + escapeHtml(session.id) + '">');
          blocks.push('<div class="session-heading" id="raw-session-' + session.index + '-body-header">');
          blocks.push('<div class="entry-block"><div class="session-heading-title">session ' + session.index + '</div>');
          blocks.push('<dl class="compact-list">');
          blocks.push("<dt>来源文件</dt><dd>" + escapeHtml(session.sourcePath || "") + "</dd>");
          blocks.push("<dt>记录时间</dt><dd>" + escapeHtml(formatTime(session.timestamp)) + "</dd>");
          blocks.push("</dl></div></div>");
          blocks.push(session.rawRecords.map(function (record) {
            return [
              '<article class="raw-record" id="' + rawRecordDomId(session, record) + '" data-search="' + escapeHtml((record.summary + " " + JSON.stringify(record.data)).toLowerCase()) + '">',
              "<details>",
              "<summary>",
              '<span class="raw-kind">' + escapeHtml(record.summary) + "</span>",
              '<span class="raw-time">' + escapeHtml(formatTime(record.timestamp)) + "</span>",
              "</summary>",
              '<div class="detail-body">' + jsonBlock(record.data) + "</div>",
              "</details>",
              "</article>"
            ].join("");
          }).join(""));
          blocks.push("</section>");
        });
        rawView.innerHTML = blocks.join("");
      }

      function compactText(value) {
        return String(value || "").replace(/\\s+/g, " ").trim();
      }

      function previewText(value, maxLength) {
        const text = compactText(value);
        if (!text) return "[空]";
        return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
      }

      function turnUserPreview(turn) {
        return previewText(turn.userMessages.map(function (message) {
          return message.text;
        }).join(" "), 96);
      }

      function turnCodexPreview(turn) {
        const finalText = turn.assistantFinal.map(function (message) {
          return message.text;
        }).join(" ");
        const fallbackText = turn.assistantCommentary.map(function (message) {
          return message.text;
        }).join(" ");
        return previewText(finalText || fallbackText, 96);
      }

      function renderTree() {
        const query = state.query.toLowerCase();
        const nodes = [];
        data.sessions.forEach(function (session) {
          const sessionExpanded = Boolean(query) || !state.collapsedSessions.has(session.id);
          nodes.push(treeNode({
            target: state.view === "conversation" ? sessionSectionId(session) : rawSessionSectionId(session),
            prefix: "",
            className: "tree-session",
            label: "session " + session.index,
            sessionToggle: session.id,
            expanded: sessionExpanded
          }));
          if (state.view === "conversation") {
            session.turns.forEach(function (turn) {
              if (query && !searchTextForTurn(turn).includes(query)) return;
              if (!sessionExpanded) return;
              nodes.push(treeNode({
                target: turnDomId(session, turn),
                prefix: "  -",
                className: "tree-user",
                label: "turn " + turn.index,
                sessionChild: session.id
              }));
              nodes.push(treeNode({
                target: turn.userMessages.length ? userDomId(session, turn, 0) : turnDomId(session, turn),
                prefix: "    -",
                className: "tree-user",
                label: "user：" + turnUserPreview(turn),
                sessionChild: session.id
              }));
              nodes.push(treeNode({
                target: codexDomId(session, turn),
                prefix: "    -",
                className: "tree-assistant",
                label: "codex：" + turnCodexPreview(turn),
                sessionChild: session.id
              }));
            });
          } else {
            session.rawRecords.forEach(function (record) {
              const searchable = (record.summary + " " + JSON.stringify(record.data)).toLowerCase();
              if (query && !searchable.includes(query)) return;
              if (!sessionExpanded) return;
              nodes.push(treeNode({
                target: rawRecordDomId(session, record),
                prefix: "  -",
                className: "tree-raw",
                label: record.summary,
                sessionChild: session.id
              }));
            });
          }
        });
        tree.innerHTML = nodes.join("");
        treeStatus.textContent = Math.max(0, nodes.length - 1) + " 条记录可见";
        tree.querySelectorAll(".tree-node").forEach(function (node) {
          node.addEventListener("click", function () {
            const sessionId = node.dataset.sessionToggle;
            if (sessionId && !state.query) {
              if (state.collapsedSessions.has(sessionId)) {
                state.collapsedSessions.delete(sessionId);
              } else {
                state.collapsedSessions.add(sessionId);
              }
            }
            if (node.dataset.sessionChild) {
              state.collapsedSessions.delete(node.dataset.sessionChild);
            }
            activate(node.dataset.target, true);
            renderTree();
          });
        });
        activate(state.activeId, false);
      }

      function treeNode(options) {
        const attrs = [
          'class="tree-node' + (options.sessionToggle ? " session-root" : "") + (options.sessionChild ? " session-child" : "") + '"',
          'data-target="' + escapeHtml(options.target) + '"'
        ];
        if (options.sessionToggle) {
          attrs.push('data-session-toggle="' + escapeHtml(options.sessionToggle) + '"');
          attrs.push('aria-expanded="' + String(Boolean(options.expanded)) + '"');
        }
        if (options.sessionChild) {
          attrs.push('data-session-child="' + escapeHtml(options.sessionChild) + '"');
        }
        return '<button ' + attrs.join(" ") + '><span class="tree-prefix">' + escapeHtml(options.prefix) + '</span>' +
          (options.sessionToggle ? '<span class="tree-disclosure">' + (options.expanded ? "-" : "+") + "</span>" : "") +
          '<span class="tree-content ' + options.className + '">' + escapeHtml(options.label) + "</span></button>";
      }

      function activate(targetId, shouldScroll) {
        state.activeId = targetId;
        document.querySelectorAll(".tree-node").forEach(function (node) {
          node.classList.toggle("active", node.dataset.target === targetId);
        });
        if (!shouldScroll) return;
        const target = document.getElementById(targetId);
        if (!target) return;
        content.scrollTop = Math.max(0, target.offsetTop - content.offsetTop - 12);
      }

      function applyQuery() {
        const query = state.query.toLowerCase();
        const selector = state.view === "conversation" ? "#conversation-view .turn" : "#raw-view .raw-record";
        document.querySelectorAll(selector).forEach(function (node) {
          const searchText = node.dataset.search || node.textContent.toLowerCase();
          node.classList.toggle("hidden", Boolean(query) && !searchText.includes(query));
        });
        renderTree();
      }

      function setView(view) {
        state.view = view;
        document.querySelectorAll(".view-btn").forEach(function (button) {
          button.classList.toggle("active", button.dataset.view === view);
        });
        conversationView.classList.toggle("hidden", view !== "conversation");
        rawView.classList.toggle("hidden", view !== "raw");
        renderTree();
        applyQuery();
      }

      function setupSidebarResize() {
        let cleanup = null;
        function bounds() {
          const root = getComputedStyle(document.documentElement);
          const min = parseFloat(root.getPropertyValue("--sidebar-min-width")) || 260;
          const max = parseFloat(root.getPropertyValue("--sidebar-max-width")) || 820;
          return { min, max: Math.max(min, Math.min(max, window.innerWidth - MIN_CONTENT_WIDTH)) };
        }
        function apply(width) {
          const b = bounds();
          const next = Math.max(b.min, Math.min(b.max, width));
          document.documentElement.style.setProperty("--sidebar-width", Math.round(next) + "px");
        }
        resizer.addEventListener("pointerdown", function (event) {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = sidebar.getBoundingClientRect().width;
          document.body.classList.add("sidebar-resizing");
          function onMove(moveEvent) { apply(startWidth + moveEvent.clientX - startX); }
          function stop() {
            document.body.classList.remove("sidebar-resizing");
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
            cleanup = null;
          }
          cleanup = stop;
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", stop);
          window.addEventListener("pointercancel", stop);
        });
        window.addEventListener("resize", function () {
          if (!cleanup) apply(sidebar.getBoundingClientRect().width);
        });
      }

      document.querySelectorAll(".view-btn").forEach(function (button) {
        button.addEventListener("click", function () {
          setView(button.dataset.view);
        });
      });
      search.addEventListener("input", function () {
        state.query = search.value.trim();
        applyQuery();
      });

      renderHeader();
      renderConversation();
      renderRaw();
      setupSidebarResize();
      setView("conversation");
    })();
  </script>
</body>
</html>`;
}

function escapeForTemplate(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const data = {
  generatedAt: new Date().toISOString(),
  sessions: sessionPaths.map((sessionPath, index) => buildSessionData(readJsonl(sessionPath), sessionPath, index + 1))
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, htmlTemplate(data));
console.log(outputPath);
