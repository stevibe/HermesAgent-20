import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {
    scenarios: [],
    list: false,
    all: false,
    buildImage: false,
    image: process.env.HERMES_AGENT_20_IMAGE || "hermesagent20-dev",
    provider: process.env.HERMES_AGENT_20_PROVIDER || "openrouter",
    baseUrl: process.env.HERMES_AGENT_20_BASE_URL || "https://openrouter.ai/api/v1",
    authMode: process.env.HERMES_AGENT_20_AUTH_MODE || "bearer",
    apiKey: process.env.HERMES_AGENT_20_API_KEY || process.env.OPENROUTER_API_KEY,
    model: process.env.HERMES_AGENT_20_MODEL,
    providerModel: process.env.HERMES_AGENT_20_PROVIDER_MODEL,
    label: process.env.HERMES_AGENT_20_LABEL,
    verbose: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    switch (current) {
      case "--list":
        args.list = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--scenario":
        if (!next) {
          throw new Error("Missing value for --scenario");
        }
        args.scenarios.push(next);
        index += 1;
        break;
      case "--build-image":
        args.buildImage = true;
        break;
      case "--image":
        if (!next) {
          throw new Error("Missing value for --image");
        }
        args.image = next;
        index += 1;
        break;
      case "--provider":
        if (!next) {
          throw new Error("Missing value for --provider");
        }
        args.provider = next;
        index += 1;
        break;
      case "--base-url":
        if (!next) {
          throw new Error("Missing value for --base-url");
        }
        args.baseUrl = next;
        index += 1;
        break;
      case "--auth-mode":
        if (!next) {
          throw new Error("Missing value for --auth-mode");
        }
        args.authMode = next;
        index += 1;
        break;
      case "--api-key":
        if (!next) {
          throw new Error("Missing value for --api-key");
        }
        args.apiKey = next;
        index += 1;
        break;
      case "--model":
        if (!next) {
          throw new Error("Missing value for --model");
        }
        args.model = next;
        index += 1;
        break;
      case "--provider-model":
        if (!next) {
          throw new Error("Missing value for --provider-model");
        }
        args.providerModel = next;
        index += 1;
        break;
      case "--label":
        if (!next) {
          throw new Error("Missing value for --label");
        }
        args.label = next;
        index += 1;
        break;
      case "--json":
        args.json = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`HermesAgent-20 dev runner

Usage:
  npm run dev:run -- --list
  npm run dev:run -- --scenario ha_real_hermes_file_write --model openai/gpt-4.1
  npm run dev:run -- --all --model openai/gpt-4.1 --build-image

Options:
  --list                 List available scenarios
  --scenario <id>        Run one scenario; can be repeated
  --all                  Run all scenarios
  --model <id>           Required unless --list
  --provider-model <id>  Upstream provider model; defaults to --model
  --provider <id>        Defaults to openrouter
  --base-url <url>       Defaults to https://openrouter.ai/api/v1
  --api-key <token>      Defaults to OPENROUTER_API_KEY or HERMES_AGENT_20_API_KEY
  --auth-mode <mode>     bearer or none; defaults to bearer
  --label <label>        Display label; defaults to --model
  --build-image          Force rebuild verification Docker image
  --image <name>         Docker image name; defaults to hermesagent20-dev
  --json                 Print full JSON results
  --verbose              Print raw logs for each scenario

Environment:
  OPENROUTER_API_KEY
  HERMES_AGENT_20_MODEL
  HERMES_AGENT_20_BASE_URL
  HERMES_AGENT_20_API_KEY
`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

async function requireSuccessful(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${[command, ...args].join(" ")}\nexit=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`
    );
  }
  return result;
}

async function imageExists(image) {
  const result = await runCommand("docker", ["image", "inspect", image]);
  return result.exitCode === 0;
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port.")));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for verifier health at ${url}`);
}

async function startVerifierContainer(image) {
  const hostPort = await allocatePort();
  const containerName = `hermesagent20-dev-${randomUUID().slice(0, 8)}`;
  const verificationDir = path.join(process.cwd(), "verification");

  await requireSuccessful("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    containerName,
    "-p",
    `${hostPort}:4010`,
    "-v",
    `${verificationDir}:/opt/verification`,
    "--entrypoint",
    "sh",
    image,
    "-lc",
    "(/opt/hermes-venv/bin/pip show pytest >/dev/null 2>&1 || /opt/hermes-venv/bin/pip install -q pytest) && exec node /opt/verification/server.mjs"
  ]);

  const baseUrl = `http://127.0.0.1:${hostPort}`;

  try {
    await waitForHealth(`${baseUrl}/health`);
  } catch (error) {
    const logs = await runCommand("docker", ["logs", "--tail", "100", containerName]);
    await runCommand("docker", ["rm", "-f", containerName]);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nverifier_logs=${logs.stdout || logs.stderr}`);
  }

  return {
    containerName,
    baseUrl
  };
}

async function stopVerifierContainer(containerName) {
  await runCommand("docker", ["rm", "-f", containerName]);
}

async function loadScenarios() {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist/lib/benchmark.js")).href;
  const benchmarkModule = await import(moduleUrl);
  return benchmarkModule.SCENARIOS ?? [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = await loadScenarios();

  if (args.list) {
    for (const scenario of scenarios) {
      console.log(`${scenario.id}\t${scenario.title}`);
    }
    return;
  }

  if (!args.model) {
    throw new Error("Missing model. Pass --model <id> or set HERMES_AGENT_20_MODEL.");
  }

  if (args.authMode === "bearer" && !args.apiKey) {
    throw new Error("Missing API key. Pass --api-key <token> or set OPENROUTER_API_KEY.");
  }

  const selectedScenarioIds = args.all || args.scenarios.length === 0
    ? scenarios.map((scenario) => scenario.id)
    : args.scenarios;
  const selectedScenarios = selectedScenarioIds.map((scenarioId) => {
    const scenario = scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) {
      throw new Error(`Unknown scenario id: ${scenarioId}`);
    }
    return scenario;
  });

  if (args.buildImage || !(await imageExists(args.image))) {
    await requireSuccessful("docker", ["build", "-t", args.image, "verification"], {
      cwd: process.cwd()
    });
  }

  const verifier = await startVerifierContainer(args.image);
  const payloadModel = {
    id: `${args.provider}:${args.model}`,
    label: args.label ?? args.model,
    provider: args.provider,
    providerModel: args.providerModel ?? args.model,
    inferenceBaseUrl: args.baseUrl,
    authMode: args.authMode,
    apiKey: args.authMode === "bearer" ? args.apiKey : undefined,
    exposedModel: args.model
  };

  try {
    const results = [];

    for (const scenario of selectedScenarios) {
      const response = await fetch(`${verifier.baseUrl}/run-scenario`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          scenarioId: scenario.id,
          runId: `dev-${Date.now()}-${randomUUID().slice(0, 8)}`,
          model: payloadModel,
          generation: {
            temperature: 0
          }
        })
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Verifier rejected scenario ${scenario.id}: ${response.status} ${response.statusText}\n${detail}`);
      }

      const result = await response.json();
      results.push(result);

      const summary = `[${String(result.status).toUpperCase()}] ${scenario.id} score=${result.score ?? "?"} ${result.summary}`;
      console.log(summary);

      if (result.note) {
        console.log(`note: ${result.note}`);
      }

      if (args.verbose && result.rawLog) {
        console.log("rawLog:");
        console.log(result.rawLog);
      }

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      }
    }

    const passed = results.filter((result) => result.status === "pass").length;
    const partial = results.filter((result) => result.status === "partial").length;
    const failed = results.filter((result) => result.status === "fail").length;
    const averageScore = results.length === 0
      ? 0
      : Math.round(results.reduce((sum, result) => sum + (Number(result.score) || 0), 0) / results.length);

    console.log("");
    console.log(`completed=${results.length} pass=${passed} partial=${partial} fail=${failed} averageScore=${averageScore}`);
    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopVerifierContainer(verifier.containerName);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
