// A throwaway static server for testing web/ in a real browser.
//
//   node tools/serve.js [port]
//
// The app normally runs from the WebView2 virtual host or from disk. This
// exists only so Playwright can load it over http:// and get a real origin --
// IndexedDB needs one, and file:// gives an opaque origin with no storage.

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "web");
const port = Number(process.argv[2]) || 8791;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(root, rel === "/" ? "/index.html" : rel);
    // Never serve outside web/. The separator matters: a bare prefix test lets any
    // sibling whose name *begins* with "web" through, so `/../web-backup/notes.txt`
    // normalises to a path that startsWith("...\web") and was served. Requiring
    // the separator is what makes this a boundary rather than a substring.
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    });
  })
  .listen(port, "127.0.0.1", () => console.log("serving " + root + " on http://127.0.0.1:" + port));
