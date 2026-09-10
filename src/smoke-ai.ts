import { readEnv } from './config/env.js';
import { createProvider } from './ai/factory.js';
import { AppError, safeLog } from './utils/errors.js';
try {
  const env = readEnv();
  if (!env.defaultAI.model || !env.defaultAI.apiKey) throw new AppError('config');
  await createProvider(env.defaultAI, env.customAllowedBaseUrls).generate([{ role: 'user', content: 'Reply with OK.' }], env.defaultAI, env);
  safeLog('smoke_ok');
} catch (error) { safeLog('smoke_failed', error); process.exitCode = 1; }
