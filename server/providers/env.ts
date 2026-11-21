/** Variables that would make a CLI bill an API account instead of the subscription login. */
export const API_KEY_VARS: Record<string, string[]> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  antigravity: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'AGY_ADC_AUTH',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GEMINI_BASE_URL',
  ],
};

/**
 * The environment for a CLI call: the server's own, minus the given variables when stripping is
 * on, plus NO_COLOR so output is not decorated. Names compare case-insensitively because
 * Windows environment names are case-insensitive.
 */
export function buildChildEnv(
  strip: string[],
  stripApiKeys: boolean,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const remove = new Set(stripApiKeys ? strip.map((v) => v.toUpperCase()) : []);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || remove.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

/** Strip-list variables that are set (non-empty) in `base`. */
export function presentApiKeyVars(strip: string[], base: NodeJS.ProcessEnv = process.env): string[] {
  const present = new Set(
    Object.entries(base)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k]) => k.toUpperCase()),
  );
  return strip.filter((v) => present.has(v.toUpperCase()));
}

export function apiKeyWarnings(strip: string[], stripApiKeys: boolean, base: NodeJS.ProcessEnv = process.env): string[] {
  return presentApiKeyVars(strip, base).map((v) =>
    stripApiKeys
      ? `${v} is set in this environment; it is removed from council calls so they use your subscription login.`
      : `${v} is set and will be used — calls may be billed to the API.`,
  );
}
