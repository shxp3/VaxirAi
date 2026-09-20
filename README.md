# Vaxir AI

บอต Discord สำหรับถาม AI และคำถามเขียนโค้ด รองรับ Gemini, Groq, OpenRouter และบริการที่รองรับ Chat Completions ผ่าน HTTPS ใช้ TypeScript, discord.js และ Node.js 24 พร้อม SQLite

## ความสามารถ

- `/ask message` ถาม AI, `/clear` ล้างความจำของคุณในห้องปัจจุบัน
- เมื่อ AI เขียนโค้ด บอตจะแยก fenced code block เป็นไฟล์แนบตามภาษา เช่น `code-1.java` หรือ `code-1.py` และแสดงเฉพาะคำอธิบายในข้อความ
- เมื่อถามตัวตน บอตตอบว่า Vaxir AI สร้างโดย `shxp3` และรายงาน provider/model จากค่าที่กำลังใช้งานจริง โดยไม่เปิดเผย Key หรือ Gateway URL
- `/ask file` อ่านรูป JPG/PNG/GIF/WebP และไฟล์ข้อความหรือโค้ด UTF-8 หรือแนบหลายไฟล์ผ่านข้อความในห้อง AI/mention ได้สูงสุดตามค่าที่กำหนด รูปถูกส่งให้โมเดลเฉพาะคำขอปัจจุบันและไม่บันทึก Base64 ลง memory
- เรียกด้วย `@Vaxir AI` หรือคุยในห้อง AI ที่แอดมินกำหนด เมื่อกำหนดห้องแล้ว `/ask` และ mention จากห้องอื่นจะถูกปฏิเสธพร้อมลิงก์ไปยังห้อง AI ไม่อ่านข้อความย้อนหลังทั้งเซิร์ฟเวอร์มาเป็นบริบท
- `/setup` และ `/status` สำหรับผู้มีสิทธิ์ Administrator เท่านั้น ตรวจสิทธิ์ซ้ำเมื่อส่งแบบฟอร์ม
- API Key ของเซิร์ฟเวอร์เข้ารหัส AES-256-GCM โดยใช้กุญแจจาก environment และผูก ciphertext กับ server ID
- ใช้ provider เริ่มต้นของเจ้าของบอตเมื่อเซิร์ฟเวอร์ไม่ได้ตั้ง provider ของตนเอง ไม่มี automatic fallback เมื่อ provider ล้มเหลว
- จำกัดคำขอต่อผู้ใช้ข้ามห้อง/เซิร์ฟเวอร์ พร้อมขีดจำกัดรวมของบอต ป้องกันคำขอซ้อนในบทสนทนาเดียว
- จัดการ quota, timeout, key/model ผิด และผลลัพธ์ผิดรูปแบบโดยไม่ส่ง raw error ไป Discord
- เก็บเฉพาะคู่คำถาม/คำตอบที่สำเร็จ แยก server/channel/user จำกัดจำนวนข้อความและลบข้อมูลเก่าตาม TTL
- ส่งโค้ดเป็นข้อความเท่านั้น ไม่ประมวลผลโค้ด และปิดการ ping จากคำตอบ AI

## สถานะการตรวจสอบ

ทดสอบในเครื่องด้วย Node.js 24: type check, build และ automated tests ใช้ provider จำลองและฐานข้อมูล SQLite จริง ยังไม่ได้ทดสอบ Discord Gateway, AI API จริง หรือ deploy บน cloud เพราะไม่มี credentials และไม่มี Docker ในเครื่องที่ใช้พัฒนา จึงยังไม่ยืนยันว่าโครงการผ่าน definition of done ด้านการเชื่อมต่อจริง

## สิ่งที่ต้องมี

- Node.js **24.x** และ npm
- Discord application ที่มี bot token และ Application ID
- AI API Key และ Model ID ที่บัญชีของคุณมีสิทธิ์ใช้งาน หรือให้แต่ละเซิร์ฟเวอร์ตั้งเอง
- Docker Engine และ Compose plugin เฉพาะกรณี deploy ด้วย Docker

## เริ่มใช้งานในเครื่อง

```powershell
npm.cmd ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

นำค่าที่สุ่มได้ใส่ `ENCRYPTION_KEY` ใน `.env` และเก็บสำรองอย่างปลอดภัย กรอก `DISCORD_TOKEN` และ `DISCORD_CLIENT_ID` ส่วนค่า AI เริ่มต้นเว้นว่างได้ แล้วตั้งผ่าน `/setup provider` ใน Discord อย่าส่ง secret ในแชตหรือ commit `.env` ห้ามเปลี่ยน ENCRYPTION_KEY โดยไม่มีการย้ายข้อมูล: key เดิมที่บันทึกไว้จะถอดรหัสไม่ได้ ต้องใช้ key เดิมหรือให้แอดมินตั้ง API Key ใหม่

บน Linux/macOS ใช้ `npm` แทน `npm.cmd` และ `cp .env.example .env` ไฟล์ `.env` ใช้เฉพาะเครื่องของคุณ ไม่ถูกเพิ่มเข้า Docker image

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run register
npm.cmd start
```

`register` แทนที่ชุด slash commands ของ application ใน scope ที่เลือก ควรใช้ Discord application เฉพาะของ Vaxir AI ตั้ง `DISCORD_GUILD_ID` เป็นเซิร์ฟเวอร์ทดสอบเพื่อ register เฉพาะที่นั่น หรือเว้นว่างเพื่อใช้ global commands อย่าลงทะเบียนทั้งสอง scope ในเซิร์ฟเวอร์เดียวถ้าไม่ต้องการคำสั่งซ้ำ

หากตั้ง AI ผ่าน Discord ให้ทดสอบด้วย `/ask` หลัง `/setup provider` หากตั้ง default AI ใน environment ใช้ `npm.cmd run smoke:ai` เพื่อส่งคำถามสั้นหนึ่งคำถามไปยัง default provider จริงและใช้ quota โดยไม่พิมพ์คำตอบหรือ secret ตรวจผลด้วย exit code และ event `smoke_ok` ส่วน `ready` หมายถึงเชื่อม Discord สำเร็จ ไม่ได้ยืนยัน AI พร้อมตอบ

ใช้ `npm.cmd run dev` สำหรับรัน TypeScript ระหว่างพัฒนา

## สร้าง Discord application

1. เปิด [Discord Developer Portal](https://discord.com/developers/applications) สร้าง application และตั้งชื่อ Vaxir AI
2. หน้า Bot สร้าง/คัดลอก bot token ลง `.env` และเปิด **Message Content Intent** เพื่อรับข้อความในห้อง AI
3. คัดลอก Application ID ลง `DISCORD_CLIENT_ID`
4. สร้างลิงก์ติดตั้งแบบ Guild Install ด้วย scopes `bot` และ `applications.commands`
5. ให้บอตมี View Channels, Send Messages และ Read Message History ในห้องที่ต้องใช้ ถ้าจะเรียกใน thread ให้สิทธิ์ Send Messages in Threads ด้วย บอตไม่ต้องมี Administrator
6. เชิญเข้าเซิร์ฟเวอร์แล้วรัน register จากนั้น start

หากไม่ใช้ห้อง AI ตั้ง `MESSAGE_CONTENT_ENABLED=false` ได้ ยังใช้ slash commands และ direct mention ได้ การอ่านห้องอัตโนมัติต้องเปิด intent ทั้งใน Portal และ configuration แอปที่มีขนาดถึงเกณฑ์ Discord อาจต้องได้รับอนุมัติ privileged intent ตาม [Gateway documentation](https://docs.discord.com/developers/events/gateway)

คำสั่งถาม AI จะ defer ก่อนเรียก provider เพื่อให้ทันเวลารับ interaction ตาม [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)

## ตั้งค่า AI

ค่าเริ่มต้นของเจ้าของบอต:

```dotenv
DEFAULT_AI_PROVIDER=gemini
DEFAULT_AI_MODEL=your-available-model-id
DEFAULT_AI_API_KEY=your-private-key
```

Model ID ในตัวอย่างเป็น placeholder ต้องแทนด้วยโมเดลจริงในบัญชี ไม่มีการ hardcode โมเดลหรือสมมติว่าโมเดลใช้ฟรี

| Provider | ค่า configuration | API ที่ใช้ |
| --- | --- | --- |
| Gemini | `gemini` | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| Groq | `groq` | `api.groq.com/openai/v1/chat/completions` |
| OpenRouter | `openrouter` | `openrouter.ai/api/v1/chat/completions` |
| Custom | `custom` | `{baseUrl}/chat/completions` |

Custom ตั้งผ่าน `/setup provider` โดยเลือก `custom` แล้วกรอก API Gateway base URL เช่น `https://llm.example.com/v1` พร้อม model และ API Key ไม่ต้องใส่ค่า AI ใน environment บอตจะโหลดค่าของเซิร์ฟเวอร์สำหรับคำขอถัดไปทันที Gateway ต้องเป็น HTTPS port 443 บน IP สาธารณะ บอตตรวจ DNS ทุกคำขอและตรึง IP ที่ตรวจแล้วกับการเชื่อมต่อ TLS ไม่ตาม redirects ไม่รับ private/loopback/metadata IP หรือ URL ที่มี credentials/query/fragment หรือ IP literal

`CUSTOM_AI_ALLOWED_BASE_URLS` เป็นข้อจำกัดเพิ่มเติมที่เจ้าของบอตเลือกใช้ได้: เว้นว่างเพื่อให้แอดมินตั้ง public gateway ได้ หรือกรอก base URL เต็มรวม path คั่นด้วย comma เพื่อจำกัดเฉพาะรายการ หากใช้ default custom จาก environment ให้ตั้ง `DEFAULT_AI_BASE_URL` ด้วย

Custom เลือก API ใน `/setup provider` ได้สามแบบ: `chat` (Chat Completions), `responses` (Responses API) และ `messages` (Anthropic-compatible Messages API) เว้นว่างเพื่อเลือกอัตโนมัติ โดยใช้ `chat` เป็นค่าเริ่มต้น ยกเว้น Base URL `https://api.justwoker.icu/v1` จะใช้ `messages` และเรียก `/v1/messages` ผ่าน Key ของ JustDoWork โมเดลยังเป็น ID ที่ผู้ใช้เลือก ไม่มีการเปลี่ยนโมเดลตามชื่อโปรโตคอล `/status` แสดง API ที่เลือก และทุกแบบใช้การตรวจ HTTPS/DNS ของ custom gateway ตามเดิม

ตรวจ JustDoWork วันที่ 2026-09-08: โมเดล `gpt-5.6-luna` ตอบข้อความผ่าน Messages API ด้วย Key จริงสำเร็จ ส่วน `/v1/chat/completions` ถูกบล็อกด้วย HTML 403 และ `/v1/responses` ตอบ `convert_request_failed / not implemented` จึงเลือก Messages โดยตรง ไม่มีการลองยิงซ้ำอัตโนมัติหลาย endpoint ข้อมูลนี้เป็นผลทดสอบ ณ เวลาหนึ่ง ไม่รับประกัน uptime หรือการค้นเว็บ โปรโตคอลอ้างอิงจาก [Messages API](https://platform.claude.com/docs/en/api/http/messages/create) และ [Responses API](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)

ระบบ Search Grounding แยกจาก AI provider และใช้ [Brave LLM Context API](https://api-dashboard.search.brave.com/documentation/services/llm-context) ค้นเนื้อหาเว็บพร้อม URL ก่อนส่งให้โมเดล จึงใช้กับ JustDoWork ได้ เจ้าของบอตตั้งค่ากลางใน `.env` เท่านั้น แอดมินแต่ละเซิร์ฟเวอร์ไม่สามารถดูหรือเปลี่ยน Search Key ได้ โหมด `auto` ค้นเฉพาะคำถามที่น่าจะต้องใช้ข้อมูลปัจจุบันหรือผู้ใช้สั่งค้น ส่วน `always` ค้นทุกคำถาม บอตขอผลลัพธ์เพิ่มแล้วจัดอันดับใหม่จาก ISO timestamp, วัน/เดือน/ปี และปี พ.ศ. เพื่อเลือกแหล่งที่ใกล้เวลาปัจจุบันที่สุดก่อน ผลค้นถูกทำเครื่องหมายเป็นข้อมูลที่ไม่น่าเชื่อถือและจำกัดจำนวนแหล่งกับขนาด บอตซ่อนรายการ URL ตามปกติและแสดงเมื่อผู้ใช้ขอแหล่งข้อมูล อ้างอิง หรือลิงก์ หาก Search API ล้มเหลว บอตจะแจ้งข้อผิดพลาดแทนการตอบข้อมูลปัจจุบันโดยไม่มีหลักฐาน

คำสั่งแอดมิน:

| คำสั่ง | ผลลัพธ์ |
| --- | --- |
| `/setup provider` | เปิด modal กรอก provider/model/key/base URL; ไม่ส่ง key เป็นข้อความในห้อง |
| `/setup reset-provider` | ลบ key/config ของเซิร์ฟเวอร์ กลับไปใช้ default |
| `/setup instructions text:...` | กำหนดบุคลิกและรูปแบบการตอบของ AI สำหรับเซิร์ฟเวอร์ (สูงสุด 4,000 ตัวอักษร) |
| `/setup instructions file:instructions.md` | กำหนด Instructions จากไฟล์ Markdown/ข้อความ UTF-8 สูงสุดตาม `MAX_ATTACHMENT_BYTES` |
| `/setup reset-instructions` | ล้างบุคลิกที่กำหนดและกลับไปใช้ค่าเริ่มต้น |
| `/setup ai-channel channel:#ai-chat` | ตั้งห้อง AI; เว้น channel เพื่อลบการตั้งห้อง |
| `/setup limits requests:5 context:20` | จำกัด requests ต่อช่วงเวลาที่เจ้าของบอตตั้ง และจำนวนข้อความความจำ |
| `/setup enabled value:false` | ปิด AI ของเซิร์ฟเวอร์ |
| `/status` | แสดง provider/model/สถานะ search กลาง/ห้อง/limits โดยไม่ตรวจการเชื่อมต่อและไม่แสดง key |

แบบฟอร์ม API Key เป็น private interaction แต่ช่องกรอกของ Discord ไม่ใช่ password field แบบปิดบังตัวอักษร และข้อมูลส่งผ่าน Discord ไปยังบอต อย่าแชร์หน้าจอระหว่างกรอก หากไม่ต้องการส่ง key ผ่าน Discord ให้ใช้ default key จาก environment แทน

ทุกครั้งที่เปลี่ยนการตั้งค่าจะล้างความจำเดิมของเซิร์ฟเวอร์ คำตอบที่กำลังประมวลผลด้วย revision เก่าจะถูกทิ้ง ค่า context คี่จะปัดลงเป็นเลขคู่เพื่อเก็บคู่ user/assistant ตั้ง 0 เพื่อปิดความจำ ค่าบทสนทนายังคงอยู่หลัง restart แต่ rate-limit counters เริ่มใหม่

## Environment variables

| ตัวแปร | ค่าเริ่มต้น / ความหมาย |
| --- | --- |
| `DISCORD_TOKEN` | ต้องมีสำหรับ start/register |
| `DISCORD_CLIENT_ID` | ต้องมีสำหรับ register |
| `DISCORD_GUILD_ID` | ว่าง = global registration |
| `DEFAULT_AI_PROVIDER` | `gemini`; รองรับ `groq`, `openrouter`, `custom` |
| `DEFAULT_AI_MODEL`, `DEFAULT_AI_API_KEY` | ว่าง; ต้องตั้งเมื่อใช้ default AI |
| `DEFAULT_AI_BASE_URL` | สำหรับ custom เท่านั้น |
| `ENCRYPTION_KEY` | ต้องมีสำหรับ start; random 32 bytes เป็น canonical base64 |
| `DATABASE_URL` | `./data/vaxir.sqlite`; เป็น **SQLite file path** ไม่ใช่ PostgreSQL URL |
| `USER_RATE_LIMIT` | 5 requests ต่อผู้ใช้ ค่าเริ่มต้นของเซิร์ฟเวอร์ |
| `RATE_WINDOW_SECONDS` | 60 วินาที |
| `GLOBAL_RATE_LIMIT` | 20 requests ต่อช่วงเวลา รวมทุกเซิร์ฟเวอร์/provider |
| `AI_REQUEST_INTERVAL_MS` | 3000 ms ระหว่างเริ่มคำขอที่ใช้ปลายทางและ API key เดียวกัน |
| `CONTEXT_MESSAGE_LIMIT` | 20 ข้อความ สูงสุด 40 |
| `MAX_PROMPT_CHARS` | 16777216; ข้อความในช่อง slash command รับสูงสุด 6000 ตัวอักษร และไฟล์จะถูกนับรวมในขีดจำกัดนี้ |
| `MAX_ATTACHMENT_BYTES` | 15728640 bytes (15 MiB) ต่อไฟล์; ตรวจทั้งขนาดที่ Discord แจ้งและข้อมูลที่ดาวน์โหลดจริง |
| `MAX_IMAGE_BYTES` | 2097152 bytes ต่อรูป; Base64 ทำให้ request ที่ส่งไป provider ใหญ่กว่าขนาดไฟล์ |
| `MAX_ATTACHMENTS` | 3 ไฟล์ต่อข้อความ; `/ask` รองรับช่องแนบหนึ่งไฟล์ ส่วนข้อความปกติรองรับตามค่านี้ |
| `MAX_OUTPUT_TOKENS` | 1024 |
| `MAX_RESPONSE_CHARS` | 12000; ตัดข้อความส่วนเกินและแบ่งส่งให้พอดี Discord |
| `AI_TIMEOUT_MS` | 45000; สูงสุด 120000 |
| `MAX_CONCURRENT_REQUESTS` | 2 รวมคำขอที่กำลังรอคิว AI |
| `MEMORY_TTL_HOURS` | 168; ไม่โหลดบริบทที่หมดอายุ และเก็บกวาดเมื่อ start/ทุกชั่วโมง |
| `MESSAGE_CONTENT_ENABLED` | `true` |
| `BRAVE_SEARCH_API_KEY` | ว่าง = ปิด Search Grounding; ใส่ Brave Search Key เพื่อเปิดให้ทุกเซิร์ฟเวอร์ |
| `SEARCH_MODE` | `auto` ค้นเมื่อคำถามต้องใช้ข้อมูลปัจจุบัน; `always` ค้นทุกคำถาม |
| `SEARCH_COUNTRY` | `ALL`; ไม่จำกัดประเทศ หรือใช้ประเทศที่ Brave รองรับ |
| `SEARCH_LANGUAGE` | `en`; ใช้กับคำค้นแบบผสมเพื่อให้ Brave คืนผลสำหรับคำถามภาษาไทย แล้ว AI ตอบเป็นภาษาเดิมของผู้ใช้ |
| `CUSTOM_AI_ALLOWED_BASE_URLS` | ว่าง = อนุญาต public HTTPS gateways; ใส่รายการเพื่อจำกัดเพิ่มเติม |

ข้อความบทสนทนาบันทึกเป็น plaintext ใน SQLite; encryption ในรุ่นนี้ใช้กับ API Key เท่านั้น จำกัดสิทธิ์ไฟล์และป้องกัน backup ด้วย Conversation TTL ไม่ได้ลบข้อมูลจาก backup หรือข้อความที่อยู่ใน Discord/provider เอง คำขอล้มเหลวจาก provider ยังนับ rate limit เพื่อลดการยิงซ้ำ มี global cap ช่วยจำกัดการใช้ default quota ร่วมกัน

## Deploy บนเครื่อง cloud

ใช้ **หนึ่ง process/หนึ่ง replica** ที่เชื่อม Gateway ต่อเนื่องและมี persistent disk สำหรับ SQLite สถาปัตยกรรมนี้ไม่เหมาะกับ serverless HTTP function ที่หยุด process หลังตอบ interaction เพราะต้องรับข้อความห้องและ mention แบบต่อเนื่อง

ตรวจเอกสาร hosting วันที่ **8 กันยายน 2026**:

- [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm): VM เป็นทางเลือกสำหรับการรันต่อเนื่องโดยไม่เปิด PC ส่วนตัว แต่ขึ้นกับทรัพยากร/สิทธิ์บัญชี และ Oracle อาจ reclaim เครื่อง idle จึงไม่มีการรับประกัน uptime ฟรี ใช้เฉพาะทรัพยากรที่ console ระบุ Always Free eligible
- [Render](https://render.com/docs/faq): free web service หยุดเมื่อไม่มี incoming traffic 15 นาที และ [persistent disk ต้องใช้บริการแบบเสียเงิน](https://render.com/docs/disks) จึงไม่เลือก free web service สำหรับบอตนี้
- [Railway](https://docs.railway.com/pricing): Free มี resource allowance จำกัด ไม่ควรสมมติว่าเพียงพอสำหรับบอต 24/7 ต้องดูการใช้จริงและราคาในบัญชี

ตัวเลือกหลักคือ Linux VM ที่มี persistent storage เช่น Oracle Always Free เมื่อสร้างได้ หรือ VPS ที่คุณมีอยู่แล้ว:

1. สร้าง Ubuntu VM ที่มี outbound HTTPS และ DNS ไม่ต้องเปิด HTTP port ของบอต จำกัด SSH ให้เข้าจาก IP ของคุณ
2. ติดตั้ง Docker Engine และ Compose plugin ตาม [คู่มือ Docker สำหรับ Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
3. คัดลอก source, package-lock และไฟล์ deployment ไป VM สร้าง `.env` บน VM แล้ว `chmod 600 .env`
4. ลงทะเบียน commands จากเครื่องพัฒนาหนึ่งครั้ง; เมื่อเปลี่ยน definitions จึง register ใหม่
5. รัน:

```sh
docker compose up -d --build
docker compose logs --tail=50 -f bot
```

ตรวจ event `ready` แล้วทำรายการทดสอบจริงด้านล่าง Container ใช้ผู้ใช้ `node`, restart policy, log rotation และ volume ถาวร ไม่เปิด inbound ports

อัปเดตด้วยการคัดลอก source ใหม่แล้ว `docker compose up -d --build` หยุดด้วย `docker compose stop` อย่าใช้ `docker compose down -v` หากต้องการเก็บฐานข้อมูล สำรองทั้ง volume และ ENCRYPTION_KEY แยกจากกัน: หยุดบอตก่อนคัดลอกฐานข้อมูลรวมไฟล์ WAL/SHM หรือใช้ SQLite backup API แล้วเปิดกลับ ห้ามคัดลอกเฉพาะไฟล์ `.sqlite` ขณะมี WAL write

Dockerfile/Compose เตรียมไว้ แต่ยังไม่ได้ build/run ด้วย Docker ในสภาพแวดล้อมพัฒนา ต้องตรวจบน VM จริงก่อนใช้งาน production

## เพิ่ม provider หรือเปลี่ยนฐานข้อมูล

สร้าง class ที่ implements `AIProvider.generate(messages, config, settings)` ใน `src/ai` และเพิ่มตัวเลือกใน types, env validation, factory และแบบฟอร์ม/README ใช้ `AppError` สำหรับข้อผิดพลาด ห้าม throw raw response ไป Discord เพิ่ม contract test สำหรับ request/response และ error handling

`Repository` ใน `src/database/repository.ts` แยก business logic ออกจาก storage มี SQLite implementation และ in-memory implementation สำหรับ tests สามารถเพิ่ม PostgreSQL/D1 adapter ภายหลัง แต่ D1 adapter ไม่ได้ทำให้ Gateway process กลายเป็น serverless โดยอัตโนมัติ การ scale หลาย replica ต้องย้าย rate limiter และ conversation locking ไป shared storage ด้วย

## Troubleshooting

- `startup_failed` / `config`: ตรวจตัวแปรที่ต้องมีและ ENCRYPTION_KEY ตาม `.env.example` บอตตั้งใจไม่พิมพ์ค่าที่ผิดเพื่อป้องกัน secret รั่ว
- ไม่เห็น slash command: ตรวจ Application ID, scope ที่ register, เซิร์ฟเวอร์ที่เชิญบอต และสิทธิ์ Use Application Commands
- Gateway ปิดด้วย privileged-intent error: ตรวจ Message Content Intent ใน Developer Portal หรือปิดฟีเจอร์ด้วย environment
- mention ใช้ได้แต่ห้อง AI ไม่ตอบ: ตรวจ `/setup ai-channel`, enabled, Message Content Intent และสิทธิ์บอตในห้อง
- key ใช้ไม่ได้: ตรวจ provider, key, สิทธิ์บัญชี และ model; การบันทึก setup ไม่ได้ตรวจ key จริงล่วงหน้า
- คำขอ AI ใช้คิวร่วมตาม origin ของ API และ key ข้ามเซิร์ฟเวอร์/โมเดลใน process เดียว ส่งทีละคำขอและเว้นระยะตาม `AI_REQUEST_INTERVAL_MS` คิวรับได้สูงสุด 8 คำขอรวมที่กำลังทำงาน เวลาเข้าคิวรวมอยู่ใน `AI_TIMEOUT_MS` และคำขอที่หมดเวลาก่อนส่งจะไม่เรียก API
- quota/429: พักคิวที่ใช้ปลายทางและ key เดียวกันตาม Retry-After (สูงสุด 24 ชั่วโมง) หรือ 60 วินาทีถ้าไม่มี รวมถึง quota error ใน HTTP 200 คำขอที่รอคิวจะได้รับแจ้งเวลาพัก ไม่มีการ retry อัตโนมัติหรือสลับ key/provider เพื่อเลี่ยงโควตา
- gateway_blocked: หมายถึง HTTP 403 ที่ไม่ใช่ JSON จากปลายทาง API ของ AI ไม่ใช่หลักฐานว่า Discord Gateway บล็อก พักคิว 5 นาทีหรือตาม Retry-After หากเกิดซ้ำให้ผู้ให้บริการตรวจสิทธิ์และ firewall
- log `upstream_http_failed` เก็บเวลา, HTTP status, ประเภท JSON/non-JSON และ CF-Ray/UUID request ID ที่ผ่านการตรวจรูปแบบ ไม่เก็บ key, URL, prompt หรือ response body การลดความถี่ไม่รับประกันว่าจะผ่านกฎ firewall
- คิวและเวลาพักอยู่ในหน่วยความจำและรีเซ็ตเมื่อรีสตาร์ต หากรันหลาย process/replica ต้องใช้ shared queue และ cooldown store เพื่อให้จำกัดร่วมกัน
- custom config error: ตรวจว่า DNS ชี้ไป IP สาธารณะ ใช้ HTTPS port 443 โดยไม่มี query/credentials และตรง allowlist หากเจ้าของบอตตั้งไว้
- ข้อความยาว: คำตอบแบ่งหลายข้อความและอาจตัดที่ MAX_RESPONSE_CHARS; code fence ข้ามข้อความอาจแสดงผลไม่ต่อเนื่อง
- ล้างบริบทขณะมีคำขอ: รอคำตอบจบแล้วใช้ `/clear` อีกครั้ง
- SQLite warning: API `node:sqlite` อาจมีสถานะ experimental ตาม Node 24 ที่ใช้ โครงการผูก runtime กับ Node 24; ตรวจ regression tests ก่อนอัปเกรด

เอกสาร provider ที่ใช้ตรวจ implementation: [Gemini generateContent](https://ai.google.dev/api/generate-content), [Gemini quota](https://ai.google.dev/gemini-api/docs/rate-limits), [Groq compatibility](https://console.groq.com/docs/openai), [Groq limits](https://console.groq.com/docs/rate-limits), [OpenRouter API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [OpenRouter FAQ](https://openrouter.ai/docs/faq) Quota ขึ้นกับบัญชี/โมเดลและเปลี่ยนได้ จึงไม่ hardcode ค่าฟรีจากเอกสาร

## รายการทดสอบจริงก่อนเปิดให้ใช้งาน

1. `npm run smoke:ai` ผ่านกับ provider จริงอย่างน้อยหนึ่งราย
2. Start แล้วเห็น `ready`; `/ask` ตอบได้ และถามต่อโดยอ้างบริบทเดิมได้
3. `/clear` แล้วถามต่อ ต้องไม่มีบริบทก่อนล้าง
4. ตั้งห้อง AI แล้วข้อความในห้องได้รับคำตอบ; นอกห้องตอบเฉพาะ direct mention หรือ `/ask`
5. ผู้ใช้ทั่วไปเปิด setup/status ไม่ได้; แอดมินตั้ง server key ได้ แล้ว reset กลับ default ได้
6. ทดสอบเกิน user limit และ key/model ผิด ได้ข้อความที่เข้าใจได้โดยไม่มี secret
7. Restart แล้ว settings/context ยังอยู่; ปิด AI แล้วไม่ยิง provider
8. ตรวจบน deployment จริง รวม restart, storage, สิทธิ์ห้อง และค่าใช้จ่าย/ทรัพยากร
