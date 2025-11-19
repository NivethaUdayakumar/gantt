// serve.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const router = require("./router");

const PORT = 3000;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const serveStatic = (req, res, pathname) => {
  let p = pathname === "/" ? "/tracker.html" : pathname;
  const filePath = path.join(ROOT, p);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.stat(filePath, (e, st) => {
    if (e || !st.isFile()) {
      res.writeHead(404); return res.end("Not found");
    }
    const mime = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  });
};

http.createServer((req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname === "/api/tasks") return router.handleTasks(req, res);
  if (pathname === "/api/flows") return router.handleFlows(req, res);
  if (pathname === "/api/columns") return router.handleColumns(req, res, query);

  serveStatic(req, res, pathname);
})
.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/tracker.html`);
});
