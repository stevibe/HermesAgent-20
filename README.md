# HermesAgent-20

HermesAgent-20 is a BenchLocal Bench Pack for measuring how well a model performs as the controller inside the real Hermes Agent runtime.

It is not a mocked tool-calling benchmark and it is not graded by string matching. Official scoring is based on deterministic artifacts, runtime state, and Hermes trace invariants. The full methodology is in [METHODOLOGY.md](./METHODOLOGY.md).

## What This Pack Does

- Runs 20 public benchmark scenarios with canonical IDs `HA-01` through `HA-20`
- Uses the real Hermes runtime pinned to a specific Hermes repository revision
- Verifies concrete side effects such as files, memory state, cron state, delivery logs, browser exports, and approval traces
- Runs as a BenchLocal Bench Pack with a required Docker verifier

Development-only probe scenarios may exist in the repo for transport or harness debugging. They are not part of the public 20-case score.

## Architecture

HermesAgent-20 uses a split architecture on purpose:

1. **BenchLocal host runtime**
   The host side is intentionally thin and assumes only a Node.js environment. It lists scenarios, resolves the selected model, resolves the required verifier, and forwards scenario execution requests.

2. **BenchLocal-owned inference proxy**
   BenchLocal owns provider selection, model selection, and provider secrets. For each run it exposes an OpenAI-compatible inference endpoint for the selected model, including a Docker-reachable URL for verifier containers.

3. **Docker verifier**
   The verifier is the environment-dependent side. It runs as an HTTP service inside Docker, contains the pinned Hermes checkout and runtime dependencies, materializes fixtures, launches Hermes, and performs deterministic verification.

4. **Real Hermes runtime inside the verifier**
   Official scenario execution happens inside the verifier container, not on the host. The verifier writes a temporary Hermes config pointing Hermes at the BenchLocal inference proxy, creates a temporary workspace and `HERMES_HOME`, and launches the real Hermes CLI for the scenario.

That means the benchmark is evaluating a real Hermes run, while BenchLocal still owns model routing and credentials.

## End-To-End Flow

1. BenchLocal selects the model for the run.
2. BenchLocal exposes a host-managed inference endpoint for that model.
3. The Bench Pack host runtime resolves that endpoint and the required Docker verifier.
4. The host runtime sends `scenarioId`, generation settings, and proxy metadata to the verifier.
5. The verifier starts the pinned Hermes runtime, points Hermes at the BenchLocal inference endpoint, and runs the scenario inside an isolated temp workspace.
6. The verifier returns a scored result with audit data derived from real artifacts and traces.

## Why Hermes Lives In The Verifier

BenchLocal Bench Packs should not assume arbitrary host dependencies beyond Node.js. Hermes requires a pinned Python environment, browser/runtime fixtures, and other scenario-specific dependencies, so those live in Docker.

This keeps the pack architecture clean:

- Host side: orchestration only
- Verifier side: Hermes installation, fixtures, real execution, verification

## Repository Layout

- [benchlocal/index.ts](./benchlocal/index.ts): BenchLocal host adapter
- [lib/benchmark.ts](./lib/benchmark.ts): public scenario catalog and score aggregation
- [lib/orchestrator.ts](./lib/orchestrator.ts): host-to-verifier execution path
- [verification/server.mjs](./verification/server.mjs): verifier HTTP service
- [verification/core.mjs](./verification/core.mjs): deterministic scenario verifiers
- [verification/hermes-runtime.mjs](./verification/hermes-runtime.mjs): pinned Hermes launcher and runtime helpers
- [verification/Dockerfile](./verification/Dockerfile): verifier image definition
- [METHODOLOGY.md](./METHODOLOGY.md): public benchmark methodology

## BenchLocal Integration Notes

- This pack requires a Docker verifier.
- The host runtime expects BenchLocal to provide `inferenceEndpoints`.
- Official verifier runs use the Docker-reachable endpoint, typically `dockerBaseUrl`, not the host-only URL.
- The pack should not require users to configure separate Hermes provider credentials.

## Development

Install dependencies:

```bash
npm install
```

Build the BenchLocal entry:

```bash
npm run build:benchlocal
```

Typecheck:

```bash
npm run typecheck
```

Run the local dev runner:

```bash
npm run dev:run -- --list
```

Run the local smoke probe:

```bash
npm run smoke:local
```

The dev runner is useful for scenario-by-scenario debugging. The official benchmark path is still the BenchLocal host plus Docker verifier flow described above.

License: MIT. See [LICENSE](./LICENSE).
