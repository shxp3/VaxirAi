import { readEnv } from './config/env.js';
import { resolveAI } from './config/resolve-ai.js';
import { resolveImage } from './config/resolve-image.js';
import { SqliteRepository } from './database/sqlite.js';
import { Secrets } from './config/secrets.js';
import { AdminCommands } from './commands/admin.js';
import { ServerPlans } from './commands/server-plan.js';
import { Conversations } from './memory/conversations.js';
import { createBot } from './bot/create.js';
import { AppError, safeLog } from './utils/errors.js';
async function main() {
  const env = readEnv();
  if (!env.token) throw new AppError('config');
  const secrets = new Secrets(env.encryptionKey);
  const repository = new SqliteRepository(env.databaseUrl);
  const conversations = new Conversations(repository, env, (settings, guildId) => resolveAI(env, secrets, settings, guildId), (settings, guildId) => resolveImage(env, secrets, settings, guildId));
  const client = createBot(env, conversations, new AdminCommands(env, conversations, secrets), new ServerPlans(env, conversations, secrets));
  const prune = () => repository.prune(Date.now() - env.memoryTtlHours * 3600000).catch(error => safeLog('maintenance_failed', error));
  await prune();
  const maintenance = setInterval(prune, 3600000); maintenance.unref();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    client.destroy(); clearInterval(maintenance);
    const deadline = Date.now() + env.timeoutMs + 5000;
    while (conversations.activeCount && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    repository.close(); safeLog('shutdown');
  };
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  try { await client.login(env.token); } catch (error) { client.destroy(); repository.close(); throw error; }
}
main().catch(error => { safeLog('startup_failed', error); process.exitCode = 1; });
