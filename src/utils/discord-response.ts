import { splitDiscordText } from './discord-text.js';

export interface DiscordCodeFile { attachment: Buffer; name: string }
export interface DiscordResponsePart { content?: string; files?: DiscordCodeFile[] }

const EXTENSIONS: Record<string, string> = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', java: 'java',
  c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', html: 'html', css: 'css', json: 'json',
  yaml: 'yml', yml: 'yml', xml: 'xml', sql: 'sql', bash: 'sh', shell: 'sh', sh: 'sh',
  powershell: 'ps1', ps1: 'ps1', php: 'php', ruby: 'rb', go: 'go', rust: 'rs', kotlin: 'kt',
  swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', markdown: 'md', md: 'md', text: 'txt',
  plaintext: 'txt', txt: 'txt',
};

function extension(language: string): string {
  const normalized = language.trim().toLowerCase();
  return EXTENSIONS[normalized] ?? (normalized.replace(/[^a-z0-9]+/g, '').slice(0, 10) || 'txt');
}

export function prepareDiscordResponse(text: string): DiscordResponsePart[] {
  const files: DiscordCodeFile[] = [];
  const plain = text.replace(/^```([^\r\n`]*)\r?\n([\s\S]*?)^```[ \t]*$/gm, (_whole, language: string, code: string) => {
    if (!code.trim()) return '';
    const ext = extension(language);
    files.push({ attachment: Buffer.from(code.replace(/\r\n/g, '\n'), 'utf8'), name: `code-${files.length + 1}.${ext}` });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  if (!files.length) return splitDiscordText(text).map(content => ({ content }));
  const contents = plain ? splitDiscordText(plain) : ['แนบไฟล์โค้ดให้แล้ว'];
  const parts: DiscordResponsePart[] = contents.map(content => ({ content }));
  for (let index = 0, part = 0; index < files.length; index += 10, part++) {
    const batch = files.slice(index, index + 10);
    if (!parts[part]) parts[part] = { content: 'ไฟล์โค้ดเพิ่มเติม' };
    parts[part]!.files = batch;
  }
  return parts;
}
