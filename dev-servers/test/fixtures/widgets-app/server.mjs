// Fake dev server for acme/widgets. Options: --port N, --build-ms N, --leftover, --stubborn, --ttl SECONDS.
// Write "crash", "rebuild" or "exit N" to widgets.control in the cwd to drive it like a file change would.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);

const port = Number(option("port", "8100"));
const buildMs = Number(option("build-ms", "150"));
const ttlSeconds = Number(option("ttl", "120"));
const control = path.resolve("widgets.control");
const log = (line) => console.log(`[widgets ${new Date().toISOString()}] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

setTimeout(() => process.exit(0), ttlSeconds * 1000).unref();
setInterval(() => {}, 60_000);
if (flag("stubborn")) process.on("SIGTERM", () => log("ignoring SIGTERM"));

let server = null;

async function build() {
  for (let step = 1; step <= 3; step += 1) {
    log(`building widgets ${step}/3`);
    await sleep(buildMs);
  }
  server = http.createServer((request, response) => {
    if (request.url === "/health") response.end("ok");
    else response.end(`widgets on ${port}`);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  log(`widgets ready on http://127.0.0.1:${port}`);
}

function crash() {
  log("server crashed: TypeError: widget is undefined");
  server?.close();
  server?.closeAllConnections();
  server = null;
  log("waiting for file changes");
}

function spawnLeftover() {
  const dir = path.resolve(".build/server");
  fs.mkdirSync(dir, { recursive: true });
  const code = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), ${ttlSeconds * 1000});`;
  const child = spawn(process.execPath, ["-e", code], { cwd: dir, detached: true, stdio: "ignore" });
  child.unref();
  log(`leftover helper pid ${child.pid}`);
}

setInterval(async () => {
  let command;
  try {
    command = fs.readFileSync(control, "utf8").trim();
    fs.rmSync(control);
  } catch {
    return;
  }
  if (command === "crash") crash();
  else if (command === "rebuild") {
    log("file change seen, rebuilding widgets");
    await build();
  } else if (command.startsWith("exit")) {
    log(`fatal: exiting with code ${command.split(" ")[1] ?? 1}`);
    process.exit(Number(command.split(" ")[1] ?? 1));
  }
}, 50);

if (flag("leftover")) spawnLeftover();
await build();
