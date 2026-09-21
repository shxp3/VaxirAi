export function shouldRespond(input: { guildId: string | null; authorIsBot: boolean; webhookId: string | null; mentioned: boolean; channelId: string; aiChannelId: string | null; threadParentId?: string | null }): boolean {
  if (!input.guildId || input.authorIsBot || input.webhookId) return false;
  if (input.mentioned) return true;
  if (input.aiChannelId && input.channelId === input.aiChannelId) return true;
  if (input.aiChannelId && input.threadParentId && input.threadParentId === input.aiChannelId) return true;
  return false;
}
export function removeBotMention(content: string, botId: string): string { return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim(); }
