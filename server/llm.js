// Switchable LLM provider layer. The app depends ONLY on the LlmProvider shape:
//   { name: string, generate({ system, user, maxTokens? }): Promise<string> }
// Never on a specific vendor — flip LLM_PROVIDER (env) to switch with no code change.
// This is also the compliance switch: dev against Ollama/Anthropic, production
// against the company-approved endpoint.

const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/** POST JSON and parse the response; throws with upstream status + body on failure. */
async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 500) : ''}`);
    err.status = res.status;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

class AnthropicProvider {
  name = 'anthropic';
  async generate({ system, user, maxTokens }) {
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      {
        model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      },
    );
    const blocks = Array.isArray(data.content) ? data.content : [];
    return blocks
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}

class AzureOpenAiProvider {
  name = 'azure-openai';
  async generate({ system, user, maxTokens }) {
    const url = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;
    const data = await postJson(
      url,
      { 'api-key': process.env.AZURE_OPENAI_API_KEY },
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      },
    );
    return data?.choices?.[0]?.message?.content ?? '';
  }
}

class OllamaProvider {
  name = 'ollama';
  async generate({ system, user }) {
    const base = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
    const data = await postJson(
      `${base}/api/chat`,
      {},
      {
        model: process.env.OLLAMA_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
      },
    );
    return data?.message?.content ?? '';
  }
}

class CopilotStudioProvider {
  name = 'copilot-studio';
  async generate() {
    // Not yet implemented. Requires the Direct Line flow: obtain a Direct Line
    // token, start a conversation, POST the user activity, then poll the
    // conversation's activities for the bot reply. Wire later.
    throw new Error('Copilot Studio adapter not yet implemented');
  }
}

function requireEnv(keys, provider) {
  const missing = keys.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length) {
    throw new Error(`LLM provider "${provider}" is missing required env var(s): ${missing.join(', ')}.`);
  }
}

/**
 * Read LLM_PROVIDER and return the matching adapter, validating that the chosen
 * provider's required env vars are present. Throws a clear, specific error if not.
 */
export function createLlmProvider() {
  const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  switch (provider) {
    case 'anthropic':
      requireEnv(['ANTHROPIC_API_KEY'], provider); // model has a default
      return new AnthropicProvider();
    case 'azure-openai':
      requireEnv(
        ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION'],
        provider,
      );
      return new AzureOpenAiProvider();
    case 'ollama':
      requireEnv(['OLLAMA_MODEL'], provider); // base URL has a default
      return new OllamaProvider();
    case 'copilot-studio':
      return new CopilotStudioProvider();
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${process.env.LLM_PROVIDER}". Use one of: anthropic, azure-openai, ollama, copilot-studio.`,
      );
  }
}
