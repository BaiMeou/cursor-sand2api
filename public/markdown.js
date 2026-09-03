// A small Markdown renderer, deliberately dependency-free so the console keeps
// working on a machine with no internet.
//
// Everything is escaped before any tag is produced, and inline spans are only
// applied to already-escaped text, so model output cannot inject HTML.
(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Only http/https/mailto survive; a javascript: url in a model-written link
  // would otherwise be one click from running.
  function safeUrl(url) {
    const trimmed = String(url).trim();
    return /^(https?:\/\/|mailto:|#|\/)/i.test(trimmed) ? trimmed : "";
  }

  // Inline passes run on escaped text. Code spans are lifted out first so their
  // contents never get emphasis or link treatment.
  function inline(text) {
    const spans = [];
    let out = String(text).replace(/(`+)([\s\S]*?)\1/g, (_, ticks, code) => {
      spans.push(`<code>${code.trim()}</code>`);
      return `\u0000${spans.length - 1}\u0000`;
    });

    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      const safe = safeUrl(url);
      return safe ? `<img src="${safe}" alt="${alt}" />` : m;
    });
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
      const safe = safeUrl(url);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (m, lead, url) => {
      return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^_])__([^_]+)__/g, "$1<strong>$2</strong>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
  }

  function tableFrom(lines, start) {
    const header = lines[start];
    const divider = lines[start + 1] || "";
    if (!/\|/.test(header) || !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(divider)) return null;
    const cells = (row) =>
      row
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim());

    const head = cells(header);
    const rows = [];
    let i = start + 2;
    for (; i < lines.length && /\|/.test(lines[i]) && lines[i].trim(); i++) rows.push(cells(lines[i]));

    let html = "<table><thead><tr>";
    for (const c of head) html += `<th>${inline(escapeHtml(c))}</th>`;
    html += "</tr></thead><tbody>";
    for (const row of rows) {
      html += "<tr>";
      for (let c = 0; c < head.length; c++) html += `<td>${inline(escapeHtml(row[c] || ""))}</td>`;
      html += "</tr>";
    }
    return { html: `${html}</tbody></table>`, next: i };
  }

  // A fenced block that never closes is normal mid-stream, so an unterminated
  // fence still renders as code rather than swallowing the rest of the answer.
  function codeBlock(lines, start) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[start]);
    if (!open) return null;
    const fence = open[1][0];
    const size = open[1].length;
    const lang = open[2] || "";
    const body = [];
    let i = start + 1;
    for (; i < lines.length; i++) {
      const close = new RegExp(`^\\s*${fence === "`" ? "`" : "~"}{${size},}\\s*$`);
      if (close.test(lines[i])) {
        i++;
        break;
      }
      body.push(lines[i]);
    }
    const code = escapeHtml(body.join("\n"));
    const label = lang ? escapeHtml(lang) : "code";
    const html =
      `<div class="code-block" data-code="${encodeURIComponent(body.join("\n"))}">` +
      `<div class="code-head"><span>${label}</span>` +
      `<button class="copy-btn" type="button" data-copy>复制</button></div>` +
      `<pre><code>${code}</code></pre></div>`;
    return { html, next: i };
  }

  function listBlock(lines, start) {
    const bullet = /^(\s*)([-*+])\s+(.*)$/;
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/;
    if (!bullet.test(lines[start]) && !ordered.test(lines[start])) return null;
    const isOrdered = ordered.test(lines[start]);
    const tag = isOrdered ? "ol" : "ul";

    const items = [];
    let i = start;
    for (; i < lines.length; i++) {
      const m = (isOrdered ? ordered : bullet).exec(lines[i]);
      if (m) {
        items.push(m[3]);
        continue;
      }
      // An indented continuation belongs to the item above it.
      if (/^\s{2,}\S/.test(lines[i]) && items.length) {
        items[items.length - 1] += `\n${lines[i].trim()}`;
        continue;
      }
      break;
    }
    let html = `<${tag}>`;
    for (const item of items) html += `<li>${inline(escapeHtml(item))}</li>`;
    return { html: `${html}</${tag}>`, next: i };
  }

  function render(src) {
    const lines = String(src == null ? "" : src).split("\n");
    let html = "";
    let i = 0;
    let paragraph = [];

    const flush = () => {
      if (!paragraph.length) return;
      html += `<p>${inline(escapeHtml(paragraph.join("\n"))).replace(/\n/g, "<br />")}</p>`;
      paragraph = [];
    };

    while (i < lines.length) {
      const line = lines[i];

      const code = codeBlock(lines, i);
      if (code) {
        flush();
        html += code.html;
        i = code.next;
        continue;
      }

      if (!line.trim()) {
        flush();
        i++;
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length, 4);
        html += `<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`;
        i++;
        continue;
      }

      if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
        flush();
        html += "<hr />";
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flush();
        const quoted = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        html += `<blockquote>${render(quoted.join("\n"))}</blockquote>`;
        continue;
      }

      const table = tableFrom(lines, i);
      if (table) {
        flush();
        html += table.html;
        i = table.next;
        continue;
      }

      const list = listBlock(lines, i);
      if (list) {
        flush();
        html += list.html;
        i = list.next;
        continue;
      }

      paragraph.push(line);
      i++;
    }
    flush();
    return html;
  }

  global.md = { render, escapeHtml };
})(window);
