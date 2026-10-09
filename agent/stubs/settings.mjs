// Headless stand-in for src/main/settings.ts: API keys come from environment
// variables (e.g. ELEVENLABS_API_KEY in agent/.env) instead of the keychain.

export const settings = {
  get: (key) => process.env[key] || undefined,
};
