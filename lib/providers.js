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

function providerRequestError(status, detail) {
  const error = new Error(status === 401
    ? "AI 接口认证失败（401）。API Key 未配置、无效或已失效，请在设置中重新填写并测试对应的翻译或审校接口。"
    : `AI provider returned ${status}: ${detail}`);
  error.status = status;
  if (status === 401) {
    error.code = "AI_AUTH_FAILED";
    error.details = { providerMessage: detail };
  }
  return error;
}

async function requestJson(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
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
      if (response.ok) return payload;
      const detail = payload?.error?.message || payload?.message || payload?.raw || response.statusText;
      const error = providerRequestError(response.status, detail);
      if (![408, 429].includes(response.status) && response.status < 500) throw error;
      lastError = error;
      if (attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(5000, retryAfter * 1000)
          : 750 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error;
      if (error.status && ![408, 429].includes(error.status) && error.status < 500) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw lastError || new Error("AI provider request failed after retries.");
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
  const apiKey = String(profile.apiKey || "").trim();
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // The request will report an invalid URL after provider validation.
  }
  if (hostname === "api.deepseek.com" && !apiKey) {
    const error = new Error("段落翻译或全文审校尚未配置 DeepSeek API Key，请在设置中填写对应接口的 Key。");
    error.status = 400;
    error.code = "AI_API_KEY_MISSING";
    throw error;
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model: profile.model,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user }
    ],
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens || 8192,
    stream: false
  };
  if (/^deepseek-v4-(?:flash|pro)$/i.test(String(profile.model || ""))) {
    body.thinking = { type: profile.thinkingMode === "enabled" ? "enabled" : "disabled" };
    if (profile.thinkingMode === "enabled") body.reasoning_effort = profile.reasoningEffort === "max" ? "max" : "high";
  }
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
