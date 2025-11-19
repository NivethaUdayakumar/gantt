// server.js
// Simple Node server with no Express
// Serves static files and provides:
// GET /api/tasks
// PUT /api/tasks
// GET /api/flows
// GET /api/columns?flow=FlowName

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = 3000;
const ROOT_DIR = __dirname;
const DATA_FILE = path.join(ROOT_DIR, "projectTasks.json");
const DATA_DIR = path.join(ROOT_DIR, "data");

// Basic mime types
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// ------------- /api/tasks -------------

function handleApiTasks(req, res) {
  if (req.method === "GET") {
    fs.readFile(DATA_FILE, "utf8", (err, content) => {
      if (err) {
        if (err.code === "ENOENT") {
          // No file yet, treat as empty list
          return sendJson(res, 200, []);
        }
        console.error("Error reading projectTasks.json:", err);
        return sendJson(res, 500, { error: "Failed to read projectTasks.json" });
      }

      try {
        const json = JSON.parse(content || "[]");
        sendJson(res, 200, json);
      } catch (e) {
        console.error("Error parsing projectTasks.json:", e);
        sendJson(res, 500, { error: "Invalid JSON in projectTasks.json" });
      }
    });
  } else if (req.method === "PUT") {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.connection.destroy();
      }
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "[]");
        if (!Array.isArray(data)) {
          return sendJson(res, 400, { error: "Body must be an array" });
        }
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8", err => {
          if (err) {
            console.error("Error writing projectTasks.json:", err);
            return sendJson(res, 500, { error: "Failed to write projectTasks.json" });
          }
          sendJson(res, 200, { ok: true });
        });
      } catch (e) {
        console.error("Error parsing request body:", e);
        sendJson(res, 400, { error: "Invalid JSON in request body" });
      }
    });
  } else {
    sendJson(res, 405, { error: "Method not allowed" });
  }
}

// ------------- /api/flows -------------

function handleApiFlows(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  fs.readdir(DATA_DIR, (err, files) => {
    if (err) {
      if (err.code === "ENOENT") {
        // No data folder yet
        return sendJson(res, 200, []);
      }
      console.error("Error reading data dir:", err);
      return sendJson(res, 500, { error: "Failed to read data directory" });
    }

    const flows = files
      .filter(name => name.toLowerCase().endsWith(".csv"))
      .map(name => path.basename(name, path.extname(name)));

    sendJson(res, 200, flows);
  });
}

// ------------- /api/columns?flow=... -------------

function parseCsvHeader(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim().replace(/^"(.*)"$/, "$1"));
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.length) {
    result.push(current.trim().replace(/^"(.*)"$/, "$1"));
  }

  return result;
}

function handleApiColumns(req, res, query) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const flow = query.flow;
  if (!flow) {
    return sendJson(res, 400, { error: "Missing flow query parameter" });
  }

  const csvPath = path.join(DATA_DIR, flow + ".csv");
  const safePath = path.normalize(csvPath);
  if (!safePath.startsWith(DATA_DIR)) {
    return sendJson(res, 400, { error: "Invalid flow name" });
  }

  fs.readFile(safePath, "utf8", (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        return sendJson(res, 404, { error: "CSV file not found for flow " + flow });
      }
      console.error("Error reading CSV for flow:", flow, err);
      return sendJson(res, 500, { error: "Failed to read CSV file" });
    }

    const lines = content
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (!lines.length) {
      return sendJson(res, 200, []);
    }

    const headers = parseCsvHeader(lines[0]);
    sendJson(res, 200, headers);
  });
}

// ------------- Static files -------------

function serveStatic(req, res, pathname) {
  let requestedPath = pathname || "/";
  if (requestedPath === "/") {
    requestedPath = "/tracker.html";
  }

  const safePath = path.normalize(path.join(ROOT_DIR, requestedPath));
  if (!safePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(safePath).pipe(res);
  });
}

// ------------- Main server -------------

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === "/api/tasks") {
    handleApiTasks(req, res);
  } else if (pathname === "/api/flows") {
    handleApiFlows(req, res);
  } else if (pathname === "/api/columns") {
    handleApiColumns(req, res, parsedUrl.query);
  } else {
    serveStatic(req, res, pathname);
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/tracker.html`);
});
