function joinUrl(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}${suffix}`;
}

function parseExtraHeaders(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("Extra headers must be a JSON object.");
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(120_000)
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || payload?.raw || response.statusText;
    throw new Error(`AI provider returned ${response.status}: ${detail}`);
  }
  return payload;
}

async function callOpenAICompatible(profile, request) {
  const baseUrl = profile.baseUrl || "https://api.deepseek.com";
  const endpoint = profile.apiPath
    ? joinUrl(baseUrl, profile.apiPath.startsWith("/") ? profile.apiPath : `/${profile.apiPath}`)
    : baseUrl.endsWith("/chat/completions")
      ? baseUrl
      : joinUrl(baseUrl, "/chat/completions");
  const headers = {
    "Content-Type": "application/json",
    ...parseExtraHeaders(profile.extraHeaders)
  };
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;

  const body = {
    model: profile.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user }
    ],
    temperature: request.temperature ?? 0.2,
    stream: false
  };
  if (request.json && profile.jsonMode) body.response_format = { type: "json_object" };
  const payload = await requestJson(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return payload?.choices?.[0]?.message?.content || "";
}

async function callAnthropic(profile, request) {
  const baseUrl = profile.baseUrl || "https://api.anthropic.com";
  const endpoint = profile.apiPath
    ? joinUrl(baseUrl, profile.apiPath.startsWith("/") ? profile.apiPath : `/${profile.apiPath}`)
    : joinUrl(baseUrl, "/v1/messages");
  const payload = await requestJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": profile.apiKey || "",
      "anthropic-version": profile.apiVersion || "2023-06-01",
      ...parseExtraHeaders(profile.extraHeaders)
    },
    body: JSON.stringify({
      model: profile.model,
      max_tokens: request.maxTokens || 8192,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      temperature: request.temperature ?? 0.2
    })
  });
  return (payload?.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function callGemini(profile, request) {
  const baseUrl = profile.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const model = profile.model?.startsWith("models/") ? profile.model : `models/${profile.model}`;
  const endpoint = profile.apiPath
    ? joinUrl(baseUrl, profile.apiPath.startsWith("/") ? profile.apiPath : `/${profile.apiPath}`)
    : joinUrl(baseUrl, `/${model}:generateContent`);
  const url = new URL(endpoint);
  if (profile.apiKey) url.searchParams.set("key", profile.apiKey);
  const generationConfig = {
    temperature: request.temperature ?? 0.2,
    maxOutputTokens: request.maxTokens || 8192
  };
  if (request.json) generationConfig.responseMimeType = "application/json";
  const payload = await requestJson(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...parseExtraHeaders(profile.extraHeaders)
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig
    })
  });
  return (payload?.candidates?.[0]?.content?.parts || [])
    .map((item) => item.text || "")
    .join("\n");
}

export async function callProvider(profile, request) {
  if (!profile?.model) throw new Error("Configure a model before using AI.");
  const type = profile.type || "openai-compatible";
  if (type === "anthropic") return callAnthropic(profile, request);
  if (type === "gemini") return callGemini(profile, request);
  return callOpenAICompatible(profile, request);
}

export function parseJsonResponse(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("The AI provider did not return valid JSON.");
  }
}
