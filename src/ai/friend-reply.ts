const friendId = '842420149314650122';

/** Only explicit references trigger the joke; never infer a person from context. */
export function friendReply(prompt: string): string | null {
  const referencesFriend = new RegExp(`(?:<@!?${friendId}>|(?<!\\d)${friendId}(?!\\d))`).test(prompt);
  if (!referencesFriend || !/(?:เกย์|\bgay\b)/iu.test(prompt)) return null;
  return 'เรื่องรสนิยมให้เจ้าตัวตอบเอง แต่ทรงนี้เปิดไมค์ที เพื่อนกดปิดเสียงเร็วกว่ากดรับของฟรีอีก 😂';
}
