"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HERMES_PINNED_COMMIT = exports.HERMES_REPOSITORY_URL = void 0;
exports.ensureHermesRuntime = ensureHermesRuntime;
exports.executeHermesQuietQuery = executeHermesQuietQuery;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
exports.HERMES_REPOSITORY_URL = "https://github.com/nousresearch/hermes-agent.git";
exports.HERMES_PINNED_COMMIT = "ea74f61d983ebdfd6a863c45761d1b38081f1d08";
const HERMES_SOURCE_DIR_ENV = "HERMES_AGENT_20_SOURCE_DIR";
const HERMES_PYTHON_BIN_ENV = "HERMES_AGENT_20_PYTHON_BIN";
function commandLabel(file, args) {
    return [file, ...args].join(" ");
}
function truncateTail(value, maxChars = 20_000) {
    if (value.length <= maxChars) {
        return value;
    }
    return `${value.slice(0, maxChars)}\n...[truncated]`;
}
function runCommand(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(file, [...args], {
            cwd: options.cwd,
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timeout;
        const finish = (callback) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            if (options.signal) {
                options.signal.removeEventListener("abort", abortListener);
            }
            callback();
        };
        const abortListener = () => {
            child.kill("SIGTERM");
            finish(() => reject(new Error(`Command aborted: ${commandLabel(file, args)}`)));
        };
        if (options.signal) {
            if (options.signal.aborted) {
                abortListener();
                return;
            }
            options.signal.addEventListener("abort", abortListener, { once: true });
        }
        if (options.timeoutMs && options.timeoutMs > 0) {
            timeout = setTimeout(() => {
                child.kill("SIGTERM");
                finish(() => reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${commandLabel(file, args)}`)));
            }, options.timeoutMs);
        }
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout = truncateTail(`${stdout}${chunk}`);
        });
        child.stderr.on("data", (chunk) => {
            stderr = truncateTail(`${stderr}${chunk}`);
        });
        child.on("error", (error) => {
            finish(() => reject(error));
        });
        child.on("close", (code) => {
            finish(() => resolve({
                exitCode: code ?? 1,
                stdout,
                stderr
            }));
        });
    });
}
async function runCheckedCommand(file, args, options) {
    const result = await runCommand(file, args, options);
    if (result.exitCode === 0) {
        return result;
    }
    throw new Error(`${options.failureLabel}\ncommand=${commandLabel(file, args)}\nexit_code=${result.exitCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}
async function pathExists(targetPath) {
    try {
        await (0, promises_1.stat)(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
function getVenvBinaryPath(venvDir, name) {
    if (process.platform === "win32") {
        return node_path_1.default.join(venvDir, "Scripts", `${name}.exe`);
    }
    return node_path_1.default.join(venvDir, "bin", name);
}
async function getGitRevision(repoDir) {
    const result = await runCheckedCommand("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        failureLabel: `Failed to read git revision for ${repoDir}.`
    });
    return result.stdout.trim();
}
async function ensurePinnedManagedSource(managedSourceDir) {
    if (!(await pathExists(node_path_1.default.join(managedSourceDir, ".git")))) {
        await (0, promises_1.mkdir)(node_path_1.default.dirname(managedSourceDir), { recursive: true });
        await runCheckedCommand("git", ["clone", exports.HERMES_REPOSITORY_URL, managedSourceDir], {
            failureLabel: "Failed to clone the Hermes repository."
        });
    }
    await runCheckedCommand("git", ["fetch", "--all", "--tags"], {
        cwd: managedSourceDir,
        failureLabel: "Failed to fetch the pinned Hermes revision."
    });
    await runCheckedCommand("git", ["checkout", "--force", exports.HERMES_PINNED_COMMIT], {
        cwd: managedSourceDir,
        failureLabel: "Failed to checkout the pinned Hermes revision."
    });
    const revision = await getGitRevision(managedSourceDir);
    if (revision !== exports.HERMES_PINNED_COMMIT) {
        throw new Error(`Pinned Hermes checkout mismatch: expected ${exports.HERMES_PINNED_COMMIT}, received ${revision}.`);
    }
    return managedSourceDir;
}
async function resolveHermesSourceDir(cacheDir) {
    const overrideDir = process.env[HERMES_SOURCE_DIR_ENV]?.trim();
    if (overrideDir) {
        const revision = await getGitRevision(overrideDir);
        if (revision !== exports.HERMES_PINNED_COMMIT) {
            throw new Error(`${HERMES_SOURCE_DIR_ENV} points to ${overrideDir}, but HEAD is ${revision}; expected ${exports.HERMES_PINNED_COMMIT}.`);
        }
        return overrideDir;
    }
    const managedSourceDir = node_path_1.default.join(cacheDir, "hermes-agent", exports.HERMES_PINNED_COMMIT, "source");
    return ensurePinnedManagedSource(managedSourceDir);
}
async function resolvePython311Binary() {
    const override = process.env[HERMES_PYTHON_BIN_ENV]?.trim();
    if (override) {
        return override;
    }
    const result = await runCheckedCommand("uv", ["python", "find", "3.11"], {
        failureLabel: "Failed to locate Python 3.11 through uv."
    });
    const resolved = result.stdout.trim();
    if (!resolved) {
        throw new Error("uv did not return a Python 3.11 interpreter path.");
    }
    return resolved;
}
async function ensureHermesVenv(cacheDir, sourceDir, pythonBin) {
    const venvDir = node_path_1.default.join(cacheDir, "hermes-agent", exports.HERMES_PINNED_COMMIT, "venv");
    const hermesBin = getVenvBinaryPath(venvDir, "hermes");
    const venvPython = getVenvBinaryPath(venvDir, "python");
    const markerPath = node_path_1.default.join(venvDir, ".hermesagent20-install.json");
    const expectedMarker = JSON.stringify({
        revision: exports.HERMES_PINNED_COMMIT,
        sourceDir
    }, null, 2);
    if (await pathExists(markerPath)) {
        const existingMarker = await (0, promises_1.readFile)(markerPath, "utf8");
        if (existingMarker.trim() === expectedMarker.trim() && await pathExists(hermesBin)) {
            return venvDir;
        }
    }
    await (0, promises_1.mkdir)(node_path_1.default.dirname(venvDir), { recursive: true });
    await runCheckedCommand("uv", ["venv", venvDir, "--python", pythonBin], {
        failureLabel: "Failed to create the Hermes virtualenv."
    });
    await runCheckedCommand("uv", ["pip", "install", "--python", venvPython, "-e", sourceDir], {
        cwd: sourceDir,
        timeoutMs: 20 * 60 * 1000,
        failureLabel: "Failed to install Hermes into the cached virtualenv."
    });
    await (0, promises_1.writeFile)(markerPath, `${expectedMarker}\n`, "utf8");
    if (!(await pathExists(hermesBin))) {
        throw new Error(`Hermes CLI was not installed correctly; missing ${hermesBin}.`);
    }
    return venvDir;
}
function yamlScalar(value) {
    return JSON.stringify(value);
}
async function writeHermesConfig(hermesHomeDir, workspaceDir, model, maxTurns) {
    await (0, promises_1.mkdir)(hermesHomeDir, { recursive: true });
    const configPath = node_path_1.default.join(hermesHomeDir, "config.yaml");
    const lines = [
        "model:",
        `  default: ${yamlScalar(model.exposedModel)}`,
        '  provider: "custom"',
        `  base_url: ${yamlScalar(model.baseUrl)}`
    ];
    if (model.authMode === "bearer" && model.apiKey) {
        lines.push(`  api_key: ${yamlScalar(model.apiKey)}`);
    }
    lines.push("terminal:", '  backend: "local"', `  cwd: ${yamlScalar(workspaceDir)}`, "  timeout: 60", "  lifetime_seconds: 300", "display:", '  tool_progress: "off"', "  streaming: false", "  inline_diffs: false", "  show_reasoning: false", "compression:", "  enabled: false", "agent:", `  max_turns: ${maxTurns}`);
    await (0, promises_1.writeFile)(configPath, `${lines.join("\n")}\n`, "utf8");
    return configPath;
}
function parseSessionId(stdout) {
    const match = stdout.match(/(?:^|\n)session_id:\s*([^\s]+)\s*$/m);
    return match?.[1];
}
function parseFinalAnswer(stdout) {
    const sessionMarker = stdout.match(/^(.*?)(?:\n\nsession_id:\s*[^\s]+\s*)$/s);
    const candidate = (sessionMarker?.[1] ?? stdout).trim();
    return candidate || undefined;
}
async function ensureHermesRuntime(cacheDir) {
    const sourceDir = await resolveHermesSourceDir(cacheDir);
    const pythonBin = await resolvePython311Binary();
    const venvDir = await ensureHermesVenv(cacheDir, sourceDir, pythonBin);
    return {
        sourceDir,
        venvDir,
        pythonBin: getVenvBinaryPath(venvDir, "python"),
        hermesBin: getVenvBinaryPath(venvDir, "hermes"),
        revision: await getGitRevision(sourceDir)
    };
}
async function executeHermesQuietQuery(request) {
    const hermesHomeDir = node_path_1.default.join(request.runDir, "hermes-home");
    const promptPath = node_path_1.default.join(request.runDir, "prompt.txt");
    const stdoutPath = node_path_1.default.join(request.runDir, "stdout.txt");
    const stderrPath = node_path_1.default.join(request.runDir, "stderr.txt");
    await (0, promises_1.mkdir)(request.runDir, { recursive: true });
    await (0, promises_1.mkdir)(request.workspaceDir, { recursive: true });
    await (0, promises_1.writeFile)(promptPath, `${request.prompt}\n`, "utf8");
    await writeHermesConfig(hermesHomeDir, request.workspaceDir, request.model, request.maxTurns);
    const args = [
        "chat",
        "-q",
        request.prompt,
        "-Q",
        "-t",
        request.toolsets.join(","),
        "--max-turns",
        String(request.maxTurns),
        "-m",
        request.model.exposedModel
    ];
    const result = await runCommand(request.runtime.hermesBin, args, {
        cwd: request.workspaceDir,
        env: {
            ...process.env,
            HERMES_HOME: hermesHomeDir,
            HERMES_WRITE_SAFE_ROOT: request.workspaceDir,
            HERMES_SESSION_SOURCE: "benchlocal-hermesagent-20"
        },
        signal: request.signal,
        timeoutMs: 10 * 60 * 1000
    });
    await (0, promises_1.writeFile)(stdoutPath, result.stdout, "utf8");
    await (0, promises_1.writeFile)(stderrPath, result.stderr, "utf8");
    const sessionId = parseSessionId(result.stdout);
    const sessionLogPath = sessionId
        ? node_path_1.default.join(hermesHomeDir, "sessions", `session_${sessionId}.json`)
        : undefined;
    let sessionLog;
    if (sessionLogPath && await pathExists(sessionLogPath)) {
        try {
            sessionLog = JSON.parse(await (0, promises_1.readFile)(sessionLogPath, "utf8"));
        }
        catch { }
    }
    const lastAssistantText = [...(sessionLog?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant" && typeof message.content === "string")
        ?.content;
    return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        sessionId,
        finalAnswer: lastAssistantText ?? parseFinalAnswer(result.stdout),
        sessionLogPath,
        sessionLog,
        promptPath,
        stdoutPath,
        stderrPath
    };
}
