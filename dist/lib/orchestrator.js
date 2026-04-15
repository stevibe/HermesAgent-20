"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runScenarioForModel = runScenarioForModel;
async function postScenarioToVerifier(verifierUrl, payload, signal) {
    const response = await fetch(new URL("/run-scenario", verifierUrl), {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Verifier request failed with ${response.status} ${response.statusText}: ${detail}`.trim());
    }
    return await response.json();
}
async function runScenarioForModel(model, scenario, emit, options) {
    await emit({
        type: "model_progress",
        modelId: model.id,
        scenarioId: scenario.id,
        message: `Submitting ${scenario.title} to the Hermes verifier container.`
    });
    return postScenarioToVerifier(options.verifierUrl, {
        scenarioId: scenario.id,
        runId: options.runId,
        model,
        generation: {
            temperature: options.temperature,
            top_p: options.top_p,
            top_k: options.top_k,
            min_p: options.min_p,
            repetition_penalty: options.repetition_penalty,
            request_timeout_seconds: options.request_timeout_seconds
        }
    }, options.signal);
}
