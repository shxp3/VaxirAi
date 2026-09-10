import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';
export class Secrets {
  private key: Buffer;
  constructor(value: string) {
    this.key = Buffer.from(value, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== value) throw new AppError('config');
  }
  encrypt(value: string, guildId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(guildId));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }
  decrypt(value: string, guildId: string): string {
    try {
      const [version, iv, tag, data] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !data) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      cipher.setAAD(Buffer.from(guildId)); cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8');
    } catch { throw new AppError('config'); }
  }
}
