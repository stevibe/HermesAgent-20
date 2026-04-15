import {
  createHostHelpers,
  defineBenchPack,
  loadBenchPackManifest,
  requireScoredResults,
  type ProgressEmitter,
  type ScenarioResult,
  type ScenarioRunInput
} from "@benchlocal/sdk";
import { SCENARIOS, getScenarioCards, scoreModelResults as scoreHermesResults } from "../lib/benchmark";
import { runScenarioForModel } from "../lib/orchestrator";

type ModelConfig = {
  id: string;
  label: string;
  provider: string;
  providerModel: string;
  inferenceBaseUrl: string;
  authMode: "none" | "bearer";
  apiKey?: string;
  exposedModel: string;
};

const manifest = loadBenchPackManifest(__dirname);

function toModelConfig(input: ScenarioRunInput, endpoint: {
  baseUrl: string;
  dockerBaseUrl?: string;
  authMode: "none" | "bearer";
  apiKey?: string;
  exposedModel: string;
}): ModelConfig {
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

export { manifest };

export default defineBenchPack({
  manifest,

  async listScenarios() {
    return getScenarioCards().map((scenario) => ({
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
    const helpers = createHostHelpers(context);
    const verifier = helpers.getRequiredVerifier("verifier", {
      runningOnly: true
    });

    if (!verifier.url) {
      throw new Error('Verifier "verifier" is running but did not provide a URL.');
    }
    const verifierUrl = verifier.url;

    return {
      async runScenario(input: ScenarioRunInput, emit: ProgressEmitter): Promise<ScenarioResult> {
        const scenario = helpers.getScenarioById(SCENARIOS, input.scenario.id);
        const endpoint = helpers.getRequiredInferenceEndpoint(input.model.id);
        if (verifier.mode === "docker" && !endpoint.dockerBaseUrl) {
          throw new Error(
            `BenchLocal did not provide a dockerBaseUrl for model "${input.model.id}". Upgrade BenchLocal to a build that exposes verifier-reachable inference endpoints.`
          );
        }

        return runScenarioForModel(
          toModelConfig(input, endpoint),
          scenario,
          emit as Parameters<typeof runScenarioForModel>[2],
          {
            runId: input.runId,
            verifierUrl,
            ...helpers.resolveGenerationRequest(input.generation),
            signal: input.abortSignal
          }
        );
      },

      async dispose() {}
    };
  },

  scoreModelResults(results) {
    return scoreHermesResults(requireScoredResults(results));
  }
});
