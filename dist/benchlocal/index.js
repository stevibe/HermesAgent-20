"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manifest = void 0;
const sdk_1 = require("@benchlocal/sdk");
const benchmark_1 = require("../lib/benchmark");
const orchestrator_1 = require("../lib/orchestrator");
const manifest = (0, sdk_1.loadBenchPackManifest)(__dirname);
exports.manifest = manifest;
function toModelConfig(input, endpoint) {
    return {
        id: input.model.id,
        label: input.model.label,
        provider: input.model.provider,
        providerModel: input.model.model,
        inferenceBaseUrl: endpoint.dockerBaseUrl ?? endpoint.baseUrl,
        authMode: endpoint.authMode,
        apiKey: endpoint.apiKey,
        exposedModel: endpoint.exposedModel
    };
}
exports.default = (0, sdk_1.defineBenchPack)({
    manifest,
    async listScenarios() {
        return (0, benchmark_1.getScenarioCards)().map((scenario) => ({
            id: scenario.id,
            title: scenario.title,
            category: scenario.category,
            description: scenario.description,
            promptText: scenario.promptText,
            detailCards: [
                {
                    title: "What this tests",
                    content: scenario.description
                },
                {
                    title: "Success case",
                    content: scenario.successCase
                },
                {
                    title: "Failure case",
                    content: scenario.failureCase
                }
            ]
        }));
    },
    async prepare(context) {
        const helpers = (0, sdk_1.createHostHelpers)(context);
        const verifier = helpers.getRequiredVerifier("verifier", {
            runningOnly: true
        });
        if (!verifier.url) {
            throw new Error('Verifier "verifier" is running but did not provide a URL.');
        }
        const verifierUrl = verifier.url;
        return {
            async runScenario(input, emit) {
                const scenario = helpers.getScenarioById(benchmark_1.SCENARIOS, input.scenario.id);
                const endpoint = helpers.getRequiredInferenceEndpoint(input.model.id);
                if (verifier.mode === "docker" && !endpoint.dockerBaseUrl) {
                    throw new Error(`BenchLocal did not provide a dockerBaseUrl for model "${input.model.id}". Upgrade BenchLocal to a build that exposes verifier-reachable inference endpoints.`);
                }
                return (0, orchestrator_1.runScenarioForModel)(toModelConfig(input, endpoint), scenario, emit, {
                    runId: input.runId,
                    verifierUrl,
                    ...helpers.resolveGenerationRequest(input.generation),
                    signal: input.abortSignal
                });
            },
            async dispose() { }
        };
    },
    scoreModelResults(results) {
        return (0, benchmark_1.scoreModelResults)((0, sdk_1.requireScoredResults)(results));
    }
});
