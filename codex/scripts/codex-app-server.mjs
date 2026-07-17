#!/usr/bin/env node
/**
 * Dependency-free host and client for `codex app-server --listen stdio://`.
 *
 * A session host keeps one bidirectional App Server connection alive. Other
 * processes use an authenticated filesystem control plane to submit requests, read
 * state, steer active turns, and answer server-initiated requests. The files
 * are local IPC only. The host remains the sole owner of the JSON-RPC stream.
 */
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const CLIENT_INFO = {
  name: "boring-but-good-codex-skill",
  title: "Boring but Good Codex skill",
  version: "2.0.0",
};
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const TURN_INTERRUPT_GRACE_MS = 5_000;
const MAX_STDERR_TAIL = 4_000;
const SESSION_SCAN_MS = 25;
const SESSION_START_TIMEOUT_MS = 10_000;
const SESSION_HEARTBEAT_MS = 2_000;
const SESSION_STALE_MS = 10_000;
const SERVER_REQUEST_CLEARED = Symbol("server request cleared by app-server");
const COMMAND_VERSION = 1;
const COMMAND_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const COMMAND_MAC_PATTERN = /^[0-9a-f]{64}$/;

function usage() {
  process.stderr.write(`Usage:
  codex-app-server.mjs start --session-dir DIR [options]
  codex-app-server.mjs serve --session-dir DIR [options]
  codex-app-server.mjs turn (--prompt TEXT | --prompt-file FILE) [--thread ID | --new] [options]
  codex-app-server.mjs review --scope uncommitted|base|commit|custom --workdir DIR [options]
  codex-app-server.mjs steer --session-dir DIR (--prompt TEXT | --prompt-file FILE)
  codex-app-server.mjs interrupt --session-dir DIR
  codex-app-server.mjs respond --session-dir DIR --request ID --result-file FILE
  codex-app-server.mjs pending --session-dir DIR
  codex-app-server.mjs status --session-dir DIR
  codex-app-server.mjs shutdown --session-dir DIR
  codex-app-server.mjs request --session-dir DIR --method METHOD [--params-file FILE]

Shared options:
  --workdir DIR          Thread and turn working directory
  --thread-out FILE      Write the durable thread id here as soon as known
  --session-dir DIR      Authenticated control plane for one long-lived App Server host
  --control-dir DIR      Legacy one-turn control channel for isolated mode
  --events FILE          Append every app-server notification as JSONL
  --report FILE          Write final assistant or review text
  --model MODEL          Model override
  --effort EFFORT        Reasoning effort advertised by the selected model
  --sandbox MODE         read-only, workspace-write, or danger-full-access
  --network              Allow network for workspace-write turns
  --approval MODE        interactive, decline, accept, or accept-for-session
  --config KEY=VALUE     App-server -c override, repeatable
  --timeout SECONDS      Turn timeout, default 1800
  --no-params            Omit params for a no-params request command

Start a session host once, then direct every command to its --session-dir. The
host stays alive across completed turns. It archives notifications and exposes
server-initiated requests through pending/respond. Use shutdown to close it.

The request command exposes the complete current app-server request surface.
Its params file must contain one JSON object. It always completes initialize
first. The turn and review commands print a final JSON summary to stdout.
The turn command resumes an existing thread when --thread is supplied, otherwise --new
creates one. A turn is never replayed automatically after a timeout or a
closed transport because commands and file changes may already have run.
`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 1);
  }
  const options = { command, config: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--new" || arg === "--network" || arg === "--no-params" || arg === "--force" || arg === "--claimed") {
      options[arg.slice(2)] = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      fail(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    index += 1;
    if (key === "config") {
      options.config.push(value);
    } else {
      options[key] = value;
    }
  }
  return options;
}

async function readText(path, label) {
  if (!path) {
    fail(`${label} is required`);
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    fail(`Cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readPrompt(options) {
  if (typeof options.prompt === "string") return options.prompt;
  return await readText(options["prompt-file"], "--prompt or --prompt-file");
}

async function writeText(path, text) {
  if (!path) return;
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function appendJson(path, value) {
  if (!path) return;
  await mkdir(dirname(resolve(path)), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode });
  await rename(temporary, path);
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionPath(options) {
  const path = options["session-dir"];
  return path ? resolve(path) : null;
}

function sessionCredentialRoot() {
  if (process.env.CODEX_APP_SERVER_AUTH_ROOT) return resolve(process.env.CODEX_APP_SERVER_AUTH_ROOT);
  const stateRoot = process.env.XDG_STATE_HOME
    ? resolve(process.env.XDG_STATE_HOME)
    : resolve(homedir(), ".local", "state");
  return join(stateRoot, "boring-but-good", "codex-app-server-auth");
}

function sessionCredentialPath(path) {
  const name = createHash("sha256").update(resolve(path)).digest("hex");
  return join(sessionCredentialRoot(), `${name}.key`);
}

async function createSessionCredential(path) {
  const root = sessionCredentialRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const credentialPath = sessionCredentialPath(path);
  await unlink(credentialPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const key = randomBytes(32).toString("hex");
  await writeFile(credentialPath, `${key}\n`, { flag: "wx", mode: 0o600 });
  return { credentialPath, key };
}

async function readSessionCredential(path) {
  const credentialPath = sessionCredentialPath(path);
  const key = (await readFile(credentialPath, "utf8")).trim();
  if (!COMMAND_MAC_PATTERN.test(key)) fail("session command credential is invalid");
  return { credentialPath, key };
}

async function removeSessionCredential(path) {
  await unlink(sessionCredentialPath(path)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("session command contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  fail("session command contains a non-JSON value");
}

function sessionCommandBody(id, action, payload, submittedAt) {
  return JSON.parse(JSON.stringify({ version: COMMAND_VERSION, id, action, payload, submittedAt }));
}

function signSessionCommand(body, key) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(stableJson(body))
    .digest("hex");
}

function commandIsAuthenticated(command, key) {
  if (command?.version !== COMMAND_VERSION || command?.auth?.algorithm !== "hmac-sha256") return false;
  if (!COMMAND_MAC_PATTERN.test(command.auth.mac ?? "")) return false;
  let expected;
  try {
    expected = signSessionCommand(sessionCommandBody(
      command.id,
      command.action,
      command.payload,
      command.submittedAt,
    ), key);
  } catch {
    return false;
  }
  const actualBytes = Buffer.from(command.auth.mac, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function cleanConfig(config, network, effort) {
  const result = [...config];
  if (network && !result.some((entry) => entry.startsWith("sandbox_workspace_write.network_access="))) {
    result.push("sandbox_workspace_write.network_access=true");
  }
  if (effort && !result.some((entry) => entry.startsWith("model_reasoning_effort="))) {
    result.push(`model_reasoning_effort=${effort}`);
  }
  return result;
}

function buildChildArgs(options) {
  const args = ["app-server", "--listen", "stdio://"];
  for (const config of cleanConfig(options.config, options.network, options.effort)) {
    args.push("-c", config);
  }
  return args;
}

class AppServerClosedError extends Error {
  constructor(message) {
    super(message);
    this.name = "AppServerClosedError";
  }
}

class AppServerRpcError extends Error {
  constructor(method, error) {
    super(`${method} failed: ${error?.message || "unknown JSON-RPC error"}`);
    this.name = "AppServerRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

class CodexAppServerClient {
  constructor(options) {
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.notifications = [];
    this.closeHandlers = new Set();
    this.stderrTail = "";
    this.eventWrite = Promise.resolve();
    this.eventSequence = 0;
    this.closed = false;
    this.buffer = "";
    this.child = spawn("codex", buildChildArgs(options), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_TAIL);
    });
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.once("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      this.closeWithError(
        new AppServerClosedError(
          `codex app-server exited: code=${code ?? "null"} signal=${signal ?? "null"}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    this.child.stdin.on("error", (error) => this.closeWithError(error));
  }

  addNotificationHandler(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  addCloseHandler(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async initialize() {
    const response = await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return response;
  }

  getModelCapabilities() {
    this.modelCapabilitiesPromise ??= this.fetchModelCapabilities();
    return this.modelCapabilitiesPromise;
  }

  async fetchModelCapabilities() {
    const models = [];
    const seenCursors = new Set();
    let cursor;
    while (true) {
      const result = await this.request("model/list", {
        includeHidden: true,
        ...(cursor === undefined ? {} : { cursor }),
      }, 60_000);
      const page = normalizeModelCapabilitiesPage(result);
      models.push(...page.models);
      if (page.nextCursor === null) return models;
      if (seenCursors.has(page.nextCursor)) {
        fail(`model/list returned repeated cursor '${page.nextCursor}'`);
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  request(method, params = undefined, timeoutMs = 0) {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new AppServerClosedError("codex app-server client is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      let timer;
      const finish = (action, value) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        action(value);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish(rejectRequest, new Error(`${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        method,
        resolve: (result) => finish(resolveRequest, result),
        reject: (error) => finish(rejectRequest, error),
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method, params = undefined) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async close() {
    if (!this.closed) this.invalidate(new AppServerClosedError("codex app-server client is closed"));
    await this.eventWrite;
  }

  invalidate(error) {
    this.closeWithError(error);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  recordEvent(event) {
    const recorded = {
      ...event,
      _session: { sequence: ++this.eventSequence, receivedAt: new Date().toISOString() },
    };
    this.eventWrite = this.eventWrite.then(
      () => appendJson(this.options.events, recorded),
      () => appendJson(this.options.events, recorded),
    );
    return this.eventWrite;
  }

  write(message) {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.closeWithError(error);
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line));
      } catch (error) {
        void this.recordEvent({
          method: "client/parseError",
          params: { line: line.slice(0, 20_000), error: String(error) },
        });
        this.closeWithError(new AppServerClosedError(`invalid JSON from codex app-server: ${String(error)}`));
        this.child.kill("SIGTERM");
        return;
      }
    }
  }

  handle(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && !Object.prototype.hasOwnProperty.call(message, "method")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new AppServerRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.notifications.push(message);
      void this.recordEvent(message);
      for (const handler of this.notificationHandlers) {
        Promise.resolve(handler(message)).catch(() => undefined);
      }
    }
  }

  async handleServerRequest(message) {
    try {
      await this.recordEvent({
        method: "client/serverRequest",
        params: { requestId: String(message.id), method: message.method, params: message.params ?? {} },
      });
      const result = this.options.serverRequestHandler
        ? await this.options.serverRequestHandler(message, this)
        : this.defaultServerRequestResponse(message);
      if (result === SERVER_REQUEST_CLEARED) {
        await this.recordEvent({
          method: "client/serverRequestCleared",
          params: { requestId: String(message.id), method: message.method },
        });
        return;
      }
      this.write({ id: message.id, result });
      await this.recordEvent({
        method: "client/serverRequestResolved",
        params: { requestId: String(message.id), method: message.method },
      });
    } catch (error) {
      this.write({ id: message.id, error: { code: -32601, message: String(error) } });
    }
  }

  defaultServerRequestResponse(message) {
    const method = message.method;
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const configured = this.options.approval ?? "decline";
      const decision = configured === "accept-for-session" ? "acceptForSession" : configured;
      return { decision: decision === "accept" || decision === "acceptForSession" ? decision : "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      const configured = this.options.approval ?? "decline";
      const accepted = configured === "accept" || configured === "accept-for-session";
      return {
        permissions: accepted ? (message.params?.permissions ?? {}) : {},
        scope: configured === "accept-for-session" ? "session" : "turn",
      };
    }
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null, _meta: null };
    if (method === "item/tool/call") {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "This local Codex skill does not expose host dynamic tools." }],
      };
    }
    throw new Error(`Unsupported app-server request: ${method}`);
  }

  closeWithError(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error instanceof Error ? error : new AppServerClosedError(String(error));
    for (const request of this.pending.values()) request.reject(this.closeError);
    this.pending.clear();
    for (const handler of this.closeHandlers) handler(this.closeError);
  }
}

function normalizeModelCapabilitiesPage(result) {
  if (!Array.isArray(result?.data)) {
    fail("model/list returned no model data");
  }
  if (result.nextCursor !== undefined && result.nextCursor !== null
      && (typeof result.nextCursor !== "string" || result.nextCursor.length === 0)) {
    fail("model/list returned invalid nextCursor");
  }
  const models = result.data.map((model, index) => {
    if (typeof model?.id !== "string" || model.id.length === 0
        || typeof model.isDefault !== "boolean"
        || !Array.isArray(model.supportedReasoningEfforts)) {
      fail(`model/list returned invalid model at index ${index}`);
    }
    const supportedReasoningEfforts = model.supportedReasoningEfforts.map((entry, effortIndex) => {
      if (typeof entry?.reasoningEffort !== "string" || entry.reasoningEffort.length === 0) {
        fail(`model/list returned invalid reasoning effort at model index ${index}, effort index ${effortIndex}`);
      }
      return entry.reasoningEffort;
    });
    return {
      id: model.id,
      isDefault: model.isDefault,
      supportedReasoningEfforts: [...new Set(supportedReasoningEfforts)],
    };
  });
  return { models, nextCursor: result.nextCursor ?? null };
}

async function validateReasoningEffort(client, options) {
  if (!Object.prototype.hasOwnProperty.call(options, "effort")) return;
  const models = await client.getModelCapabilities();
  const hasExplicitModel = Object.prototype.hasOwnProperty.call(options, "model");
  const selected = hasExplicitModel
    ? models.find((model) => model.id === options.model)
    : models.find((model) => model.isDefault);
  if (!selected) {
    const available = models.map((model) => model.id).join(", ") || "none";
    if (hasExplicitModel) {
      fail(`Model '${options.model}' is not advertised by model/list. Available models: ${available}.`);
    }
    fail(`model/list did not advertise a default model. Available models: ${available}.`);
  }
  if (!selected.supportedReasoningEfforts.includes(options.effort)) {
    const advertised = selected.supportedReasoningEfforts.join(", ") || "none";
    fail(`Reasoning effort '${options.effort}' is not advertised for model '${selected.id}'. Advertised efforts: ${advertised}.`);
  }
  options.model = selected.id;
}

function sandboxPolicy(options) {
  if (options.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (options.sandbox === "read-only") return { type: "readOnly", networkAccess: Boolean(options.network) };
  const root = resolve(options.workdir ?? process.cwd());
  return {
    type: "workspaceWrite",
    writableRoots: [root],
    networkAccess: Boolean(options.network),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function buildThreadParams(options) {
  return {
    ...(options.workdir ? { cwd: resolve(options.workdir) } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.instructions ? { developerInstructions: options.instructions } : {}),
    ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
  };
}

function terminalText(turn, assistantTexts) {
  const reviewItems = Array.isArray(turn?.items)
    ? turn.items.filter((item) => item?.type === "exitedReviewMode" && typeof item.review === "string")
    : [];
  if (reviewItems.length > 0) return reviewItems.map((item) => item.review).join("\n\n").trim();
  const terminalItems = Array.isArray(turn?.items)
    ? turn.items.filter((item) => item?.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string")
    : [];
  const texts = terminalItems.map((item) => item.text);
  return (texts.length ? texts : assistantTexts).join("\n\n").trim();
}

async function createControlChannel(client, options, threadId, getTurnId) {
  if (!options["control-dir"]) return null;
  const path = resolve(options["control-dir"]);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await writeFile(`${path}/state.json`, `${JSON.stringify({ threadId, turnId: getTurnId() })}\n`, { mode: 0o600 });

  const processCommands = async () => {
    const names = await readdir(path).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    for (const name of names.filter((entry) => entry.startsWith("command-") && entry.endsWith(".json")).sort()) {
      const id = name.slice("command-".length, -".json".length);
      const commandPath = `${path}/${name}`;
      let response;
      try {
        const command = JSON.parse(await readFile(commandPath, "utf8"));
        const turnId = getTurnId();
        if (!turnId) fail("turn is not active yet");
        if (command.threadId && command.threadId !== threadId) fail("control command thread id does not match the active thread");
        if (command.turnId && command.turnId !== turnId) fail("control command turn id does not match the active turn");
        let result;
        if (command.action === "steer") {
          if (typeof command.prompt !== "string" || command.prompt.length === 0) fail("steer control command requires a prompt");
          result = await client.request("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: "text", text: command.prompt, text_elements: [] }],
          }, 30_000);
        } else if (command.action === "interrupt") {
          result = await client.request("turn/interrupt", { threadId, turnId }, 30_000);
        } else {
          fail(`unsupported control action: ${command.action}`);
        }
        response = { threadId, turnId, result };
      } catch (error) {
        response = { error: error instanceof Error ? error.message : String(error) };
      }
      await writeFile(`${path}/response-${id}.json`, `${JSON.stringify(response)}\n`, { mode: 0o600 });
      await unlink(commandPath).catch(() => undefined);
    }
  };
  let scanPromise = Promise.resolve();
  const timer = setInterval(() => {
    scanPromise = scanPromise.then(processCommands, processCommands);
  }, 25);
  return {
    path,
    async close() {
      clearInterval(timer);
      await scanPromise;
      const responseDeadline = Date.now() + 2_000;
      while (Date.now() < responseDeadline) {
        const names = await readdir(path).catch(() => []);
        if (!names.some((name) => name.startsWith("response-") && name.endsWith(".json"))) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function sendControlCommand(options, command) {
  if (!options["control-dir"]) fail(`${command.action} requires --control-dir DIR from the active turn`);
  const path = resolve(options["control-dir"]);
  const state = JSON.parse(await readText(`${path}/state.json`, "active control state"));
  const id = randomUUID();
  const commandPath = `${path}/command-${id}.json`;
  const responsePath = `${path}/response-${id}.json`;
  await writeFile(commandPath, `${JSON.stringify({ ...command, threadId: command.threadId ?? state.threadId, turnId: command.turnId ?? state.turnId })}\n`, { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      await unlink(responsePath).catch(() => undefined);
      if (response.error) throw new Error(response.error);
      return response;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  await unlink(commandPath).catch(() => undefined);
  throw new Error(`${command.action} control request timed out`);
}

async function establishThread(client, options) {
  let response;
  if (options.thread && options.loadedThreads?.has(options.thread)) {
    response = { thread: { id: options.thread } };
  } else if (options.thread) {
    response = await client.request("thread/resume", {
      threadId: options.thread,
      ...buildThreadParams(options),
    });
  } else {
    if (!options.new) fail("turn requires --thread ID or --new");
    response = await client.request("thread/start", buildThreadParams(options));
  }
  const threadId = response?.thread?.id;
  if (!threadId) fail("app-server returned no thread id");
  options.loadedThreads?.add(threadId);
  await writeText(options["thread-out"], `${threadId}\n`);
  return threadId;
}

async function waitForTurn(client, options, turnId, threadId) {
  const timeoutMs = Number(options.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number of seconds");
  const assistantTexts = [];
  const reviewTexts = [];
  const openSideEffects = new Set();
  let completedTurn;
  let clientClosed;
  let waitFinished = false;
  let interruptGrace;
  const timeoutError = new Error("codex app-server turn timed out after interrupt request. The turn was not replayed because it may have changed files or run commands.");
  const finish = new Promise((resolveFinish, rejectFinish) => {
    let removeNotifications = () => undefined;
    let removeClose = () => undefined;
    const processNotification = (notification) => {
      if (notification.params?.turnId !== turnId && notification.params?.turn?.id !== turnId) return;
      const item = notification.params?.item;
      if (notification.method === "item/started" && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item?.type)) {
        openSideEffects.add(item.id);
      }
      if (notification.method === "item/completed" && notification.params?.turnId === turnId) {
        openSideEffects.delete(item?.id);
        if (item?.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string") assistantTexts.push(item.text);
        if (item?.type === "exitedReviewMode" && typeof item.review === "string") reviewTexts.push(item.review);
      }
      if (notification.method === "turn/completed" && notification.params?.turn?.id === turnId) {
        completedTurn = notification.params.turn;
        removeNotifications();
        removeClose();
        resolveFinish();
      }
    };
    removeNotifications = client.addNotificationHandler(processNotification);
    removeClose = client.addCloseHandler((error) => {
      clientClosed = error;
      removeNotifications();
      removeClose();
      rejectFinish(error);
    });
    for (const notification of client.notifications) processNotification(notification);
    if (client.closed) {
      clientClosed = client.closeError ?? new AppServerClosedError("codex app-server client is closed");
      removeNotifications();
      removeClose();
      rejectFinish(clientClosed);
    }
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void client.request("turn/interrupt", { threadId, turnId }, 10_000).then(() => {
      if (waitFinished) return;
      interruptGrace = setTimeout(() => {
        if (!waitFinished) client.invalidate(timeoutError);
      }, TURN_INTERRUPT_GRACE_MS);
    }).catch(() => {
      if (!waitFinished) client.invalidate(timeoutError);
    });
  }, timeoutMs);
  try {
    await finish;
  } catch (error) {
    if (timedOut) throw timeoutError;
    const recoveredTexts = reviewTexts.length > 0 ? reviewTexts : assistantTexts;
    if (clientClosed && recoveredTexts.length > 0 && openSideEffects.size === 0) {
      return { status: "completed", text: recoveredTexts.join("\n\n"), recoveredAfterClose: true };
    }
    throw error;
  } finally {
    waitFinished = true;
    clearTimeout(timeout);
    clearTimeout(interruptGrace);
  }
  const text = reviewTexts.length > 0 ? reviewTexts.join("\n\n").trim() : terminalText(completedTurn, assistantTexts);
  if (timedOut) {
    throw timeoutError;
  }
  if (completedTurn?.status !== "completed") {
    const message = completedTurn?.error?.message ?? `turn finished with status ${completedTurn?.status ?? "unknown"}`;
    throw new Error(message);
  }
  return { status: "completed", text, recoveredAfterClose: false };
}

async function runTurnOnClient(client, options, useLegacyControl = false) {
  if (options.new && options.thread) fail("turn accepts either --new or --thread ID, not both");
  const prompt = await readPrompt(options);
  await validateReasoningEffort(client, options);
  let controlChannel;
  try {
    const threadId = await establishThread(client, options);
    let activeTurnId;
    const started = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(options.workdir ? { cwd: resolve(options.workdir) } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.sandbox ? { sandboxPolicy: sandboxPolicy(options) } : {}),
    }, 60_000);
    const turnId = started?.turn?.id;
    if (!turnId) fail("app-server returned no turn id");
    activeTurnId = turnId;
    options.onTurnStarted?.({ threadId, turnId });
    if (useLegacyControl) {
      controlChannel = await createControlChannel(client, options, threadId, () => activeTurnId);
    }
    await client.recordEvent({ method: "client/turnStarted", params: { threadId, turnId } });
    const result = await waitForTurn(client, options, turnId, threadId);
    await writeText(options.report, result.text ? `${result.text}\n` : "");
    return { threadId, turnId, model: options.model, effort: options.effort, ...result };
  } finally {
    options.onTurnFinished?.();
    await controlChannel?.close();
  }
}

async function runTurn(options) {
  if (sessionPath(options)) {
    return await sendSessionCommand(options, "turn", { options }, sessionCommandTimeout(options));
  }
  const client = new CodexAppServerClient(options);
  try {
    const initialized = await client.initialize();
    await client.recordEvent({ method: "client/initialized", params: initialized });
    return await runTurnOnClient(client, options, true);
  } finally {
    await client.close();
  }
}

function reviewTarget(options) {
  switch (options.scope) {
    case "uncommitted": return { type: "uncommittedChanges" };
    case "base":
      if (!options["scope-value"]) fail("review scope base requires --scope-value BRANCH");
      return { type: "baseBranch", branch: options["scope-value"] };
    case "commit":
      if (!options["scope-value"]) fail("review scope commit requires --scope-value SHA");
      return { type: "commit", sha: options["scope-value"], title: options.title ?? null };
    case "custom":
      if (!options.reviewInstructions) fail("review scope custom requires --prompt or --prompt-file");
      return { type: "custom", instructions: options.reviewInstructions };
    default: fail("review requires --scope uncommitted, base, commit, or custom");
  }
}

async function runReviewOnClient(client, options, useLegacyControl = false) {
  if (!options.workdir) fail("review requires --workdir");
  let reviewInstructions;
  if (options["prompt-file"]) reviewInstructions = await readText(options["prompt-file"], "--prompt-file");
  else if (typeof options.prompt === "string") reviewInstructions = options.prompt;
  if (options.scope === "custom") options.reviewInstructions = reviewInstructions;
  else options.instructions = reviewInstructions;
  options.new = true;
  options.sandbox ??= "read-only";
  await validateReasoningEffort(client, options);
  let controlChannel;
  try {
    const threadId = await establishThread(client, options);
    let activeTurnId;
    const started = await client.request("review/start", {
      threadId,
      target: reviewTarget(options),
      delivery: "inline",
    }, 60_000);
    const turnId = started?.turn?.id;
    if (!turnId) fail("app-server returned no review turn id");
    activeTurnId = turnId;
    options.onTurnStarted?.({ threadId, turnId });
    if (useLegacyControl) {
      controlChannel = await createControlChannel(client, options, threadId, () => activeTurnId);
    }
    const result = await waitForTurn(client, options, turnId, threadId);
    await writeText(options.report, result.text ? `${result.text}\n` : "");
    return { threadId, turnId, model: options.model, effort: options.effort, ...result };
  } finally {
    options.onTurnFinished?.();
    await controlChannel?.close();
  }
}

async function runReview(options) {
  if (sessionPath(options)) {
    return await sendSessionCommand(options, "review", { options }, sessionCommandTimeout(options));
  }
  const client = new CodexAppServerClient(options);
  try {
    const initialized = await client.initialize();
    await client.recordEvent({ method: "client/initialized", params: initialized });
    return await runReviewOnClient(client, options, true);
  } finally {
    await client.close();
  }
}

async function runInterrupt(options) {
  if (sessionPath(options)) {
    return await sendSessionCommand(options, "interrupt", {
      threadId: options.thread,
      turnId: options.turn,
    });
  }
  return await sendControlCommand(options, {
    action: "interrupt",
    ...(options.thread ? { threadId: options.thread } : {}),
    ...(options.turn ? { turnId: options.turn } : {}),
  });
}

async function runSteer(options) {
  const prompt = await readPrompt(options);
  if (sessionPath(options)) {
    return await sendSessionCommand(options, "steer", {
      prompt,
      threadId: options.thread,
      turnId: options.turn,
    });
  }
  return await sendControlCommand(options, {
    action: "steer",
    prompt,
    ...(options.thread ? { threadId: options.thread } : {}),
    ...(options.turn ? { turnId: options.turn } : {}),
  });
}

async function runRequest(options) {
  if (!options.method) fail("request requires --method");
  const params = options["no-params"]
    ? undefined
    : options["params-file"]
      ? JSON.parse(await readText(options["params-file"], "--params-file"))
      : {};
  if (params !== undefined && (params === null || Array.isArray(params) || typeof params !== "object")) {
    fail("--params-file must contain one JSON object");
  }
  if (sessionPath(options)) {
    return await sendSessionCommand(options, "request", { method: options.method, params });
  }
  const client = new CodexAppServerClient(options);
  try {
    const initialized = await client.initialize();
    const result = await client.request(options.method, params, 60_000);
    return { initialized, result };
  } finally {
    await client.close();
  }
}

function sessionCommandTimeout(options) {
  const turnSeconds = Number(options.timeout ?? DEFAULT_TIMEOUT_MS / 1000);
  return Number.isFinite(turnSeconds) && turnSeconds > 0
    ? turnSeconds * 1000 + 70_000
    : DEFAULT_TIMEOUT_MS + 70_000;
}

async function sendSessionCommand(options, action, payload = {}, timeoutMs = 60_000) {
  const path = sessionPath(options);
  if (!path) fail(`${action} requires --session-dir DIR`);
  const state = await readJson(`${path}/state.json`, "session state");
  if (state.status !== "ready") fail(`session is not ready: ${state.status ?? "unknown"}`);
  if (!processIsAlive(state.pid)) fail(`session host process ${state.pid ?? "unknown"} is not alive`);
  const heartbeatTime = Date.parse(state.heartbeatAt ?? "");
  if (!Number.isFinite(heartbeatTime) || Date.now() - heartbeatTime > SESSION_STALE_MS) {
    fail("session host heartbeat is stale");
  }
  const { key } = await readSessionCredential(path).catch(() => {
    fail("session command credential is unavailable");
  });
  const id = randomUUID();
  const commandPath = `${path}/inbox/${id}.json`;
  const responsePath = `${path}/outbox/${id}.json`;
  const body = sessionCommandBody(id, action, payload, new Date().toISOString());
  await writeJsonAtomic(commandPath, {
    ...body,
    auth: { algorithm: "hmac-sha256", mac: signSessionCommand(body, key) },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8"));
      await unlink(responsePath).catch(() => undefined);
      if (response.error) throw new Error(response.error.message ?? String(response.error));
      return response.result;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const current = await readFile(`${path}/state.json`, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (current?.status === "closed") {
      throw new Error(current.error ?? "session host closed before the request completed");
    }
    if (current?.pid && !processIsAlive(current.pid)) {
      throw new Error(`session host process ${current.pid} exited before the request completed`);
    }
    await delay(SESSION_SCAN_MS);
  }
  await unlink(commandPath).catch(() => undefined);
  throw new Error(`${action} session request timed out. The request was not replayed.`);
}

function managerArgsFromOptions(options) {
  const args = [resolve(process.argv[1]), "serve", "--session-dir", sessionPath(options), "--claimed"];
  for (const key of ["events", "approval", "model", "effort", "sandbox", "timeout"]) {
    if (options[key] !== undefined) args.push(`--${key}`, String(options[key]));
  }
  if (options.network) args.push("--network");
  for (const config of options.config ?? []) args.push("--config", config);
  return args;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function runStart(options) {
  const path = sessionPath(options);
  if (!path) fail("start requires --session-dir DIR");
  const existing = await readFile(`${path}/state.json`, "utf8").then(JSON.parse).catch(() => null);
  if (existing) {
    if (existing.status !== "closed" && processIsAlive(existing.pid)) {
      fail(`session already has a live host process ${existing.pid}`);
    }
    fail("session directory already contains host state. Use a new directory so stale commands cannot be replayed");
  }
  await mkdir(`${path}/inbox`, { recursive: true, mode: 0o700 });
  await mkdir(`${path}/outbox`, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  try {
    await mkdir(`${path}/host.lock`);
  } catch (error) {
    if (error?.code === "EEXIST") fail("session directory is already claimed by another host start");
    throw error;
  }
  let child;
  try {
    await createSessionCredential(path);
    child = spawn(process.execPath, managerArgsFromOptions(options), {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await readFile(`${path}/state.json`, "utf8").then(JSON.parse).catch(() => null);
      if (state?.status === "ready") return state;
      if (state?.status === "closed") fail(state.error ?? "session host failed during startup");
      if (child.exitCode !== null) fail(`session host exited during startup with code ${child.exitCode}`);
      await delay(SESSION_SCAN_MS);
    }
    throw new Error("session host did not become ready within 10 seconds");
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await removeSessionCredential(path);
    throw error;
  }
}

async function runSessionStatus(options) {
  const path = sessionPath(options);
  if (!path) fail("status requires --session-dir DIR");
  const state = await readJson(`${path}/state.json`, "session state");
  const heartbeatTime = Date.parse(state.heartbeatAt ?? "");
  const heartbeatAgeMs = Number.isFinite(heartbeatTime) ? Math.max(0, Date.now() - heartbeatTime) : null;
  return {
    ...state,
    processAlive: processIsAlive(state.pid),
    responsive: heartbeatAgeMs !== null && heartbeatAgeMs <= SESSION_STALE_MS,
    heartbeatAgeMs,
  };
}

async function runPending(options) {
  return await sendSessionCommand(options, "pending");
}

async function runRespond(options) {
  if (!options.request) fail("respond requires --request ID");
  const result = options["result-file"]
    ? JSON.parse(await readText(options["result-file"], "--result-file"))
    : options.decision
      ? { decision: options.decision }
      : undefined;
  if (result === undefined || result === null || Array.isArray(result) || typeof result !== "object") {
    fail("respond requires --result-file with one JSON object, or --decision VALUE");
  }
  return await sendSessionCommand(options, "respond", { requestId: options.request, result });
}

async function runShutdown(options) {
  return await sendSessionCommand(options, "shutdown", { force: Boolean(options.force) });
}

async function runServe(options) {
  const path = sessionPath(options);
  if (!path) fail("serve requires --session-dir DIR");
  const existingState = await readFile(`${path}/state.json`, "utf8").then(JSON.parse).catch(() => null);
  if (existingState) fail("session directory already contains host state. Use a new directory");
  if (options.claimed) {
    const entries = await readdir(path).catch(() => []);
    if (!entries.includes("host.lock")) fail("session start claim is missing");
  } else {
    await mkdir(path, { recursive: true, mode: 0o700 });
    try {
      await mkdir(`${path}/host.lock`);
    } catch (error) {
      if (error?.code === "EEXIST") fail("session directory is already claimed by another host");
      throw error;
    }
  }
  const credential = options.claimed
    ? await readSessionCredential(path)
    : await createSessionCredential(path);
  const cleanupCredentialOnExit = () => {
    try {
      unlinkSync(credential.credentialPath);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
    }
  };
  process.once("exit", cleanupCredentialOnExit);
  await mkdir(`${path}/inbox`, { recursive: true, mode: 0o700 });
  await mkdir(`${path}/outbox`, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  options.events ??= `${path}/events.jsonl`;
  options.approval ??= "interactive";

  const state = {
    version: 1,
    pid: process.pid,
    status: "starting",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    events: resolve(options.events),
    leaseCount: 0,
    threads: [],
    activeTurns: [],
    pendingRequests: [],
  };
  let stateWrite = Promise.resolve();
  const persistState = () => {
    state.updatedAt = new Date().toISOString();
    const snapshot = JSON.parse(JSON.stringify(state));
    stateWrite = stateWrite.then(
      () => writeJsonAtomic(`${path}/state.json`, snapshot),
      () => writeJsonAtomic(`${path}/state.json`, snapshot),
    );
    return stateWrite;
  };
  await persistState();

  const pendingServerRequests = new Map();
  const clearedServerRequests = new Set();
  const activeTurns = new Map();
  const threads = new Set();
  const clearActiveTurnsForThread = (threadId) => {
    let changed = false;
    for (const [activeTurnId, activeTurn] of activeTurns) {
      if (activeTurn.threadId === threadId) {
        activeTurns.delete(activeTurnId);
        changed = true;
      }
    }
    return changed;
  };
  const refreshState = () => {
    state.threads = [...threads];
    state.activeTurns = [...activeTurns.values()];
    state.pendingRequests = [...pendingServerRequests.values()].map((entry) => ({
      requestId: entry.requestId,
      method: entry.message.method,
      params: entry.message.params ?? {},
      receivedAt: entry.receivedAt,
      autoResolveAt: entry.autoResolveAt ?? null,
    }));
    void persistState();
  };

  let client;
  let closingNormally = false;
  const brokerServerRequest = async (message, activeClient) => {
    if (options.approval !== "interactive") return activeClient.defaultServerRequestResponse(message);
    const requestId = String(message.id);
    return await new Promise((resolveRequest, rejectRequest) => {
      const autoResolutionMs = message.method === "item/tool/requestUserInput"
        && Number.isInteger(message.params?.autoResolutionMs)
        && message.params.autoResolutionMs > 0
        ? message.params.autoResolutionMs
        : null;
      const entry = {
        requestId,
        message,
        receivedAt: new Date().toISOString(),
        resolve: resolveRequest,
        reject: rejectRequest,
        autoResolveAt: autoResolutionMs ? new Date(Date.now() + autoResolutionMs).toISOString() : null,
        timer: null,
      };
      if (autoResolutionMs) {
        entry.timer = setTimeout(() => resolveRequest({ answers: {} }), autoResolutionMs);
        entry.timer.unref?.();
      }
      pendingServerRequests.set(requestId, entry);
      if (clearedServerRequests.delete(requestId)) {
        resolveRequest(SERVER_REQUEST_CLEARED);
      }
      refreshState();
    }).finally(() => {
      const entry = pendingServerRequests.get(requestId);
      if (entry?.timer) clearTimeout(entry.timer);
      pendingServerRequests.delete(requestId);
      refreshState();
    });
  };

  let shutdownRequested = false;
  let acceptingCommands = true;
  let signalReceived = null;
  const requestSignalShutdown = (signal) => {
    signalReceived = signal;
    acceptingCommands = false;
    state.status = "closing";
    void persistState();
    shutdownRequested = true;
  };
  process.once("SIGTERM", () => requestSignalShutdown("SIGTERM"));
  process.once("SIGINT", () => requestSignalShutdown("SIGINT"));

  const executeCommand = async (command) => {
    const payload = command.payload ?? {};
    switch (command.action) {
      case "turn":
      case "review": {
        let activeId;
        const commandOptions = {
          ...payload.options,
          command: command.action,
          loadedThreads: threads,
          onTurnStarted(active) {
            activeId = active.turnId;
            threads.add(active.threadId);
            activeTurns.set(active.turnId, { ...active, startedAt: new Date().toISOString() });
            refreshState();
          },
          onTurnFinished() {
            if (activeId) activeTurns.delete(activeId);
            refreshState();
          },
        };
        return command.action === "turn"
          ? await runTurnOnClient(client, commandOptions)
          : await runReviewOnClient(client, commandOptions);
      }
      case "steer": {
        const matches = [...activeTurns.values()].filter((turn) =>
          (!payload.threadId || turn.threadId === payload.threadId)
          && (!payload.turnId || turn.turnId === payload.turnId));
        if (matches.length !== 1) fail(`steer requires exactly one matching active turn, found ${matches.length}`);
        const active = matches[0];
        return await client.request("turn/steer", {
          threadId: active.threadId,
          expectedTurnId: active.turnId,
          input: [{ type: "text", text: payload.prompt, text_elements: [] }],
        }, 30_000);
      }
      case "interrupt": {
        const matches = [...activeTurns.values()].filter((turn) =>
          (!payload.threadId || turn.threadId === payload.threadId)
          && (!payload.turnId || turn.turnId === payload.turnId));
        if (matches.length !== 1) fail(`interrupt requires exactly one matching active turn, found ${matches.length}`);
        const active = matches[0];
        return await client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 30_000);
      }
      case "request":
        return await client.request(payload.method, payload.params, 60_000);
      case "pending":
        return [...pendingServerRequests.values()].map((entry) => ({
          requestId: entry.requestId,
          method: entry.message.method,
          params: entry.message.params ?? {},
          receivedAt: entry.receivedAt,
          autoResolveAt: entry.autoResolveAt ?? null,
        }));
      case "respond": {
        const pending = pendingServerRequests.get(String(payload.requestId));
        if (!pending) fail(`no pending server request ${payload.requestId}`);
        pending.resolve(payload.result);
        return { requestId: String(payload.requestId), accepted: true };
      }
      case "shutdown":
        if (!payload.force && (activeTurns.size > 0 || pendingServerRequests.size > 0 || state.leaseCount > 1)) {
          fail("session has an active turn, pending server request, or another command lease. Interrupt, respond, or wait before shutdown, or use --force");
        }
        acceptingCommands = false;
        shutdownRequested = true;
        state.status = "closing";
        void persistState();
        if (payload.force) {
          for (const active of activeTurns.values()) {
            await client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 10_000).catch(() => undefined);
          }
          for (const pending of pendingServerRequests.values()) {
            pending.resolve(client.defaultServerRequestResponse(pending.message));
          }
          closingNormally = true;
          await client.close();
        }
        return { shuttingDown: true };
      default:
        fail(`unsupported session action: ${command.action}`);
    }
  };

  const tasks = new Set();
  const consumedCommandIds = new Set();
  const activeCommandIds = new Set();
  const writeCommandResponse = (id, value) => writeJsonAtomic(join(path, "outbox", `${id}.json`), value);
  const scanCommands = async () => {
    const inboxPath = join(path, "inbox");
    const names = await readdir(inboxPath).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    for (const name of names.sort()) {
      const commandPath = join(inboxPath, name);
      if (!name.endsWith(".json")) continue;
      const filenameMatch = COMMAND_FILE_PATTERN.exec(name);
      if (!filenameMatch) {
        await rm(commandPath, { force: true, recursive: true });
        continue;
      }
      const fileId = filenameMatch[1];
      let command;
      try {
        const serialized = await readFile(commandPath, "utf8");
        await unlink(commandPath);
        try {
          command = JSON.parse(serialized);
        } catch {
          await writeCommandResponse(fileId, {
            id: fileId,
            error: { message: "session command contains invalid JSON" },
          });
          continue;
        }
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (command?.id !== fileId) {
        await writeCommandResponse(fileId, {
          id: fileId,
          error: { message: "session command id does not match its canonical filename" },
        });
        continue;
      }
      if (!commandIsAuthenticated(command, credential.key)) {
        await writeCommandResponse(fileId, {
          id: fileId,
          error: { message: "session command authentication failed" },
        });
        continue;
      }
      if (consumedCommandIds.has(fileId)) {
        if (!activeCommandIds.has(fileId)) {
          await writeCommandResponse(fileId, {
            id: fileId,
            error: { message: "session command replay rejected" },
          });
        }
        continue;
      }
      consumedCommandIds.add(fileId);
      if (!acceptingCommands) {
        await writeCommandResponse(fileId, {
          id: fileId,
          error: { message: "session is closing and no longer accepts commands" },
        });
        continue;
      }
      state.leaseCount += 1;
      void persistState();
      activeCommandIds.add(fileId);
      let task;
      task = executeCommand(command)
        .then((result) => writeCommandResponse(fileId, { id: fileId, result }))
        .catch((error) => writeCommandResponse(fileId, {
          id: fileId,
          error: { message: error instanceof Error ? error.message : String(error) },
        }))
        .finally(() => {
          tasks.delete(task);
          activeCommandIds.delete(fileId);
          state.leaseCount -= 1;
          void persistState();
        });
      tasks.add(task);
    }
  };

  try {
    client = new CodexAppServerClient({ ...options, serverRequestHandler: brokerServerRequest });
    const initialized = await client.initialize();
    await client.recordEvent({ method: "client/initialized", params: initialized });
    client.addNotificationHandler((notification) => {
      const threadId = notification.params?.threadId ?? notification.params?.thread?.id;
      const turnId = notification.params?.turnId ?? notification.params?.turn?.id;
      let changed = false;
      if (notification.method === "serverRequest/resolved" && notification.params?.requestId !== undefined) {
        const pending = pendingServerRequests.get(String(notification.params.requestId));
        if (pending) {
          pending.resolve(SERVER_REQUEST_CLEARED);
          changed = true;
        } else {
          const requestId = String(notification.params.requestId);
          clearedServerRequests.add(requestId);
          const cleanup = setTimeout(() => clearedServerRequests.delete(requestId), 1_000);
          cleanup.unref?.();
        }
      }
      if (threadId && !threads.has(threadId)) {
        threads.add(threadId);
        changed = true;
      }
      if (notification.method === "turn/started" && threadId && turnId) {
        activeTurns.set(turnId, { threadId, turnId, startedAt: new Date().toISOString() });
        changed = true;
      }
      if (notification.method === "turn/completed" && turnId) {
        changed = activeTurns.delete(turnId) || changed;
        if (threadId) changed = clearActiveTurnsForThread(threadId) || changed;
      }
      if (notification.method === "thread/status/changed" && notification.params?.status?.type === "idle" && threadId) {
        changed = clearActiveTurnsForThread(threadId) || changed;
      }
      if (changed) refreshState();
    });
    client.addCloseHandler((error) => {
      if (!closingNormally) state.error = error.message;
      shutdownRequested = true;
      for (const pending of pendingServerRequests.values()) pending.reject(error);
    });
    state.status = "ready";
    state.server = initialized;
    await persistState();

    let nextHeartbeatAt = Date.now() + SESSION_HEARTBEAT_MS;
    while (!shutdownRequested) {
      await scanCommands();
      if (Date.now() >= nextHeartbeatAt) {
        state.heartbeatAt = new Date().toISOString();
        await persistState();
        nextHeartbeatAt = Date.now() + SESSION_HEARTBEAT_MS;
      }
      await delay(SESSION_SCAN_MS);
    }
    if (signalReceived) {
      for (const active of activeTurns.values()) {
        await client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 10_000).catch(() => undefined);
      }
      for (const pending of pendingServerRequests.values()) {
        try {
          pending.resolve(client.defaultServerRequestResponse(pending.message));
        } catch {
          pending.reject(new AppServerClosedError(`session host received ${signalReceived}`));
        }
      }
      closingNormally = true;
      await client.close().catch(() => undefined);
    } else {
      await scanCommands();
    }
    await Promise.allSettled([...tasks]);
    state.status = "closing";
    if (signalReceived) state.signal = signalReceived;
    await persistState();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const pending of pendingServerRequests.values()) {
      try {
        pending.resolve(client?.defaultServerRequestResponse(pending.message));
      } catch {
        pending.reject(new AppServerClosedError("session host closed"));
      }
    }
    closingNormally = true;
    await client?.close().catch(() => undefined);
    state.status = "closed";
    state.closedAt = new Date().toISOString();
    state.activeTurns = [];
    state.pendingRequests = [];
    state.leaseCount = 0;
    await persistState();
    await stateWrite;
    await removeSessionCredential(path);
    process.removeListener("exit", cleanupCredentialOnExit);
  }
  return state;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.prompt !== undefined && options["prompt-file"] !== undefined) {
    fail("use either --prompt or --prompt-file, not both");
  }
  if (options["no-params"] && options["params-file"]) {
    fail("use either --no-params or --params-file, not both");
  }
  if (options.sandbox && !["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)) {
    fail("--sandbox must be read-only, workspace-write, or danger-full-access");
  }
  if (options.approval && !["interactive", "decline", "accept", "accept-for-session"].includes(options.approval)) {
    fail("--approval must be interactive, decline, accept, or accept-for-session");
  }
  let result;
  switch (options.command) {
    case "start": result = await runStart(options); break;
    case "serve": result = await runServe(options); break;
    case "turn": result = await runTurn(options); break;
    case "review": result = await runReview(options); break;
    case "steer": result = await runSteer(options); break;
    case "interrupt": result = await runInterrupt(options); break;
    case "respond": result = await runRespond(options); break;
    case "pending": result = await runPending(options); break;
    case "status": result = await runSessionStatus(options); break;
    case "shutdown": result = await runShutdown(options); break;
    case "request": result = await runRequest(options); break;
    default: fail(`Unknown command: ${options.command}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex app-server: ${message}\n`);
  process.exitCode = 1;
});
