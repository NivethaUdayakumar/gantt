// router.js
// All processing and routing lives here. No express.

const fs = require("fs/promises");
const path = require("path");
const { parse: parseUrl } = require("url");

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let buf = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      buf += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function safeResolveBaseDir(baseDir) {
  if (typeof baseDir !== "string") throw new Error("baseDir must be a string");
  const trimmed = baseDir.trim();
  if (!trimmed) throw new Error("baseDir is required");
  return path.resolve(trimmed);
}

async function assertDirectory(dirPath) {
  const st = await fs.stat(dirPath);
  if (!st.isDirectory()) throw new Error("baseDir is not a directory");
}

async function listImmediateSubdirs(baseDir) {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function walkCsvFiles(dirPath, outFiles) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) await walkCsvFiles(full, outFiles);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".csv")) outFiles.push(full);
  }
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsvText(csvText) {
  const lines = csvText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((x) => x.trim().length);

  if (!lines.length) return { columns: [], rows: [] };

  const columns = splitCsvLine(lines[0]).map((x) => x.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < columns.length; c++) row[columns[c]] = parts[c] ?? "";

    for (const k of Object.keys(row)) {
      const raw = row[k];
      const num = Number(raw);
      if (raw !== "" && Number.isFinite(num) && String(raw).trim() === String(num)) row[k] = num;
    }

    rows.push(row);
  }

  return { columns, rows };
}

async function loadCombinedCsvs(baseDir, startKeyword) {
  await assertDirectory(baseDir);

  const subdirs = await listImmediateSubdirs(baseDir);
  const key = typeof startKeyword === "string" ? startKeyword.trim() : "";

  const matchedFolders = key ? subdirs.filter((d) => d.startsWith(key)) : subdirs;
  if (!matchedFolders.length) throw new Error("No subdirectories matched startKeyword");

  const csvFiles = [];
  for (const dirName of matchedFolders) {
    const folder = path.join(baseDir, dirName);
    await walkCsvFiles(folder, csvFiles);
  }
  if (!csvFiles.length) throw new Error("No csv files found under matched subdirectories");

  const colSet = new Set();
  const allRows = [];

  for (const filePath of csvFiles) {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = parseCsvText(text);
    parsed.columns.forEach((c) => colSet.add(c));
    allRows.push(...parsed.rows);
  }

  return {
    headers: Array.from(colSet),
    rows: allRows,
    meta: {
      baseDir,
      startKeyword: key,
      matchedFolders,
      csvCount: csvFiles.length,
      rowCount: allRows.length,
      colCount: colSet.size,
    },
  };
}

async function serveIndexHtml(res) {
  const htmlPath = path.join(__dirname, "index.html");
  const html = await fs.readFile(htmlPath, "utf8");
  sendText(res, 200, html, "text/html; charset=utf-8");
}

async function handleApiReports(req, res) {
  const body = await readJsonBody(req);
  const baseDir = safeResolveBaseDir(body.baseDir);
  const startKeyword = typeof body.startKeyword === "string" ? body.startKeyword : "";
  const out = await loadCombinedCsvs(baseDir, startKeyword);
  sendJson(res, 200, { ok: true, ...out });
}

async function route(req, res) {
  const method = (req.method || "GET").toUpperCase();
  const { pathname } = parseUrl(req.url || "/", true);

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    await serveIndexHtml(res);
    return;
  }

  if (method === "POST" && pathname === "/api/reports") {
    await handleApiReports(req, res);
    return;
  }

  if (method === "GET") {
    sendText(res, 404, "Not found");
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function handleRequest(req, res) {
  try {
    await route(req, res);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
  }
}

module.exports = { handleRequest };
