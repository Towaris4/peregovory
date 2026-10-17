"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = __dirname;
const TOOLS = path.join(ROOT, "tools");
const EXE = path.join(TOOLS, "cloudflared.exe");
const URL_FILE = path.join(ROOT, "data", "public-url.txt");
const DL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

function download() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TOOLS, { recursive: true });
    if (fs.existsSync(EXE) && fs.statSync(EXE).size > 5_000_000) return resolve();
    console.log("Завантаження cloudflared…");
    const tmp = EXE + ".part";
    const file = fs.createWriteStream(tmp);
    const go = (url, hops) => {
      if (hops > 8) return reject(new Error("too many redirects"));
      https
        .get(url, { headers: { "User-Agent": "peregovory" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(res.headers.location, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("download HTTP " + res.statusCode));
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => {
            fs.renameSync(tmp, EXE);
            resolve();
          }));
        })
        .on("error", reject);
    };
    go(DL, 0);
  });
}

function which(cmd) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const p = path.join(dir, cmd + ext);
    if (fs.existsSync(p)) return p;
    const p2 = path.join(dir, cmd);
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}

function runNgrok() {
  const exe = which("ngrok");
  if (!exe) return false;
  console.log("Публічний тунель: ngrok");
  const child = spawn(exe, ["http", "8765", "--log", "stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const onData = (buf) => {
    const s = buf.toString();
    process.stdout.write(s);
    const m = s.match(/url=https:\/\/[a-z0-9.-]+\.ngrok[^\s]*/i);
    if (m) {
      const u = m[0].replace(/^url=/, "");
      fs.writeFileSync(URL_FILE, u, "utf8");
      console.log("\nПублічне посилання: " + u + "\n");
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    console.log("ngrok exit", code);
    process.exit(code || 0);
  });
  return true;
}

function run() {
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  if (runNgrok()) return;
  const child = spawn(EXE, ["tunnel", "--url", "http://127.0.0.1:8765", "--no-autoupdate", "--protocol", "http2"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const seen = new Set();
  const onData = (buf) => {
    const s = buf.toString();
    process.stdout.write(s);
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi) || [];
    for (const u of m) {
      if (seen.has(u)) continue;
      seen.add(u);
      fs.writeFileSync(URL_FILE, u, "utf8");
      console.log("\nПублічне посилання: " + u + "\n");
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    console.log("tunnel exit", code);
    process.exit(code || 0);
  });
}

download().then(run).catch((err) => {
  console.error(err);
  process.exit(1);
});
