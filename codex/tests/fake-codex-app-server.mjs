#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import readline from "node:readline";

const THREAD_ID = "00000000-0000-0000-0000-000000000001";
const TURN_ID = "00000000-0000-0000-0000-000000000002";
const PROVISIONAL_REVIEW_TURN_ID = "00000000-0000-0000-0000-000000000003";
const OTHER_THREAD_ID = "00000000-0000-0000-0000-000000000004";
const OTHER_TURN_ID = "00000000-0000-0000-0000-000000000005";
const MODELS = [
  {
    id: "fake-default-model",
    model: "fake-default-model",
    displayName: "Fake Default Model",
    description: "Default fake model with the complete advertised effort range.",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
      .map((reasoningEffort) => ({ reasoningEffort, description: `Fake ${reasoningEffort} effort` })),
  },
  {
    id: "fake-explicit-model",
    model: "fake-explicit-model",
    displayName: "Fake Explicit Model",
    description: "Non-default fake model with a smaller capability set.",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["high", "ultra"]
      .map((reasoningEffort) => ({ reasoningEffort, description: `Fake ${reasoningEffort} effort` })),
  },
];
const REQUESTED_PERMISSIONS = {
  fileSystem: {
    entries: [
      { access: "write", path: { type: "path", path: "/tmp/fake-app-server-output" } },
    ],
    globScanMaxDepth: 3,
  },
  network: { enabled: true },
};
const scenario = process.env.FAKE_APP_SERVER_SCENARIO ?? "complete";
const logFile = process.env.FAKE_APP_SERVER_LOG;
const pidFile = process.env.FAKE_CODEX_PID_FILE;
const pendingApprovalIds = new Set([901, 902, 903, 904, 905, 906]);

if (pidFile) appendFileSync(pidFile, `${process.pid}\n`, "utf8");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(message) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(message)}\n`, "utf8");
}

if (process.argv.includes("-c")) {
  record({ method: "fake/appServerArgs", params: { args: process.argv.slice(2) } });
}

function completed(text = "APP_SERVER_FAKE_OK") {
  send({
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: Date.now(),
      item: { type: "agentMessage", id: "message-1", text, phase: null, memoryCitation: null },
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", items: [], error: null },
    },
  });
}

function closeAfter(messages) {
  process.stdout.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, () => process.exit(0));
}

function sendApprovalRequests() {
  send({ id: 901, method: "item/commandExecution/requestApproval", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "command-1" } });
  send({ id: 902, method: "item/fileChange/requestApproval", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "file-1" } });
  send({
    id: 903,
    method: "item/permissions/requestApproval",
    params: {
      cwd: "/tmp",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "permissions-1",
      permissions: REQUESTED_PERMISSIONS,
      reason: "Fake permission request",
      startedAtMs: Date.now(),
    },
  });
  send({ id: 904, method: "item/tool/requestUserInput", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "input-1", questions: [] } });
  send({ id: 905, method: "mcpServer/elicitation/request", params: { threadId: THREAD_ID, turnId: TURN_ID, serverName: "fake", request: { mode: "form", message: "fake", requestedSchema: {} } } });
  send({ id: 906, method: "item/tool/call", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "tool-1", tool: "fake", arguments: {} } });
}

function handle(message) {
  record(message);

  if (pendingApprovalIds.has(message.id) && !message.method) {
    if (scenario === "auto-resolve" && message.id === 904) {
      completed("AUTO_RESOLVED_INPUT");
      return;
    }
    pendingApprovalIds.delete(message.id);
    if (pendingApprovalIds.size === 0) completed("APPROVALS_HANDLED");
    return;
  }

  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { serverInfo: { version: "0.144.1" } } });
      return;
    case "initialized":
      return;
    case "thread/start":
      send({
        id: message.id,
        result: {
          thread: { id: THREAD_ID },
          model: message.params?.model ?? "fake-default-model",
          reasoningEffort: message.params?.config?.model_reasoning_effort ?? null,
        },
      });
      return;
    case "thread/resume":
      send({ id: message.id, result: { thread: { id: THREAD_ID } } });
      return;
    case "turn/start": {
      const response = { id: message.id, result: { turn: { id: TURN_ID, status: "inProgress", items: [], error: null } } };
      if (scenario === "rpc-error") {
        send({ id: message.id, error: { code: -32602, message: "bad turn params" } });
      } else if (scenario === "notification-race") {
        completed("EARLY_NOTIFICATION_OK");
        send(response);
      } else {
        send(response);
        if (scenario === "complete" || scenario === "review-turn-id-mismatch" || scenario.startsWith("model-")) completed();
        if (scenario === "approvals") sendApprovalRequests();
        if (scenario === "auto-resolve") {
          send({ id: 904, method: "item/tool/requestUserInput", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "input-1", questions: [], autoResolutionMs: 25 } });
        }
        if (scenario === "request-cleared") {
          send({ id: 904, method: "item/tool/requestUserInput", params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "input-1", questions: [], autoResolutionMs: null } });
          send({ method: "serverRequest/resolved", params: { threadId: THREAD_ID, requestId: 904 } });
          completed("REQUEST_CLEARED");
        }
        if (scenario === "close-recovered") {
          closeAfter([{ method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: Date.now(), item: { type: "agentMessage", id: "message-1", text: "RECOVERED_AFTER_CLOSE", phase: null, memoryCitation: null } } }]);
        }
        if (scenario === "close-commentary") {
          closeAfter([{ method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: Date.now(), item: { type: "agentMessage", id: "message-1", text: "COMMENTARY_IS_NOT_FINAL", phase: "commentary", memoryCitation: null } } }]);
        }
        if (scenario === "close-unresolved") {
          closeAfter([
            { method: "item/started", params: { threadId: THREAD_ID, turnId: TURN_ID, item: { type: "commandExecution", id: "command-1" } } },
            { method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: Date.now(), item: { type: "agentMessage", id: "message-1", text: "MUST_NOT_RECOVER", phase: null, memoryCitation: null } } },
          ]);
        }
        if (scenario === "malformed-json") {
          process.stdout.write("this is not json\n");
        }
      }
      return;
    }
    case "review/start":
      if (scenario === "review-turn-id-mismatch" || scenario === "review-turn-id-mismatch-with-other") {
        send({
          method: "turn/started",
          params: {
            threadId: THREAD_ID,
            turn: { id: PROVISIONAL_REVIEW_TURN_ID, status: "inProgress", items: [], error: null },
          },
        });
      }
      if (scenario === "review-turn-id-mismatch-with-other") {
        send({
          method: "turn/started",
          params: {
            threadId: OTHER_THREAD_ID,
            turn: { id: OTHER_TURN_ID, status: "inProgress", items: [], error: null },
          },
        });
      }
      send({ id: message.id, result: { turn: { id: TURN_ID, status: "inProgress", items: [], error: null }, reviewThreadId: THREAD_ID } });
      send({ method: "item/completed", params: { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: Date.now(), item: { type: "exitedReviewMode", id: "review-1", review: "NATIVE_REVIEW_OK" } } });
      send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", items: [], error: null } } });
      return;
    case "turn/steer":
      if (message.params?.expectedTurnId !== TURN_ID || Object.hasOwn(message.params ?? {}, "turnId")) {
        send({ id: message.id, error: { code: -32602, message: "expectedTurnId required" } });
      } else {
        send({ id: message.id, result: { turnId: TURN_ID } });
        if (scenario === "control-steer") completed("STEERED_ON_ACTIVE_CONNECTION");
      }
      return;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      if (scenario === "timeout" || scenario === "control-interrupt" || scenario === "hold") {
        send({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "interrupted", items: [], error: null } } });
      }
      return;
    case "model/list":
      if (scenario === "thread-idle-with-other-active") {
        send({
          method: "turn/started",
          params: {
            threadId: THREAD_ID,
            turn: { id: PROVISIONAL_REVIEW_TURN_ID, status: "inProgress", items: [], error: null },
          },
        });
        send({
          method: "turn/started",
          params: {
            threadId: OTHER_THREAD_ID,
            turn: { id: OTHER_TURN_ID, status: "inProgress", items: [], error: null },
          },
        });
        send({
          method: "thread/status/changed",
          params: { threadId: THREAD_ID, status: { type: "idle" } },
        });
      }
      if (scenario === "model-pagination") {
        if (message.params?.includeHidden !== true) {
          send({ id: message.id, error: { code: -32602, message: "model pagination requires includeHidden true" } });
          return;
        }
        if (message.params?.cursor === undefined) {
          send({ id: message.id, result: { data: [MODELS[0]], nextCursor: "hidden-page-2" } });
        } else if (message.params.cursor === "hidden-page-2") {
          send({ id: message.id, result: { data: [MODELS[1]], nextCursor: null } });
        } else {
          send({ id: message.id, error: { code: -32602, message: "unexpected model cursor" } });
        }
        return;
      }
      if (scenario === "model-pagination-loop") {
        send({ id: message.id, result: { data: [MODELS[0]], nextCursor: "repeated-cursor" } });
        return;
      }
      if (scenario === "model-malformed") {
        send({ id: message.id, result: { data: MODELS, nextCursor: 42 } });
        return;
      }
      send({ id: message.id, result: { data: MODELS, nextCursor: null } });
      return;
    case "account/logout":
      send({ id: message.id, result: {} });
      return;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line));
});
