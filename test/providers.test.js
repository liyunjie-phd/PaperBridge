import assert from "node:assert/strict";
import test from "node:test";
import { callProvider, parseJsonResponse } from "../lib/providers.js";

test("provider adapters normalize OpenAI, Anthropic, and Gemini responses", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      if (String(url).includes("anthropic")) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: "anthropic-ok" }] }), { status: 200 });
      }
      if (String(url).includes("googleapis")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "openai-ok" } }] }), { status: 200 });
    };

    const request = { system: "system", user: "user", temperature: 0, maxTokens: 32 };
    assert.equal(await callProvider({ type: "openai-compatible", baseUrl: "https://example.test/v1", model: "m", apiKey: "k" }, request), "openai-ok");
    assert.equal(await callProvider({ type: "anthropic", baseUrl: "https://api.anthropic.test", model: "m", apiKey: "k" }, request), "anthropic-ok");
    assert.equal(await callProvider({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.test/v1beta", model: "m", apiKey: "k" }, request), "gemini-ok");

    assert.match(calls[0].url, /chat\/completions$/);
    assert.equal(calls[0].options.headers.Authorization, "Bearer k");
    assert.match(calls[1].url, /v1\/messages$/);
    assert.equal(calls[1].options.headers["x-api-key"], "k");
    assert.match(calls[2].url, /models\/m:generateContent\?key=k$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseJsonResponse accepts fenced JSON", () => {
  assert.deepEqual(parseJsonResponse("```json\n{\"ok\":true}\n```"), { ok: true });
});
