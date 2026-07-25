// Load .env directly — makes the app self-sufficient regardless of whether the
// launch script (start.sh) exports variables into the shell before running
// `node server.js`. Wrapped in try/catch so a missing `dotenv` package doesn't
// crash the app either — it just falls back to whatever the shell already exported.
try {
  require("dotenv").config();
} catch (e) {
  console.warn("dotenv not installed — relying on shell-exported environment variables. Run `npm install dotenv` to load .env automatically.");
}

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./sqlite-manager");

// QR-with-logo generation. Wrapped in try/catch so the app still boots (with plain QR
// generation disabled) if these haven't been installed yet — run:
//   npm install qrcode jimp --save
let QRCode = null, JimpLib = null;
try {
  QRCode = require("qrcode");
  JimpLib = require("jimp").Jimp;
} catch (e) {
  console.warn("qrcode/jimp not installed — payment QR endpoint will be unavailable. Run `npm install qrcode jimp --save`.");
}

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const WEB_URL = process.env.WEB_URL;
const PORT = process.env.PORT || 3000;
// OWNER_ID supports multiple comma-separated Telegram user IDs, e.g.:
//   OWNER_ID=123456789,987654321,555555555
// The FIRST id in the list is the "super owner" — used for the startup-required
// check and for permissions on /addowner & /removeowner below.
const OWNER_IDS = (process.env.OWNER_ID || "").split(",").map(s => parseInt(s.trim(), 10)).filter(Boolean);
const OWNER_ID = OWNER_IDS[0] || 0; // super owner — kept for backward compat with existing code below
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID) : null;
const UPI_ID = process.env.UPI_ID || "";
const UPI_NAME = process.env.UPI_NAME || ""; // payee name shown in the UPI app (pn= param) — set this in env, else falls back to a generic name
const PAYMENT_GROUP_ID = process.env.PAYMENT_GROUP_ID ? parseInt(process.env.PAYMENT_GROUP_ID) : null;
const CONTACT_LINK = process.env.CONTACT_LINK || "";

let BOT_USERNAME = "";
let bot = null;

if (!TOKEN || !MONGO_URI || !WEB_URL || !OWNER_ID) { console.error("Missing env: BOT_TOKEN, MONGO_URI, WEB_URL, OWNER_ID are required."); process.exit(1); }
if (!STORAGE_CHANNEL_ID) console.warn("Warning: STORAGE_CHANNEL_ID not set.");

// ── Multi-owner support with per-owner power control ─────────────────────────
// OWNER_ID (first id in the env OWNER_ID list) is the permanent "super owner" —
// it always has full power and is the only one allowed to add/remove owners or
// change their powers. Every other owner (whether from the env list or added
// via /addowner) can have three individual powers toggled on/off via /owners:
//   - forwardBypass: skip forward/save protection when receiving files
//   - adminPanel:    show the Admin button/panel in the Telegram Mini App
//   - broadcast:     allowed to use /broadcast
// New owners default to full power (all true) until explicitly restricted.
// Everything is persisted to disk (data/owners.json) so it survives restarts.
const OWNERS_FILE = path.join(__dirname, "data", "owners.json");
const OWNER_PERMS = ["forwardBypass", "adminPanel", "broadcast", "approvePayment"];
function loadOwnersData() {
  try {
    if (!fs.existsSync(OWNERS_FILE)) return {};
    const obj = JSON.parse(fs.readFileSync(OWNERS_FILE, "utf8"));
    return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
  } catch (e) { console.warn("Could not read data/owners.json, starting fresh:", e.message); return {}; }
}
function saveOwnersData() {
  try {
    fs.mkdirSync(path.dirname(OWNERS_FILE), { recursive: true });
    fs.writeFileSync(OWNERS_FILE, JSON.stringify(ownersData, null, 2));
  } catch (e) { console.error("Could not save data/owners.json:", e.message); }
}
const ownersData = loadOwnersData(); // { "<userId>": { forwardBypass, adminPanel, broadcast } } — only for non-super owners
function isSuperOwner(userId) { return userId === OWNER_ID; }
function isOwner(userId) { return OWNER_IDS.includes(userId) || Object.prototype.hasOwnProperty.call(ownersData, String(userId)); }
// hasPerm: super owner always full power; any other owner defaults to full
// power until a specific permission is explicitly set to false.
function hasPerm(userId, perm) {
  if (isSuperOwner(userId)) return true;
  if (!isOwner(userId)) return false;
  const rec = ownersData[String(userId)];
  return !rec || rec[perm] !== false;
}
function setPerm(userId, perm, value) {
  const key = String(userId);
  if (!ownersData[key]) ownersData[key] = {};
  ownersData[key][perm] = value;
  saveOwnersData();
}
function ensureOwnerRecord(userId) {
  const key = String(userId);
  if (!ownersData[key]) { ownersData[key] = {}; saveOwnersData(); }
}
// All manageable owners (excludes the super owner, who is always full power and not listed for editing)
function listManageableOwners() {
  const ids = new Set([...OWNER_IDS.filter((id) => id !== OWNER_ID), ...Object.keys(ownersData).map(Number)]);
  return [...ids];
}
function isGroupChat(msg) { return msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup"); }

// ── MongoDB Schemas (for backup writes only) ──────────────────────────────────
const fileSchema = new mongoose.Schema({ code: { type: String, required: true, unique: true }, file_id: { type: String, required: true }, file_type: { type: String, required: true }, file_name: { type: String, default: "file" }, uploaded_by: Number, expires_at: { type: Date, default: null }, delivered_to: [Number], delivered_at: { type: String, default: '{}' }, created_at: { type: Date, default: Date.now }, channel_msg_id: { type: Number, default: null } });
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({ batch_code: { type: String, required: true, unique: true }, user_id: Number, files: [{ file_id: String, file_type: String, file_name: { type: String, default: "file" } }], created_at: { type: Date, default: Date.now } });
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({ chat_id: Number, message_id: Number, delete_at: Date });
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

// Persisted job to remove a chatId from a file's delivered_to list once the 6h
// re-request cooldown expires — mirrors PendingDelete so it survives restarts
// instead of relying solely on an in-memory setTimeout (which was the bug:
// on restart the timer was lost and the chatId stayed in delivered_to forever).
const pendingUndeliverSchema = new mongoose.Schema({ file_record_id: String, code: String, chat_id: Number, undeliver_at: Date });
const PendingUndeliver = mongoose.model("PendingUndeliver", pendingUndeliverSchema);

const userSchema = new mongoose.Schema({ userId: { type: String, required: true, unique: true }, firstName: { type: String, default: "" }, lastName: { type: String, default: "" }, username: { type: String, default: "" }, firstSeen: { type: Date, default: Date.now }, lastSeen: { type: Date, default: Date.now } });
const User = mongoose.model("User", userSchema);

const dailyLimitSchema = new mongoose.Schema({ userId: { type: Number, required: true, unique: true }, count: { type: Number, default: 0 }, resetDate: { type: String, required: true } });
const DailyVideoLimit = mongoose.model("DailyVideoLimit", dailyLimitSchema);
const DAILY_VIDEO_LIMIT = 10;

// ── MongoDB connect ───────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(async () => {
  console.log("MongoDB connected");
  try { await mongoose.connection.collection("filerecords").dropIndex("expires_at_1"); } catch (e) {}
  try { await mongoose.connection.collection("filerecords").updateMany({ expires_at: { $ne: null } }, { $set: { expires_at: null } }); } catch (e) {}
  // Sync all MongoDB → SQLite on startup
  await db.syncFromMongo(mongoose);
}).catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTodayIST() { const now = new Date(); return new Date(now.getTime() + 5.5*60*60*1000).toISOString().slice(0,10); }

function peekVideoLimit(userId) {
  const today = getTodayIST();
  let rec = db.dailyVideoLimit.find(userId);
  if (!rec || rec.resetDate !== today) { db.dailyVideoLimit.upsert({ userId, count: 0, resetDate: today }); rec = { count: 0 }; }
  if (rec.count >= DAILY_VIDEO_LIMIT) return { allowed: false, used: rec.count, remaining: 0 };
  return { allowed: true, used: rec.count, remaining: DAILY_VIDEO_LIMIT - rec.count };
}

// Call only AFTER the file has actually been delivered successfully — never
// before sendFile(). Incrementing before delivery meant a failed send (dead
// file_id, Telegram error, etc.) still burned one of the user's 10 daily
// slots even though they received nothing, with no rollback on error.
function commitVideoLimitIncrement(userId) {
  const today = getTodayIST();
  let rec = db.dailyVideoLimit.find(userId);
  if (!rec || rec.resetDate !== today) rec = { count: 0 };
  const newCount = rec.count + 1;
  db.dailyVideoLimit.upsert({ userId, count: newCount, resetDate: today });
  DailyVideoLimit.findOneAndUpdate({ userId }, { userId, count: newCount, resetDate: today }, { upsert: true }).catch(() => {});
  return { allowed: true, used: newCount, remaining: DAILY_VIDEO_LIMIT - newCount };
}

function generateCode() { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; let c=""; for(let i=0;i<6;i++) c+=chars[Math.floor(Math.random()*chars.length)]; return c; }
function getUniqueCode() { let c; do { c = generateCode(); } while (db.fileRecord.findByCode(c)); return c; }
function getUniqueBatchCode() { let c; do { c = "B"+generateCode(); } while (db.bulkBatch.findByCode(c)); return c; }

function extractFileInfo(msg) {
  const caption = msg.caption || null;
  if (msg.document)   return { file_id: msg.document.file_id, file_type: "document", file_name: msg.document.file_name||"document", caption };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg", caption };
  if (msg.video)      return { file_id: msg.video.file_id, file_type: "video", file_name: msg.video.file_name||"video.mp4", caption };
  if (msg.audio)      return { file_id: msg.audio.file_id, file_type: "audio", file_name: msg.audio.file_name||"audio.mp3", caption };
  if (msg.voice)      return { file_id: msg.voice.file_id, file_type: "voice", file_name: "voice.ogg", caption };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4", caption: null };
  return null;
}

async function saveToStorageChannel(bot, fileInfo) {
  if (!STORAGE_CHANNEL_ID) return fileInfo;
  try {
    let sentMsg;
    const caption = fileInfo.caption || `📎 ${fileInfo.file_name}`;
    switch(fileInfo.file_type) {
      case "photo":      sentMsg = await bot.sendPhoto(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video":      sentMsg = await bot.sendVideo(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "audio":      sentMsg = await bot.sendAudio(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "voice":      sentMsg = await bot.sendVoice(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video_note": sentMsg = await bot.sendVideoNote(STORAGE_CHANNEL_ID, fileInfo.file_id); break;
      default:           sentMsg = await bot.sendDocument(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
    }
    const channelFileInfo = extractFileInfo(sentMsg);
    if (channelFileInfo) return { ...channelFileInfo, file_name: fileInfo.file_name, channel_msg_id: sentMsg.message_id };
    return { ...fileInfo, channel_msg_id: sentMsg.message_id };
  } catch (err) { console.error("saveToStorageChannel failed:", err.message); return fileInfo; }
}

async function sendFile(bot, chatId, record) {
  const caption = `📎 ${record.file_name}`;
  // Forward-restriction (protect_content) should only apply to videos — other file types
  // (photo, audio, voice, document) must stay freely forwardable even for non-owners.
  const isVideoType = record.file_type === "video" || record.file_type === "video_note";
  const protect = isVideoType && !hasPerm(chatId, "forwardBypass");
  try {
    switch(record.file_type) {
      case "photo":      return await bot.sendPhoto(chatId, record.file_id, { caption, protect_content: protect });
      case "video":      return await bot.sendVideo(chatId, record.file_id, { caption, protect_content: protect });
      case "audio":      return await bot.sendAudio(chatId, record.file_id, { caption, protect_content: protect });
      case "voice":      return await bot.sendVoice(chatId, record.file_id, { caption, protect_content: protect });
      case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: protect });
      default:           return await bot.sendDocument(chatId, record.file_id, { caption, filename: record.file_name, protect_content: protect });
    }
  } catch (err) {
    // file_id can go bad (e.g. after switching to a new bot token, since a
    // Telegram file_id is only valid for the bot that issued it). Fall back to
    // copying the mirrored message from the storage channel — but force our own
    // caption, otherwise Telegram keeps whatever caption was on that channel
    // message originally (old filename / promo text) instead of record.file_name.
    if (STORAGE_CHANNEL_ID && record.channel_msg_id) {
      try { return await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, record.channel_msg_id, { caption, protect_content: protect }); } catch (_) {}
    }
    throw err;
  }
}

let rmWords = [];
function cleanFileName(name) {
  if (!rmWords.length) return name;
  const extMatch = name.match(/(\.[a-zA-Z0-9]{1,6})$/);
  let result = extMatch ? name.slice(0,-extMatch[1].length) : name;
  for (const w of rmWords) { const wN=w.toLowerCase().replace(/_/g," "); let rN=result.toLowerCase().replace(/_/g," "); let idx; while((idx=rN.indexOf(wN))!==-1){result=result.slice(0,idx)+result.slice(idx+w.length);rN=result.toLowerCase().replace(/_/g," ");} }
  result = result.replace(/[_ .\-:]{2,}/g,"_").replace(/^[_ .\-:]+|[_ .\-:]+$/g,"").trim();
  return (extMatch ? result+extMatch[1] : result) || name;
}

async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  const id = db.generateId();
  db.pendingDelete.create({ id, chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt }).catch(() => {});
  const delay = Math.max(0, new Date(deleteAt) - Date.now());
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, messageId); } catch (err) { if (!err.message?.includes("message to delete not found")) console.error("Auto DM deletion error:", err.message); }
    db.pendingDelete.deleteByChatMsg(chatId, messageId);
    PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }, delay);
}

async function recoverPendingDeletes(bot) {
  const pending = db.pendingDelete.getAll();
  console.log(`Recovering ${pending.length} pending DM deletions...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try { await bot.deleteMessage(p.chat_id, p.message_id); } catch (err) { console.error("Recovered deletion error:", err.message); }
      db.pendingDelete.deleteById(p._id);
      PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

// delivered_at is stored as a JSON string (chatId -> timestamp) to mirror the
// SQLite column exactly; Mongo has no atomic op for "set one key inside a
// JSON string field", so this is a small best-effort read-modify-write,
// consistent with the existing fire-and-forget .catch(()=>{}) pattern here.
async function stampMongoDeliveredAt(fileRecordId, chatId, value) {
  try {
    const doc = await FileRecord.findById(fileRecordId).select('delivered_at').lean();
    if (!doc) return;
    const at = JSON.parse(doc.delivered_at || '{}');
    if (value === null) delete at[chatId]; else at[chatId] = value;
    await FileRecord.updateOne({ _id: fileRecordId }, { $set: { delivered_at: JSON.stringify(at) } });
  } catch (_) {}
}

// Persists the "un-deliver" job (like scheduleDelete persists the message-delete
// job) so a bot restart doesn't lose the timer and leave the chatId stuck in
// delivered_to forever — which was blocking re-requests after 6 hours.
async function scheduleUndeliver(fileRecordId, code, chatId, undeliverAt) {
  const id = db.generateId();
  db.pendingUndeliver.create({ id, file_record_id: fileRecordId, code, chat_id: chatId, undeliver_at: undeliverAt });
  PendingUndeliver.create({ file_record_id: fileRecordId, code, chat_id: chatId, undeliver_at: undeliverAt })
    .catch(err => console.error('PendingUndeliver mongo create error:', err.message));
  const delay = Math.max(0, new Date(undeliverAt) - Date.now());
  setTimeout(() => {
    db.fileRecord.removeDeliveredTo(fileRecordId, chatId);
    // Match by _id (=fileRecordId), not by code — code is only kept for
    // debugging and must never be a hard requirement for clearing delivered_to.
    FileRecord.updateOne({ _id: fileRecordId }, { $pull: { delivered_to: chatId } }).catch(() => {});
    stampMongoDeliveredAt(fileRecordId, chatId, null);
    db.pendingUndeliver.deleteById(id);
    PendingUndeliver.deleteOne({ file_record_id: fileRecordId, chat_id: chatId }).catch(() => {});
  }, delay);
}

async function recoverPendingUndelivers() {
  const pending = db.pendingUndeliver.getAll();
  console.log(`Recovering ${pending.length} pending file re-request cooldowns...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.undeliver_at) - Date.now());
    setTimeout(() => {
      db.fileRecord.removeDeliveredTo(p.file_record_id, p.chat_id);
      FileRecord.updateOne({ _id: p.file_record_id }, { $pull: { delivered_to: p.chat_id } }).catch(() => {});
      stampMongoDeliveredAt(p.file_record_id, p.chat_id, null);
      db.pendingUndeliver.deleteById(p._id);
      PendingUndeliver.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime(), mongo: mongoose.connection.readyState===1?"connected":"disconnected", sqlite: "active" }));
app.get("/api/config", (req, res) => {
  const fj = (process.env.FORCE_JOIN_CHANNELS||"").split(",").map(s=>s.trim()).filter(Boolean);
  const adminPanelOwnerIds = [...new Set([...OWNER_IDS, ...listManageableOwners()])].filter((id) => hasPerm(id, "adminPanel"));
  res.json({ ownerId: OWNER_ID, ownerIds: adminPanelOwnerIds, botUsername: BOT_USERNAME||"", forceJoinRequired: fj.length>0, upiId: UPI_ID||"", upiName: UPI_NAME||"", contactLink: CONTACT_LINK||`https://t.me/${BOT_USERNAME}` });
});

// Generates the payment UPI QR server-side (so it's a real, shareable/downloadable HTTPS
// URL — required for Telegram's native tg.downloadFile) and overlays public/logo.png in
// the center. errorCorrectionLevel "H" (30% redundancy) keeps the code scannable even with
// ~22% of the middle covered by the logo. If public/logo.png doesn't exist yet, falls back
// to a plain QR with no logo — drop your logo file in at public/logo.png to enable this.
app.get("/api/payment-qr", async (req, res) => {
  try {
    if (!QRCode || !JimpLib) return res.status(503).send("QR generator not installed on server. Run: npm install qrcode jimp --save");
    if (!UPI_ID) return res.status(404).send("UPI_ID not configured");
    const amount = req.query.amount ? Number(req.query.amount) : null;
    const note = (req.query.note || "Payment").toString().slice(0, 40);

    let upiStr = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(UPI_NAME || "Payment")}`;
    if (amount && amount > 0) upiStr += `&am=${amount.toFixed(2)}`;
    upiStr += `&cu=INR&tn=${encodeURIComponent("Payment for " + note)}`;

    const qrBuffer = await QRCode.toBuffer(upiStr, { errorCorrectionLevel: "H", width: 500, margin: 1 });
    const qrImg = await JimpLib.read(qrBuffer);

    const logoPath = path.join(__dirname, "public", "logo.png");
    if (fs.existsSync(logoPath)) {
      const logoImg = await JimpLib.read(logoPath);
      const qrSize = qrImg.bitmap.width;
      const logoSize = Math.floor(qrSize * 0.22);
      logoImg.resize({ w: logoSize, h: logoSize });

      const pad = Math.floor(logoSize * 0.12);
      const backdropSize = logoSize + pad * 2;
      const backdrop = new JimpLib({ width: backdropSize, height: backdropSize, color: 0xffffffff });
      const bx = Math.floor((qrSize - backdropSize) / 2), by = Math.floor((qrSize - backdropSize) / 2);
      qrImg.composite(backdrop, bx, by);

      const lx = Math.floor((qrSize - logoSize) / 2), ly = Math.floor((qrSize - logoSize) / 2);
      qrImg.composite(logoImg, lx, ly);
    }

    const outBuffer = await qrImg.getBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(outBuffer);
  } catch (e) {
    console.error("payment-qr error:", e);
    res.status(500).send("QR generation failed");
  }
});

const courseRoutes = require("./routes/course");
app.use("/api", courseRoutes);
const autoLectureSession = courseRoutes.autoLectureSession;
const autoAddLecture = courseRoutes.autoAddLecture;

app.post("/api/pay-request", async (req, res) => {
  try {
    const { batchId, userId, firstName, lastName, username, txnId, screenshotBase64, couponCode, discountPct, finalAmount } = req.body;
    if (!batchId || !txnId) return res.status(400).json({ error: "Missing fields" });
    const batchData = db.batch.getOne(batchId);
    const batchName = batchData ? batchData.name : batchId;
    const origPrice = batchData?.price ? `₹${batchData.price}` : "N/A";
    let priceLine = `💰 Amount: <b>${esc(origPrice)}</b>`;
    if (couponCode && discountPct && finalAmount!=null) priceLine = `💰 Original: <b>${esc(origPrice)}</b>\n🎟 Coupon: <code>${esc(couponCode)}</code> (${esc(String(discountPct))}% off)\n✅ Final: <b>₹${esc(String(finalAmount))}</b>`;
    const caption = `💸 <b>New Payment Request!</b>\n\n👤 <b>${esc(firstName)}${lastName?" "+esc(lastName):""}</b>\n🆔 UID: <code>${esc(userId)}</code>\n📱 @${username||"N/A"}\n\n📚 Batch: <b>${esc(batchName)}</b>\n${priceLine}\n🔖 UTR: <code>${esc(txnId)}</code>`;
    if (!PAYMENT_GROUP_ID) return res.status(500).json({ error: "PAYMENT_GROUP_ID not configured" });
    const kb = { inline_keyboard: [[{ text: "✅ Approve", callback_data: `pay_approve_${batchId}_${userId}` },{ text: "❌ Reject", callback_data: `pay_reject_${batchId}_${userId}` }]] };
    if (screenshotBase64) { const buf = Buffer.from(screenshotBase64.replace(/^data:image\/\w+;base64,/,""),"base64"); await bot.sendPhoto(PAYMENT_GROUP_ID, buf, { caption, parse_mode:"HTML", filename:`payment_${userId}.jpg`, reply_markup: kb }); }
    else await bot.sendMessage(PAYMENT_GROUP_ID, caption, { parse_mode:"HTML", reply_markup: kb });
    res.json({ success: true });
  } catch (err) { console.error("Payment request error:", err.message); res.status(500).json({ error: err.message }); }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ── Bulk sessions ─────────────────────────────────────────────────────────────
const bulkSessions = new Map();
const BULK_TIMEOUT_MS = 5 * 60 * 1000;

// ── Bot startup ───────────────────────────────────────────────────────────────
async function startBot() {
  try { await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(10000) }); } catch (_) {}
  console.log("Clearing old polling...");

  for (let attempt=1; attempt<=5; attempt++) {
    try { bot = new TelegramBot(TOKEN, { polling: { interval:2000, autoStart:false, params:{ timeout:30 } } }); await bot.getMe(); break; }
    catch (err) { console.error(`Bot init attempt ${attempt} failed`); if(attempt===5) throw err; await wait(5000*attempt); }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);

  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ menu_button:{ type:"web_app", text:"Open EduBot", web_app:{ url:WEB_URL } } }) });
    console.log("Menu button set:", WEB_URL);
  } catch (_) {}

  await recoverPendingDeletes(bot);
  await recoverPendingUndelivers();

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = match[1].trim();
    const isNewUser = userId ? !db.user.findOne(String(userId)) : false;

    if (userId) {
      db.user.upsert({ userId: String(userId), firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", firstSeen: new Date(), lastSeen: new Date() });
      User.findOneAndUpdate({ userId: String(userId) }, { userId: String(userId), firstName: msg.from.first_name||"", lastName: msg.from.last_name||"", username: msg.from.username||"", lastSeen: new Date() }, { upsert: true }).catch(() => {});
    }

    if (param) {
      if (param.startsWith("ref_")) {
        const referrerId = param.replace("ref_","");
        bot.sendMessage(chatId, `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚`, { reply_markup:{ inline_keyboard:[[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]] } });
        if (referrerId && referrerId !== String(userId)) {
          try {
            const r = await fetch(`http://localhost:${PORT}/api/refer/record`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ referrerId, referredId: String(userId), isNewUser }) });
            const d = await r.json();
            if (d.isNew) {
              const s = await (await fetch(`http://localhost:${PORT}/api/refer/stats/${referrerId}`)).json();
              bot.sendMessage(parseInt(referrerId), `🎉 <b>New Referral!</b>\n\n${msg.from.first_name} joined using your link!\n⭐ <b>+5 Points!</b> Total: <b>${s.points}</b>`, { parse_mode:"HTML" }).catch(() => {});
            }
          } catch (_) {}
        }
        return;
      }

      if (param.startsWith("buy_")) {
        bot.sendMessage(chatId, `💳 <b>Complete your payment in the app!</b>`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"💳 Pay Now", web_app:{ url:WEB_URL } }]] } });
        return;
      }

      if (param.startsWith("B")) {
        try {
          const batch = db.bulkBatch.findByCode(param);
          if (!batch) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
          let hasVideo = false, failedCount = 0;
          for (const f of batch.files) {
            let sentMsg;
            try {
              sentMsg = await sendFile(bot, chatId, f);
            } catch (fileErr) {
              // One broken file (dead file_id + no channel copy to fall back on) must
              // not abort the whole batch — skip it and keep sending the rest.
              failedCount++;
              continue;
            }
            if ((f.file_type==="video"||f.file_type==="video_note") && sentMsg) { hasVideo=true; await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000)); }
          }
          if (hasVideo) await bot.sendMessage(chatId, `⚠️ Videos will auto-delete after 6 hours.`);
          if (failedCount > 0) await bot.sendMessage(chatId, `⚠️ ${failedCount} file(s) in this batch couldn't be delivered (owner needs to re-upload them).`);
          return;
        } catch (err) { return bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      }

      // Single file
      try {
        const record = db.fileRecord.findByCode(param);
        if (!record) return bot.sendMessage(chatId, `File not found. Link may be invalid.`);
        const isVideo = record.file_type==="video"||record.file_type==="video_note";
        if (isVideo && db.fileRecord.isDeliveryActive(record.id, chatId, 6*60*60*1000)) return bot.sendMessage(chatId, `⚠️ This video was already delivered. You can request it again after 6 hours.`);
        if (isVideo && !isOwner(userId)) {
          const limCheck = peekVideoLimit(userId);
          if (!limCheck.allowed) return bot.sendMessage(chatId, `🚫 <b>Daily limit reached!</b>\n\nYou've watched <b>${DAILY_VIDEO_LIMIT} videos</b> today.\n📅 Resets at midnight.`, { parse_mode:"HTML" });
          const sentMsg = await sendFile(bot, chatId, record);
          const lim = commitVideoLimitIncrement(userId);
          await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          db.fileRecord.addDeliveredTo(record.id,chatId);
          FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          stampMongoDeliveredAt(record.id, chatId, Date.now());
          await scheduleUndeliver(record.id, record.code, chatId, new Date(Date.now()+6*60*60*1000));
          const lines=[`⚠️ This video auto-deletes in 6 hours.`,``,`📊 <b>Today:</b> ${lim.used}/${DAILY_VIDEO_LIMIT} videos`];
          if(lim.remaining===0) lines.push(`🚫 Limit reached for today!`);
          else if(lim.remaining<=3) lines.push(`⚠️ Only <b>${lim.remaining}</b> left today!`);
          await bot.sendMessage(chatId, lines.join("\n"), { parse_mode:"HTML" });
          return;
        }
        const sentMsg = await sendFile(bot, chatId, record);
        if (isVideo) {
          await scheduleDelete(bot,chatId,sentMsg.message_id,new Date(Date.now()+6*60*60*1000));
          db.fileRecord.addDeliveredTo(record.id,chatId);
          FileRecord.updateOne({ code:record.code },{ $addToSet:{ delivered_to:chatId } }).catch(() => {});
          stampMongoDeliveredAt(record.id, chatId, Date.now());
          await scheduleUndeliver(record.id, record.code, chatId, new Date(Date.now()+6*60*60*1000));
          await bot.sendMessage(chatId, `⚠️ This video auto-deletes in 6 hours.`);
        }
      } catch (err) { console.error("Deep link error:", err.message); bot.sendMessage(chatId, `Error occurred. Please try again.`); }
      return;
    }

    const referLink = userId ? `https://t.me/${BOT_USERNAME}?start=ref_${userId}` : "";
    const referLinkCode = referLink ? `<code>${referLink}</code>` : "";
    const welcomeText = isOwner(userId)
      ? `👋 Hello Admin!\n\nTap below to browse lectures! 📚\n\n📁 File Store:\n/bulk — bulk upload\n/myfiles — view files\n/delete &lt;code&gt; — delete file\n/rmword 'word' — remove word from names\n/cancel — cancel bulk\n\n📡 Broadcast:\n/broadcast &lt;text&gt; or reply to media${isSuperOwner(userId) ? `\n\n👑 Owner Management (super owner only):\n/addowner &lt;user_id&gt; — grant owner access\n/removeowner &lt;user_id&gt; — revoke owner access\n/owners — open the power-control catalog (toggle forward-bypass, admin panel, broadcast per owner)` : ``}\n\n🔗 <b>Your Invite Link:</b> (tap to copy)\n${referLinkCode}`
      : `👋 Hello ${msg.from.first_name}!\n\nTap below to browse all lectures! 📚\n\n🔗 <b>Your Invite Link:</b> (tap to copy)\n${referLinkCode}\n\nShare karo aur har referral pe <b>5 points</b> kamao! 🎁`;
    const shareUrl = referLink ? `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent("Join and get free lectures! 📚")}` : "";
    const startButtons = [[{ text:"📚 Browse Lectures", web_app:{ url:WEB_URL } }]];
    if (shareUrl) startButtons.push([{ text:"📤 Share & Earn Points", url: shareUrl }]);
    bot.sendMessage(chatId, welcomeText, { parse_mode:"HTML", reply_markup:{ inline_keyboard: startButtons } });
  });

  // ── /bulk ─────────────────────────────────────────────────────────────────
  bot.onText(/\/bulk/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    if (bulkSessions.has(userId)) return bot.sendMessage(chatId, `⚠️ Bulk mode already active! Use /done or /cancel.`);
    const timer = setTimeout(async () => { if(bulkSessions.has(userId)){bulkSessions.delete(userId);try{await bot.sendMessage(chatId,`⏰ Bulk session timed out. Use /bulk to start again.`);}catch(_){}} }, BULK_TIMEOUT_MS);
    bulkSessions.set(userId, { files:[], chatId, timer });
    bot.sendMessage(chatId, `📦 Bulk mode ON!\n\nSend files one by one, then /done for a single link!\n\n❌ Cancel: /cancel`);
  });

  // ── /done ─────────────────────────────────────────────────────────────────
  bot.onText(/\/done/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const session=bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId, `No active bulk session. Use /bulk to start.`);
    if (session.files.length===0) return bot.sendMessage(chatId, `⚠️ No files yet! Send files first.`);
    clearTimeout(session.timer); bulkSessions.delete(userId);
    const processing=await bot.sendMessage(chatId,`⏳ Saving batch...`);
    try {
      const batchCode=getUniqueBatchCode();
      const storedFiles=[];
      for (const f of session.files) storedFiles.push(await saveToStorageChannel(bot,f));
      const id=db.generateId();
      db.bulkBatch.create({ id, batch_code:batchCode, user_id:userId, files:storedFiles });
      BulkBatch.create({ batch_code:batchCode, user_id:userId, files:storedFiles }).catch(() => {});
      const link=`https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId,processing.message_id);
      const fileList=session.files.map((f,i)=>`${i+1}. ${f.file_name}`).join("\n");
      await bot.sendMessage(chatId, `✅ Batch ready! ${session.files.length} files.\n\n📋 Files:\n${fileList}\n\n🔗 Link:\n<code>${link}</code>`, { parse_mode:"HTML", reply_markup:{ inline_keyboard:[[{ text:"📥 Get Files", url:link }]] } });
    } catch (err) { console.error("Batch save error:",err.message); try{await bot.editMessageText(`Batch save failed. Try again.`,{chat_id:chatId,message_id:processing.message_id});}catch(_){} }
  });

  // ── /cancel ───────────────────────────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    if (isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const session=bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId,`No active bulk session.`);
    clearTimeout(session.timer); bulkSessions.delete(userId);
    bot.sendMessage(chatId,`❌ Bulk session cancelled.${session.files.length>0?` (${session.files.length} files discarded)`:""}`);
  });

  // ── /myfiles ──────────────────────────────────────────────────────────────
  const PAGE_SIZE=10;
  async function sendMyFilesPage(chatId,userId,page,editMsgId=null) {
    try {
      const allFiles=db.fileRecord.findByUploader(userId);
      const allBatches=db.bulkBatch.findByUser(userId);
      const totalItems=allFiles.length+allBatches.length;
      if (!totalItems) return bot.sendMessage(chatId,`No files or batches uploaded yet.`);
      const totalPages=Math.ceil(totalItems/PAGE_SIZE);
      page=Math.max(0,Math.min(page,totalPages-1));
      const combined=[...allFiles.map(f=>({type:"file",data:f,created_at:f.created_at})),...allBatches.map(b=>({type:"batch",data:b,created_at:b.created_at}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
      const items=combined.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
      const emoji={document:"📄",photo:"🖼️",video:"🎬",audio:"🎵",voice:"🎤",video_note:"📹"};
      let text=`📂 My Files — Page ${page+1}/${totalPages} (${totalItems} total)\n\n`;
      items.forEach((item,i) => {
        const n=page*PAGE_SIZE+i+1;
        if(item.type==="file"){const f=item.data;text+=`${n}. ${emoji[f.file_type]||"📎"} ${f.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;}
        else{const b=item.data;text+=`${n}. 📦 Batch (${b.files.length} files)\nhttps://t.me/${BOT_USERNAME}?start=${b.batch_code}\n\n`;}
      });
      const buttons=[];
      if(page>0) buttons.push({text:"⬅️ Prev",callback_data:`myfiles_page_${page-1}`});
      if(page<totalPages-1) buttons.push({text:"Next ➡️",callback_data:`myfiles_page_${page+1}`});
      const rm=buttons.length?{inline_keyboard:[buttons]}:undefined;
      if(editMsgId) await bot.editMessageText(text,{chat_id:chatId,message_id:editMsgId,disable_web_page_preview:true,reply_markup:rm});
      else await bot.sendMessage(chatId,text,{disable_web_page_preview:true,reply_markup:rm});
    } catch(err){console.error("myfiles error:",err.message);bot.sendMessage(chatId,`Error occurred.`);}
  }
  bot.onText(/\/myfiles/, async (msg) => { if(isGroupChat(msg)||!isOwner(msg.from?.id)) return; await sendMyFilesPage(msg.chat.id,msg.from.id,0); });

  // ── /addowner, /removeowner, /owners (with per-owner power control) ───────
  // Only the super owner (OWNER_ID — first id in the env OWNER_ID list) can
  // grant/revoke owner access or change anyone's powers — otherwise an owner
  // could grant itself unlimited access.
  const ownerNameCache = {};
  async function getOwnerLabel(id) {
    if (ownerNameCache[id]) return ownerNameCache[id];
    try {
      const chat = await bot.getChat(id);
      const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? "@"+chat.username : String(id));
      ownerNameCache[id] = name;
      return name;
    } catch (_) { return String(id); }
  }
  const PERM_LABELS = { forwardBypass: "🚫 Forward Restriction Bypass", adminPanel: "🛠 Admin Panel Access", broadcast: "📡 Broadcast Access", approvePayment: "💳 Approve/Reject Payments" };

  async function sendOwnerCatalog(chatId, editMsgId) {
    const ids = listManageableOwners();
    if (!ids.length) {
      const text = `👑 <b>Owners</b>\n\nAbhi koi extra owner nahi hai.\nUse <code>/addowner &lt;user_id&gt;</code> (or reply to their message) to add one.`;
      if (editMsgId) return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: "HTML" }).catch(() => {});
      return bot.sendMessage(chatId, text, { parse_mode: "HTML" });
    }
    const labels = await Promise.all(ids.map((id) => getOwnerLabel(id)));
    const kb = { inline_keyboard: ids.map((id, i) => [{ text: `👤 ${labels[i]} (${id})`, callback_data: `own_view_${id}` }]) };
    const text = `👑 <b>Manage Owners</b>\n\nTap an owner to view & toggle their powers:`;
    if (editMsgId) return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    return bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb });
  }

  async function sendOwnerPowerView(chatId, targetId, editMsgId) {
    const label = await getOwnerLabel(targetId);
    const isEnvOwner = OWNER_IDS.includes(targetId);
    const rows = OWNER_PERMS.map((perm) => {
      const on = hasPerm(targetId, perm);
      return [{ text: `${on ? "✅" : "❌"} ${PERM_LABELS[perm]}`, callback_data: `own_toggle_${perm}_${targetId}` }];
    });
    if (!isEnvOwner) rows.push([{ text: "🗑 Remove Owner", callback_data: `own_remove_${targetId}` }]);
    rows.push([{ text: "⬅️ Back", callback_data: "own_back" }]);
    const text = `👤 <b>${esc(label)}</b>\n<code>${targetId}</code>${isEnvOwner ? `\n<i>(env owner — stays an owner even if removed here)</i>` : ``}\n\nTap a power to turn it on/off:`;
    return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: "HTML", reply_markup: { inline_keyboard: rows } }).catch(() => {});
  }

  bot.onText(/\/addowner(?:\s+(\S+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isSuperOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const targetId = match[1] ? parseInt(match[1], 10) : msg.reply_to_message?.from?.id;
    if (!targetId) return bot.sendMessage(chatId, `❌ Usage: /addowner <user_id>\nOr reply to that user's message with /addowner`);
    if (targetId === OWNER_ID) return bot.sendMessage(chatId, `⚠️ That user is already the super owner.`);
    if (isOwner(targetId)) return bot.sendMessage(chatId, `⚠️ <code>${targetId}</code> is already an owner.`, { parse_mode: "HTML" });
    ensureOwnerRecord(targetId);
    bot.sendMessage(chatId, `✅ Added <code>${targetId}</code> as an owner with full power (forward bypass, admin panel, broadcast).\n\nUse /owners to fine-tune their powers.`, { parse_mode: "HTML" });
    bot.sendMessage(targetId, `🎉 You've been made a bot owner!`).catch(() => {});
  });

  bot.onText(/\/removeowner(?:\s+(\S+))?/, async (msg, match) => {
    if (isGroupChat(msg) || !isSuperOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const targetId = match[1] ? parseInt(match[1], 10) : msg.reply_to_message?.from?.id;
    if (!targetId) return bot.sendMessage(chatId, `❌ Usage: /removeowner <user_id>\nOr reply to that user's message with /removeowner`);
    if (targetId === OWNER_ID) return bot.sendMessage(chatId, `❌ Cannot remove the super owner.`);
    if (OWNER_IDS.includes(targetId)) return bot.sendMessage(chatId, `❌ <code>${targetId}</code> is set via the OWNER_ID env variable — remove it there instead (bot restart needed).`, { parse_mode: "HTML" });
    if (!Object.prototype.hasOwnProperty.call(ownersData, String(targetId))) return bot.sendMessage(chatId, `⚠️ <code>${targetId}</code> is not an owner.`, { parse_mode: "HTML" });
    delete ownersData[String(targetId)]; saveOwnersData();
    bot.sendMessage(chatId, `✅ Removed <code>${targetId}</code> from owners.`, { parse_mode: "HTML" });
  });

  bot.onText(/\/owners/, async (msg) => {
    if (isGroupChat(msg) || !isSuperOwner(msg.from?.id)) return;
    await sendOwnerCatalog(msg.chat.id);
  });

  // ── Callback queries ──────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const userId=query.from?.id; const data=query.data||""; const chatId=query.message?.chat?.id; const msgId=query.message?.message_id;
    if (data.startsWith("pay_approve_")||data.startsWith("pay_reject_")) {
      if (!isOwner(userId)) return bot.answerCallbackQuery(query.id,{text:"❌ Not authorized"});
      if (!hasPerm(userId,"approvePayment")) return bot.answerCallbackQuery(query.id,{text:"❌ You don't have payment-approval permission."});
      const isApprove=data.startsWith("pay_approve_");
      const parts=data.replace("pay_approve_","").replace("pay_reject_","").split("_");
      const batchId=parts[0]; const targetUserId=parts[1];
      if (isApprove) {
        try {
          const Batch=require("./models/Course");
          const batch=await Batch.findById(batchId);
          if(batch){if(!batch.premiumUsers)batch.premiumUsers=[];if(!batch.premiumUsers.includes(String(targetUserId))){batch.premiumUsers.push(String(targetUserId));await batch.save();}db.batch.upsert(batch.toObject());}
          bot.sendMessage(parseInt(targetUserId),`✅ <b>Payment Approved!</b>\n\nAccess to <b>${esc(batch?.name||"the batch")}</b> unlocked! 🚀`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📚 Open App",web_app:{url:WEB_URL}}]]}}).catch(()=>{});
          await bot.editMessageCaption(`${query.message.caption||""}\n\n✅ <b>APPROVED</b> by ${esc(query.from.first_name||"Admin")}`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>bot.editMessageText(`${query.message.text||""}\n\n✅ <b>APPROVED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
          await bot.answerCallbackQuery(query.id,{text:"✅ Approved!"});
        } catch(err){await bot.answerCallbackQuery(query.id,{text:"❌ Error: "+err.message});}
      } else {
        bot.sendMessage(parseInt(targetUserId),`❌ <b>Payment Rejected</b>\n\nPlease contact support.`,{parse_mode:"HTML"}).catch(()=>{});
        await bot.editMessageCaption(`${query.message.caption||""}\n\n❌ <b>REJECTED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>bot.editMessageText(`${query.message.text||""}\n\n❌ <b>REJECTED</b>`,{chat_id:chatId,message_id:msgId,parse_mode:"HTML",reply_markup:{inline_keyboard:[]}}).catch(()=>{}));
        await bot.answerCallbackQuery(query.id,{text:"❌ Rejected"});
      }
      return;
    }
    if(query.message&&isGroupChat(query.message)) return bot.answerCallbackQuery(query.id);
    if(!isOwner(userId)) return bot.answerCallbackQuery(query.id);
    if(data.startsWith("myfiles_page_")){const page=parseInt(data.replace("myfiles_page_",""),10);await sendMyFilesPage(query.message.chat.id,userId,page,msgId);await bot.answerCallbackQuery(query.id);}

    if (data.startsWith("own_")) {
      // Power-management catalog is super-owner-only, re-checked here since
      // callback buttons can be tapped independently of the original command.
      if (!isSuperOwner(userId)) return bot.answerCallbackQuery(query.id, { text: "❌ Only the super owner can manage owners." });
      if (data === "own_back") {
        await sendOwnerCatalog(chatId, msgId);
        return bot.answerCallbackQuery(query.id);
      }
      if (data.startsWith("own_view_")) {
        const targetId = parseInt(data.replace("own_view_", ""), 10);
        await sendOwnerPowerView(chatId, targetId, msgId);
        return bot.answerCallbackQuery(query.id);
      }
      if (data.startsWith("own_toggle_")) {
        const rest = data.replace("own_toggle_", "");
        const perm = OWNER_PERMS.find((p) => rest.startsWith(p + "_"));
        if (!perm) return bot.answerCallbackQuery(query.id, { text: "❌ Unknown power" });
        const targetId = parseInt(rest.replace(perm + "_", ""), 10);
        if (OWNER_IDS.includes(targetId) && targetId === OWNER_ID) return bot.answerCallbackQuery(query.id, { text: "❌ Can't restrict the super owner." });
        setPerm(targetId, perm, !hasPerm(targetId, perm));
        await sendOwnerPowerView(chatId, targetId, msgId);
        return bot.answerCallbackQuery(query.id, { text: "✅ Updated" });
      }
      if (data.startsWith("own_remove_")) {
        const targetId = parseInt(data.replace("own_remove_", ""), 10);
        if (OWNER_IDS.includes(targetId)) return bot.answerCallbackQuery(query.id, { text: "❌ Env owner — edit OWNER_ID env var instead." });
        delete ownersData[String(targetId)]; saveOwnersData();
        await sendOwnerCatalog(chatId, msgId);
        return bot.answerCallbackQuery(query.id, { text: "✅ Removed" });
      }
      return bot.answerCallbackQuery(query.id);
    }
  });

  // ── /delete ───────────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const code=match[1].trim();
    try {
      if(db.fileRecord.deleteByCode(code,msg.from.id)){FileRecord.deleteOne({code:{$regex:new RegExp(`^${code}$`,"i")},uploaded_by:msg.from.id}).catch(()=>{});return bot.sendMessage(chatId,`✅ File deleted!`);}
      if(db.bulkBatch.deleteByCode(code,msg.from.id)){BulkBatch.deleteOne({batch_code:{$regex:new RegExp(`^${code}$`,"i")},user_id:msg.from.id}).catch(()=>{});return bot.sendMessage(chatId,`✅ Batch deleted!`);}
      bot.sendMessage(chatId,`Code not found.`);
    } catch(_){bot.sendMessage(chatId,`Deletion failed.`);}
  });

  // ── /resetlimit <userId> ─────────────────────────────────────────────────
  // Owner-only: manually clears a user's daily video-watch count back to 0
  // for today, e.g. to compensate a user hit by a failed delivery, or as a
  // one-off courtesy reset — without waiting for the midnight IST rollover.
  bot.onText(/\/resetlimit (.+)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const targetId=parseInt(match[1].trim(),10);
    if(!targetId||isNaN(targetId)) return bot.sendMessage(chatId,`Usage: /resetlimit <userId>`);
    try {
      const today=getTodayIST();
      db.dailyVideoLimit.upsert({ userId: targetId, count: 0, resetDate: today });
      DailyVideoLimit.findOneAndUpdate({ userId: targetId }, { userId: targetId, count: 0, resetDate: today }, { upsert: true }).catch(()=>{});
      bot.sendMessage(chatId,`✅ Daily video limit reset for user <code>${targetId}</code>.`, { parse_mode:"HTML" });
    } catch(_){ bot.sendMessage(chatId,`Reset failed.`); }
  });

  // ── /rmword ───────────────────────────────────────────────────────────────
  bot.onText(/\/rmword(.*)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id; const arg=(match[1]||"").trim();
    if(arg.toLowerCase()==="list") return bot.sendMessage(chatId,rmWords.length?`📋 Words:\n${rmWords.map((w,i)=>`${i+1}. <code>${esc(w)}</code>`).join("\n")}`:`No words in list.`,{parse_mode:"HTML"});
    if(arg.toLowerCase()==="clear"){const c=rmWords.length;rmWords=[];return bot.sendMessage(chatId,`🗑️ Cleared ${c} word(s).`);}
    const quoted=arg.match(/^['"'](.+?)['"']$/)||arg.match(/^'(.+?)'$/)||arg.match(/^"(.+?)"$/);
    const word=quoted?quoted[1].trim():arg.replace(/^['"']|['"']$/g,"").trim();
    if(!word) return bot.sendMessage(chatId,`Usage: /rmword 'word' | list | clear`,{parse_mode:"HTML"});
    const wl=word.toLowerCase();
    if(rmWords.includes(wl)) return bot.sendMessage(chatId,`⚠️ Already in list.`);
    rmWords.push(wl);
    bot.sendMessage(chatId,`✅ Added <code>${esc(word)}</code>. Total: ${rmWords.length}`,{parse_mode:"HTML"});
  });

  // ── /migrate ──────────────────────────────────────────────────────────────
  // Fixes files saved by an old bot token: a Telegram file_id only works for the
  // bot that issued it, so after switching bots, sendFile()'s primary path fails
  // and falls back to copyMessage from the storage channel — which shows the
  // channel's original caption instead of the correct file_name. This command
  // re-forwards every stored file from the storage channel (which the CURRENT
  // bot can access), grabs a fresh valid file_id, and updates the DB in place.
  // The original file_name already stored in the DB is preserved — only file_id
  // is replaced — so nothing about naming needs to be re-typed.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let migrateRunning = false;

  bot.onText(/\/migrate/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    if (!STORAGE_CHANNEL_ID) return bot.sendMessage(chatId, `⚠️ STORAGE_CHANNEL_ID not set — nothing to migrate from.`);
    if (migrateRunning) return bot.sendMessage(chatId, `⚠️ A migration is already running.`);
    migrateRunning = true;

    try {
      const singleFiles = db.fileRecord.findAllWithChannelMsg();
      const batches = db.bulkBatch.findAll();
      const batchJobs = [];
      const noBackupCodes = []; // files with NO channel_msg_id — can't be auto-fixed, must be re-uploaded
      for (const b of batches) {
        b.files.forEach((f, idx) => {
          if (f.channel_msg_id) batchJobs.push({ batch: b, idx });
          else noBackupCodes.push(`${b.batch_code} (file ${idx + 1})`);
        });
      }
      const total = singleFiles.length + batchJobs.length;
      if (!total && !noBackupCodes.length) return bot.sendMessage(chatId, `Nothing to migrate.`);
      if (!total) {
        return bot.sendMessage(chatId, `⚠️ No files have a channel_msg_id to migrate from.\n\nThese ${noBackupCodes.length} file(s) have no channel backup at all and must be re-uploaded:\n${noBackupCodes.slice(0, 30).map(esc).join(", ")}${noBackupCodes.length > 30 ? "…" : ""}`, { parse_mode: "HTML" });
      }

      const status = await bot.sendMessage(chatId, `🔄 Migrating 0/${total}...`);
      let done = 0, fixed = 0, failed = 0;
      const failedCodes = [];

      const migrateOne = async (channelMsgId) => {
        // Forward → new valid file_id for THIS bot, then clean up the forwarded copy.
        const fwd = await bot.forwardMessage(chatId, STORAGE_CHANNEL_ID, channelMsgId);
        const info = extractFileInfo(fwd);
        bot.deleteMessage(chatId, fwd.message_id).catch(() => {});
        if (!info) throw new Error("no file in forwarded message");
        return info.file_id;
      };

      for (const rec of singleFiles) {
        try {
          const file_id = await migrateOne(rec.channel_msg_id);
          db.fileRecord.updateFileId(rec.id, { file_id });
          FileRecord.updateOne({ code: rec.code }, { file_id }).catch(() => {});
          fixed++;
        } catch (err) { failed++; failedCodes.push(rec.code); }
        done++;
        if (done % 20 === 0 || done === total) {
          bot.editMessageText(`🔄 Migrating ${done}/${total}... (✅ ${fixed} 🚫 ${failed})`, { chat_id: chatId, message_id: status.message_id }).catch(() => {});
        }
        await sleep(300); // stay well under Telegram's flood limits
      }

      for (const { batch, idx } of batchJobs) {
        try {
          const file_id = await migrateOne(batch.files[idx].channel_msg_id);
          batch.files[idx].file_id = file_id;
          db.bulkBatch.updateFiles(batch.id, batch.files);
          BulkBatch.updateOne({ batch_code: batch.batch_code }, { files: batch.files }).catch(() => {});
          fixed++;
        } catch (err) { failed++; failedCodes.push(batch.batch_code); }
        done++;
        if (done % 20 === 0 || done === total) {
          bot.editMessageText(`🔄 Migrating ${done}/${total}... (✅ ${fixed} 🚫 ${failed})`, { chat_id: chatId, message_id: status.message_id }).catch(() => {});
        }
        await sleep(300);
      }

      let summary = `✅ <b>Migration done!</b>\n\n📦 Total: ${total}\n✅ Fixed: ${fixed}\n🚫 Failed: ${failed}`;
      if (failedCodes.length) summary += `\n\n⚠️ Failed codes (message likely deleted from channel):\n${failedCodes.slice(0, 30).map(esc).join(", ")}${failedCodes.length > 30 ? "…" : ""}`;
      if (noBackupCodes.length) summary += `\n\n📛 No channel backup at all (re-upload needed):\n${noBackupCodes.slice(0, 30).map(esc).join(", ")}${noBackupCodes.length > 30 ? "…" : ""}`;
      await bot.sendMessage(chatId, summary, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Migrate error:", err.message);
      bot.sendMessage(chatId, `❌ Migration failed: ${esc(err.message)}`, { parse_mode: "HTML" });
    } finally {
      migrateRunning = false;
    }
  });

  let syncRunning = false;
  bot.onText(/\/sync/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    if (syncRunning) return bot.sendMessage(chatId, `⚠️ A sync is already running.`);
    syncRunning = true;
    const status = await bot.sendMessage(chatId, `🔄 Syncing SQLite → MongoDB…`);
    try {
      const summary = await db.syncToMongo(mongoose);
      const labels = {
        batches: '📚 Batches', users: '👤 Users', announcements: '📢 Announcements',
        access: '🔓 Access grants', referrals: '🔗 Referrals', coupons: '🎟️ Coupons',
        autoLecSession: '⚙️ Auto-lecture session', fileRecords: '📎 File records',
        bulkBatches: '📦 Bulk batches', dailyVideoLimits: '📺 Daily video limits',
        rewardRedemptions: '🎁 Reward redemptions', batchRewardAccess: '⏳ Batch reward access',
        spinHistory: '🎡 Spin history', watchedLectures: '👁️ Watched lectures',
      };
      let text = `✅ <b>Sync complete</b>\n\n`;
      let hadError = false;
      for (const key of Object.keys(labels)) {
        const val = summary[key];
        if (val === undefined) continue;
        if (val === 'error') { text += `${labels[key]}: ⚠️ failed (check server logs)\n`; hadError = true; }
        else text += `${labels[key]}: ${val}\n`;
      }
      text += `\n<i>Skipped: pending deletes/undelivers and spin tokens — these are short-lived job markers, not data worth backing up.</i>`;
      if (hadError) text += `\n\n⚠️ Some tables had errors — check server logs for details.`;
      await bot.editMessageText(text, { chat_id: chatId, message_id: status.message_id, parse_mode: "HTML" });
    } catch (err) {
      console.error("Sync error:", err.message);
      bot.editMessageText(`❌ Sync failed: ${esc(err.message)}`, { chat_id: chatId, message_id: status.message_id, parse_mode: "HTML" }).catch(() => {});
    } finally {
      syncRunning = false;
    }
  });
  const TG_LINK_RE=/https?:\/\/t\.me\/(c\/(\d+)|([a-zA-Z][a-zA-Z0-9_]{3,}))\/(\d+)/;
  const fileQueues=new Map();
  function enqueueFile(userId,task){const prev=fileQueues.get(userId)||Promise.resolve();const next=prev.then(task).catch(()=>{});fileQueues.set(userId,next);next.finally(()=>{if(fileQueues.get(userId)===next)fileQueues.delete(userId);});}

  bot.onText(TG_LINK_RE, (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    enqueueFile(msg.from.id, async () => {
      const chatId=msg.chat.id; const userId=msg.from.id;
      const isPrivate=!!match[2]; const rawId=match[2]; const username=match[3]; const messageId=parseInt(match[4],10);
      const fromChatId=isPrivate?parseInt(`-100${rawId}`,10):`@${username}`;
      const processing=await bot.sendMessage(chatId,`⏳ Fetching file...`);
      try {
        const forwarded=await bot.forwardMessage(chatId,fromChatId,messageId);
        const fileInfo=extractFileInfo(forwarded);
        if(!fileInfo){await bot.deleteMessage(chatId,forwarded.message_id).catch(()=>{});return bot.editMessageText(`⚠️ No file found in that message.`,{chat_id:chatId,message_id:processing.message_id});}
        await bot.deleteMessage(chatId,forwarded.message_id).catch(()=>{});
        const session=bulkSessions.get(userId);
        if(session){session.files.push(fileInfo);return bot.editMessageText(`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{chat_id:chatId,message_id:processing.message_id});}
        const stored=await saveToStorageChannel(bot,fileInfo); stored.file_name=cleanFileName(stored.file_name);
        const code=getUniqueCode(); const id=db.generateId();
        db.fileRecord.create({id,code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,channel_msg_id:stored.channel_msg_id||null});
        FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null}).catch(()=>{});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            const lNum=autoLectureSession.lectureCount+1; const lName=`Lecture ${lNum}`;
            await autoAddLecture({batchId:autoLectureSession.batchId,subjectId:autoLectureSession.subjectId,chapterId:autoLectureSession.chapterId,unitId:autoLectureSession.unitId,name:lName,link:code});
            autoLectureSession.lectureCount=lNum; courseRoutes.saveAutoSession&&courseRoutes.saveAutoSession();
            const loc=autoLectureSession.unitName?`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`:`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,`✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send next video for <b>Lecture ${lNum+1}</b>`,{parse_mode:"HTML"});
          }catch(err){await bot.sendMessage(chatId,`⚠️ File saved but auto-lecture failed: ${err.message}\n🔗 <code>${link}</code>`,{parse_mode:"HTML"});}
        } else {
          await bot.sendMessage(chatId,`✅ ${stored.file_name}\n\n🔗 Link:\n<code>${link}</code>`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📥 File Lo",url:link}]]}});
        }
      } catch(err){
        const errText=err.message.includes("chat not found")||err.message.includes("CHAT_ADMIN_REQUIRED")?`❌ Bot is not a member of that group/channel.`:err.message.includes("MESSAGE_ID_INVALID")?`❌ Message not found.`:err.message.includes("PEER_ID_INVALID")?`❌ Cannot access this channel.`:`❌ Error: ${err.message}`;
        try{await bot.editMessageText(errText,{chat_id:chatId,message_id:processing.message_id});}catch(_){bot.sendMessage(chatId,errText);}
      }
    });
  });

  // ── File upload handler ───────────────────────────────────────────────────
  bot.on("message", (msg) => {
    if(isGroupChat(msg)||msg.text||!isOwner(msg.from?.id)) return;
    if(msg.text&&TG_LINK_RE.test(msg.text)) return;
    const chatId=msg.chat.id; const userId=msg.from.id;
    const fileInfo=extractFileInfo(msg);
    if(!fileInfo) return;
    const session=bulkSessions.get(userId);
    if(session){enqueueFile(userId,async()=>{session.files.push(fileInfo);await bot.sendMessage(chatId,`✅ File ${session.files.length} added: ${fileInfo.file_name}\n📦 Total: ${session.files.length}\n\nSend more or /done`,{reply_to_message_id:msg.message_id});});return;}
    enqueueFile(userId, async () => {
      const processing=await bot.sendMessage(chatId,`⏳ Saving: ${fileInfo.file_name}...`);
      try {
        const stored=await saveToStorageChannel(bot,fileInfo); stored.file_name=cleanFileName(stored.file_name);
        const code=getUniqueCode(); const id=db.generateId();
        db.fileRecord.create({id,code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,channel_msg_id:stored.channel_msg_id||null});
        FileRecord.create({code,file_id:stored.file_id,file_type:stored.file_type,file_name:stored.file_name,uploaded_by:userId,expires_at:null,channel_msg_id:stored.channel_msg_id||null}).catch(()=>{});
        const link=`https://t.me/${BOT_USERNAME}?start=${code}`;
        await bot.deleteMessage(chatId,processing.message_id);
        if(autoLectureSession&&autoLectureSession.active){
          try{
            const lNum=autoLectureSession.lectureCount+1; const lName=`Lecture ${lNum}`;
            await autoAddLecture({batchId:autoLectureSession.batchId,subjectId:autoLectureSession.subjectId,chapterId:autoLectureSession.chapterId,unitId:autoLectureSession.unitId,name:lName,link:code});
            autoLectureSession.lectureCount=lNum; courseRoutes.saveAutoSession&&courseRoutes.saveAutoSession();
            const loc=autoLectureSession.unitName?`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`:`${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            await bot.sendMessage(chatId,`✅ <b>Auto-Saved!</b>\n📖 <b>${lName}</b>\n📁 ${stored.file_name}\n📍 ${loc}\n🔗 <code>${link}</code>\n\n📨 Send next video for <b>Lecture ${lNum+1}</b>`,{parse_mode:"HTML"});
          }catch(err){await bot.sendMessage(chatId,`⚠️ Saved but auto-lecture failed: ${err.message}\n🔗 <code>${link}</code>`,{parse_mode:"HTML"});}
        } else {
          await bot.sendMessage(chatId,`✅ ${stored.file_name}\n\n🔗 Link:\n<code>${link}</code>`,{parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"📥 Get File",url:link}]]}});
        }
      } catch(err){console.error("Save error:",err.message);try{await bot.editMessageText(`❌ Could not save. Try again.`,{chat_id:chatId,message_id:processing.message_id});}catch(_){}}
    });
  });

  // ── /broadcast ────────────────────────────────────────────────────────────
  bot.onText(/\/broadcast(.*)/, async (msg,match) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    if(!hasPerm(msg.from?.id,"broadcast")) return bot.sendMessage(msg.chat.id,`❌ You don't have broadcast permission.`);
    const chatId=msg.chat.id; const argRaw=(match[1]||"").trim();
    const pinFlag=argRaw.includes("--pin"); const forwardFlag=argRaw.includes("--f");
    const inlineText=argRaw.replace("--pin","").replace("--f","").trim();
    const reply=msg.reply_to_message;
    let bType=null, bPayload={};
    if(reply){
      if(reply.sticker){bType="sticker";bPayload={file_id:reply.sticker.file_id};}
      else if(reply.animation){bType="animation";bPayload={file_id:reply.animation.file_id,caption:reply.caption||""};}
      else if(reply.video_note){bType="video_note";bPayload={file_id:reply.video_note.file_id};}
      else if(reply.voice){bType="voice";bPayload={file_id:reply.voice.file_id,caption:reply.caption||""};}
      else if(reply.audio){bType="audio";bPayload={file_id:reply.audio.file_id,caption:reply.caption||""};}
      else if(reply.document){bType="document";bPayload={file_id:reply.document.file_id,caption:reply.caption||""};}
      else if(reply.video){bType="video";bPayload={file_id:reply.video.file_id,caption:reply.caption||""};}
      else if(reply.photo){bType="photo";bPayload={file_id:reply.photo[reply.photo.length-1].file_id,caption:reply.caption||""};}
      else if(reply.text){bType="text";bPayload={text:reply.text};}
    }
    if(!bType&&inlineText){bType="text";bPayload={text:inlineText};}
    if(!bType) return bot.sendMessage(chatId,`❌ Nothing to broadcast.\n\nReply to a message with /broadcast or /broadcast Your text here`);

    async function sendToUser(tid){
      if(forwardFlag&&reply) return bot.forwardMessage(tid,reply.chat.id,reply.message_id);
      const o={parse_mode:"HTML"};
      switch(bType){
        case"text": return bot.sendMessage(tid,bPayload.text,o);
        case"photo": return bot.sendPhoto(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"video": return bot.sendVideo(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"audio": return bot.sendAudio(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"document": return bot.sendDocument(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"voice": return bot.sendVoice(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
        case"video_note": return bot.sendVideoNote(tid,bPayload.file_id);
        case"sticker": return bot.sendSticker(tid,bPayload.file_id);
        case"animation": return bot.sendAnimation(tid,bPayload.file_id,bPayload.caption?{caption:bPayload.caption,...o}:{});
      }
    }

    const allUsers=db.user.getAll();
    if(!allUsers.length) return bot.sendMessage(chatId,`⚠️ No users found.`);
    const progress=await bot.sendMessage(chatId,`📡 Broadcasting to ${allUsers.length} users...`);
    let sent=0,failed=0,blocked=0;
    for(let i=0;i<allUsers.length;i++){
      const tid=parseInt(allUsers[i].userId,10);
      if(!tid){failed++;continue;}
      try{const sm=await sendToUser(tid);if(pinFlag&&sm?.message_id){try{await bot.pinChatMessage(tid,sm.message_id,{disable_notification:true});}catch(_){}}sent++;}
      catch(err){if((err.message||"").match(/blocked|deactivated|Forbidden/))blocked++;else failed++;}
      if((i+1)%20===0||i===allUsers.length-1){try{await bot.editMessageText(`📡 Broadcasting...\n✅ ${sent} | 🚫 ${blocked} | ❌ ${failed} | ⏳ ${i+1}/${allUsers.length}`,{chat_id:chatId,message_id:progress.message_id});}catch(_){}}
      if((i+1)%25===0&&i<allUsers.length-1) await wait(1000);
    }
    try{await bot.editMessageText(`✅ <b>Broadcast Complete!</b>\n\n✅ Delivered: ${sent}\n🚫 Blocked: ${blocked}\n❌ Failed: ${failed}`,{chat_id:chatId,message_id:progress.message_id,parse_mode:"HTML"});}catch(_){}
  });

  // ── /stats ────────────────────────────────────────────────────────────────
  function formatIST(d) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('day')}/${get('month')}/${get('year')}, ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod').toLowerCase()}`;
  }
  const nf = (n) => Number(n || 0).toLocaleString('en-IN');

  bot.onText(/\/stats/, async (msg) => {
    if(isGroupChat(msg)||!isOwner(msg.from?.id)) return;
    const chatId=msg.chat.id;
    const processing=await bot.sendMessage(chatId,"⏳ Fetching stats...");
    try {
      const s=await (await fetch(`http://localhost:${PORT}/api/stats`)).json();
      const uptime=process.uptime(); const d=Math.floor(uptime/86400); const h=Math.floor((uptime%86400)/3600); const m=Math.floor((uptime%3600)/60);
      const uptimeStr = d>0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;

      const text = [
        `╔═══════════════════════╗`,
        `      📊 BOT DASHBOARD`,
        `╚═══════════════════════╝`,
        ``,
        `👥 USERS`,
        `┣ Total Users: ${nf(s.users.totalUsers)}`,
        `┣ New Today: +${nf(s.users.newToday)}`,
        `┗ This Week: +${nf(s.users.recentUsers)}`,
        ``,
        `📚 CONTENT`,
        `┣ Batches: ${s.content.totalBatches} (🟢 ${s.content.publicBatches} Public · 🔒 ${s.content.privateBatches} Private)`,
        `┣ Subjects: ${s.content.totalSubjects}  |  Chapters: ${s.content.totalChapters}`,
        `┗ Lectures: ${nf(s.content.totalLectures)}`,
        ``,
        `🔑 ACCESS`,
        `┣ Total Granted: ${nf(s.access.totalAccess)}`,
        `┣ Granted Today: +${nf(s.access.grantedToday)}`,
        `┗ Currently Active: ${nf(s.access.activeAccess)}`,
        ``,
        `👫 REFERRALS`,
        `┣ Total Referrals: ${nf(s.referrals.totalReferrals)}`,
        `┣ Today: +${nf(s.referrals.referralsToday)}  |  This Week: +${nf(s.referrals.referralsThisWeek)}`,
        `┣ Unique Referrers: ${nf(s.referrals.uniqueReferrers)}  |  Avg: ${s.referrals.avgPerReferrer}/referrer`,
        `┣ Points Earned (total): ${nf(s.referrals.totalPointsEarned)}`,
        `┣ Top Referrers:`,
        ...(s.referrals.topReferrers && s.referrals.topReferrers.length
          ? s.referrals.topReferrers.map((r, i) => {
              const medal = ["🥇","🥈","🥉"][i] || `${i+1}.`;
              const isLast = i === s.referrals.topReferrers.length - 1;
              return `${isLast ? "┗" : "┃"}  ${medal} ${r.name} — ${nf(r.count)} refs`;
            })
          : [`┗  —`]),
        ``,
        `🎰 SPIN WHEEL`,
        `┣ Spins Today: ${nf(s.spinWheel.spinsToday)}`,
        `┣ Total Spinners: ${nf(s.spinWheel.totalSpinners)}`,
        `┣ Total Pts Earned: ${nf(s.spinWheel.totalPtsEarned)}`,
        `┗ Total Pts Redeemed: ${nf(s.spinWheel.totalPtsRedeemed)}`,
        ``,
        `📁 FILE STORE`,
        `┣ Files: ${nf(s.fileStore.singleFiles)}`,
        `┗ Bulk Batches: ${nf(s.fileStore.bulkBatches)}`,
        ``,
        `⚙️ SERVER`,
        `┣ Uptime: ${uptimeStr}`,
        `┣ MongoDB: ${mongoose.connection.readyState===1?"🟢 Online":"🔴 Offline"}`,
        `┗ SQLite: ✅ Active`,
        ``,
        `🕐 ${formatIST(new Date())}`,
      ].join("\n");

      await bot.editMessageText(text,{chat_id:chatId,message_id:processing.message_id});
    } catch(err){ console.error("Stats error:", err.message); bot.editMessageText("❌ Could not fetch stats.",{chat_id:chatId,message_id:processing.message_id}); }
  });

  bot.on("polling_error",(err)=>console.error("Polling error:",err.message));
  process.on("SIGTERM",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
  process.on("SIGINT",()=>{bot.stopPolling();mongoose.connection.close();process.exit(0);});
}

startBot().catch((err)=>{console.error("Bot startup error:",err.message);process.exit(1);});
