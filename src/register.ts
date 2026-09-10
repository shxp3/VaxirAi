import { REST, Routes } from 'discord.js';
import { readEnv } from './config/env.js';
import { commands } from './commands/definitions.js';
import { safeLog, AppError } from './utils/errors.js';
try {
  const env = readEnv();
  if (!env.token || !/^\d{17,20}$/.test(env.clientId) || (env.guildId && !/^\d{17,20}$/.test(env.guildId))) throw new AppError('config');
  const route = env.guildId ? Routes.applicationGuildCommands(env.clientId, env.guildId) : Routes.applicationCommands(env.clientId);
  await new REST({ version: '10' }).setToken(env.token).put(route, { body: commands.map(c => c.toJSON()) });
  safeLog('registered');
} catch (error) { safeLog('startup_failed', error); process.exitCode = 1; }
