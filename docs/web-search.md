# ค้นเว็บด้วย Groq Compound

ตั้ง `/setup provider` เป็น provider `groq`, model `groq/compound` หรือ `groq/compound-mini`, ใส่ Groq API Key และเว้น Gateway URL ว่าง สร้าง key ได้ที่ https://console.groq.com/keys

บอตเปิดเฉพาะ `web_search` และ `visit_website` โดยส่ง `compound_custom.tools.enabled_tools` ไม่เปิด code execution Compound เลือกใช้เครื่องมือตามคำถามเอง ลอง `/ask message:ค้นเว็บข่าวเทคโนโลยีล่าสุด พร้อมลิงก์แหล่งข้อมูล` คำตอบถูกขอให้อ้าง URL จากผลเครื่องมือ แต่บอตยังไม่ได้ตรวจความถูกต้องของ citation ทีละรายการ ไม่รับประกันว่าคำถามทุกข้อจะเรียกค้นเว็บ

หลังอัปเดตโค้ด ให้หยุด process เดิมแล้ว `npm.cmd run build` และ `npm.cmd start` ไม่มีการเปลี่ยน provider ของเซิร์ฟเวอร์ให้อัตโนมัติ

ตรวจวันที่ 2026-09-08: Groq แสดง Compound และ Compound Mini ใน Free Plan Limits ที่ 30 RPM, 250 RPD, 70K TPM ต่อโมเดล ตรวจข้อจำกัดจริงในบัญชีอีกครั้ง ไม่ใช่บริการฟรีแบบไม่จำกัด ส่วน OpenRouter Web Search มีค่าใช้จ่ายเพิ่มแม้ใช้โมเดลฟรี

เอกสาร: https://console.groq.com/docs/rate-limits , https://console.groq.com/docs/compound/built-in-tools , https://openrouter.ai/docs/guides/features/plugins/web-search

ตรวจ request payload ด้วย automated tests แล้ว ยังไม่ได้ทดสอบค้นเว็บกับบัญชี Groq จริงเพราะยังไม่มี Groq API Key สำหรับการทดสอบ
