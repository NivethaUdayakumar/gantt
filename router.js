// router.js
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "projectTasks.json");
const DATA_DIR = path.join(__dirname, "data");

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

const readBody = (req, cb) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => cb(body));
};

const parseCsvHeader = line => {
  const out = []; let cur = ""; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur.trim());
  return out.map(s => s.replace(/^"(.*)"$/, "$1"));
};

function handleTasks(req, res) {
  if (req.method === "GET") {
    return fs.readFile(DATA_FILE, "utf8", (e, txt) =>
      e && e.code === "ENOENT"
        ? sendJson(res, 200, [])
        : e
        ? sendJson(res, 500, { error: "read fail" })
        : sendJson(res, 200, JSON.parse(txt || "[]"))
    );
  }
  if (req.method === "PUT") {
    return readBody(req, body => {
      let data;
      try { data = JSON.parse(body || "[]"); }
      catch { return sendJson(res, 400, { error: "invalid json" }); }
      if (!Array.isArray(data)) return sendJson(res, 400, { error: "must be array" });
      fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8", e =>
        e ? sendJson(res, 500, { error: "write fail" }) : sendJson(res, 200, { ok: true })
      );
    });
  }
  sendJson(res, 405, { error: "method not allowed" });
}

function handleFlows(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  fs.readdir(DATA_DIR, (e, files) => {
    if (e && e.code === "ENOENT") return sendJson(res, 200, []);
    if (e) return sendJson(res, 500, { error: "dir fail" });
    const flows = files.filter(f => f.endsWith(".csv")).map(f => f.replace(/\.csv$/i, ""));
    sendJson(res, 200, flows);
  });
}

function handleColumns(req, res, q) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const flow = q.flow;
  if (!flow) return sendJson(res, 400, { error: "missing flow" });

  const file = path.join(DATA_DIR, flow + ".csv");
  fs.readFile(file, "utf8", (e, txt) => {
    if (e && e.code === "ENOENT") return sendJson(res, 404, { error: "not found" });
    if (e) return sendJson(res, 500, { error: "read fail" });
    const first = txt.split(/\r?\n/).find(l => l.trim());
    sendJson(res, 200, first ? parseCsvHeader(first) : []);
  });
}

module.exports = {
  handleTasks,
  handleFlows,
  handleColumns
};