export function shouldRespond(input: { guildId: string | null; authorIsBot: boolean; webhookId: string | null; mentioned: boolean; channelId: string; aiChannelId: string | null }): boolean {
  return !!input.guildId && !input.authorIsBot && !input.webhookId && (input.mentioned || input.channelId === input.aiChannelId);
}
export function removeBotMention(content: string, botId: string): string { return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim(); }
