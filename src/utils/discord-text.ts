export function splitDiscordText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let fenceLanguage: string | null = null;
  const flush = () => {
    if (!chunk) return;
    const closed = fenceLanguage !== null ? `${chunk}${chunk.endsWith('\n') ? '' : '\n'}\`\`\`` : chunk;
    chunks.push(closed);
    chunk = fenceLanguage !== null ? `\`\`\`${fenceLanguage}\n` : '';
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    let rest = line;
    while (rest) {
      const reserve = fenceLanguage !== null ? 4 : 0;
      const capacity = 1900 - chunk.length - reserve;
      if (capacity <= 0) { flush(); continue; }
      let end = Math.min(capacity, rest.length);
      if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
      chunk += rest.slice(0, end);
      rest = rest.slice(end);
      if (rest) flush();
    }
    const marker = line.trim();
    if (marker === '```' && fenceLanguage !== null) fenceLanguage = null;
    else if (fenceLanguage === null) {
      const opening = marker.match(/^```([\w+#.-]*)$/);
      if (opening) fenceLanguage = opening[1] ?? '';
    }
    if (chunk.length >= 1900 - (fenceLanguage !== null ? 4 : 0)) flush();
  }
  flush();
  return chunks;
}
