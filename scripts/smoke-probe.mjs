import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createFakeRelay() {
  const expectedToken = "smoke-token";
  const expectedModel = "smoke-model";
  const requestLog = [];

  const server = createServer(async (request, response) => {
    const authHeader = request.headers.authorization ?? "";
    if (authHeader !== `Bearer ${expectedToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad auth" } }));
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: expectedModel,
              object: "model",
              created: 0,
              owned_by: "smoke-provider"
            }
          ]
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }

      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userMessage = messages.find((message) => message.role === "user")?.content ?? "";
      const nonceMatch = String(userMessage).match(/nonce\s+([a-z0-9-]+)/i);
      const nonce = nonceMatch?.[1] ?? "missing";
      requestLog.push({
        path: url.pathname,
        model: body.model ?? null,
        messageCount: messages.length,
        userMessage
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl_smoke",
          object: "chat.completion",
          created: 0,
          model: expectedModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `relay ok nonce ${nonce}`
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2
          }
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });

  return {
    server,
    expectedModel,
    expectedToken,
    requestLog
  };
}

async function startVerifierServer(port) {
  const child = spawn("node", ["verification/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for verifier startup.\nstdout=${stdout}\nstderr=${stderr}`));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.stdout.off("data", onStdout);
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`Verifier exited before startup with code ${code}.\nstdout=${stdout}\nstderr=${stderr}`));
    };

    const onStdout = () => {
      if (stdout.includes("HermesAgent-20 verifier listening")) {
        cleanup();
        resolve();
      }
    };

    child.on("exit", onExit);
    child.stdout.on("data", onStdout);
  });

  return {
    child,
    getLogs() {
      return { stdout, stderr };
    }
  };
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => resolve(), 5000);
  });
}

const { server, expectedModel, expectedToken, requestLog } = createFakeRelay();

const relayAddress = await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});

if (!relayAddress || typeof relayAddress === "string") {
  throw new Error("Failed to bind smoke relay.");
}

const verifierPort = 4310;
const verifier = await startVerifierServer(verifierPort);

const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist/benchlocal/index.js")).href;
const benchPackModule = await import(moduleUrl);
const benchPack = benchPackModule.default?.default ?? benchPackModule.default ?? benchPackModule;
const scenarios = await benchPack.listScenarios();
const prepared = await benchPack.prepare({
  protocolVersion: 1,
  benchPack: {
    id: "hermesagent-20",
    version: "0.1.0",
    installDir: process.cwd(),
    dataDir: path.join(os.tmpdir(), "hermesagent-20-data"),
    cacheDir: path.join(os.tmpdir(), "hermesagent-20-cache"),
    runsDir: path.join(os.tmpdir(), "hermesagent-20-runs")
  },
  providers: [],
  models: [
    {
      id: expectedModel,
      provider: "smoke-provider",
      model: "upstream-smoke-model",
      label: "Smoke Model",
      enabled: true,
      group: "primary"
    }
  ],
  secrets: [],
  verifiers: [
    {
      id: "verifier",
      transport: "http",
      mode: "docker",
      required: true,
      status: "running",
      url: `http://127.0.0.1:${verifierPort}`
    }
  ],
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {}
  },
  inferenceEndpoints: [
    {
      modelId: expectedModel,
      providerId: "smoke-provider",
      transport: "openai_compatible",
      status: "running",
      baseUrl: `http://127.0.0.1:${relayAddress.port}/v1/`,
      dockerBaseUrl: `http://127.0.0.1:${relayAddress.port}/v1/`,
      authMode: "bearer",
      apiKey: expectedToken,
      exposedModel: expectedModel
    }
  ]
});

try {
  const bootstrapScenario = scenarios.find((scenario) => scenario.id === "ha_bootstrap_inference_relay");
  if (!bootstrapScenario) {
    throw new Error("Missing verifier smoke scenario.");
  }

  const result = await prepared.runScenario(
    {
      runId: "smoke-run",
      benchPackId: "hermesagent-20",
      scenario: bootstrapScenario,
      model: {
        id: expectedModel,
        provider: "smoke-provider",
        model: "upstream-smoke-model",
        label: "Smoke Model",
        enabled: true,
        group: "primary"
      },
      generation: {
        temperature: 0
      }
    },
    () => {}
  );

  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") {
    console.error(JSON.stringify({ requestLog, verifierLogs: verifier.getLogs() }, null, 2));
    process.exitCode = 1;
  }
} finally {
  await prepared.dispose();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  await stopChild(verifier.child);
}
