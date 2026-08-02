/**
 * Default configuration for the Visual AI Agent.
 * Settings are stored in chrome.storage.local under key 'vaia:config'
 * and always deep-merged over these defaults.
 */

export const DEFAULTS = {
  enabled: true,
  identity: {
    userId: '',
    device: '',
  },

  tracking: {
    mouseMoveSampleMs: 50,
    mouseMoveMinDistance: 4,
    maxEventsPerSec: 300,
    scrollThrottleMs: 120,
    trackKeyboard: true,
    trackClicks: true,
    trackScroll: true,
    trackNavigation: true,
    trackMutations: false,
    trackErrors: true,
    trackPerformance: true,
    trackForm: true,
    trackFocus: true,
    trackTouch: true,
    trackDrag: true,
    trackSelection: true,
    trackIdle: true,
    mutationBatchMs: 1500,
    mutationMaxNodes: 200,
  },

  capture: {
    enabled: true,
    intervalMs: 5000,
    onSignificantEvent: true,
    onSessionEnd: true,
    quality: 60,
    maxWidth: 1280,
    storeLocal: true,
    storeLocalMaxFrames: 600,
    trimDataUris: true,
    skipDuplicateFrames: true,
  },

  vision: {
    enabled: false,
    provider: 'openai',
    model: '',
    apiKey: '',
    baseUrl: '',
    timeoutMs: 30000,
    analyzeScreenEveryNth: 5,
    describeClips: false,
    temperature: 0.2,
    maxTokens: 1024,
    language: 'en',
    autoModel: true,
    modelFallbacks: true,
  },

  privacy: {
    maskSensitive: true,
    redactKeystrokeValues: true,
    dropScreenshotsOnSensitivePage: true,
    sensitiveDomains: [],
    denylistHosts: [],
    allowlistHosts: [],
    disableOnIncognito: true,
    dataRetentionDays: 30,
    stripQueryParams: true,
  },

  db: {
    endpoint: '',
    apiKey: '',
    batchSize: 25,
    flushIntervalMs: 10000,
    maxRetries: 6,
    retryBaseMs: 1500,
    offlineQueueLimit: 20000,
    sendEvents: true,
    sendScreenshots: true,
    sendInsights: true,
    headers: {},
  },

  insights: {
    enabled: true,
    rageClickThreshold: 3,
    rageClickWindowMs: 4000,
    deadClickDelayMs: 2000,
    idleThresholdMs: 45000,
    errorSpikeWindowMs: 60000,
    errorSpikeThreshold: 5,
    rapidNavThreshold: 6,
    rapidNavWindowMs: 30000,
    scrollSpikeWindowMs: 3000,
    scrollSpikeThreshold: 8,
    generateEndOfSessionSummary: true,
  },

  digest: {
    enabled: true,
    hourOfDay: 20,
    windowHours: 24,
    period: 'daily',
  },

  goals: {
    enabled: false,
    distractionsMinutes: 60,
    checkIntervalMinutes: 30,
    notify: true,
  },

  recorder: {
    enabled: true,
  },

  heatmaps: {
    enabled: true,
    showClicks: true,
    showScroll: true,
    opacity: 0.45,
  },

  ui: {
    showBadge: true,
    notifyOnInsight: false,
  },
};

/**
 * Deep-merge `overrides` over `base`, returning a new object.
 * Arrays are replaced (not merged). Both must be plain objects.
 */
export function deepMerge(base, overrides) {
  if (overrides === undefined || overrides === null) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(overrides)) {
    const bv = out[key];
    const ov = overrides[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, ov);
    } else {
      out[key] = ov === undefined ? bv : ov;
    }
  }
  return out;
}

/** Build a full config from a (possibly partial) stored object. */
export function normalizeConfig(stored) {
  return deepMerge(DEFAULTS, stored || {});
}

/** @returns {Array<{id:string,label:string,needsKey:boolean}>} */
export function visionProviders() {
  return [
    { id: 'openai', label: 'OpenAI (GPT-4o / o-series)', needsKey: true },
    { id: 'anthropic', label: 'Anthropic (Claude)', needsKey: true },
    { id: 'gemini', label: 'Google Gemini', needsKey: true },
    { id: 'groq', label: 'Groq (fast Llama vision)', needsKey: true },
    { id: 'openrouter', label: 'OpenRouter', needsKey: true },
    { id: 'ollama', label: 'Ollama (local)', needsKey: false },
    { id: 'mock', label: 'Mock / offline', needsKey: false },
  ];
}

export function defaultModels() {
  return {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-5',
    gemini: 'gemini-2.5-flash',
    groq: 'qwen/qwen3.6-27b',
    openrouter: 'openai/gpt-4o',
    ollama: 'llama3.2-vision',
    mock: 'mock-vision',
  };
}
