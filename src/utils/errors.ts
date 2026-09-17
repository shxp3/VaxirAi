export type ErrorCode = 'quota' | 'timeout' | 'auth' | 'model' | 'unavailable' | 'malformed' | 'input' | 'limited' | 'disabled' | 'config' | 'busy' | 'intent' | 'channel_permissions' | 'wrong_ai_channel' | 'too_large' | 'gateway_blocked' | 'search_auth' | 'search_quota' | 'search_unavailable' | 'file_type' | 'file_size' | 'file_count' | 'file_download' | 'file_encoding';
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryAfter?: number, public readonly channelId?: string) { super(code); }
}
export function userError(error: unknown): string {
  const code = error instanceof AppError ? error.code : 'unavailable';
  const messages: Record<ErrorCode, string> = {
    wrong_ai_channel: 'เซิร์ฟเวอร์นี้อนุญาตให้ใช้ AI เฉพาะห้องที่กำหนดไว้',
    search_auth: 'ระบบค้นเว็บปฏิเสธ API Key กรุณาให้ผู้ดูแลตั้งค่า Brave Search Key ใหม่',
    search_quota: 'ระบบค้นเว็บใช้โควตาครบแล้ว กรุณาลองใหม่ภายหลังหรือติดต่อผู้ดูแล',
    search_unavailable: 'ระบบค้นเว็บไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง',
    file_type: 'รองรับรูป JPG, PNG, GIF, WebP และไฟล์ข้อความหรือโค้ดที่กำหนดเท่านั้น',
    file_size: 'ไฟล์หรือเนื้อหารวมมีขนาดใหญ่เกินค่าที่บอตกำหนด กรุณาลดขนาดไฟล์แล้วลองใหม่',
    file_count: 'แนบไฟล์มากเกินจำนวนที่บอตกำหนด กรุณาลดจำนวนไฟล์แล้วลองใหม่',
    file_download: 'ดาวน์โหลดไฟล์แนบจาก Discord ไม่สำเร็จ กรุณาแนบไฟล์ใหม่แล้วลองอีกครั้ง',
    file_encoding: 'อ่านไฟล์ไม่ได้ กรุณาบันทึกไฟล์ Markdown เป็น UTF-8 แล้วลองใหม่',
    gateway_blocked: 'ปลายทาง API ของ AI ปฏิเสธคำขอ บอตพักการส่งชั่วคราว หากยังเกิดซ้ำให้ผู้ดูแลตรวจสอบกับผู้ให้บริการ AI',
    too_large: 'ผู้ให้บริการ AI ปฏิเสธคำขอเพราะข้อมูลมีขนาดใหญ่เกินไป (อาจรวมบริบทหรือผลค้นเว็บ) ลองถามให้เจาะจงขึ้น หรือใช้ /clear แล้วถามใหม่ หากใช้ Groq Compound ให้ลองโมเดล groq/compound-mini',
    intent: 'ยังใช้ห้อง AI อัตโนมัติไม่ได้ เจ้าของบอตต้องเปิด Message Content Intent ใน Discord Developer Portal → Bot → Privileged Gateway Intents แล้วตั้ง MESSAGE_CONTENT_ENABLED=true และรีสตาร์ตบอต ระหว่างนี้ใช้ /ask หรือ @mention ได้',
    channel_permissions: 'บอตเข้าถึงห้องนี้ไม่ได้ กรุณาให้สิทธิ์ View Channel, Send Messages และ Read Message History ในห้องที่เลือก',
    quota: '⚠️ Vaxir AI ใช้งานไม่ได้ชั่วคราว ผู้ให้บริการ AI ใช้งานครบโควตาแล้ว กรุณาลองใหม่ภายหลัง',
    timeout: 'ผู้ให้บริการ AI ตอบกลับช้าเกินไป กรุณาลองใหม่ภายหลัง',
    auth: 'ผู้ให้บริการ AI ปฏิเสธ API Key กรุณาแจ้งผู้ดูแลให้ตรวจสอบการตั้งค่า',
    model: 'โมเดลหรือคำขอไม่รองรับ กรุณาแจ้งผู้ดูแลให้ตรวจสอบการตั้งค่าโมเดล',
    unavailable: 'Vaxir AI ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง',
    malformed: 'ผู้ให้บริการ AI ไม่ได้ส่งคำตอบที่ใช้งานได้ กรุณาลองใหม่ภายหลัง',
    input: 'กรุณาส่งข้อความที่ไม่ว่างและไม่เกินขีดจำกัดความยาวที่ตั้งไว้',
    limited: 'คุณส่งคำขอครบจำนวนที่กำหนดแล้ว กรุณารอสักครู่',
    disabled: 'ผู้ดูแลปิดการใช้งาน AI ในเซิร์ฟเวอร์นี้แล้ว',
    config: 'ยังตั้งค่า AI ไม่ครบหรืออ่านการตั้งค่าไม่ได้ กรุณาแจ้งผู้ดูแล',
    busy: 'มีคำขอที่กำลังทำงานอยู่ กรุณารอให้เสร็จก่อนแล้วลองอีกครั้ง',
  };
  const retry = error instanceof AppError && error.retryAfter ? ` (ลองอีกครั้งใน ${Math.ceil(error.retryAfter)} วินาที)` : '';
  const channel = error instanceof AppError && error.code === 'wrong_ai_channel' && /^\d{17,20}$/.test(error.channelId ?? '') ? ` กรุณาไปใช้ที่ห้อง <#${error.channelId}>` : '';
  return messages[code] + channel + retry;
}
// Deliberately allow only internal event identifiers and typed error categories.
// Never serialize exception objects, HTTP bodies, Discord payloads, or prompts.
export function safeLog(event: 'ready' | 'startup_failed' | 'request_failed' | 'discord_failed' | 'registered' | 'shutdown' | 'maintenance_failed' | 'smoke_ok' | 'smoke_failed', error?: unknown): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, code: error === undefined ? undefined : error instanceof AppError ? error.code : 'internal' }));
}
