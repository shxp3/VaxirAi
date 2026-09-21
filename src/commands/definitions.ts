import { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits, ChannelType } from 'discord.js';
export const commands = [
  new SlashCommandBuilder().setName('server-plan').setDescription('วางแผนจัดการช่อง Role และสมาชิก ก่อนกด Accept').setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('instruction').setDescription('จัดการช่อง สิทธิ์ Role สมาชิก หรือคำสั่งดูแลเซิร์ฟเวอร์').setRequired(true).setMaxLength(3000)),
  new SlashCommandBuilder().setName('ask').setDescription('ถาม Vaxir AI').setContexts(InteractionContextType.Guild)
    .addStringOption(o => o.setName('message').setDescription('ข้อความที่ต้องการถาม (เว้นว่างได้เมื่อแนบไฟล์)').setMaxLength(6000))
    .addAttachmentOption(o => o.setName('file').setDescription('รูปภาพหรือไฟล์ข้อความ/โค้ดที่ต้องการให้ AI อ่าน')),
  new SlashCommandBuilder().setName('imagine').setDescription('สร้างหรือแต่งรูปภาพ (แนบรูปเพื่อสั่งแก้ไข)').setContexts(InteractionContextType.Guild)
    .addStringOption(o => o.setName('prompt').setDescription('คำอธิบายรูปที่ต้องการ (สูงสุด 1000 ตัวอักษร)').setRequired(true).setMaxLength(1000))
    .addAttachmentOption(o => o.setName('image').setDescription('รูปต้นฉบับที่ต้องการแก้ไข (JPG/PNG/GIF/WebP)'))
    .addStringOption(o => o.setName('aspect').setDescription('สัดส่วนภาพ').addChoices(
      { name: '1:1', value: '1:1' }, { name: '16:9', value: '16:9' }, { name: '9:16', value: '9:16' },
      { name: '4:3', value: '4:3' }, { name: '3:4', value: '3:4' },
    )),
  new SlashCommandBuilder().setName('clear').setDescription('ล้างบทสนทนาของคุณในห้องนี้').setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('regenerate').setDescription('ตอบคำถามล่าสุดใหม่อีกครั้ง').setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('summarize').setDescription('สรุปบทสนทนาของคุณในห้องนี้').setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('help').setDescription('วิธีใช้ Vaxir AI และคำสั่งทั้งหมด').setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('usage').setDescription('สถิติการใช้งาน AI (แอดมิน)').setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('status').setDescription('สถานะและการตั้งค่า AI').setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder().setName('setup').setDescription('ตั้งค่า Vaxir AI').setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('provider').setDescription('ตั้งค่า provider และ API Key ผ่านแบบฟอร์มส่วนตัว'))
    .addSubcommand(s => s.setName('image').setDescription('ตั้งค่าโมเดลรูปภาพ OpenRouter ผ่านแบบฟอร์มส่วนตัว'))
    .addSubcommand(s => s.setName('reset-provider').setDescription('ลบ API Key ของเซิร์ฟเวอร์และใช้ค่าเริ่มต้น'))
    .addSubcommand(s => s.setName('reset-image').setDescription('ลบโมเดลรูปภาพของเซิร์ฟเวอร์และใช้ค่าเริ่มต้น'))
    .addSubcommand(s => s.setName('instructions').setDescription('กำหนดบุคลิก AI สำหรับเซิร์ฟเวอร์')
      .addStringOption(o => o.setName('text').setDescription('บุคลิกและรูปแบบการตอบ สูงสุด 4,000 ตัวอักษร').setMaxLength(4000))
      .addAttachmentOption(o => o.setName('file').setDescription('ไฟล์ Markdown หรือไฟล์ข้อความสำหรับ Instructions')))
    .addSubcommand(s => s.setName('reset-instructions').setDescription('ล้างบุคลิก AI และกลับไปใช้ค่าเริ่มต้น'))
    .addSubcommand(s => s.setName('ai-channel').setDescription('ตั้งห้อง AI หรือเว้นว่างเพื่อลบห้อง AI').addChannelOption(o => o.setName('channel').setDescription('ห้อง AI').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('limits').setDescription('ตั้งค่าขีดจำกัด').addIntegerOption(o => o.setName('requests').setDescription('คำขอต่อผู้ใช้ต่อช่วงเวลา').setMinValue(1).setMaxValue(100)).addIntegerOption(o => o.setName('context').setDescription('จำนวนข้อความความจำ 0 = ปิด').setMinValue(0).setMaxValue(40)))
    .addSubcommand(s => s.setName('enabled').setDescription('เปิดหรือปิด AI').addBooleanOption(o => o.setName('value').setDescription('เปิดใช้งาน').setRequired(true))),
];
