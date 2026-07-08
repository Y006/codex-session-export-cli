#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const inputDir = args[0];
const outputPath = args[1];
const portableMode = args.includes("--portable");

if (!inputDir || !outputPath) {
  console.error("usage: node generate-chatgpt-history-html.js <chatgpt-export-folder> <output.html>");
  process.exit(1);
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstTextLine(text, fallback) {
  const line = compactText(text);
  if (!line) return fallback;
  return line.length > 92 ? line.slice(0, 89) + "..." : line;
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topCounts(counts, limit) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, value]) => ({ key, value }));
}

function numberToMs(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp > 100000000000 ? timestamp : timestamp * 1000;
}

function conversationFiles(exportDir) {
  return fs.readdirSync(exportDir)
    .filter((file) => /^conversations-\d+\.json$/.test(file))
    .sort()
    .map((file) => path.join(exportDir, file));
}

function normalizeFileId(value) {
  const text = String(value || "");
  const match = text.match(/(file_[A-Za-z0-9]+)/);
  return match ? match[1] : "";
}

function libraryIndexes(files, baseDir) {
  const indexes = new Map();
  function add(key, file) {
    if (!key || indexes.has(String(key))) return;
    indexes.set(String(key), file);
  }
  for (const file of Array.isArray(files) ? files : []) {
    add(file.file_id, file);
    add(file.origination_message_id, file);
    if (file.id && typeof file.id === "object") add(file.id.id, file);
    if (file.file_id) {
      const localFile = path.join(baseDir, `${file.file_id}.dat`);
      if (fs.existsSync(localFile)) file.local_file = localFile;
    }
  }
  return indexes;
}

function displayLocalFile(filePath) {
  if (!filePath) return "";
  if (!portableMode) return filePath;
  const relative = path.relative(path.dirname(path.resolve(outputPath)), path.resolve(filePath));
  return relative.split(path.sep).join("/");
}

function fileSummary(fileId, fallback, fileIndex, assetNameMap, baseDir) {
  const id = normalizeFileId(fileId || fallback.id || fallback.file_id || fallback.asset_pointer);
  const matched = id ? fileIndex.get(id) : null;
  const localFile = id ? path.join(baseDir, `${id}.dat`) : "";
  const mappedName = id ? assetNameMap[`${id}.dat`] : "";
  const name = fallback.name || fallback.title || mappedName || (matched && (matched.file_name || matched.normalized_name)) || (id ? `${id}.dat` : "attachment");
  return {
    id,
    name,
    mimeType: fallback.mime_type || fallback.mimeType || (matched && matched.mime_type) || "",
    sizeBytes: fallback.size || fallback.size_bytes || fallback.sizeBytes || (matched && matched.file_size_bytes) || 0,
    width: fallback.width || 0,
    height: fallback.height || 0,
    localFile: localFile && fs.existsSync(localFile)
      ? displayLocalFile(localFile)
      : displayLocalFile((matched && matched.local_file) || "")
  };
}

function addAttachment(attachments, attachment) {
  const key = attachment.id || attachment.localFile || attachment.name || JSON.stringify(attachment);
  if (attachments.some((item) => (item.id || item.localFile || item.name || JSON.stringify(item)) === key)) return;
  attachments.push(attachment);
}

function extractContent(message, fileIndex, assetNameMap, baseDir) {
  const content = message.content || {};
  const contentType = content.content_type || "";
  const textParts = [];
  const attachments = [];

  function handlePart(part) {
    if (typeof part === "string") {
      if (part.trim()) textParts.push(part);
      return;
    }
    if (!part || typeof part !== "object") return;
    if (typeof part.text === "string" && part.text.trim()) textParts.push(part.text);
    if (part.asset_pointer || part.file_id || part.id) {
      const summary = fileSummary(part.asset_pointer || part.file_id || part.id, part, fileIndex, assetNameMap, baseDir);
      addAttachment(attachments, {
        type: part.content_type || "asset",
        id: summary.id,
        name: summary.name,
        mimeType: summary.mimeType,
        sizeBytes: summary.sizeBytes,
        width: summary.width,
        height: summary.height,
        localFile: summary.localFile
      });
    }
  }

  if (contentType === "text") {
    (Array.isArray(content.parts) ? content.parts : []).forEach(handlePart);
  } else if (contentType === "multimodal_text") {
    (Array.isArray(content.parts) ? content.parts : []).forEach(handlePart);
  } else {
    return null;
  }

  const metadataAttachments = message.metadata && Array.isArray(message.metadata.attachments)
    ? message.metadata.attachments
    : [];
  for (const item of metadataAttachments) {
    const summary = fileSummary(item.id || item.file_id || item.asset_pointer, item, fileIndex, assetNameMap, baseDir);
    addAttachment(attachments, {
      type: item.source || item.mime_type || "attachment",
      id: summary.id,
      name: summary.name,
      mimeType: summary.mimeType,
      sizeBytes: summary.sizeBytes,
      width: summary.width,
      height: summary.height,
      localFile: summary.localFile
    });
  }

  const text = textParts.join("\n\n").trim();
  if (!text && !attachments.length) return null;
  return {
    text: text || "[附件消息]",
    attachments,
    contentType
  };
}

function roleLabel(role) {
  if (role === "assistant") return "ChatGPT";
  if (role === "user") return "用户";
  return role || "未知";
}

function mainPathNodes(conversation) {
  const mapping = conversation.mapping || {};
  const ids = Object.keys(mapping);
  const nodes = [];
  const seen = new Set();
  let current = conversation.current_node;

  while (current && mapping[current] && !seen.has(current)) {
    seen.add(current);
    nodes.push({ id: current, node: mapping[current] });
    current = mapping[current].parent;
  }

  if (!nodes.length) {
    return ids
      .map((id) => ({ id, node: mapping[id] }))
      .sort((a, b) => numberToMs(a.node.message && a.node.message.create_time) - numberToMs(b.node.message && b.node.message.create_time));
  }
  return nodes.reverse();
}

function normalizeConversation(conversation, index, sourceFile, fileIndex, assetNameMap, baseDir) {
  const allNodes = Object.keys(conversation.mapping || {});
  const pathNodes = mainPathNodes(conversation);
  const messages = [];
  let skippedInternal = 0;
  let turnIndex = 0;

  for (const item of pathNodes) {
    const message = item.node && item.node.message;
    if (!message || !message.author) continue;
    const role = message.author.role || "";
    if (role !== "user" && role !== "assistant") continue;

    const extracted = extractContent(message, fileIndex, assetNameMap, baseDir);
    if (!extracted) {
      skippedInternal += 1;
      continue;
    }

    if (role === "user" || turnIndex === 0) turnIndex += 1;
    messages.push({
      id: message.id || item.id,
      nodeId: item.id,
      index: messages.length + 1,
      turnIndex,
      role,
      roleLabel: roleLabel(role),
      createdMs: numberToMs(message.create_time),
      text: extracted.text,
      title: firstTextLine(extracted.text, `${roleLabel(role)} ${messages.length + 1}`),
      attachments: extracted.attachments,
      contentType: extracted.contentType
    });
  }

  const createdMs = numberToMs(conversation.create_time);
  const updatedMs = numberToMs(conversation.update_time);
  const title = conversation.title || `conversation ${index}`;

  return {
    index,
    id: conversation.conversation_id || conversation.id || `conversation-${index}`,
    title,
    sourceFile,
    createMs: createdMs,
    updateMs: updatedMs,
    model: conversation.default_model_slug || "",
    archived: Boolean(conversation.is_archived),
    starred: Boolean(conversation.is_starred),
    messageCount: messages.length,
    turnCount: turnIndex,
    nodeCount: allNodes.length,
    pathNodeCount: pathNodes.length,
    branchNodeCount: Math.max(0, allNodes.length - pathNodes.length),
    skippedInternal,
    messages
  };
}

function buildData(exportDir) {
  const files = conversationFiles(exportDir);
  if (!files.length) throw new Error("没有找到 conversations-*.json");

  const assetNameMap = readJson(path.join(exportDir, "conversation_asset_file_names.json"), {});
  const libraryFiles = readJson(path.join(exportDir, "library_files.json"), []);
  const fileIndex = libraryIndexes(libraryFiles, exportDir);
  const conversations = [];

  for (const filePath of files) {
    const rows = readJson(filePath, []);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      conversations.push({ row, sourceFile: path.basename(filePath) });
    }
  }

  conversations.sort((a, b) => {
    const left = numberToMs(a.row.create_time) || numberToMs(a.row.update_time);
    const right = numberToMs(b.row.create_time) || numberToMs(b.row.update_time);
    return left - right || String(a.row.title || "").localeCompare(String(b.row.title || ""));
  });

  const normalized = conversations.map((item, index) =>
    normalizeConversation(item.row, index + 1, item.sourceFile, fileIndex, assetNameMap, exportDir)
  );
  const allMessages = normalized.flatMap((conversation) => conversation.messages);
  const allAttachments = allMessages.flatMap((message) => message.attachments);

  return {
    generatedAt: new Date().toISOString(),
    sourcePath: portableMode ? `portable package: ${path.basename(path.resolve(exportDir))}` : path.resolve(exportDir),
    portable: portableMode,
    conversationFiles: files.map((filePath) => path.basename(filePath)),
    conversations: normalized,
    summary: {
      conversationCount: normalized.length,
      messageCount: allMessages.length,
      turnCount: normalized.reduce((sum, conversation) => sum + conversation.turnCount, 0),
      attachmentCount: allAttachments.length,
      branchNodeCount: normalized.reduce((sum, conversation) => sum + conversation.branchNodeCount, 0),
      skippedInternalCount: normalized.reduce((sum, conversation) => sum + conversation.skippedInternal, 0),
      libraryFileCount: Array.isArray(libraryFiles) ? libraryFiles.length : 0,
      roles: topCounts(countBy(allMessages, (message) => message.roleLabel), 8),
      contentTypes: topCounts(countBy(allMessages, (message) => message.contentType), 8)
    }
  };
}

function htmlTemplate(data) {
  const embedded = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="zh-CN" data-chatgpt-history-export="true">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChatGPT 历史导出 ${data.summary.conversationCount} conversations</title>
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
      --selected-bg: #425047;
      --line-height: 18px;
      --font-bump: 2pt;
      --content-inset-x: 12px;
      --content-inset-y: 10px;
      --block-inset: 12px;
      --sidebar-width: 300px;
      --sidebar-min-width: 240px;
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
    .tree-node.conversation-root { margin-top: 8px; }
    .tree-node.turn-node { color: var(--muted); }
    .tree-node.message-node { color: var(--dim); }
    .tree-prefix { color: var(--muted); flex: 0 0 auto; white-space: pre; }
    .tree-disclosure {
      width: 1ch;
      flex: 0 0 auto;
      color: var(--warning);
      font-weight: 700;
      text-align: center;
    }
    .tree-content { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tree-conversation { color: var(--warning); font-weight: 700; }
    .tree-user { color: var(--accent); }
    .tree-assistant { color: #e5e5e7; }
    .tree-turn { color: var(--muted); }
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
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 0 8px;
      color: var(--dim);
      font-size: calc(11px + var(--font-bump));
    }
    .kv dt { font-weight: 700; }
    .kv dd { min-width: 0; color: var(--text); overflow-wrap: anywhere; }
    .summary-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: var(--line-height);
      color: var(--muted);
    }
    .summary-pill {
      border: 1px solid var(--border-muted);
      border-radius: 3px;
      padding: 2px 6px;
      color: var(--text);
      background: rgba(0, 0, 0, 0.08);
    }
    #conversation-view {
      display: flex;
      flex-direction: column;
      gap: var(--content-inset-y);
    }
    .hidden { display: none !important; }
    .conversation-section::before {
      content: "";
      display: block;
      border-top: 1px dashed var(--border-muted);
      margin: 0 0 var(--content-inset-y);
    }
    .conversation-heading {
      margin-bottom: var(--content-inset-y);
    }
    .conversation-heading .entry-block {
      background: var(--panel-bg-2);
      border: 1px solid var(--border-muted);
    }
    .conversation-heading-title {
      color: var(--border-accent);
      font-weight: 700;
      margin-bottom: calc(var(--line-height) / 2);
    }
    .message + .message {
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
    .label { color: var(--muted); font-weight: 700; }
    .speaker-line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: calc(var(--line-height) / 2);
    }
    .message-index { color: var(--dim); }
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
    .attachments {
      margin-top: var(--line-height);
      display: grid;
      gap: 6px;
    }
    .attachment {
      padding: 6px 8px;
      border: 1px solid var(--border-muted);
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.08);
      color: var(--muted);
    }
    .attachment-title {
      color: var(--warning);
      font-weight: 700;
      margin-bottom: 2px;
    }
    .attachment-meta {
      color: var(--dim);
      font-size: calc(10px + var(--font-bump));
      overflow-wrap: anywhere;
    }
    .attachment a {
      color: var(--border-accent);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
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
        <div class="sidebar-title">ChatGPT 历史对话</div>
        <div class="sidebar-subtitle">${data.summary.conversationCount} 个 conversation / ${data.summary.messageCount} 条消息</div>
        <div class="search-wrap">
          <input id="tree-search" type="search" placeholder="搜索历史对话..." autocomplete="off">
        </div>
      </div>
      <nav id="tree" aria-label="chatgpt history tree"></nav>
      <div class="tree-status" id="tree-status">0 条记录可见</div>
    </aside>
    <div id="sidebar-resizer" aria-hidden="true"></div>
    <main id="content">
      <div class="top-line">
        <span>ChatGPT History Export</span>
      </div>
      <section class="header" id="collection-header"></section>
      <section id="conversation-view"></section>
    </main>
  </div>
  <script type="application/json" id="chat-data">${embedded}</script>
  <script>
    (function () {
      const data = JSON.parse(document.getElementById("chat-data").textContent);
      const state = {
        query: "",
        activeId: "collection-header",
        collapsedConversations: new Set(data.conversations.map(function (conversation) { return conversation.id; }))
      };
      const tree = document.getElementById("tree");
      const content = document.getElementById("content");
      const treeStatus = document.getElementById("tree-status");
      const search = document.getElementById("tree-search");
      const conversationView = document.getElementById("conversation-view");
      const sidebar = document.getElementById("sidebar");
      const resizer = document.getElementById("sidebar-resizer");
      const MIN_CONTENT_WIDTH = 320;
      const messageSearch = new Map();

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

      function fileHref(value) {
        if (!value) return "#";
        const raw = String(value).replace(/#/g, "%23").replace(/ /g, "%20");
        if (/^(https?:|file:|mailto:)/i.test(raw)) return safeUrl(raw);
        if (raw.charAt(0) === "/" || /^[A-Za-z]:/.test(raw)) return safeUrl("file://" + raw);
        const relative = raw.indexOf("./") === 0 ? raw.slice(2) : raw;
        return safeUrl("./" + relative);
      }

      function renderInline(value) {
        const stash = [];
        let text = String(value || "").replace(/\`([^\`\\n]+)\`/g, function (_, code) {
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
          const fence = line.match(/^\\s*\`\`\`(.*)$/);
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

      function formatTime(ms) {
        if (!ms) return "";
        const date = new Date(ms);
        if (Number.isNaN(date.getTime())) return "";
        return date.toISOString().replace("T", " ").replace(".000Z", "Z");
      }

      function formatBytes(value) {
        const bytes = Number(value || 0);
        if (!bytes) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
        return (bytes / 1024 / 1024).toFixed(1) + " MB";
      }

      function renderCountPills(items) {
        if (!items || !items.length) return "";
        return items.map(function (item) {
          return '<span class="summary-pill">' + escapeHtml(item.key + " " + item.value) + "</span>";
        }).join("");
      }

      function renderHeader() {
        document.getElementById("collection-header").innerHTML = [
          "<h1>ChatGPT 历史对话导出</h1>",
          '<dl class="kv">',
          "<dt>来源目录</dt><dd>" + escapeHtml(data.sourcePath) + "</dd>",
          "<dt>conversation 文件</dt><dd>" + escapeHtml(data.conversationFiles.join(", ")) + "</dd>",
          "<dt>对话数量</dt><dd>" + escapeHtml(data.summary.conversationCount + " 个") + "</dd>",
          "<dt>turn 数量</dt><dd>" + escapeHtml(data.summary.turnCount + " 个") + "</dd>",
          "<dt>消息数量</dt><dd>" + escapeHtml(data.summary.messageCount + " 条") + "</dd>",
          "<dt>附件引用</dt><dd>" + escapeHtml(data.summary.attachmentCount + " 个") + "</dd>",
          "<dt>导出范围</dt><dd>每个 conversation 的 current_node 主干；隐藏 thoughts / reasoning_recap；附件保留本地文件引用</dd>",
          "<dt>导出时间</dt><dd>" + escapeHtml(formatTime(Date.parse(data.generatedAt))) + "</dd>",
          "</dl>",
          '<div class="summary-row">' + renderCountPills(data.summary.roles) + renderCountPills(data.summary.contentTypes) + "</div>"
        ].join("");
      }

      function conversationSectionId(conversation) {
        return "conversation-" + conversation.index + "-section";
      }

      function messageDomId(conversation, message) {
        return "conversation-" + conversation.index + "-message-" + message.index;
      }

      function searchTextForMessage(conversation, message) {
        return [
          conversation.title,
          conversation.id,
          message.roleLabel,
          message.title,
          message.text,
          message.attachments.map(function (attachment) {
            return [attachment.id, attachment.name, attachment.mimeType, attachment.localFile].join(" ");
          }).join(" ")
        ].join(" ").toLowerCase();
      }

      function searchTextForConversation(conversation) {
        return [
          conversation.title,
          conversation.id,
          conversation.model,
          conversation.sourceFile,
          conversation.messages.map(function (message) { return message.title; }).join(" ")
        ].join(" ").toLowerCase();
      }

      function renderAttachments(attachments) {
        if (!attachments || !attachments.length) return "";
        return '<div class="attachments">' + attachments.map(function (attachment, index) {
          const title = attachment.name || attachment.id || "attachment " + (index + 1);
          const lines = [
            attachment.id ? "id: " + attachment.id : "",
            attachment.mimeType ? "mime: " + attachment.mimeType : "",
            attachment.sizeBytes ? "size: " + formatBytes(attachment.sizeBytes) : "",
            attachment.width && attachment.height ? "shape: " + attachment.width + " x " + attachment.height : "",
            attachment.localFile ? "local: " + attachment.localFile : "local: 未在导出目录中找到对应 .dat"
          ].filter(Boolean);
          return '<div class="attachment">' +
            '<div class="attachment-title">' + escapeHtml(title) + "</div>" +
            '<div class="attachment-meta">' + escapeHtml(lines.join(" / ")) + "</div>" +
            (attachment.localFile ? '<div class="attachment-meta"><a href="' + fileHref(attachment.localFile) + '" target="_blank" rel="noreferrer">打开本地附件</a></div>' : "") +
            "</div>";
        }).join("") + "</div>";
      }

      function renderConversation() {
        if (!data.conversations.some(function (conversation) { return conversation.messages.length; })) {
          conversationView.innerHTML = '<div class="empty">没有解析到可展示的用户/ChatGPT 消息。</div>';
          return;
        }
        const blocks = [];
        data.conversations.forEach(function (conversation) {
          blocks.push('<section class="conversation-section" id="' + conversationSectionId(conversation) + '">');
          blocks.push('<div class="conversation-heading"><div class="entry-block">');
          blocks.push('<div class="conversation-heading-title">conversation ' + conversation.index + " / " + escapeHtml(conversation.title) + "</div>");
          blocks.push('<dl class="kv">' +
            "<dt>conversation id</dt><dd>" + escapeHtml(conversation.id) + "</dd>" +
            "<dt>消息数</dt><dd>" + escapeHtml(conversation.messageCount + " 条 / " + conversation.turnCount + " 个 turn") + "</dd>" +
            "<dt>模型</dt><dd>" + escapeHtml(conversation.model || "[未知]") + "</dd>" +
            "<dt>来源文件</dt><dd>" + escapeHtml(conversation.sourceFile) + "</dd>" +
            "<dt>创建时间</dt><dd>" + escapeHtml(formatTime(conversation.createMs)) + "</dd>" +
            "<dt>更新时间</dt><dd>" + escapeHtml(formatTime(conversation.updateMs)) + "</dd>" +
            "</dl>");
          blocks.push("</div></div>");
          blocks.push(conversation.messages.map(function (message) {
            const roleClass = message.role === "assistant" ? "assistant" : "user";
            const domId = messageDomId(conversation, message);
            messageSearch.set(domId, searchTextForMessage(conversation, message));
            return [
              '<article class="message" id="' + domId + '" data-turn="' + escapeHtml(message.turnIndex) + '">',
              '<div class="timestamp">' + escapeHtml(formatTime(message.createdMs)) + "</div>",
              '<section class="entry-block ' + roleClass + '">',
              '<div class="speaker-line"><span class="label">turn ' + escapeHtml(message.turnIndex) + " / " + escapeHtml(message.roleLabel) + '</span><span class="message-index">message ' + message.index + "</span></div>",
              renderMarkdown(message.text || "[空消息]"),
              renderAttachments(message.attachments),
              "</section></article>"
            ].join("");
          }).join(""));
          blocks.push("</section>");
        });
        conversationView.innerHTML = blocks.join("");
      }

      function compactPreview(value, maxLength) {
        const text = String(value || "").replace(/\\s+/g, " ").trim();
        if (!text) return "[空]";
        return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
      }

      function messagesByTurn(conversation) {
        const turns = [];
        conversation.messages.forEach(function (message) {
          let turn = turns.find(function (item) { return item.index === message.turnIndex; });
          if (!turn) {
            turn = { index: message.turnIndex, messages: [] };
            turns.push(turn);
          }
          turn.messages.push(message);
        });
        return turns;
      }

      function renderTree() {
        const query = state.query.toLowerCase();
        const nodes = [];
        data.conversations.forEach(function (conversation) {
          const conversationText = searchTextForConversation(conversation);
          const matchingMessages = conversation.messages.filter(function (message) {
            return !query || searchTextForMessage(conversation, message).includes(query);
          });
          if (query && !conversationText.includes(query) && !matchingMessages.length) return;

          const expanded = Boolean(query) || !state.collapsedConversations.has(conversation.id);
          nodes.push(treeNode({
            target: conversationSectionId(conversation),
            prefix: "",
            className: "tree-conversation",
            label: "conversation " + conversation.index + " / " + compactPreview(conversation.title, 80),
            conversationToggle: conversation.id,
            expanded
          }));
          if (!expanded) return;

          messagesByTurn(conversation).forEach(function (turn) {
            const turnMessages = turn.messages.filter(function (message) {
              return !query || searchTextForMessage(conversation, message).includes(query);
            });
            if (query && !turnMessages.length) return;
            const firstMessage = turn.messages[0];
            nodes.push(treeNode({
              target: firstMessage ? messageDomId(conversation, firstMessage) : conversationSectionId(conversation),
              prefix: "  -",
              className: "tree-turn",
              label: "turn " + turn.index + " / " + compactPreview(firstMessage && firstMessage.title, 70),
              turnNode: true
            }));
            turnMessages.forEach(function (message) {
              nodes.push(treeNode({
                target: messageDomId(conversation, message),
                prefix: "    -",
                className: message.role === "assistant" ? "tree-assistant" : "tree-user",
                label: message.roleLabel + "：" + compactPreview(message.text, 92),
                messageNode: true
              }));
            });
          });
        });
        tree.innerHTML = nodes.join("");
        treeStatus.textContent = nodes.length + " 条记录可见";
        tree.querySelectorAll(".tree-node").forEach(function (node) {
          node.addEventListener("click", function () {
            const conversationId = node.dataset.conversationToggle;
            if (conversationId && !state.query) {
              if (state.collapsedConversations.has(conversationId)) {
                state.collapsedConversations.delete(conversationId);
              } else {
                state.collapsedConversations.add(conversationId);
              }
            }
            activate(node.dataset.target, true);
            renderTree();
          });
        });
        activate(state.activeId, false);
      }

      function treeNode(options) {
        const attrs = [
          'class="tree-node' + (options.conversationToggle ? " conversation-root" : "") + (options.turnNode ? " turn-node" : "") + (options.messageNode ? " message-node" : "") + '"',
          'data-target="' + escapeHtml(options.target) + '"'
        ];
        if (options.conversationToggle) {
          attrs.push('data-conversation-toggle="' + escapeHtml(options.conversationToggle) + '"');
          attrs.push('aria-expanded="' + String(Boolean(options.expanded)) + '"');
        }
        return '<button ' + attrs.join(" ") + '><span class="tree-prefix">' + escapeHtml(options.prefix) + '</span>' +
          (options.conversationToggle ? '<span class="tree-disclosure">' + (options.expanded ? "-" : "+") + "</span>" : "") +
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
        document.querySelectorAll("#conversation-view .message").forEach(function (node) {
          const searchText = messageSearch.get(node.id) || node.textContent.toLowerCase();
          node.classList.toggle("hidden", Boolean(query) && !searchText.includes(query));
        });
        document.querySelectorAll("#conversation-view .conversation-section").forEach(function (section) {
          if (!query) {
            section.classList.remove("hidden");
            return;
          }
          const conversation = data.conversations[Number((section.id.match(/conversation-(\\d+)-section/) || [])[1]) - 1];
          const ownText = conversation ? searchTextForConversation(conversation) : "";
          const hasVisibleMessage = Array.from(section.querySelectorAll(".message")).some(function (node) {
            return !node.classList.contains("hidden");
          });
          section.classList.toggle("hidden", !ownText.includes(query) && !hasVisibleMessage);
        });
        renderTree();
      }

      function setupSidebarResize() {
        let cleanup = null;
        function bounds() {
          const root = getComputedStyle(document.documentElement);
          const min = parseFloat(root.getPropertyValue("--sidebar-min-width")) || 240;
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

      search.addEventListener("input", function () {
        state.query = search.value.trim();
        applyQuery();
      });

      renderHeader();
      renderConversation();
      setupSidebarResize();
      applyQuery();
    })();
  </script>
</body>
</html>`;
}

const data = buildData(inputDir);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, htmlTemplate(data));
console.log(outputPath);
