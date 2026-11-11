const express   = require('express');
const multer    = require('multer');
const PDFParser = require('pdf2json');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config();
const mongoose  = require('mongoose');

const app    = express();
const port   = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage() });
const uploadLabels = multer({ storage: multer.memoryStorage() });
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// Local Proofs Storage Directory (handles Vercel read-only filesystem by using /tmp)
const uploadsBase = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
const uploadsDir  = path.join(uploadsBase, 'proofs');
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch(e) {
  console.warn('[storage] cannot create uploadsDir:', e.message);
}
app.use('/uploads', express.static(uploadsBase));

// In-memory PIN requests for PC bypass
let pendingPinRequests = [];
let dailyStagingProof = null;

app.get('/logo.png', (_req, res) => {
  res.sendFile(path.join(__dirname, 'logo.png'));
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const EMPLOYEES = ['หนุ่ย', 'หยก', 'ซิน', 'ภู', 'ปอ'];
// ไม่มีรหัส admin แล้ว — ใครก็เข้าได้ แต่ต้องเลือกชื่อก่อน

// ─── DATA PERSISTENCE (MONGODB) ─────────────────────────────────────────────
const dataSchema = new mongoose.Schema({
  docId: { type: String, default: 'main' },
  rounds: Array,
  currentRoundId: String,
  kpi: Object,
  adminLog: Array,
  blacklist: Array,
  sysSettings: Object,
  dailyStagingProof: Object
});
const DataModel = mongoose.model('Data', dataSchema);

async function saveData() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    // Strip large base64 strings to prevent MongoDB BSON 16MB document size limit and RAM spikes
    const cleanRounds = rounds.map(r => {
      const copy = { ...r };
      if (copy.completionProof && copy.completionProof.photoBase64) {
        copy.completionProof = { ...copy.completionProof, photoBase64: '' };
      }
      if (copy.stagingProof && copy.stagingProof.photoBase64) {
        copy.stagingProof = { ...copy.stagingProof, photoBase64: '' };
      }
      if (Array.isArray(copy.completionHistory)) {
        copy.completionHistory = copy.completionHistory.map(h => ({ ...h, photoBase64: '' }));
      }
      return copy;
    });
    const cleanStaging = dailyStagingProof ? { ...dailyStagingProof, photoBase64: '' } : null;
    const payload = { rounds: cleanRounds, currentRoundId, kpi, adminLog, sysSettings, blacklist, dailyStagingProof: cleanStaging };
    await DataModel.findOneAndUpdate({ docId: 'main' }, payload, { upsert: true });
  } catch(e) { console.error('[save to db]', e.message); }
}

async function loadData() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const d = await DataModel.findOne({ docId: 'main' }).lean();
    if (!d) return;
    if (Array.isArray(d.rounds)) {
      // Keep latest 100 rounds in memory to prevent Render 512MB RAM OOM crash
      rounds = d.rounds.length > 100 ? d.rounds.slice(-100) : d.rounds;
    }
    if (d.currentRoundId != null)  currentRoundId = d.currentRoundId;
    if (d.kpi && typeof d.kpi === 'object') kpi   = d.kpi;
    if (Array.isArray(d.adminLog)) adminLog       = d.adminLog;
    if (Array.isArray(d.blacklist)) blacklist     = d.blacklist;
    if (d.sysSettings)             sysSettings    = { ...sysSettings, ...d.sysSettings };
    if (d.dailyStagingProof)       dailyStagingProof = d.dailyStagingProof;
    // Reset staging proof if confirmed on a previous day (Bangkok UTC+7)
    if (dailyStagingProof && dailyStagingProof.confirmedAt) {
      const confirmedDate = new Date(new Date(dailyStagingProof.confirmedAt).toLocaleString('en-US', {timeZone:'Asia/Bangkok'}));
      const today = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Bangkok'}));
      if (confirmedDate.toDateString() !== today.toDateString()) {
        console.log('[persist] staging proof เป็นของเมื่อวาน — reset ใหม่');
        dailyStagingProof = null;
      }
    }
    
    // Override settings with .env if provided to ensure security
    if (process.env.LINE_TOKEN) sysSettings.lineToken = process.env.LINE_TOKEN;
    if (process.env.LINE_GROUP_ID) sysSettings.lineGroupId = process.env.LINE_GROUP_ID;
    if (process.env.ADMIN_PASSWORD) sysSettings.adminPassword = process.env.ADMIN_PASSWORD;
    if (process.env.WEBHOOK_URL) sysSettings.webhookUrl = process.env.WEBHOOK_URL;
    
    console.log(`[persist] โหลดข้อมูลจาก DB สำเร็จ — ${rounds.length} รอบ`);
  } catch(e) { console.error('[load from db]', e.message); }
}

// Debounce save: รอ 500ms หลังเปลี่ยนข้อมูลแล้วค่อย save (บน Vercel เซฟทันทีป้องกัน Lambda freeze)
let _saveTimer = null;
function scheduleSave() {
  if (process.env.VERCEL) {
    saveData();
    return;
  }
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveData, 500);
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let rounds         = [];
let currentRoundId = null;
let kpi            = {};
// adminLog: { user, time, action } — ประวัติการเข้าใช้หน้า admin
let adminLog       = [];
let blacklist      = [];
let sysSettings    = {
  lineToken: process.env.LINE_TOKEN || '',
  lineGroupId: process.env.LINE_GROUP_ID || '',
  printTime: '15:00',
  autoPrintEnabled: false,
  excludeCarriers: ['ส่งทันที', 'ด่วน', 'ด่วนคลัง'],
  adminPassword: process.env.ADMIN_PASSWORD || '',
  autoCleanEnabled: false,
  autoCleanDays: 30,
  voiceEnabled: true,
  thermalMode: false,
  lineNotifyOnComplete: true,
  validateCarrierMismatch: true,
  carrierPrefixes: {
    'FLASH': ['FXTH','FX','THLTS','THLAS'],
    'SPX': ['SPXTH','SPX'],
    'KERRY': ['KR'],
    'J&T': ['JT','601'],
    'DHL': ['DHL'],
    'LAZADA': ['LAZ','1Z'],
    'NIM': ['NIM'],
    'BEST': ['BES']
  },
  lineMessageStyle: 'flex',  // 'flex' = rich card, 'text' = plain text
  admins: [],  // C8: [{name, password, role:'admin'|'viewer'}]
  webhookUrl: process.env.WEBHOOK_URL || ''  // C10
};

// ─── Audit Log (C9) ──────────────────────────────────────────────────────────
let editLog = [];
function logAudit(user, action, detail) {
  if (!user) user = 'system';
  editLog.unshift({ user, action, detail, time: new Date().toISOString() });
  if (editLog.length > 500) editLog.length = 500;
}

// ─── XSS ESCAPE ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// เชื่อมต่อ MongoDB และโหลดข้อมูล (รองรับทั้ง Serverless Vercel และ Local/Render)
let dbPromise = null;
function initDB() {
  if (!process.env.MONGODB_URI) return Promise.resolve();
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!dbPromise) {
    dbPromise = mongoose.connect(process.env.MONGODB_URI)
      .then(async () => {
        console.log('✅ Connected to MongoDB');
        await loadData();
      })
      .catch(err => {
        console.error('❌ MongoDB Connection Error:', err);
        dbPromise = null;
      });
  }
  return dbPromise;
}

if (process.env.MONGODB_URI) {
  initDB();
} else {
  console.log('⚠️ ไม่พบ MONGODB_URI ในไฟล์ .env (ระบบจะทำงานโดยไม่บันทึกข้อมูลแบบถาวรบนคลาวด์)');
}

// Middleware: ensure DB is ready on serverless cold starts
app.use(async (_req, _res, next) => {
  if (process.env.MONGODB_URI && mongoose.connection.readyState !== 1) {
    try { await initDB(); } catch(e) {}
  }
  next();
});

// ─── LINE MESSAGING API ───────────────────────────────────────────────────────
const https = require('https');

function sendLineNotify(messages) {
  return new Promise((resolve, reject) => {
    if (!sysSettings.lineToken || !sysSettings.lineGroupId) 
      return reject(new Error('ไม่มี LINE Channel Access Token หรือ Group ID'));
      
    // If messages is a string, auto-convert to flex or text based on lineMessageStyle
    if (typeof messages === 'string') {
      if (sysSettings.lineMessageStyle === 'flex') {
        // Keep as text for simple notifications (flex is reserved for summaries)
        messages = [{ type: 'text', text: messages }];
      } else {
        messages = [{ type: 'text', text: messages }];
      }
    }

    const postData = JSON.stringify({
      to: sysSettings.lineGroupId,
      messages: messages
    });

    const options = {
      hostname: 'api.line.me',
      path: '/v2/bot/message/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sysSettings.lineToken,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Build completion Flex Message (C7)
function buildCompletionFlex(round, doneCount) {
  const pct = round.items.length > 0 ? Math.round(doneCount / round.items.length * 100) : 0;
  const now = new Date().toLocaleString('th-TH');
  if (sysSettings.lineMessageStyle !== 'flex') {
    return `✅ รอบ "${round.name}" สแกนครบ 100% แล้ว!\n📦 จำนวน ${doneCount}/${round.items.length} ชิ้น\n🕐 เวลา: ${now}`;
  }
  return {
    type: 'flex',
    altText: `✅ รอบ "${round.name}" ครบ 100%!`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: '#16a34a', paddingAll: '16px',
        contents: [
          { type: 'text', text: '🎉 ยิงครบ 100%!', color: '#ffffff', weight: 'bold', size: 'xl' },
          { type: 'text', text: 'SPX Scanner — รอบสำเร็จ', color: '#ffffffaa', size: 'xs', margin: 'sm' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          { type: 'text', text: round.name, weight: 'bold', size: 'md', wrap: true, color: '#111111' },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
            { type: 'text', text: '📦 สแกนแล้ว', color: '#555', size: 'sm' },
            { type: 'text', text: `${doneCount}/${round.items.length} ชิ้น`, align: 'end', weight: 'bold', color: '#16a34a' }
          ]},
          { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
            { type: 'text', text: '✔️ สำเร็จ', color: '#555', size: 'sm' },
            { type: 'text', text: `${pct}%`, align: 'end', weight: 'bold', color: '#16a34a' }
          ]},
          { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
            { type: 'text', text: '🕐 เวลา', color: '#555', size: 'sm' },
            { type: 'text', text: now, align: 'end', size: 'xs', color: '#888' }
          ]}
        ]
      }
    }
  };
}

// ─── C10: Webhook ─────────────────────────────────────────────────────────────
function triggerWebhook(event, data) {
  if (!sysSettings.webhookUrl) return;
  try {
    const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    const url = new URL(sysSettings.webhookUrl);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : require('http');
    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = mod.request(opts, r => { r.on('data', () => {}); });
    req.on('error', e => console.error('[webhook]', e.message));
    req.write(payload);
    req.end();
  } catch(e) { console.error('[webhook] bad url:', e.message); }
}

// ─── DAILY SCHEDULER (Auto-Print + LINE Summary) ─────────────────────────────
let schedulerTimer = null;

function buildDailySummary() {
  const today = new Date();
  const ymd = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  
  // Get today's rounds
  const todayRounds = rounds.filter(r => {
    const dt = new Date(r.uploadedAt);
    const ry = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
    return ry === ymd;
  });
  
  if (!todayRounds.length) return null;

  const excludeList = sysSettings.excludeCarriers || [];
  let totalItems = 0, totalDone = 0;
  let carrierSummary = {};
  let includedRoundIds = [];

  todayRounds.forEach(r => {
    // Check if this round should be excluded
    const shouldExclude = excludeList.some(ex => r.name.startsWith(ex));
    if (shouldExclude) return;
    
    includedRoundIds.push(r.id);
    const st = roundStats(r);
    totalItems += st.total;
    totalDone += st.done;

    // Detect carrier for summary
    const carrier = detectCarrier(r.name, (r.items[0]||{}).tracking || '');
    if (!carrierSummary[carrier]) carrierSummary[carrier] = { rounds: 0, items: 0, done: 0 };
    carrierSummary[carrier].rounds++;
    carrierSummary[carrier].items += st.total;
    carrierSummary[carrier].done += st.done;
  });

  return {
    date: ymd,
    totalRounds: includedRoundIds.length,
    totalItems,
    totalDone,
    totalMissing: totalItems - totalDone,
    carrierSummary,
    roundIds: includedRoundIds
  };
}

function formatLineMessage(summary) {
  if (!summary) return [{ type: 'text', text: '\n📦 [Express Scanner] ไม่มีรอบจัดส่งวันนี้' }];

  let bodyContents = [
    { type: 'text', text: '— สรุปผลงานวันนี้ —', align: 'center', color: '#888888', size: 'sm', weight: 'bold', margin: 'md' },
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
        { type: 'text', text: '📦 ออเดอร์ทั้งหมด', color: '#555555', size: 'sm' },
        { type: 'text', text: String(summary.totalItems), align: 'end', weight: 'bold', color: '#111111' }
      ]
    },
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
        { type: 'text', text: '✅ ยิงสำเร็จ', color: '#555555', size: 'sm' },
        { type: 'text', text: String(summary.totalDone), align: 'end', weight: 'bold', color: '#16a34a' }
      ]
    },
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
        { type: 'text', text: '❌ ยิงไม่สำเร็จ', color: '#555555', size: 'sm' },
        { type: 'text', text: String(summary.totalMissing), align: 'end', weight: 'bold', color: summary.totalMissing > 0 ? '#ef4444' : '#111111' }
      ]
    },
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
        { type: 'text', text: '📋 จำนวนรอบทั้งหมด', color: '#555555', size: 'sm' },
        { type: 'text', text: String(summary.totalRounds), align: 'end', weight: 'bold', color: '#eab308' }
      ]
    }
  ];

  if (Object.keys(summary.carrierSummary).length > 0) {
    bodyContents.push({ type: 'separator', margin: 'xl' });
    bodyContents.push({ type: 'text', text: '— แยกตามขนส่ง —', align: 'center', color: '#888888', size: 'sm', weight: 'bold', margin: 'md' });
    
    Object.entries(summary.carrierSummary).forEach(([carrier, data]) => {
      const pct = data.items > 0 ? Math.round(data.done / data.items * 100) : 0;
      bodyContents.push({
        type: 'box', layout: 'horizontal', margin: 'sm', contents: [
          { type: 'text', text: '🚚 ' + carrier, color: '#555555', size: 'sm', flex: 2 },
          { type: 'text', text: data.done + '/' + data.items, align: 'end', size: 'sm', color: '#111111' },
          { type: 'text', text: '(' + pct + '%)', align: 'end', size: 'sm', color: pct === 100 ? '#16a34a' : '#888888', flex: 1 }
        ]
      });
    });
  }

  const flex = {
    type: 'flex',
    altText: 'Daily Report Summary',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0ea5e9',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: 'สรุปยอดยิงใบส่งมอบ', color: '#ffffff', weight: 'bold', size: 'xl' },
          { type: 'text', text: 'วันที่ ' + summary.date, color: '#ffffffcc', size: 'sm', margin: 'sm' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: bodyContents
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: 'SPX Scanner — Delivery', align: 'center', color: '#cccccc', size: 'xs' }
        ]
      },
      styles: { header: { backgroundColor: '#0ea5e9' } }
    }
  };

  return [flex];
}

async function runDailyJob() {
  console.log('[scheduler] ⏰ เริ่มงาน Auto-Print + LINE Notify');
  try {
    const summary = buildDailySummary();
    const msg = formatLineMessage(summary);
    const result = await sendLineNotify(msg);
    console.log('[scheduler] ✅ ส่ง LINE สำเร็จ:', result.status || result);
    
    // Auto-clean old rounds
    if (sysSettings.autoCleanEnabled) {
      const days = sysSettings.autoCleanDays || 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const before = rounds.length;
      rounds = rounds.filter(r => new Date(r.uploadedAt) >= cutoff);
      const removed = before - rounds.length;
      if (removed > 0) {
        scheduleSave();
        console.log('[auto-clean] 🧹 ลบ ' + removed + ' รอบที่เก่ากว่า ' + days + ' วัน');
      }
    }

  } catch(e) {
    console.error('[scheduler] ❌ ส่ง LINE ล้มเหลว:', e.message);
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  // Check every 30 seconds if it's time
  let lastTriggeredDate = '';
  schedulerTimer = setInterval(() => {
    if (!sysSettings.autoPrintEnabled) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const timeNow = hh + ':' + mm;
    const dateNow = now.toISOString().slice(0,10);
    
    if (timeNow === sysSettings.printTime && lastTriggeredDate !== dateNow) {
      lastTriggeredDate = dateNow;
      runDailyJob();
    }
  }, 30000);
  console.log('[scheduler] 🕐 ตั้งเวลาสำเร็จ — จะทำงานทุกวันเวลา ' + sysSettings.printTime);
}

startScheduler();

const genId        = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const getRound     = id  => rounds.find(r => r.id === id) || null;
const currentRound = ()  => getRound(currentRoundId);

function recordKpi(user, result) {
  if (!user || !EMPLOYEES.includes(user)) return;
  if (!kpi[user]) kpi[user] = { ok:0, dup:0, err:0, daily:{} };
  kpi[user][result] = (kpi[user][result] || 0) + 1;
  const day = new Date().toISOString().slice(0,10);
  if (!kpi[user].daily[day]) kpi[user].daily[day] = { ok:0, dup:0, err:0 };
  kpi[user].daily[day][result]++;
  scheduleSave();
}

function roundStats(r) {
  if (!r) return { total:0, done:0, missing:0, isComplete:false, scannedKeys:[], missingItems:[], scans:[], recalledCount:0, pendingRecallCount:0 };
  // Exclude items that are canceled/recalled from required active items
  const activeItems = (r.items || []).filter(it => it.recallState !== 'RECALLED' && it.recallState !== 'PENDING_RECALL');
  const okScans = (r.scans || []).filter(s => s.result === 'ok');
  const scannedSet  = new Set(okScans.map(s => s.code));
  const missingItems = activeItems.filter(it => {
    if (it.tracking && scannedSet.has(it.tracking)) return false;
    if (it.order    && scannedSet.has(it.order))    return false;
    return true;
  });
  const recalledItems = (r.items || []).filter(it => it.recallState === 'RECALLED');
  const pendingRecallItems = (r.items || []).filter(it => it.recallState === 'PENDING_RECALL');

  return { 
    total: activeItems.length, 
    totalOriginal: (r.items || []).length,
    done: scannedSet.size, 
    missing: missingItems.length,
    isComplete: activeItems.length > 0 && scannedSet.size >= activeItems.length && pendingRecallItems.length === 0,
    scannedKeys: [...scannedSet], 
    missingItems, 
    scans: okScans,
    recalledCount: recalledItems.length,
    pendingRecallCount: pendingRecallItems.length,
    recalledItems,
    pendingRecallItems
  };
}

function getTodayScans() {
  const todayDateStr = new Date().toISOString().split('T')[0];
  let c = 0;
  rounds.forEach(r => {
    (r.scans || []).forEach(s => {
      if (s.result === 'ok' && s.time && s.time.startsWith(todayDateStr)) c++;
    });
  });
  return c;
}

function statsPayload(targetRound) {
  const r = targetRound || currentRound();
  const t = getTodayScans();
  if (!r) return { total:0, done:0, scanned:[], todayCount:t, recalledCount:0, pendingRecallCount:0 };
  const st = roundStats(r);
  return { 
    total: st.total, 
    totalOriginal: st.totalOriginal,
    done: st.done, 
    scanned: st.scannedKeys, 
    todayCount: t,
    recalledCount: st.recalledCount,
    pendingRecallCount: st.pendingRecallCount
  };
}

// ─── PDF EXTRACTION (coordinate-based pairing) ───────────────────────────────
// เดิมระบบดึง Tracking ทั้งชุดเป็น array หนึ่ง, Order อีก array หนึ่ง แล้วจับคู่ตาม index
// (tracking[i] คู่กับ order[i]) — ถ้า pdf2json คืนลำดับข้อความไม่ตรงกับที่ตาเห็นในตาราง
// 2 คอลัมน์ หรือมีตัวไหนหลุด regex ไป ทุกคู่หลังจากนั้นจะเลื่อนผิดหมด (Order ว่าง/ไม่ครบ)
// ฟังก์ชันใหม่นี้จับคู่ตามตำแหน่งจริงบนหน้ากระดาษ (X, Y) แทน จึงแม่นยำกว่ามาก
// ─── PDF & TEXT EXTRACTION ENGINES ──────────────────────────────────────────
function extractAllPdfPages(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataReady', data => {
      const pages = (data.Pages || []).map((p, idx) => {
        const text = (p.Texts || []).map(t => decodeURIComponent(t.R?.[0]?.T || '')).join(' ');
        const compactText = (p.Texts || []).map(t => decodeURIComponent(t.R?.[0]?.T || '')).join('');
        const runs = (p.Texts || []).map(t => ({
          x: t.x, y: t.y,
          text: (t.R || []).map(r => decodeURIComponent(r.T || '')).join('')
        }));
        return { pageNum: idx + 1, text, compactText, runs };
      });
      resolve(pages);
    });
    parser.on('pdfParser_dataError', err => reject(new Error(String(err.parserError || err))));
    parser.parseBuffer(buffer);
  });
}

function cleanSpacedText(str) {
  if (!str) return '';
  return str.replace(/([A-Za-z0-9])\s+([A-Za-z0-9])(?=\s+[A-Za-z0-9]|$)/g, '$1$2')
            .replace(/([A-Za-z0-9])\s+([A-Za-z0-9])/g, '$1$2');
}

function extractLabelItem(pageText, filename, compactText = '') {
  const normText = cleanSpacedText(pageText);

  // 1. TikTok Check
  if (/tiktok|tht/i.test(pageText) || /tht/i.test(normText) || /tiktok|tht/i.test(compactText) || /tiktok/i.test(filename)) {
    const trackM = pageText.match(/\b(THT[0-9A-Z]{10,16})\b/i) || 
                   normText.match(/\b(THT[0-9A-Z]{10,16})\b/i) ||
                   compactText.match(/\b(THT[0-9A-Z]{10,16})\b/i) ||
                   compactText.match(/(THT[0-9A-Z]{10,16})/i);
    const tracking = trackM ? (trackM[1] || trackM[0]).toUpperCase() : '';
    
    let order = '';
    const orderM = pageText.match(/Order\s*ID[:\s]*([0-9\s]{15,26})/i) || 
                   normText.match(/Order\s*ID[:\s]*([0-9]{15,22})/i) ||
                   compactText.match(/Order\s*ID[:\s]*([0-9]{15,22})/i);
    if (orderM) {
      order = (orderM[1] || '').replace(/\s+/g, '');
    }
    if (!order) {
      const anyNum = normText.match(/\b(5\d{16,20})\b/) || compactText.match(/(5\d{16,20})/);
      if (anyNum) order = anyNum[1] || anyNum[0];
    }
    return { order, tracking, carrier: 'TikTok Shop', platform: 'TikTok' };
  }

  // 2. Lazada Check
  if (/lazada|lex/i.test(pageText) || /lazada|lex/i.test(compactText) || /lazada|lex/i.test(filename)) {
    const trackM = pageText.match(/L\s*E\s*X\s*P\s*U\s*([0-9\s]{10,20})/i) || 
                   pageText.match(/\b(LEXPU[0-9]{10})\b/i) ||
                   compactText.match(/(LEXPU[0-9]{10})/i);
    const tracking = trackM ? ('LEXPU' + (trackM[1] || trackM[0].replace(/^LEXPU/i, '')).replace(/\s+/g, '').substring(0, 10)).toUpperCase() : '';
    
    let order = '';
    const orderM = pageText.match(/Order\s*No\.?[:\s]*([0-9]{14,18})/i) || 
                   pageText.match(/Order\s*Number[:\s]*([0-9]{14,18})/i) ||
                   compactText.match(/Order\s*No\.?[:\s]*([0-9]{14,18})/i) ||
                   compactText.match(/Order\s*Number[:\s]*([0-9]{14,18})/i);
    if (orderM) {
      order = (orderM[1] || orderM[0]).trim();
    }
    return { order, tracking, carrier: 'Lazada (LEX)', platform: 'Lazada' };
  }

  // 3. Shopee Check (SPX / Flash)
  let tracking = '';
  let order = '';

  const specificOrderM = pageText.match(/(?:Shopee\s*Order\s*No\.?|ค\s*ํ\s*า\s*ส\s*ั\s*่\s*ง\s*ซ\s*ื\s*้\s*อ\s*:?)\s*([2-9A-Z0-9\s]{14,26})/i) ||
                         compactText.match(/(?:Shopee\s*Order\s*No\.?|คำสั่งซื้อ:?)\s*([2-9A-Z0-9]{14,20})/i);
  if (specificOrderM) {
    const raw = (specificOrderM[1] || '').replace(/\s+/g, '').toUpperCase();
    if (raw.startsWith('26') && raw.length >= 14) {
      order = raw.substring(0, 14);
    }
  }
  if (!order) {
    const fbM = pageText.match(/\b(26[0-9A-Z]{12})\b/) || normText.match(/\b(26[0-9A-Z]{12})\b/) || compactText.match(/(26[0-9A-Z]{12})/);
    if (fbM) order = (fbM[1] || fbM[0]).toUpperCase();
  }

  const trackMatches = pageText.match(/\b(TH[0-9A-Z]{11,15})\b/gi) || 
                       normText.match(/\b(TH[0-9A-Z]{11,15})\b/gi) || 
                       compactText.match(/(TH[0-9A-Z]{11,15})/gi) || [];
  for (const t of trackMatches) {
    const ut = t.toUpperCase();
    if (ut !== order) {
      tracking = ut;
      break;
    }
  }

  let carrier = 'SPX Express';
  if (/bulky/i.test(filename) || /bulky/i.test(pageText) || /bulky/i.test(compactText)) {
    carrier = 'Flash Express Bulky';
  } else if (/flash|แฟลช|_bsp|speed/i.test(filename) || /_bsp|speed/i.test(pageText) || /_bsp|speed/i.test(compactText)) {
    carrier = 'Flash Express';
  } else if (/ด่วนคลัง/i.test(filename) || /ด่วนคลัง/i.test(pageText) || /ด่วนคลัง/i.test(compactText)) {
    carrier = 'SPX ด่วนคลัง';
  } else if (/ส่งด่วน|ส่งทันที|ด่วนทันที/i.test(filename) || /ส่งด่วน|shp food/i.test(pageText) || /ส่งด่วน|shp food/i.test(compactText)) {
    carrier = 'SPX ส่งด่วน';
  } else if (/spx/i.test(filename) || /express delivery \(spx\)/i.test(pageText) || /^TH2/.test(tracking)) {
    carrier = 'SPX Express';
  }

  return { order, tracking, carrier, platform: 'Shopee' };
}

function extractPdfRuns(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataReady', data => {
      // อ่านและรวม Text Runs จากทุกหน้า โดยปรับค่า Y ตามเลขหน้าเพื่อไม่ให้แถวของหน้าต่างกันซ้อนทับกัน
      const runs = [];
      const PAGE_HEIGHT = 100; // ค่า offset ความสูงต่อหน้าเพื่อแยกแถว
      (data.Pages || []).forEach((p, pageIdx) => {
        (p.Texts || []).forEach(t => {
          runs.push({
            x: t.x,
            y: t.y + (pageIdx * PAGE_HEIGHT),
            text: (t.R || []).map(r => decodeURIComponent(r.T || '')).join('')
          });
        });
      });
      resolve(runs);
    });
    parser.on('pdfParser_dataError', err => reject(new Error(String(err.parserError || err))));
    parser.parseBuffer(buffer);
  });
}


function extractItems(runs) {
  const ORDER_RE = /^26[0-9A-Z]{8,16}$/;
  const TRACK_RE = /^TH[0-9A-Z]{9,16}$/;

  // 1) จัดกลุ่ม text-run เป็น "แถว" ตามค่า Y ที่ใกล้เคียงกัน (tolerance 0.5)
  const rows = {};
  runs.forEach(r => {
    const key = Math.round(r.y * 2) / 2;
    (rows[key] = rows[key] || []).push(r);
  });

  // 2) ในแต่ละแถว เรียง run ตาม X แล้วไล่หา token ที่ขึ้นต้นด้วย "26" หรือ "TH"
  //    ถ้า run เดียวยังไม่ครบรูปแบบ (pdf2json บางทีตัดเลขเดียวกันออกเป็นหลาย
  //    text-run กลางคัน เช่น "260724GR" + "YYU69H") จะปะติดกับ run ถัดไปเรื่อยๆ
  //    จนกว่าจะได้รูปแบบที่ถูกต้อง — แก้ปัญหา Order/Tracking หายหรือจับคู่ผิด
  const items = [];
  const seen = new Set();
  Object.keys(rows).sort((a,b) => a - b).forEach(key => {
    const rowRuns = rows[key].slice().sort((a,b) => a.x - b.x);
    const orders = [], trackings = [];
    let i = 0;
    while (i < rowRuns.length) {
      const txt = (rowRuns[i].text || '').toUpperCase();
      if ((/^26/.test(txt) || /^TH/.test(txt)) && !/^[0-9]{1,4}$/.test(txt)) {
        const isTrack = /^TH/.test(txt);
        const re = isTrack ? TRACK_RE : ORDER_RE;
        let buf = txt, j = i + 1;
        while (!re.test(buf) && j < rowRuns.length && buf.length < 22) {
          buf += (rowRuns[j].text || '').toUpperCase();
          j++;
        }
        if (re.test(buf)) {
          (isTrack ? trackings : orders).push(buf);
          i = j;
          continue;
        }
      }
      i++;
    }
    // 3) จับคู่ order/tracking ตามลำดับที่พบในแถวเดียวกัน (ซ้าย→ขวา)
    const n = Math.max(orders.length, trackings.length);
    for (let k = 0; k < n; k++) {
      const order = orders[k] || '';
      const tracking = trackings[k] || '';
      const dupKey = order || tracking;
      if (!dupKey || seen.has(dupKey)) continue; // กันซ้ำภายในไฟล์เดียวกัน
      seen.add(dupKey);
      items.push({ id: genId(), order, tracking });
    }
  });
  return items;
}

function extractItemsFromPdfPages(pages, filename) {
  if (!pages || !pages.length) return [];
  const firstText = (pages[0] && pages[0].text) || '';
  const firstCompact = (pages[0] && pages[0].compactText) || '';
  const isLabel = /Shopee\s*Order|Order\s*No|Order\s*ID|Order\s*Number|Express\s*Delivery|SHIP\s*BY|TikTok|Lazada|THT/i.test(firstText) ||
                  /Shopee\s*Order|Order\s*No|Order\s*ID|Order\s*Number|Express\s*Delivery|SHIP\s*BY|TikTok|Lazada|THT/i.test(firstCompact) ||
                  /tiktok|lazada|spx|shopee|flash|tacking|tracking|label/i.test(filename || '') ||
                  pages.length > 1;

  if (isLabel) {
    const items = [];
    const seen = new Set();
    pages.forEach(p => {
      const extracted = extractLabelItem(p.text, filename, p.compactText);
      if (extracted.order || extracted.tracking) {
        const key = extracted.order || extracted.tracking;
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            id: genId(),
            order: extracted.order,
            tracking: extracted.tracking,
            carrier: extracted.carrier,
            platform: extracted.platform
          });
        }
      }
    });
    return items;
  } else {
    // Fallback: Old delivery manifest table format
    const allItems = [];
    pages.forEach(p => {
      const pageItems = extractItems(p.runs);
      pageItems.forEach(it => allItems.push(it));
    });
    return allItems;
  }
}

function parseTextOrders(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let currentCarrier = 'General';
  const carrierGroups = {};

  lines.forEach(line => {
    if (/ขนส่ง\s*(.+?)(?:\s*เรียกรถ|$)/i.test(line)) {
      const m = line.match(/ขนส่ง\s*(.+?)(?:\s*เรียกรถ|$)/i);
      currentCarrier = m[1].trim();
      return;
    }
    
    const orderM = line.match(/\b(26[0-9A-Z]{12})\b/i) || line.match(/[-:\s]+([0-9A-Z]{14,18})\b/i);
    if (orderM) {
      const order = orderM[1].toUpperCase();
      let lineCarrier = currentCarrier;
      const prefixM = line.match(/^([^-\n]+)\s*-\s*[0-9A-Z]/i);
      if (prefixM) {
        lineCarrier = prefixM[1].trim();
      }
      carrierGroups[lineCarrier] = carrierGroups[lineCarrier] || [];
      if (!carrierGroups[lineCarrier].includes(order)) {
        carrierGroups[lineCarrier].push(order);
      }
    }
  });
  return carrierGroups;
}

// ─── SHARED HEAD ──────────────────────────────────────────────────────────────
function parseShippingLabelPage(pageRuns, pageNum) {
  const merged = pageRuns.map(r => r.text || '').join('');
  let carrier = 'อื่นๆ';
  let order = '';
  let tracking = '';

  // 1. SPX ส่งด่วน (Instant / Express Delivery แบบไม่มี tracking หรือ SHP Food)
  if (merged.includes('รหัสอ้างอิง') || merged.includes('SHP Food') || 
     ((merged.includes('Express Delivery') || merged.includes('Instant Delivery')) && !merged.includes('TH2'))) {
    carrier = 'SPX ส่งด่วน';
    const mOrd = merged.match(/26[0-9A-Z]{12}/);
    if (mOrd) order = mOrd[0];
    tracking = '';
  }
  // 2. Lazada (LEX)
  else if (merged.includes('LAZADA') || merged.includes('Lazada') || /LEX[0-9A-Z]{12}/.test(merged)) {
    carrier = 'Lazada Express';
    const mLex = merged.match(/LEX[0-9A-Z]{12}/);
    if (mLex) tracking = mLex[0];
    const mOrd = merged.match(/Order No\.\s*:?\s*(\d+)/i) || merged.match(/\b11\d{14}\b/);
    if (mOrd) order = Array.isArray(mOrd) && mOrd[1] ? mOrd[1] : mOrd[0];
  }
  // 3. Flash TikTok Shop
  else if (merged.includes('THT') || merged.includes('TikTok') || merged.includes('ติ๊กต็อก')) {
    carrier = 'Flash Express (TikTok)';
    const mTht = merged.match(/THT[0-9A-Z]{12}/);
    if (mTht) tracking = mTht[0];
    const mOrd = merged.match(/Order ID\s*:?\s*(\d{16,19})/i) || merged.match(/\d{18}/);
    if (mOrd) order = Array.isArray(mOrd) && mOrd[1] ? mOrd[1] : mOrd[0];
  }
  // 4. Flash Shopee (TH3... หรือมีคำว่า Flash/แฟลช)
  else if (merged.includes('Flash') || /TH3[0-9A-Z]{12}/.test(merged)) {
    carrier = 'Flash Express';
    const mTr = merged.match(/TH[0-9A-Z]{12}/);
    if (mTr) tracking = mTr[0];
    const mOrd = merged.match(/26[0-9A-Z]{12}/);
    if (mOrd) order = mOrd[0];
  }
  // 5. SPX Standard / SPX ด่วนคลัง (Shopee)
  else if (merged.includes('SPX') || /TH2[0-9A-Z]{12}/.test(merged)) {
    carrier = (merged.includes('ด่วนคลัง') || merged.includes('APWET')) ? 'SPX ด่วนคลัง' : 'SPX Express';
    const mTr = merged.match(/TH[0-9A-Z]{12,13}/);
    if (mTr) tracking = mTr[0];
    // หาเลขออเดอร์ Shopee โดยไม่เอา tracking ที่ตัดหัว TH ออก
    const all26 = merged.match(/26[0-9A-Z]{12}/g) || [];
    const validOrd = all26.find(o => !tracking || !tracking.includes(o));
    if (validOrd) order = validOrd;
    else if (all26.length > 0) order = all26[0];
  }

  // Fallback regex detection ถ้ายังไม่พบ
  if (!order) {
    const all26 = merged.match(/26[0-9A-Z]{12}/g) || [];
    const validOrd = all26.find(o => !tracking || !tracking.includes(o));
    if (validOrd) order = validOrd;
    else if (all26.length) order = all26[0];
  }
  if (!tracking && carrier !== 'SPX ส่งด่วน') {
    const mTr = merged.match(/TH[0-9A-Z]{12,13}/) || merged.match(/LEX[0-9A-Z]{12}/);
    if (mTr) tracking = mTr[0];
  }

  const ok = !!(order || tracking);
  return {
    ok,
    pageNum,
    carrier,
    order: order || '',
    tracking: tracking || '',
    scanKey: tracking || order || ''
  };
}

function sharedHead(title) {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<style>
/* SweetAlert2 Theme Integration */
.swal2-container {
  z-index: 1000000 !important;
}
.swal2-popup {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif !important;
  border-radius: 1.25rem !important;
  font-size: .92rem !important;
}
[data-theme="dark"] .swal2-popup,
html:not([data-theme="light"]) .swal2-popup {
  background: var(--surface, #1e293b) !important;
  color: var(--text, #f1f5f9) !important;
  border: 1px solid var(--border, #334155) !important;
  box-shadow: 0 16px 48px rgba(0,0,0,0.6) !important;
}
[data-theme="dark"] .swal2-title,
html:not([data-theme="light"]) .swal2-title {
  color: var(--text, #f1f5f9) !important;
  font-weight: 800 !important;
  font-size: 1.15rem !important;
}
[data-theme="dark"] .swal2-html-container,
html:not([data-theme="light"]) .swal2-html-container {
  color: var(--muted, #94a3b8) !important;
  line-height: 1.5 !important;
}
[data-theme="light"] .swal2-popup {
  background: #ffffff !important;
  color: #0f172a !important;
  border: 1px solid #e2e8f0 !important;
  box-shadow: 0 16px 48px rgba(0,0,0,0.12) !important;
}
[data-theme="light"] .swal2-title {
  color: #0f172a !important;
  font-weight: 800 !important;
  font-size: 1.15rem !important;
}
[data-theme="light"] .swal2-html-container {
  color: #475569 !important;
  line-height: 1.5 !important;
}
.swal2-actions {
  gap: .5rem !important;
}
.swal2-confirm {
  background: var(--blue, #3b82f6) !important;
  color: #fff !important;
  border-radius: .7rem !important;
  font-weight: 700 !important;
  padding: .6rem 1.4rem !important;
  border: none !important;
  box-shadow: none !important;
}
.swal2-confirm:hover {
  background: #2563eb !important;
}
.swal2-cancel {
  background: transparent !important;
  color: var(--muted, #94a3b8) !important;
  border: 1px solid var(--border, #334155) !important;
  border-radius: .7rem !important;
  font-weight: 700 !important;
  padding: .6rem 1.4rem !important;
  box-shadow: none !important;
}
.swal2-cancel:hover {
  color: var(--text, #f1f5f9) !important;
  border-color: var(--text, #f1f5f9) !important;
}
[data-theme="light"] .swal2-cancel {
  border-color: #cbd5e1 !important;
  color: #64748b !important;
}
[data-theme="light"] .swal2-cancel:hover {
  border-color: #0f172a !important;
  color: #0f172a !important;
}
</style>
<link rel="icon" type="image/png" href="/logo.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#3b82f6">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>
:root{
  --bg:#0f172a;--surface:#1e293b;--surface2:#273344;--border:#334155;
  --blue:#3b82f6;--blue2:#60a5fa;--green:#22c55e;--red:#ef4444;
  --yellow:#f59e0b;--purple:#a855f7;--text:#f1f5f9;--muted:#94a3b8;
  --shadow:0 4px 24px rgba(0,0,0,.35);
}
[data-theme=light]{
  --bg:#f1f5f9;--surface:#fff;--surface2:#f8fafc;--border:#e2e8f0;
  --text:#0f172a;--muted:#64748b;--shadow:0 4px 24px rgba(0,0,0,.08);
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;transition:background .25s,color .25s}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
  padding:.65rem 1.15rem;border:none;border-radius:.7rem;font-size:.875rem;
  font-weight:700;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:active{transform:scale(.96)}
.btn-blue{background:var(--blue);color:#fff}.btn-blue:hover{background:#2563eb}
.btn-green{background:#14532d;color:var(--green);border:1px solid #166534}
.btn-red{background:#450a0a;color:var(--red);border:1px solid var(--red)}
.btn-gray{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-gray:hover{color:var(--text);border-color:var(--text)}
.btn-sm{padding:.38rem .8rem;font-size:.76rem;border-radius:.5rem}
.btn-full{width:100%}
.card{background:var(--surface);border:1px solid var(--border);border-radius:1.25rem;padding:1.25rem;box-shadow:var(--shadow)}
.badge{border-radius:9999px;padding:.14rem .65rem;font-size:.7rem;font-weight:700;display:inline-flex;align-items:center;gap:.2rem}
.bg-green{background:#14532d;color:var(--green);border:1px solid #166534}
.bg-yellow{background:#451a03;color:var(--yellow);border:1px solid #92400e}
.bg-blue{background:#1e3a5f;color:var(--blue2);border:1px solid #1d4ed8}
.bg-red{background:#450a0a;color:var(--red);border:1px solid #991b1b}
.bg-muted{background:var(--surface2);color:var(--muted)}
[data-theme=light] .bg-green{background:#dcfce7;color:#166534}
[data-theme=light] .bg-yellow{background:#fef9c3;color:#854d0e}
[data-theme=light] .bg-blue{background:#dbeafe;color:#1d4ed8}
[data-theme=light] .bg-red{background:#fee2e2;color:#991b1b}
.theme-btn{width:2.1rem;height:2.1rem;border-radius:9999px;border:1px solid var(--border);
  background:var(--surface2);cursor:pointer;font-size:.95rem;display:flex;align-items:center;justify-content:center;flex-shrink:0}
input,select{background:var(--surface2);border:1px solid var(--border);border-radius:.6rem;
  color:var(--text);padding:.6rem .85rem;font-size:.875rem;outline:none;transition:border-color .15s;width:100%}
input:focus,select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(59,130,246,.12)}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{text-align:left;padding:.5rem .65rem;border-bottom:2px solid var(--border);
  color:var(--muted);font-size:.68rem;text-transform:uppercase;letter-spacing:.06em}
td{padding:.42rem .65rem;border-bottom:1px solid rgba(128,128,128,.08);vertical-align:middle}
tr:last-child td{border:none}
.progress{background:var(--border);border-radius:9999px;height:7px;overflow:hidden}
.progress-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,var(--blue),var(--green));transition:width .5s ease}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:9999px}
.hidden{display:none!important}
.flex{display:flex;align-items:center}
.gap{gap:.6rem}.gap-sm{gap:.4rem}
.between{justify-content:space-between}
.wrap{flex-wrap:wrap}
.folder-month, .folder-day { margin-bottom: .45rem; }
.folder-summary { 
  padding: .6rem .8rem; background: var(--surface2); border: 1px solid var(--border); 
  border-radius: .5rem; cursor: pointer; font-weight: 600; display: flex; 
  align-items: center; gap: .5rem; user-select: none; transition: background .15s; font-size:.9rem;
}
.folder-summary:hover { background: var(--surface); }
.folder-summary::marker { content: ''; display: none; }
.folder-summary::-webkit-details-marker { display: none; }
details[open] > .folder-summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom: none; }
details[open] > .folder-summary .f-icon::before { content: '📂'; }
details:not([open]) > .folder-summary .f-icon::before { content: '📁'; }
.folder-content { 
  border: 1px solid var(--border); border-top: none;
  border-bottom-left-radius: .5rem; border-bottom-right-radius: .5rem; 
  padding: .6rem; padding-left: .8rem;
  background: rgba(0,0,0,0.05);
}
.day-content { display: flex; flex-direction: column; gap: .4rem; }
.round-name, .rc-name { word-break: break-word; overflow-wrap: anywhere; white-space: normal; }
.rc-item > div:first-child { word-break: break-word; overflow-wrap: anywhere; min-width: 0; }
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:200;padding:1rem}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:1.25rem;padding:1.5rem;max-width:420px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.modal-title{font-size:1rem;font-weight:800;margin-bottom:1rem}
.form-group{margin-bottom:.8rem}
.form-label{font-size:.75rem;color:var(--muted);margin-bottom:.3rem;display:block}
</style>
<script>
// ── Shared UI Helpers ────────────────────────────────────────────────────────
function groupHistoryByDate(history) {
  var groups = {};
  var sortedMonths = [];
  history.forEach(function(r) {
    var dt = new Date(r.uploadedAt);
    var y = dt.getFullYear();
    var m = dt.getMonth() + 1;
    var d = dt.getDate();
    
    var monthKey = y + '/' + String(m).padStart(2,'0');
    var dayKey = y + '/' + String(m).padStart(2,'0') + '/' + String(d).padStart(2,'0');
    
    if(!groups[monthKey]) {
      groups[monthKey] = { label: 'เดือน ' + monthKey, days: {}, dayOrder: [], totalRounds: 0 };
      sortedMonths.push(monthKey);
    }
    if(!groups[monthKey].days[dayKey]) {
      groups[monthKey].days[dayKey] = { label: 'วันที่ ' + dayKey, rounds: [] };
      groups[monthKey].dayOrder.push(dayKey);
    }
    groups[monthKey].days[dayKey].rounds.push(r);
    groups[monthKey].totalRounds++;
  });
  return { groups: groups, monthOrder: sortedMonths };
}

function generateOptgroupsHTML(history, labelFn) {
  var g = groupHistoryByDate(history);
  var html = '';
  g.monthOrder.forEach(function(mKey) {
    g.groups[mKey].dayOrder.forEach(function(dKey) {
      html += '<optgroup label="--- ' + dKey + ' ---">';
      g.groups[mKey].days[dKey].rounds.forEach(function(r) {
        var globalIdx = history.indexOf(r);
        var num = history.length - globalIdx;
        html += labelFn(r, num);
      });
      html += '</optgroup>';
    });
  });
  return html;
}

function generateFoldersHTML(history, renderRoundFn) {
  var g = groupHistoryByDate(history);
  var html = '';
  var isFirstMonth = true;
  g.monthOrder.forEach(function(mKey) {
    var monthData = g.groups[mKey];
    html += '<details class="folder-month" '+(isFirstMonth?'open':'')+'>';
    html += '<summary class="folder-summary month-summary"><span class="f-icon"></span> '+monthData.label+' <span class="badge bg-gray" style="margin-left:auto">'+monthData.totalRounds+' รอบ</span></summary>';
    html += '<div class="folder-content">';
    
    var isFirstDayInMonth = true;
    monthData.dayOrder.forEach(function(dKey) {
      var dayData = monthData.days[dKey];
      var openAttr = (isFirstMonth && isFirstDayInMonth) ? 'open' : '';
      html += '<details class="folder-day" '+openAttr+'>';
      html += '<summary class="folder-summary day-summary" style="font-size:.85rem;padding:.4rem .6rem"><span class="f-icon"></span> '+dayData.label+' <span class="badge bg-gray" style="margin-left:auto">'+dayData.rounds.length+' รอบ</span></summary>';
      html += '<div class="folder-content day-content">';
      
      dayData.rounds.forEach(function(r) {
        var globalIdx = history.indexOf(r);
        var num = history.length - globalIdx;
        html += renderRoundFn(r, num);
      });
      
      html += '</div></details>';
      isFirstDayInMonth = false;
    });
    
    html += '</div></details>';
    isFirstMonth = false;
  });
  return html;
}

// ── SweetAlert2 Global Helpers ───────────────────────────────────────────
function isDarkMode() {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

function showModalAlert(titleOrMsg, message, icon) {
  var title = message ? titleOrMsg : '';
  var text = message ? message : titleOrMsg;
  var ic = icon || 'info';

  if (!icon && typeof text === 'string') {
    if (text.includes('✅') || text.includes('🎉') || text.includes('สำเร็จ')) ic = 'success';
    else if (text.includes('❌') || text.includes('ล้มเหลว') || text.includes('ไม่ถูกต้อง') || text.includes('ไม่ได้') || text.includes('Error') || text.includes('ผิดพลาด')) ic = 'error';
    else if (text.includes('⚠️') || text.includes('คำเตือน') || text.includes('ระวัง')) ic = 'warning';
  }

  if (typeof Swal !== 'undefined') {
    return Swal.fire({
      title: title || (ic === 'success' ? 'สำเร็จ' : (ic === 'error' ? 'แจ้งเตือน' : (ic === 'warning' ? 'คำเตือน' : 'แจ้งเตือน'))),
      html: String(text).split(String.fromCharCode(10)).join('<br>'),
      icon: ic,
      confirmButtonText: 'ตกลง',
      buttonsStyling: false,
      customClass: {
        confirmButton: 'btn btn-blue',
        popup: 'swal2-popup'
      }
    });
  } else {
    window.originalAlert ? window.originalAlert(text) : alert(text);
    return Promise.resolve();
  }
}

function showModalConfirm(message, title, icon) {
  if (typeof Swal !== 'undefined') {
    return Swal.fire({
      title: title || 'ยืนยันการทำรายการ',
      html: String(message).split(String.fromCharCode(10)).join('<br>'),
      icon: icon || 'warning',
      showCancelButton: true,
      confirmButtonText: 'ยืนยัน',
      cancelButtonText: 'ยกเลิก',
      buttonsStyling: false,
      customClass: {
        confirmButton: 'btn btn-blue',
        cancelButton: 'btn btn-gray',
        popup: 'swal2-popup'
      },
      reverseButtons: true
    }).then(function(res) {
      return res.isConfirmed;
    });
  } else {
    var ok = window.originalConfirm ? window.originalConfirm(message) : confirm(message);
    return Promise.resolve(ok);
  }
}

// Override native window.alert to automatically use SweetAlert2 modal
if (typeof window !== 'undefined' && !window.originalAlert) {
  window.originalAlert = window.alert;
  window.alert = function(msg) {
    showModalAlert(msg);
  };
}

// XSS escape helper
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
</script>
<script>
(function(){
  var t=localStorage.getItem('spx_theme')||'dark';
  document.documentElement.setAttribute('data-theme',t);
})();
function toggleTheme(){
  var h=document.documentElement;
  var n=h.getAttribute('data-theme')==='dark'?'light':'dark';
  h.setAttribute('data-theme',n);
  localStorage.setItem('spx_theme',n);
  var b=document.getElementById('themeBtn');
  if(b)b.textContent=n==='dark'?'☀️':'🌙';
}
</script>
<script>
if('serviceWorker' in navigator){
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(()=>{}); });
}
</script>`;
}

// ─── PWA ──────────────────────────────────────────────────────────────────────
app.get('/manifest.json', (_req, res) => {
  res.json({
    "name": "Scanner Delivery Note", "short_name": "Scanner", "start_url": "/",
    "display": "standalone", "background_color": "#0f172a", "theme_color": "#3b82f6",
    "icons": [{"src": "/logo.png", "sizes": "512x512", "type": "image/png"}]
  });
});
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`self.addEventListener('fetch', e => {}); // minimal SW to pass PWA check`);
});

// ─── SSE (Real-time Sync) ─────────────────────────────────────────────────────
let sseClients = [];
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});
function broadcastUpdate(event = 'update', data = null) {
  let msg;
  if (data !== null) {
    msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  } else {
    msg = `data: ${event}\n\n`;
  }
  sseClients.forEach(c => {
    try { c.write(msg); } catch(e){}
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE: EMPLOYEE LOGIN
// ══════════════════════════════════════════════════════════════════════════════
app.get('/', (_req, res) => {
  const emps = JSON.stringify(EMPLOYEES);
  res.send(sharedHead('Scanner Delivery note') + `
<style>
body{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5rem;gap:1.5rem}
.logo{font-size:4rem;filter:drop-shadow(0 4px 20px rgba(59,130,246,.5))}
.title{font-size:1.5rem;font-weight:900;background:linear-gradient(135deg,var(--blue),var(--green));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-align:center}
.sub{color:var(--muted);font-size:.875rem;text-align:center}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.8rem;width:100%;max-width:380px}
.emp{padding:1.3rem .5rem 1rem;background:var(--surface);border:2px solid var(--border);
  border-radius:1.25rem;color:var(--text);font-size:1rem;font-weight:700;cursor:pointer;
  text-align:center;transition:all .2s;width:100%}
.emp .av{font-size:2rem;display:block;margin-bottom:.35rem}
.emp:hover{border-color:var(--blue);background:var(--surface2);transform:translateY(-3px);box-shadow:0 8px 24px rgba(59,130,246,.25)}
.top-abs{position:fixed;top:1rem;right:1rem;display:flex;gap:.5rem;align-items:center}
.admin-link{font-size:.75rem;color:var(--muted);cursor:pointer;background:var(--surface);
  border:1px solid var(--border);border-radius:9999px;padding:.35rem .85rem;transition:.15s;font-family:inherit}
.admin-link:hover{color:var(--text)}
/* Admin user-select modal */
.admin-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:300;padding:1rem;backdrop-filter:blur(4px);animation:fadein .18s ease}
@keyframes fadein{from{opacity:0}to{opacity:1}}
.admin-modal{background:var(--surface);border:1px solid var(--border);border-radius:1.4rem;padding:1.6rem;max-width:400px;width:100%;box-shadow:0 12px 48px rgba(0,0,0,.55);animation:slidein .2s cubic-bezier(.34,1.56,.64,1)}
@keyframes slidein{from{transform:translateY(18px);opacity:0}to{transform:translateY(0);opacity:1}}
.admin-modal-title{font-size:1.05rem;font-weight:800;margin-bottom:.3rem;color:var(--text)}
.admin-modal-sub{font-size:.8rem;color:var(--muted);margin-bottom:1.1rem}
.admin-emp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin-bottom:1rem}
.admin-emp-btn{padding:1rem .5rem .8rem;background:var(--surface2);border:2px solid var(--border);
  border-radius:1rem;color:var(--text);font-size:.85rem;font-weight:700;cursor:pointer;
  text-align:center;transition:all .18s;width:100%}
.admin-emp-btn .av{font-size:1.7rem;display:block;margin-bottom:.3rem}
.admin-emp-btn:hover{border-color:var(--blue);background:var(--surface);transform:translateY(-2px);box-shadow:0 6px 18px rgba(59,130,246,.25)}
.admin-cancel-btn{width:100%;padding:.55rem;background:transparent;border:1px solid var(--border);border-radius:.75rem;color:var(--muted);font-size:.82rem;font-weight:600;cursor:pointer;transition:.15s;font-family:inherit}
.admin-cancel-btn:hover{border-color:var(--text);color:var(--text)}
</style>
<div class="top-abs">
  <button class="btn btn-gray btn-sm" id="btnBigFont" onclick="toggleBigFontMode()" title="สลับโหมดตัวหนังสือขนาดใหญ่พิเศษสำหรับหน้าคลัง" style="font-size:.78rem;font-weight:700">🔠 จอใหญ่</button>
      <button class="theme-btn" id="themeBtn" onclick="toggleTheme()">☀️</button>
</div>
<div class="logo"><img style="width:300px;height:300px;object-fit:contain;border-radius:.45rem" src="/logo.png"</img></div>
<div><div class="title">Scanner Delivery Note</div><div class="sub" style="margin-top:.25rem">เลือกชื่อของคุณเพื่อเริ่มงาน</div></div>
<div class="grid" id="empGrid"></div>
<button class="admin-link" id="adminPanelBtn" onclick="openAdminModal()">⚙️ Admin Panel</button>

<!-- Admin user-select modal -->
<div class="admin-modal-bg" id="adminModal" style="display:none" onclick="if(event.target===this)closeAdminModal()">
  <div class="admin-modal">
    <div class="admin-modal-title">⚙️ เข้าสู่ Admin Panel</div>
    <div class="admin-modal-sub">เลือกผู้ใช้งานของคุณก่อนเข้าสู่หน้าแอดมิน</div>
    <div class="admin-emp-grid" id="adminEmpGrid"></div>
    <button class="admin-cancel-btn" onclick="closeAdminModal()">ยกเลิก</button>
  </div>
</div>

<script>
var avatars=["👨‍⚖️", "👩‍💼", "👨‍💻", "👨‍💼", "👨‍💼"];
var employees=${emps};
var grid=document.getElementById('empGrid');
var t=localStorage.getItem('spx_theme')||'dark';
document.getElementById('themeBtn').textContent=t==='dark'?'☀️':'🌙';

// Employee buttons → /scan
employees.forEach(function(name,i){
  var b=document.createElement('button');
  b.className='emp';
  b.innerHTML='<span class="av">'+avatars[i%avatars.length]+'</span>'+name;
  b.onclick=function(){ localStorage.setItem('spx_user',name); location.href='/scan'; };
  grid.appendChild(b);
});

// Admin modal employee buttons → /admin
function buildAdminEmpGrid(){
  var g=document.getElementById('adminEmpGrid');
  g.innerHTML='';
  employees.forEach(function(name,i){
    var b=document.createElement('button');
    b.className='admin-emp-btn';
    b.innerHTML='<span class="av">'+avatars[i%avatars.length]+'</span>'+name;
    b.onclick=function(){
      localStorage.setItem('spx_user',name);
      location.href='/admin';
    };
    g.appendChild(b);
  });
}

function openAdminModal(){
  buildAdminEmpGrid();
  document.getElementById('adminModal').style.display='flex';
}
function closeAdminModal(){
  document.getElementById('adminModal').style.display='none';
}
<\/script>
</body></html>`);
});

// ══════════════════════════════════════════════════════════════════════════════
// PAGE: DRIVER PASS (Mobile-First Handover Pass & QR)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/pass/:roundId', (req, res) => {
  const roundId = req.params.roundId;
  const round = rounds.find(r => r.id === roundId);
  if (!round) {
    return res.status(404).send(sharedHead('ไม่พบข้อมูลรอบขนส่ง') + `
      <div style="padding:2rem;text-align:center;color:var(--text);font-family:sans-serif">
        <h2>❌ ไม่พบรอบขนส่งนี้</h2>
        <p style="color:var(--muted)">รอบขนส่งอาจถูกลบหรือลิงก์ไม่ถูกต้อง</p>
      </div></body></html>`);
  }

  const st = roundStats(round);
  const items = round.items || [];
  const scannedKeys = new Set(st.scannedKeys || []);
  const passUrl = req.protocol + '://' + req.get('host') + req.originalUrl;

  const html = sharedHead('ตั๋วส่งมอบคนขับ - ' + round.name) + `
<style>
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0f172a; color:#f8fafc; padding:0; margin:0; line-height:1.5 }
.pass-container { max-width:520px; margin:0 auto; padding:1rem; box-sizing:border-box }
.pass-card { background:#1e293b; border:1px solid #334155; border-radius:1.5rem; padding:1.25rem; box-shadow:0 12px 30px rgba(0,0,0,0.5); margin-bottom:1rem }
.pass-header { text-align:center; border-bottom:1px dashed #334155; padding-bottom:1rem; margin-bottom:1rem }
.pass-title { font-size:1.35rem; font-weight:900; color:#38bdf8; display:flex; align-items:center; justify-content:center; gap:.5rem }
.stat-pill-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:.5rem; margin:1rem 0 }
.stat-pill { background:#0f172a; border:1px solid #334155; border-radius:1rem; padding:.6rem .4rem; text-align:center }
.stat-pill .num { font-size:1.5rem; font-weight:900; line-height:1.2 }
.stat-pill .lbl { font-size:.65rem; color:#94a3b8; text-transform:uppercase }
.qr-box { background:#fff; padding:.8rem; border-radius:1rem; display:inline-block; margin:.5rem 0 }
.driver-checklist { max-height:48vh; overflow-y:auto; border-radius:.8rem; background:#0f172a; border:1px solid #334155 }
.driver-row { display:flex; align-items:center; justify-content:space-between; padding:.65rem .85rem; border-bottom:1px solid #1e293b; font-size:.82rem }
.driver-row:last-child { border-bottom:none }
.driver-row.done { border-left:3px solid #22c55e }
.driver-row.pending { border-left:3px solid #f59e0b }
.driver-row.recalled { border-left:3px solid #ef4444; opacity:.6; text-decoration:line-through }
@media print {
  body { background:#fff!important; color:#000!important }
  .pass-card { border:1px solid #000!important; box-shadow:none!important; color:#000!important; background:#fff!important }
  .no-print { display:none!important }
  .stat-pill { background:#f1f5f9!important; color:#000!important; border:1px solid #ccc!important }
  .driver-checklist { background:#fff!important; border:1px solid #ccc!important; max-height:none!important }
  .driver-row { color:#000!important; border-bottom:1px solid #ddd!important }
}
</style>
<div class="pass-container">
  <div class="pass-card">
    <div class="pass-header">
      <div style="font-size:2rem;line-height:1">🚚</div>
      <div class="pass-title">ใบสรุปส่งมอบงานคนขับ</div>
      <div style="font-size:.85rem;color:#94a3b8;margin-top:.2rem">${escapeHtml(round.name)}</div>
      <div style="font-size:.72rem;color:#64748b;margin-top:.25rem">
        วันที่: ${new Date(round.uploadedAt).toLocaleString('th-TH')}
      </div>
    </div>

    <div class="stat-pill-row">
      <div class="stat-pill">
        <div class="lbl">ทั้งหมด</div>
        <div class="num" style="color:#38bdf8">${st.total}</div>
      </div>
      <div class="stat-pill">
        <div class="lbl">ยิงเช็คแล้ว</div>
        <div class="num" style="color:#22c55e">${st.done}</div>
      </div>
      <div class="stat-pill">
        <div class="lbl">คงเหลือ</div>
        <div class="num" style="color:#f59e0b">${st.missing}</div>
      </div>
    </div>

    <div style="text-align:center;margin-bottom:.8rem">
      <div class="qr-box">
        <canvas id="passQrCanvas"></canvas>
      </div>
      <div style="font-size:.7rem;color:#94a3b8">สแกน QR เพื่อเปิดตั๋วใบนี้บนมือถือคนขับ</div>
    </div>

    <div style="margin-bottom:.6rem;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:.85rem;font-weight:700">📦 รายการพัสดุในรอบ (${items.length} รายการ)</div>
      <span class="badge ${round.isSaved ? 'bg-green' : 'bg-yellow'}" style="font-size:.7rem">
        ${round.isSaved ? '🔒 ปิดยอดแล้ว' : '⏳ กำลังคัดแยก'}
      </span>
    </div>

    <div class="driver-checklist">
      ${items.map((it, idx) => {
        const isRecalled = it.recallState === 'RECALLED' || it.recallState === 'PENDING_RECALL';
        const isDone = !isRecalled && (scannedKeys.has(it.tracking) || scannedKeys.has(it.order));
        let statusBadge = '<span style="color:#f59e0b">⏳ รอยิง</span>';
        let rowClass = 'pending';
        if (isRecalled) {
          statusBadge = '<span style="color:#ef4444">🚫 ยกเลิก</span>';
          rowClass = 'recalled';
        } else if (isDone) {
          statusBadge = '<span style="color:#22c55e">✅ เช็คแล้ว</span>';
          rowClass = 'done';
        }
        return `
          <div class="driver-row ${rowClass}">
            <div style="display:flex;align-items:center;gap:.5rem">
              <span style="color:#64748b;font-size:.7rem;min-width:20px">${idx + 1}.</span>
              <div>
                <div style="font-family:monospace;font-weight:700">${escapeHtml(it.tracking || it.order || '-')}</div>
                <div style="font-size:.7rem;color:#94a3b8">Order: ${escapeHtml(it.order || '-')}</div>
              </div>
            </div>
            <div>${statusBadge}</div>
          </div>
        `;
      }).join('')}
    </div>

    <div style="margin-top:1.2rem;display:flex;gap:.5rem" class="no-print">
      <button class="btn btn-blue btn-full" onclick="window.print()" style="font-weight:700">🖨️ สั่งพิมพ์ใบส่งมอบ</button>
      <button class="btn btn-gray" onclick="navigator.clipboard.writeText(location.href);alert('คัดลอกลิงก์สำเร็จ!');" style="padding:.6rem .9rem" title="คัดลอกลิงก์">🔗</button>
    </div>
  </div>
</div>

<script>
// Generate QR code for driver pass url
if (window.QRCode) {
  QRCode.toCanvas(document.getElementById('passQrCanvas'), window.location.href, { width: 140, margin: 1 }, function (error) {
    if (error) console.error(error);
  });
}
<\/script>
</body></html>
  `;
  res.send(html);
});

// ══════════════════════════════════════════════════════════════════════════════
// PAGE: SCANNER
// ══════════════════════════════════════════════════════════════════════════════
app.get('/scan', (_req, res) => {
  res.send(sharedHead('Scanner Delivery note') + `
<style>
body{display:flex;flex-direction:column;align-items:stretch;transition:background .2s}
body.big-font-mode .stat-val{font-size:3.5rem!important;font-weight:900!important}
body.big-font-mode .stat-lbl{font-size:1.1rem!important}
body.big-font-mode .banner{font-size:1.8rem!important;padding:1.4rem!important;font-weight:800!important}
body.big-font-mode .scan-input{font-size:1.8rem!important;padding:1.2rem!important}
body.big-font-mode .app-name{font-size:1.25rem!important}
body.alarm-flash{animation:screenAlarmFlash .4s ease-in-out infinite alternate}
@keyframes screenAlarmFlash{from{background:rgba(239,68,68,.35)}to{background:transparent}}
.highlight-row{animation:rowGlow 2.5s ease-out;background:rgba(34,197,94,.22)!important}
@keyframes rowGlow{0%{background:rgba(34,197,94,.65)}100%{background:transparent}}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:.7rem 1.1rem;
  display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.app-name{font-weight:800;font-size:1rem}
.user-chip{background:var(--surface2);border:1px solid var(--border);border-radius:9999px;padding:.28rem .8rem;font-size:.82rem;font-weight:600}
.content{max-width:560px;width:100%;margin:0 auto;padding:.85rem;display:flex;flex-direction:column;gap:.75rem}
.stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:.55rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:1rem;padding:.8rem .4rem;text-align:center;box-shadow:var(--shadow)}
.stat-lbl{font-size:.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.2rem}
.stat-n{font-size:1.8rem;font-weight:900;line-height:1}
.c-blue{color:var(--blue)}.c-green{color:var(--green)}.c-yellow{color:var(--yellow)}
.scan-card{background:var(--surface);border:1px solid var(--border);border-radius:1.15rem;padding:1rem;box-shadow:var(--shadow)}
#scanInput{padding:1rem;border-width:2.5px;border-radius:.875rem;font-size:1.1rem;text-align:center;font-family:monospace;letter-spacing:.04em;background:var(--surface2)}
#scanInput:focus{border-color:var(--blue)}
.hint{text-align:center;font-size:.7rem;color:var(--muted);margin-top:.4rem}
#banner{border-radius:1rem;padding:.85rem 1rem;font-size:.95rem;font-weight:700;text-align:center;display:none;animation:pop .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes pop{from{transform:scale(.88);opacity:0}to{transform:scale(1);opacity:1}}
#banner.ok{background:#14532d;border:1.5px solid var(--green);color:var(--green)}
#banner.dup{background:#451a03;border:1.5px solid var(--yellow);color:var(--yellow)}
#banner.err{background:#450a0a;border:1.5px solid var(--red);color:var(--red)}
[data-theme=light] #banner.ok{background:#dcfce7;border-color:var(--green);color:#166534}
[data-theme=light] #banner.dup{background:#fef9c3;border-color:var(--yellow);color:#854d0e}
[data-theme=light] #banner.err{background:#fee2e2;border-color:var(--red);color:#991b1b}
#lastCode{text-align:center;font-size:.73rem;color:var(--muted);font-family:monospace;min-height:1.1em}
.camera-warning{display:none;border:1.5px solid var(--yellow);background:rgba(245,158,11,.1);color:var(--text);border-radius:.9rem;padding:.75rem .85rem;margin:.35rem 0 .7rem;font-size:.8rem;line-height:1.45}
.camera-warning strong{display:block;color:var(--yellow);font-size:.86rem;margin-bottom:.2rem}
.camera-warning code{background:rgba(0,0,0,.18);border-radius:.35rem;padding:.05rem .25rem;color:var(--blue2);font-family:Consolas,monospace}
.camera-panel{display:none;margin:.45rem 0 .65rem;padding:.7rem;border:1px solid var(--border);border-radius:.9rem;background:var(--surface2);gap:.55rem;flex-direction:column}
.camera-row{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}
.camera-select{flex:1;min-width:135px;padding:.45rem .55rem;border:1px solid var(--border);border-radius:.65rem;background:var(--surface);color:var(--text);font-size:.78rem;outline:none}
.scan-mode{display:flex;gap:.25rem;background:var(--surface);border:1px solid var(--border);border-radius:.75rem;padding:.2rem}
.scan-mode button{border:0;background:transparent;color:var(--muted);border-radius:.55rem;padding:.35rem .55rem;font-size:.72rem;font-weight:800;cursor:pointer}
.scan-mode button.active{background:var(--blue);color:#fff}
.camera-meta{font-size:.7rem;color:var(--muted);min-height:1em}
#reader video{width:100%!important;border-radius:1rem;background:#000}
.camBtn:disabled,#camBtn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.no-manifest{border:2px dashed var(--yellow);border-radius:1.15rem;padding:2rem;text-align:center;color:var(--yellow);background:rgba(245,158,11,.06)}
/* Presence bar */
.presence-bar{background:var(--surface);border:1px solid var(--border);border-radius:1rem;padding:.65rem .9rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;min-height:2.4rem}
.presence-title{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.presence-chip{display:inline-flex;align-items:center;gap:.25rem;background:var(--surface2);border:1px solid var(--border);border-radius:9999px;padding:.18rem .6rem;font-size:.75rem;font-weight:600;transition:all .3s}
.presence-chip.me{border-color:var(--blue);color:var(--blue2)}
.presence-chip .pdot{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* Manifest table */
.manifest-box{background:var(--surface);border:1px solid var(--border);border-radius:1.15rem;overflow:hidden;box-shadow:var(--shadow)}
.manifest-head{padding:.65rem 1rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.manifest-title{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.manifest-filter{display:flex;gap:.3rem}
.fbtn{padding:.22rem .6rem;border-radius:9999px;font-size:.68rem;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;transition:.15s}
.fbtn.active{background:var(--blue);color:#fff;border-color:var(--blue)}
.manifest-scroll{max-height:320px;overflow-y:auto}
.m-table{width:100%;border-collapse:collapse;font-size:.78rem}
.m-table th{text-align:left;padding:.42rem .65rem;border-bottom:2px solid var(--border);font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;position:sticky;top:0;background:var(--surface)}
.m-table td{padding:.4rem .65rem;border-bottom:1px solid rgba(128,128,128,.07);vertical-align:middle;font-family:monospace;font-size:.75rem}
.m-table tr:last-child td{border:none}
.m-table tr.scanned{background:rgba(34,197,94,.07)}
[data-theme=light] .m-table tr.scanned{background:rgba(22,101,52,.07)}
.m-table tr.scanned td{color:var(--muted)}
.tick{color:var(--green);font-size:1rem;font-weight:900}
.num-cell{color:var(--muted);font-size:.68rem;width:1.8rem}

/* Step indicator */
.step-nav{display:flex;align-items:center;justify-content:space-between;background:var(--surface);border:1px solid var(--border);border-radius:.9rem;padding:.5rem .75rem;font-size:.76rem;margin-bottom:.2rem}
.step-item{display:flex;align-items:center;gap:.3rem;color:var(--muted);font-weight:600}
.step-item.active{color:var(--blue);font-weight:800}
.step-item.done{color:var(--green);font-weight:700}
.step-badge{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:.62rem;background:var(--surface2);border:1px solid var(--border)}
.step-item.active .step-badge{background:var(--blue);color:#fff;border-color:var(--blue)}
.step-item.done .step-badge{background:var(--green);color:#fff;border-color:var(--green)}

/* Visual Flash Diagnostics */
@keyframes flashGreen { 0% { box-shadow: 0 0 0 5px var(--green); } 100% { box-shadow: var(--shadow); } }
@keyframes flashYellow { 0% { box-shadow: 0 0 0 5px var(--yellow); } 100% { box-shadow: var(--shadow); } }
@keyframes flashRed { 0% { box-shadow: 0 0 0 5px var(--red); } 100% { box-shadow: var(--shadow); } }
.flash-ok { animation: flashGreen .45s ease-out; }
.flash-dup { animation: flashYellow .45s ease-out; }
.flash-err { animation: flashRed .45s ease-out; }

/* Urgent Recall Mission Styles */
@keyframes recallPulse {
  0% { box-shadow: inset 0 0 40px rgba(0,0,0,0.5), 0 0 30px rgba(220,38,38,0.8); }
  100% { box-shadow: inset 0 0 100px rgba(0,0,0,0.7), 0 0 60px rgba(239,68,68,1); }
}
.canceled-row {
  background: rgba(239, 68, 68, 0.12) !important;
  color: #ef4444 !important;
  text-decoration: line-through;
}
.pending-recall-row {
  background: rgba(245, 158, 11, 0.16) !important;
  border-left: 4px solid #f59e0b !important;
}

/* ── Mobile Responsive ──────────────────────── */
@media(max-width:768px){
  .topbar{padding:.5rem .7rem}
  .app-name img{width:60px!important;height:60px!important}
  .app-name span{font-size:.85rem}
  .user-chip{padding:.2rem .55rem;font-size:.7rem}
  .topbar .btn-sm{font-size:.7rem;padding:.25rem .5rem}
  .content{padding:.5rem;gap:.5rem}
  .stats-row{gap:.4rem}
  .stat{padding:.6rem .3rem}
  .stat-lbl{font-size:.55rem}
  .stat-n{font-size:1.4rem}
  .scan-card{padding:.75rem}
  #scanInput{padding:.75rem;font-size:.95rem;border-width:2px}
  .manifest-head{padding:.5rem .75rem}
  .manifest-title{font-size:.65rem}
  .m-table th{padding:.35rem .5rem;font-size:.6rem}
  .m-table td{padding:.3rem .5rem;font-size:.7rem}
  #banner{padding:.6rem;font-size:.85rem}
}
</style>
<div class="topbar">
<div class="app-name" style="display:flex;align-items:center;gap:.55rem">
<img src="/logo.png" style="width:80px;height:80px;object-fit:contain;border-radius:.45rem">
<span>Scanner Delivery Note</span>
</div>
  <div class="flex gap-sm">
    <div class="badge bg-yellow hidden" id="todayScansBadge" style="margin-right:.5rem;font-size:.75rem">🔥 วันนี้ 0 ชิ้น</div>
    <span class="user-chip">👤 <span id="uName">-</span></span>
    <button class="theme-btn" id="themeBtn" onclick="toggleTheme()">☀️</button>
    <button class="btn btn-gray btn-sm" onclick="logout()">เปลี่ยน</button>
  </div>
</div>
<div class="content">
  <div id="noManifest" class="no-manifest hidden">
    ⚠️ ยังไม่มีข้อมูลใบส่งมอบ<br>
    <a href="/admin" style="color:var(--blue);font-size:.85rem;margin-top:.4rem;display:inline-block">📤 อัปโหลด PDF ที่หน้า Admin</a>
  </div>

  <!-- Stepped workflow indicator -->
  <div class="step-nav hidden" id="stepNav">
    <div class="step-item" id="step1Indicator">
      <span class="step-badge" id="step1Badge">1</span>
      <span>จุดวางพัสดุ</span>
    </div>
    <span style="color:var(--border)">➔</span>
    <div class="step-item" id="step2Indicator">
      <span class="step-badge" id="step2Badge">2</span>
      <span>ยิงสแกน</span>
    </div>
    <span style="color:var(--border)">➔</span>
    <div class="step-item" id="step3Indicator">
      <span class="step-badge" id="step3Badge">3</span>
      <span>ปิดยอด</span>
    </div>
  </div>

  <!-- Round selector -->
  <div class="scan-card hidden" id="roundSelector" style="padding:.65rem .9rem">
    <div style="font-size:.68rem;color:var(--muted);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.05em">📋 เลือกกลุ่มขนส่ง</div>
    <button class="btn btn-gray" id="roundSelBtn" onclick="document.getElementById('scanRoundModal').style.display='flex'" style="width:100%;text-align:left;font-size:.85rem;background:var(--surface2);display:flex;justify-content:space-between;align-items:center;padding:.6rem .85rem;">
      <span id="roundSelLabel" style="font-weight:700">กำลังโหลด...</span>
      <span>▼</span>
    </button>
  </div>

  <!-- Reopened Alert Banner (Feature 1 & Core Plan) -->
  <div id="reopenedBanner" class="hidden" style="margin-top:.4rem;margin-bottom:.4rem;padding:.7rem .85rem;background:rgba(245,158,11,.15);border:1.5px solid var(--yellow);border-radius:.8rem;color:var(--yellow);font-weight:700;font-size:.82rem;display:flex;align-items:center;gap:.5rem">
    <span style="font-size:1.2rem">📢</span>
    <span id="reopenedBannerText">มีงานเพิ่มเข้ามาในกลุ่มขนส่งนี้! (ปลดล็อกให้ยิงต่อเรียบร้อย)</span>
  </div>

  <!-- Staging Proof Card (Step 1 - Global) -->
  <div class="scan-card hidden" id="stagingCard" style="border:1.5px solid var(--yellow);background:rgba(245,158,11,.05);padding:.85rem">
    <div id="stagingUnconfirmed">
      <div style="display:flex;align-items:flex-start;gap:.55rem;margin-bottom:.65rem">
        <span style="font-size:1.4rem;line-height:1">📸</span>
        <div style="flex:1">
          <div style="font-weight:800;font-size:.88rem;color:var(--yellow)">ขั้นตอนที่ 1: ถ่ายรูปสถานที่จุดรอกระจายสาขา (ยืนยันครั้งเดียว)</div>
          <div style="font-size:.72rem;color:var(--muted);line-height:1.4;margin-top:.15rem">
            กรุณาถ่ายรูปสถานที่ว่าพัสดุอยู่ตรงจุดรอกระจายสาขาแล้ว เพื่อปลดล็อกให้เริ่มยิงได้ทุกขนส่งพร้อมกัน
          </div>
        </div>
      </div>
      <div style="display:flex;gap:.45rem;flex-wrap:wrap">
        <input type="file" id="stagingCameraInput" accept="image/*" capture="environment" style="display:none" onchange="handleStagingPhotoUpload(event)">
        <button class="btn btn-yellow" onclick="document.getElementById('stagingCameraInput').click()" style="flex:1;min-width:130px;font-size:.82rem;font-weight:700;display:flex;align-items:center;justify-content:center;gap:.35rem">
          📷 ถ่ายรูปสถานที่
        </button>
        <button class="btn btn-gray" onclick="showPinRequestBox()" style="flex:1;min-width:130px;font-size:.82rem;font-weight:700;display:flex;align-items:center;justify-content:center;gap:.35rem">
          💻 ขอ PIN ปลดล็อก (PC)
        </button>
      </div>
      <div id="pinBox" style="display:none;margin-top:.7rem;padding:.65rem;border-radius:.75rem;background:var(--surface);border:1px solid var(--border)">
        <div style="font-size:.73rem;color:var(--blue);font-weight:700;margin-bottom:.35rem">
          🔔 ส่งคำขอไปยังกระดิ่ง Admin แล้ว! กรุณากรอกรหัส PIN 4 หลักที่ได้จาก Admin:
        </div>
        <div style="display:flex;gap:.4rem">
          <input type="text" id="workerPinInput" maxlength="6" placeholder="PIN 4 หลัก" style="text-align:center;font-size:1.1rem;font-weight:800;letter-spacing:4px;flex:1;padding:.4rem;border-radius:.6rem;border:1.5px solid var(--blue)">
          <button class="btn btn-blue" onclick="submitWorkerPin()">ปลดล็อก</button>
        </div>
      </div>
    </div>
    <div id="stagingConfirmed" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem">
        <div style="display:flex;align-items:center;gap:.5rem">
          <span style="font-size:1.3rem">✅</span>
          <div>
            <div style="font-weight:800;font-size:.88rem;color:var(--green)">ยืนยันสถานที่จุดรอกระจายสาขาแล้ว</div>
            <div style="font-size:.72rem;color:var(--muted)" id="stagingProofMeta">-</div>
          </div>
        </div>
        <div style="display:flex;gap:.35rem" id="stagingProofActions">
          <button class="btn btn-gray btn-sm" id="viewProofPhotoBtn" style="display:none" onclick="viewCurrentProofPhoto()">🖼️ ดูรูป</button>
          <button class="btn btn-gray btn-sm" onclick="document.getElementById('stagingCameraInput').click()" title="ถ่ายรูปใหม่">🔄 ถ่ายใหม่</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Presence bar: who is scanning which round -->
  <div class="presence-bar hidden" id="presenceBar">
    <span class="presence-title">🟢 ออนไลน์:</span>
    <span id="presenceList" style="display:flex;gap:.35rem;flex-wrap:wrap"></span>
  </div>

  <!-- Stats -->
  <div class="stats-row hidden" id="statsRow">
    <div class="stat"><div class="stat-lbl">ทั้งหมด</div><div class="stat-n c-blue" id="sTotal">0</div></div>
    <div class="stat"><div class="stat-lbl">แสกนแล้ว</div><div class="stat-n c-green" id="sDone">0</div></div>
    <div class="stat"><div class="stat-lbl">คงเหลือ</div><div class="stat-n c-yellow" id="sLeft">0</div></div>
  </div>
  <div class="flex hidden" id="progWrap" style="align-items:center;gap:1rem;margin-top:.5rem">
    <div style="position:relative;width:44px;height:44px;flex-shrink:0">
      <svg viewBox="0 0 36 36" style="width:100%;height:100%;transform:rotate(-90deg)">
        <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--border)" stroke-width="4"/>
        <path id="svgProg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--blue)" stroke-width="4" stroke-dasharray="100, 100" stroke-dashoffset="100" style="transition:stroke-dashoffset 0.5s ease"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.55rem;font-weight:700" id="svgPct">0%</div>
    </div>
    <div class="progress" style="flex:1;height:8px"><div class="progress-fill" id="progFill" style="width:0%"></div></div>
  </div>



  <!-- Scan input -->
  <div class="scan-card hidden" id="scanCard">
    <div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:.8rem;gap:.5rem;flex-wrap:wrap">
      <div class="flex gap-sm">
        <button class="btn btn-gray btn-sm" id="audioBoostBtn" onclick="toggleAudioBoost()" title="ปรับระดับเสียงคลังสินค้า">🔊 เสียงดังปกติ</button>
        <button class="btn btn-gray btn-sm" onclick="showScanHistory()">🕐 ประวัติ</button>
        <button class="btn btn-gray btn-sm camBtn" onclick="toggleCamera()">📷 กล้อง</button>
      </div>
    </div>
    <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
      <input type="text" id="scanInput" placeholder="ยิงแสกนเนอร์ได้เลย…" autofocus autocomplete="off" spellcheck="false" inputmode="none" style="flex:1">
      <button class="btn btn-blue camBtn" onclick="toggleCamera()" title="สแกนด้วยกล้อง">📷</button>
      <button class="btn btn-red" id="undoBtn" onclick="undoScan()" title="เลิกทำ (Undo)" style="display:none">↩️ Undo</button>
    </div>
    <div class="hint">📡 USB / Bluetooth Scanner — กด Enter อัตโนมัติ</div>
    <div class="camera-warning" id="cameraNotice"></div>
    <div class="camera-panel" id="cameraPanel">
      <div class="camera-row">
        <div class="scan-mode" id="scanModeBtns">
          <button type="button" class="active" data-mode="auto" onclick="setScanMode('auto')">Auto</button>
          <button type="button" data-mode="qr" onclick="setScanMode('qr')">QR</button>
          <button type="button" data-mode="barcode" onclick="setScanMode('barcode')">Barcode</button>
        </div>
        <button class="btn btn-gray btn-sm" type="button" onclick="switchCamera()">🔄 สลับ</button>
        <button class="btn btn-gray btn-sm" type="button" id="torchBtn" onclick="toggleTorch()" style="display:none">🔦 ไฟ</button>
      </div>
      <div class="camera-row">
        <select id="cameraSelect" class="camera-select" onchange="selectCamera(this.value)"></select>
      </div>
      <div class="camera-meta" id="cameraMeta">ใช้กล้องหลังเป็นหลัก และสแกน QR/Barcode พร้อมกัน</div>
    </div>
    <div id="reader" style="display:none; width:100%; margin-top:1rem; border-radius:1rem; overflow:hidden"></div>
  </div>
  <div id="banner"></div>
  <div id="lastCode"></div>

  <!-- Manifest table -->
  <div class="manifest-box hidden" id="manifestBox">
    <div class="manifest-head" style="flex-direction:column;align-items:flex-start;gap:.5rem">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;flex-wrap:wrap;gap:.35rem">
        <span class="manifest-title">รายการพัสดุ</span>
        <div class="manifest-filter" style="display:flex;gap:.25rem;flex-wrap:wrap">
          <button class="fbtn active" onclick="filterManifest('all',this)" id="fbtn-all">ทั้งหมด <span id="cnt-all" style="opacity:.8;font-size:.7rem">(0)</span></button>
          <button class="fbtn" onclick="filterManifest('pending',this)" id="fbtn-pending" style="border-color:rgba(245,158,11,.4)">⏳ รอยิง <span id="cnt-pending" style="opacity:.8;font-size:.7rem">(0)</span></button>
          <button class="fbtn" onclick="filterManifest('done',this)" id="fbtn-done" style="border-color:rgba(34,197,94,.4)">✅ ยิงแล้ว <span id="cnt-done" style="opacity:.8;font-size:.7rem">(0)</span></button>
          <button class="fbtn" onclick="filterManifest('recalled',this)" id="fbtn-recalled" style="border-color:rgba(239,68,68,.4);display:none">🚫 ระงับ <span id="cnt-recalled" style="opacity:.8;font-size:.7rem">(0)</span></button>
        </div>
      </div>
      <div style="position:relative;width:100%">
        <input type="text" id="searchManifest" placeholder="🔍 ค้นหา Tracking หรือ Order (พิมพ์ 4 ตัวท้ายได้)..." onkeyup="renderManifest()" style="padding:.45rem .8rem;font-size:.82rem;border-radius:9999px;border:1px solid var(--border);width:100%;outline:none;background:var(--surface2);color:var(--text);box-sizing:border-box">
        <button type="button" onclick="document.getElementById('searchManifest').value='';renderManifest();" style="position:absolute;right:.6rem;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer;font-size:.85rem;padding:.2rem">✕</button>
      </div>
    </div>
    <div class="manifest-scroll">
      <table class="m-table">
        <thead><tr><th class="num-cell">No.</th><th>Order No.</th><th>Tracking No.</th><th style="text-align:center">สถานะ / บาร์โค้ด</th></tr></thead>
        <tbody id="manifestBody"></tbody>
      </table>
    </div>
  </div>
  
  <!-- Save Button (Bottom) -->
  <div id="saveSectionBottom" class="hidden" style="margin-top:.8rem;margin-bottom:1.2rem">
    <button class="btn btn-blue btn-full" id="saveRoundBtnBottom" onclick="saveRound()" style="font-size:1.1rem;padding:.9rem;border-radius:1rem;font-weight:800;box-shadow:0 6px 20px rgba(59,130,246,0.35);width:100%;">
      💾 บันทึกปิดยอด (Save)
    </button>
  </div>
</div>

<!-- Save Reject Modal -->
<div class="modal-bg hidden" id="saveRejectModal" style="align-items:center;justify-content:center" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="modal" style="width:95%;max-width:500px;background:var(--surface)">
    <div class="modal-title" style="color:var(--red);font-size:1.2rem;display:flex;align-items:center;gap:.5rem">❌ ปิดยอดไม่สำเร็จ</div>
    <div id="saveRejectMsg" style="margin-bottom:1rem;font-size:.9rem;font-weight:600"></div>
    <div style="max-height:50vh;overflow-y:auto;border-radius:.8rem;border:1px solid var(--border)">
      <table class="m-table">
        <thead><tr><th>Order No.</th><th>Tracking No.</th><th>ขนส่ง</th></tr></thead>
        <tbody id="saveRejectBody"></tbody>
      </table>
    </div>
    <button class="btn btn-gray btn-full" onclick="document.getElementById('saveRejectModal').classList.add('hidden')" style="margin-top:1rem">ปิด</button>
  </div>
</div>

<!-- Completion Proof Modal (Before Close Round) -->
<div class="modal-bg hidden" id="completionProofModal" style="align-items:center;justify-content:center" onclick="if(event.target===this)closeCompletionModal()">
  <div class="modal" style="width:95%;max-width:480px;background:var(--surface);padding:1.2rem;border-radius:1rem;border:1.5px solid var(--blue)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem">
      <div style="font-size:1.1rem;font-weight:900;color:var(--blue);display:flex;align-items:center;gap:.4rem">
        📸 บันทึกรูปถ่ายปิดยอด
      </div>
      <button class="btn btn-gray btn-sm" onclick="closeCompletionModal()" style="border-radius:50%;width:28px;height:28px;padding:0">✕</button>
    </div>
    
    <div style="font-size:.85rem;color:var(--text);margin-bottom:.5rem">
      ยืนยันการกระจายพัสดุเสร็จสิ้น: <b id="compCarrierLabel" style="color:var(--blue)">-</b>
    </div>
    <div style="font-size:.75rem;color:var(--muted);line-height:1.4;margin-bottom:1rem">
      กรุณาถ่ายรูปกองพัสดุที่คัดแยกกระจายสาขาเสร็จเรียบร้อยแล้ว เพื่อยืนยันความถูกต้องก่อนปิดยอด
    </div>

    <!-- Hidden camera file input -->
    <input type="file" id="compCameraInput" accept="image/*" capture="environment" style="display:none" onchange="handleCompletionPhoto(event)">

    <!-- Image Preview Area -->
    <div id="compPreviewBox" style="display:none;margin-bottom:1rem;text-align:center">
      <img id="compPreviewImg" src="" style="width:100%;max-height:260px;object-fit:cover;border-radius:.8rem;border:1.5px solid var(--green)">
      <div style="margin-top:.4rem">
        <button class="btn btn-gray btn-sm" onclick="document.getElementById('compCameraInput').click()">🔄 ถ่ายรูปใหม่</button>
      </div>
    </div>

    <!-- Take Photo Button (if not yet captured) -->
    <div id="compTakeBtnBox" style="margin-bottom:1rem">
      <button class="btn btn-yellow btn-full" onclick="document.getElementById('compCameraInput').click()" style="padding:.8rem;font-size:1rem;font-weight:800;display:flex;align-items:center;justify-content:center;gap:.4rem">
        📷 ถ่ายรูปกองพัสดุที่กระจายเสร็จแล้ว
      </button>
    </div>

    <!-- Confirm Save Button -->
    <button class="btn btn-gray btn-full" id="compSubmitBtn" disabled onclick="submitCompletionSave()" style="padding:.85rem;font-size:1.05rem;font-weight:800">
      💾 ยืนยันปิดยอด (พร้อมรูปถ่าย)
    </button>
  </div>
</div>

<div class="modal-bg" id="scanRoundModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="max-height:80vh;display:flex;flex-direction:column;width:100%;max-width:400px;padding:1.25rem;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <span style="font-weight:800;font-size:1rem">📁 เลือกกลุ่มขนส่ง</span>
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('scanRoundModal').style.display='none'" style="padding:.2rem .5rem">✕</button>
    </div>
    <div id="scanRoundList" style="flex:1;overflow-y:auto;">
    </div>
  </div>
</div>

<div class="modal-bg hidden" id="scanHistoryModal" style="align-items:center;justify-content:center" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="modal" style="width:90%;max-width:340px;">
    <div class="modal-title">🕐 ประวัติการสแกน (เซสชันนี้)</div>
    <div id="scanHistoryList" style="max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:.4rem">
      <div style="text-align:center;padding:1rem;color:var(--muted)">ยังไม่มีประวัติ</div>
    </div>
    <button class="btn btn-gray btn-full" onclick="document.getElementById('scanHistoryModal').classList.add('hidden')" style="margin-top:1rem">ปิด</button>
  </div>
</div>

<!-- Proof Photo Viewer Modal -->
<div class="modal-bg hidden" id="proofPhotoModal" style="align-items:center;justify-content:center" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="modal" style="width:92%;max-width:440px;background:var(--surface);text-align:center;padding:1.1rem">
    <div class="modal-title" style="margin-bottom:.8rem">📸 รูปยืนยันจุดวางพัสดุ</div>
    <img id="proofPhotoImg" src="" style="width:100%;max-height:55vh;object-fit:contain;border-radius:.8rem;border:1px solid var(--border)">
    <div id="proofPhotoDetails" style="font-size:.75rem;color:var(--muted);margin-top:.5rem"></div>
    <button class="btn btn-gray btn-full" onclick="document.getElementById('proofPhotoModal').classList.add('hidden')" style="margin-top:.8rem">ปิด</button>
  </div>
</div>

<!-- Digital Barcode Fallback Modal -->
<div class="modal-bg hidden" id="digitalBarcodeModal" style="align-items:center;justify-content:center" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="modal" style="width:95%;max-width:480px;background:#fff;color:#0f172a;text-align:center;padding:1.5rem;border-radius:1.5rem;box-shadow:0 20px 40px rgba(0,0,0,0.4)">
    <div style="font-size:1.1rem;font-weight:900;color:#1e293b;margin-bottom:.2rem">🏷️ บาร์โค้ดสำรองสำหรับสแกน</div>
    <div style="font-size:.78rem;color:#64748b;margin-bottom:1.2rem">ใช้เครื่องยิงหรือมือถืออีกเครื่องสแกนบาร์โค้ดนี้เพื่อเช็คอินพัสดุ</div>
    
    <div style="background:#f8fafc;padding:1.2rem;border-radius:1rem;border:2px dashed #cbd5e1;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-bottom:1rem">
      <svg id="digitalBarcodeSvg" style="max-width:100%;height:auto"></svg>
      <div id="digitalBarcodeCode" style="font-family:monospace;font-size:1.2rem;font-weight:900;letter-spacing:1px;color:#0f172a;margin-top:.5rem"></div>
    </div>
    
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;font-size:.82rem;background:#f1f5f9;padding:.75rem;border-radius:.75rem;margin-bottom:1.2rem;text-align:left">
      <div><span style="color:#64748b;font-size:.72rem">เลขออเดอร์:</span><br><strong id="digitalOrderText" style="color:#0f172a;word-break:break-all">-</strong></div>
      <div><span style="color:#64748b;font-size:.72rem">เลข Tracking:</span><br><strong id="digitalTrackingText" style="color:#0f172a;word-break:break-all">-</strong></div>
    </div>

    <div style="display:flex;gap:.5rem">
      <button class="btn btn-gray" onclick="document.getElementById('digitalBarcodeModal').classList.add('hidden')" style="flex:1;padding:.7rem;font-weight:700">ปิด</button>
      <button class="btn btn-green" id="digitalMarkBtn" onclick="quickMarkScannedFromModal()" style="flex:1.4;padding:.7rem;font-weight:800;display:flex;align-items:center;justify-content:center;gap:.35rem">
        ✅ ยิงผ่านทันที (Mark)
      </button>
    </div>
  </div>
</div>

<!-- ═══ URGENT RECALL MISSION MODAL (ภารกิจด่วน: นำพัสดุออกจากกอง) ═══ -->
<div id="urgentRecallModal" style="display:none;position:fixed;inset:0;background:rgba(185,28,28,0.96);z-index:99999;flex-direction:column;align-items:center;justify-content:center;padding:1.2rem;color:#fff;text-align:center;backdrop-filter:blur(10px)">
  <div style="font-size:3.5rem;animation:bounce 0.8s infinite;">🚨</div>
  <div style="font-size:1.8rem;font-weight:900;letter-spacing:.5px;margin-bottom:.4rem;text-shadow:0 3px 12px rgba(0,0,0,0.6)">ภารกิจด่วน: ดึงพัสดุออกจากกอง!</div>
  <div style="font-size:.95rem;background:rgba(0,0,0,0.35);padding:.35rem 1rem;border-radius:2rem;margin-bottom:1.2rem;display:inline-block">
    ⚠️ มีคำขอยกเลิก/ระงับการจัดส่งพัสดุชิ้นนี้แล้ว
  </div>
  
  <div style="background:#fff;color:#0f172a;border-radius:1.25rem;padding:1.2rem 1.4rem;width:min(92vw,460px);box-shadow:0 15px 35px rgba(0,0,0,0.5);margin-bottom:1.2rem;text-align:left">
    <div style="font-size:0.8rem;color:#64748b;font-weight:700;text-transform:uppercase">ตำแหน่งกองขนส่งที่ต้องไปดึงกล่องคืน:</div>
    <div id="recallCarrierTarget" style="font-size:1.5rem;font-weight:900;color:#dc2626;margin:.25rem 0 .75rem 0">📦 กองขนส่ง</div>
    
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;font-size:0.85rem;background:#f8fafc;padding:.8rem;border-radius:.8rem;border:1px solid #e2e8f0;margin-bottom:.8rem">
      <div><span style="color:#64748b;font-size:0.75rem">เลขออเดอร์:</span><br><strong id="recallOrderTarget" style="font-size:0.95rem;color:#0f172a;word-break:break-all">—</strong></div>
      <div><span style="color:#64748b;font-size:0.75rem">เลข Tracking:</span><br><strong id="recallTrackingTarget" style="font-size:0.95rem;color:#0f172a;word-break:break-all">—</strong></div>
    </div>
    
    <div style="font-size:0.85rem;color:#b91c1c;font-weight:600;display:flex;align-items:center;gap:.4rem">
      <span>สาเหตุ:</span> <span id="recallReasonTarget" style="font-weight:700">ลูกค้ายกเลิกคำสั่งซื้อ</span>
    </div>
  </div>

  <div style="background:rgba(0,0,0,0.35);border:2px dashed #fca5a5;border-radius:1.1rem;padding:1rem 1.25rem;width:min(92vw,460px);margin-bottom:1rem">
    <div style="font-size:1rem;font-weight:800;margin-bottom:.3rem">🔍 สแกนบาร์โค้ดบนกล่องที่ดึงมา เพื่อยืนยัน</div>
    <div style="font-size:0.78rem;color:#fecaca;margin-bottom:.75rem">ยิงบาร์โค้ดบนกล่องพัสดุที่ดึงออกมา หน้าจอจะปลดล็อกทันที</div>
    <input type="text" id="recallVerifyInput" placeholder="ยิงบาร์โค้ดกล่องที่ดึงคืนมาที่นี่..." style="width:100%;font-size:1.05rem;padding:.75rem 1rem;border-radius:.8rem;border:2px solid #fff;text-align:center;font-weight:bold;background:#fff;color:#0f172a;box-sizing:border-box" autocomplete="off">
    <div style="display:flex;gap:.5rem;margin-top:.7rem">
      <button class="btn btn-sm" id="recallCamBtn" type="button" onclick="toggleRecallCamera()" style="flex:1;background:#2563eb;color:#fff;border:none;padding:.65rem;font-size:0.85rem;font-weight:700;border-radius:.6rem;display:flex;align-items:center;justify-content:center;gap:.4rem">
        📷 สแกนด้วยกล้อง
      </button>
    </div>
    <div id="recallReader" style="display:none;width:100%;margin-top:.8rem;border-radius:.8rem;overflow:hidden;border:2px solid rgba(255,255,255,0.7);background:#000"></div>
    <div id="recallVerifyError" style="color:#fef08a;font-size:0.82rem;font-weight:bold;margin-top:.4rem;min-height:1.2rem"></div>
  </div>
  
  <div style="display:flex;gap:.6rem;width:min(92vw,460px)">
    <button class="btn btn-sm" onclick="manualConfirmRecall()" style="flex:1;background:rgba(255,255,255,0.22);color:#fff;border:1px solid rgba(255,255,255,0.45);padding:.65rem;font-size:0.85rem">
      ⚠️ ยืนยันว่าดึงแล้ว (กรณีบาร์โค้ดชำรุด)
    </button>
  </div>
</div>

<script>
var sysValidateCarrier = ${sysSettings.validateCarrierMismatch !== false};
var dynamicCarrierPrefixes = ${JSON.stringify(sysSettings.carrierPrefixes || null)};
var user=localStorage.getItem('spx_user');
if(!user){location.href='/';}
document.getElementById('uName').textContent=user||'-';
var t=localStorage.getItem('spx_theme')||'dark';
document.getElementById('themeBtn').textContent=t==='dark'?'☀️':'🌙';
function logout(){localStorage.removeItem('spx_user');location.href='/';}

// ── Audio ────────────────────────────────────────────────────────────────────
var actx;
var voiceEnabled = true;

// Feature 4: Voice Assistant (เสียงพูดภาษาไทย ชัดเจน เป็นธรรมชาติ ไม่ทึบอู้อี้)
var thaiVoice = null;
function initThaiVoice() {
  if (!('speechSynthesis' in window)) return;
  var voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return;
  // ค้นหาเสียงผู้หญิงภาษาไทยธรรมชาติ เช่น Premwadee (Edge/Windows), Google ภาษาไทย (Chrome), หรือ Achara
  thaiVoice = voices.find(function(v){ return v.lang && v.lang.replace('_','-').startsWith('th') && /premwadee|google|achara|female|online/i.test(v.name); }) ||
              voices.find(function(v){ return v.lang && v.lang.replace('_','-').startsWith('th') && !/niwat/i.test(v.name); }) ||
              voices.find(function(v){ return v.lang && v.lang.replace('_','-').startsWith('th'); }) || null;
}
if ('speechSynthesis' in window) {
  initThaiVoice();
  window.speechSynthesis.onvoiceschanged = initThaiVoice;
}

function speakVoice(text) {
  if (!voiceEnabled || !('speechSynthesis' in window)) return;
  if (!thaiVoice) initThaiVoice();
  var u = new SpeechSynthesisUtterance(text);
  u.lang = 'th-TH';
  if (thaiVoice) u.voice = thaiVoice;
  u.rate = 1.05;
  u.pitch = 1.1; // โทนเสียงสดใส ชัดถ้อยชัดคำ
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function beep(freq,dur,vol){
  if(!actx)actx=new(window.AudioContext||window.webkitAudioContext)();
  var o=actx.createOscillator(),g=actx.createGain();
  o.connect(g);g.connect(actx.destination);
  o.type='square';o.frequency.value=freq||880;
  var gainVal = (vol||0.3) * (isAudioBoosted ? 1.5 : 1.0); // Function 9: Audio Boost
  g.gain.setValueAtTime(gainVal,actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,actx.currentTime+(dur||100)/1000);
  o.start();o.stop(actx.currentTime+(dur||100)/1000);
}
function beepOK(){ beep(900,110); speakVoice("เรียบร้อย"); }
function beepDup(){ beep(420,100); setTimeout(function(){beep(420,100);},170); speakVoice("ซ้ำค่ะ"); }
function beepErr(){ beep(260,160); setTimeout(function(){beep(260,160);},230); speakVoice("ไม่พบพัสดุ"); }
function beepBlacklist(){ beep(260,160); setTimeout(function(){beep(260,160);},230); speakVoice("พัสดุติดแบ็คลิสค่ะ"); }

// ── Function 9: Audio Boost Toggle ──────────────────────────────────────────
function toggleAudioBoost(){
  isAudioBoosted = !isAudioBoosted;
  var btn = document.getElementById('audioBoostBtn');
  if(btn){
    btn.textContent = isAudioBoosted ? '🔊 เสียงดังพิเศษ 150%' : '🔊 เสียงดังปกติ';
    btn.className = isAudioBoosted ? 'btn btn-yellow btn-sm' : 'btn btn-gray btn-sm';
  }
  beep(isAudioBoosted ? 700 : 500, 80); // Quick feedback tone
}

// ── Screen Alarm Flash for Wrong Carrier ───────────────────────────────────
function triggerScreenAlarmFlash(){
  document.body.classList.add('alarm-flash');
  setTimeout(function(){
    document.body.classList.remove('alarm-flash');
  }, 1600);
}

// ── Auto-scroll & Highlight Manifest Row ────────────────────────────────────
function highlightManifestRow(code){
  try {
    var searchCode = code.toUpperCase();
    var rows = document.querySelectorAll('#manifestBody tr');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.textContent.includes(searchCode)) {
        r.scrollIntoView({ behavior: 'smooth', block: 'center' });
        r.classList.add('highlight-row');
        setTimeout(function(){ r.classList.remove('highlight-row'); }, 2500);
        break;
      }
    }
  } catch(e) {}
}

// ── Big Font Mode Toggle ───────────────────────────────────────────────────
function toggleBigFontMode(){
  var isBig = document.body.classList.toggle('big-font-mode');
  localStorage.setItem('spx_big_font', isBig ? '1' : '0');
  var btn = document.getElementById('btnBigFont');
  if (btn) {
    btn.className = isBig ? 'btn btn-yellow btn-sm' : 'btn btn-gray btn-sm';
    btn.textContent = isBig ? '🔠 จอใหญ่ (ON)' : '🔠 จอใหญ่';
  }
}
// Init Big font from storage
if (localStorage.getItem('spx_big_font') === '1') {
  document.body.classList.add('big-font-mode');
  var bfBtn = document.getElementById('btnBigFont');
  if (bfBtn) { bfBtn.className = 'btn btn-yellow btn-sm'; bfBtn.textContent = '🔠 จอใหญ่ (ON)'; }
}

// ── Function 3: Offline LocalStorage Queue ───────────────────────────────────
function queueOfflineScan(code, roundId, userName){
  try {
    var q = JSON.parse(localStorage.getItem('offline_scan_queue') || '[]');
    q.push({ code: code, roundId: roundId, user: userName, queuedAt: new Date().toISOString() });
    localStorage.setItem('offline_scan_queue', JSON.stringify(q));
    showBanner('📴 ออฟไลน์ — บันทึก ' + code + ' ไว้ในคิว (' + q.length + ' รายการ)', 'dup');
  } catch(e) {}
}
function flushOfflineQueue(){
  try {
    var q = JSON.parse(localStorage.getItem('offline_scan_queue') || '[]');
    if(!q.length) return;
    showBanner('🔄 กำลังซิงค์ ' + q.length + ' รายการจากคิวออฟไลน์...', 'ok');
    var pending = q.slice();
    localStorage.removeItem('offline_scan_queue');
    pending.forEach(function(item, idx){
      setTimeout(function(){
        fetch('/check',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({code:item.code,user:item.user,roundId:item.roundId})})
        .then(function(r){return r.json();})
        .then(function(d){
          if(d.result==='ok') showBanner('✅ ซิงค์ ' + item.code + ' สำเร็จ','ok');
        }).catch(function(){
          queueOfflineScan(item.code, item.roundId, item.user);
        });
      }, idx * 300);
    });
  } catch(e) {}
}
window.addEventListener('online', function(){
  showBanner('📶 เชื่อมต่ออินเทอร์เน็ตแล้ว กำลังซิงค์คิวออฟไลน์...', 'ok');
  setTimeout(flushOfflineQueue, 500);
});


// ── Urgent Siren Alarm & Recall Controls ──────────────────────────────────────
var sirenTimer = null;
function playSiren() {
  stopSiren();
  if(!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  function tone() {
    try {
      if(!actx) return;
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(880, actx.currentTime);
      o.frequency.linearRampToValueAtTime(440, actx.currentTime + 0.32);
      g.gain.setValueAtTime(0.4, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 0.32);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.32);
    } catch(e){}
  }
  tone();
  sirenTimer = setInterval(tone, 420);
}
function stopSiren() {
  if (sirenTimer) {
    clearInterval(sirenTimer);
    sirenTimer = null;
  }
}

var activeRecallItem = null;
function triggerUrgentRecallModal(data) {
  if (!data) return;
  activeRecallItem = data;
  var modal = document.getElementById('urgentRecallModal');
  if (!modal) return;
  
  if (typeof scanActive !== 'undefined' && scanActive && typeof stopCamera === 'function') {
    try { stopCamera(); } catch(e){}
  }
  
  var targetCarrier = document.getElementById('recallCarrierTarget');
  var targetOrder = document.getElementById('recallOrderTarget');
  var targetTracking = document.getElementById('recallTrackingTarget');
  var targetReason = document.getElementById('recallReasonTarget');
  var verifyInput = document.getElementById('recallVerifyInput');
  var verifyErr = document.getElementById('recallVerifyError');

  if (targetCarrier) targetCarrier.textContent = '📦 กอง ' + (data.carrierName || data.roundName || 'พัสดุ');
  if (targetOrder) targetOrder.textContent = data.orderCode || data.code || '—';
  if (targetTracking) targetTracking.textContent = data.tracking || data.code || '—';
  if (targetReason) targetReason.textContent = data.reason || 'ลูกค้ายกเลิกคำสั่งซื้อ';
  if (verifyErr) verifyErr.textContent = '';
  if (verifyInput) {
    verifyInput.value = '';
    setTimeout(function(){ verifyInput.focus(); }, 120);
  }

  modal.style.display = 'flex';
  playSiren();
  speakVoice('ออเดอร์ ' + (data.orderCode || data.code) + ' ถูกยกเลิกแล้วค่ะ กรุณานำออกจากกอง ' + (data.carrierName || 'ขนส่ง'));
}

function closeUrgentRecallModal() {
  stopSiren();
  if (typeof stopRecallCamera === 'function') stopRecallCamera();
  var modal = document.getElementById('urgentRecallModal');
  if (modal) modal.style.display = 'none';
  activeRecallItem = null;
  if (scanInput) scanInput.focus();
}

function verifyRecallBox(code) {
  if (!code) return;
  var errEl = document.getElementById('recallVerifyError');
  if (errEl) errEl.textContent = '⏳ กำลังตรวจสอบรหัส...';

  fetch('/api/blacklist/recall-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, user: user })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if (d.ok) {
      closeUrgentRecallModal();
      showBanner(d.msg || '🎉 ดึงพัสดุคืนสำเร็จ!', 'ok');
      speakVoice('ดึงพัสดุคืนสำเร็จแล้วค่ะ ขอบคุณค่ะ');
      beepOK();
      loadManifest(currentRoundId);
    } else {
      if (errEl) errEl.textContent = '❌ ' + (d.err || 'รหัสไม่ตรงกับกล่องที่ต้องดึงคืน');
      beepErr();
    }
  })
  .catch(function(e){
    if (errEl) errEl.textContent = '❌ เกิดข้อผิดพลาด: ' + e.message;
  });
}

function manualConfirmRecall() {
  if (!activeRecallItem) return;
  var codeToConfirm = activeRecallItem.code || activeRecallItem.orderCode;
  showModalConfirm('ยืนยันว่าได้นำกล่องพัสดุ ' + codeToConfirm + ' ออกจากกองเรียบร้อยแล้วใช่หรือไม่?', 'ยืนยันดึงกล่องคืน', 'warning').then(function(confirmed){
    if(confirmed) verifyRecallBox(codeToConfirm);
  });
}

function onRecallConfirmed(data) {
  if (activeRecallItem && (activeRecallItem.code === data.code || activeRecallItem.orderCode === data.orderCode)) {
    closeUrgentRecallModal();
    showBanner('🎉 ดึงพัสดุ ' + (data.orderCode || data.code) + ' คืนเรียบร้อยแล้ว', 'ok');
  }
  loadManifest(currentRoundId);
}

// ── formatThaiTime ──────────────────────────────────────────────────────────
function formatThaiTime(isoDate){
  if(!isoDate) return '';
  var d = new Date(isoDate);
  var h = d.getHours();
  var m = d.getMinutes();
  var hh = String(h).padStart(2,'0');
  var mm = String(m).padStart(2,'0');
  return hh + ':' + mm + ' น.';
}

// ── State ────────────────────────────────────────────────────────────────────
var scanInput=document.getElementById('scanInput');
var lastCode='',lastTime=0,stTimer,currentRoundId='';
var manifestItems=[]; // [{id,tracking,order}]
var scannedMap=new Map();
var filterMode='all';
var isAudioBoosted=false; // Function 9: Audio Boost Toggle
var offlineScanQueue=[]; // Function 3: Offline LocalStorage Queue
var roundListCache=[]; // cache ของ history rounds สำหรับ saveRound และ detectCurrentRoundCarrier

// ── Banner ───────────────────────────────────────────────────────────────────
function showBanner(msg,cls){
  var el=document.getElementById('banner');
  el.textContent=msg;el.className=cls;el.style.display='block';
  clearTimeout(stTimer);stTimer=setTimeout(function(){el.style.display='none';},3000);
}

// ── Stats ────────────────────────────────────────────────────────────────────
function updateStats(total,done){
  document.getElementById('sTotal').textContent=total;
  document.getElementById('sDone').textContent=done;
  document.getElementById('sLeft').textContent=Math.max(0,total-done);
  var pct=(total>0?Math.round(done/total*100):0);
  document.getElementById('progFill').style.width=pct+'%';
  
  // B3: Update SVG Progress
  var svgPct = document.getElementById('svgPct');
  if(svgPct) svgPct.textContent = pct + '%';
  var svgProg = document.getElementById('svgProg');
  if(svgProg) svgProg.style.strokeDashoffset = 100 - pct;

  // B4: Near-expiry warning
  var left = total - done;
  if (left > 0 && left <= 5 && document.getElementById('statsRow')) {
    document.getElementById('statsRow').style.animation = 'pulse-red 2s infinite';
  } else if (document.getElementById('statsRow')) {
    document.getElementById('statsRow').style.animation = 'none';
  }
}
var sessionHistory = [];
function showScanHistory() {
  var list = document.getElementById('scanHistoryList');
  if (!sessionHistory.length) {
    list.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--muted)">ยังไม่มีประวัติในเซสชันนี้</div>';
  } else {
    list.innerHTML = sessionHistory.map(function(s) {
      var icon = s.res === 'ok' ? '✅' : (s.res === 'dup' ? '⚠️' : '❌');
      var clr = s.res === 'ok' ? 'var(--green)' : (s.res === 'dup' ? 'var(--yellow)' : 'var(--red)');
      var t = new Date(s.time).toLocaleTimeString('th-TH');
      return '<div style="display:flex;justify-content:space-between;padding:.5rem;border-bottom:1px solid var(--border);border-left:3px solid '+clr+'"><span style="font-weight:600;font-size:.85rem">'+icon+' '+escapeHtml(s.code)+'</span><span style="font-size:.7rem;color:var(--muted)">'+t+'</span></div>';
    }).join('');
  }
  document.getElementById('scanHistoryModal').classList.remove('hidden');
}

// ── Manifest table ────────────────────────────────────────────────────────────
function renderManifest(){
  var tbody=document.getElementById('manifestBody');
  var q=(document.getElementById('searchManifest')?document.getElementById('searchManifest').value.toUpperCase().trim():'');
  
  // Calculate counts for One-Tap Filter tags
  var cntAll = manifestItems.length;
  var cntDone = 0;
  var cntRecalled = 0;
  manifestItems.forEach(function(it){
    var isRec = it.recallState === 'RECALLED' || it.recallState === 'PENDING_RECALL';
    if(isRec) cntRecalled++;
    else if(scannedMap.has(it.tracking) || scannedMap.has(it.order)) cntDone++;
  });
  var cntPending = Math.max(0, cntAll - cntDone - cntRecalled);

  var elAll = document.getElementById('cnt-all'); if(elAll) elAll.textContent = '(' + cntAll + ')';
  var elDone = document.getElementById('cnt-done'); if(elDone) elDone.textContent = '(' + cntDone + ')';
  var elPending = document.getElementById('cnt-pending'); if(elPending) elPending.textContent = '(' + cntPending + ')';
  var elRec = document.getElementById('cnt-recalled');
  var btnRec = document.getElementById('fbtn-recalled');
  if(elRec) elRec.textContent = '(' + cntRecalled + ')';
  if(btnRec) btnRec.style.display = cntRecalled > 0 ? 'inline-flex' : 'none';

  var rows=manifestItems.filter(function(it){
    var isRecalled = it.recallState === 'RECALLED';
    var isPendingRecall = it.recallState === 'PENDING_RECALL';
    var done=(!isRecalled && !isPendingRecall) && (scannedMap.has(it.tracking)||scannedMap.has(it.order));
    if(filterMode==='done' && !done) return false;
    if(filterMode==='pending' && (done || isRecalled || isPendingRecall)) return false;
    if(filterMode==='recalled' && !(isRecalled || isPendingRecall)) return false;
    if(q && (!String(it.tracking||'').toUpperCase().includes(q) && !String(it.order||'').toUpperCase().includes(q))) return false;
    return true;
  });

  tbody.innerHTML=rows.map(function(it,i){
    var isRecalled = it.recallState === 'RECALLED';
    var isPendingRecall = it.recallState === 'PENDING_RECALL';
    var isPendingScan = it.recallState === 'PENDING_SCAN';

    var doneScan = scannedMap.get(it.tracking) || scannedMap.get(it.order);
    var done = !isRecalled && !isPendingRecall && !!doneScan;
    
    var cls = done ? 'scanned' : '';
    if (isRecalled) cls += ' canceled-row';
    if (isPendingRecall) cls += ' pending-recall-row';

    var userDisplay = doneScan ? escapeHtml(doneScan.user) : '';
    var timeDisplay = doneScan ? new Date(doneScan.time).toLocaleTimeString('th-TH') : '';
    
    var tick = '<span style="color:var(--border)">○</span>';
    if (isRecalled) {
      tick = '<span class="badge bg-red" style="font-size:0.62rem;padding:.15rem .4rem">🚫 ยกเลิกแล้ว</span>';
    } else if (isPendingRecall) {
      tick = '<span class="badge bg-red" style="font-size:0.62rem;padding:.15rem .4rem;animation:pulse 1s infinite">🚨 ต้องดึงคืน</span>';
    } else if (isPendingScan) {
      tick = '<span class="badge bg-yellow" style="font-size:0.62rem;padding:.15rem .4rem">⏳ ระงับส่ง</span>';
    } else if (done) {
      tick = '<span class="tick" style="display:flex;flex-direction:column;font-size:0.7rem;line-height:1">✓ <span style="font-size:0.6rem;color:var(--muted);font-weight:normal">'+userDisplay+' '+timeDisplay+'</span></span>';
    }

    var newBadge = it.isNewAddition ? '<span class="badge bg-yellow" style="font-size:0.6rem;padding:.1rem .35rem;margin-left:.35rem;animation:pulse 2s infinite">⚡ งานเพิ่ม</span>' : '';

    return '<tr class="'+cls+'">'+
      '<td class="num-cell">'+(i+1)+'</td>'+
      '<td>'+escapeHtml(it.order||'—')+newBadge+'</td>'+
      '<td>'+escapeHtml(it.tracking||'—')+'</td>'+
      '<td style="text-align:center">'+
        '<div style="display:flex;align-items:center;justify-content:center;gap:.35rem">'+
          tick+
          '<button type="button" class="btn btn-gray btn-sm rc-barcode-btn" data-code="'+escapeHtml(it.tracking || it.order || '')+'" data-order="'+escapeHtml(it.order || '-')+'" data-tracking="'+escapeHtml(it.tracking || '-')+'" title="ดูบาร์โค้ดสำรองสำหรับสแกน" style="padding:.18rem .45rem;font-size:.7rem;border-radius:.4rem;line-height:1">🏷️</button>'+
        '</div>'+
      '</td>'+
    '</tr>';
  }).join('');

  tbody.querySelectorAll('.rc-barcode-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      showDigitalBarcodeModal(btn.dataset.code, btn.dataset.order, btn.dataset.tracking);
    });
  });
}

var currentModalDigitalCode = '';
function showDigitalBarcodeModal(code, order, tracking){
  if(!code) return;
  currentModalDigitalCode = code;
  document.getElementById('digitalBarcodeCode').textContent = code;
  document.getElementById('digitalOrderText').textContent = order || '-';
  document.getElementById('digitalTrackingText').textContent = tracking || '-';
  
  var svg = document.getElementById('digitalBarcodeSvg');
  if(svg && window.JsBarcode){
    try {
      JsBarcode(svg, code, {
        format: 'CODE128',
        lineColor: '#0f172a',
        width: 2.2,
        height: 75,
        displayValue: false,
        margin: 0
      });
    } catch(e) {
      console.warn('JsBarcode render err:', e);
    }
  }
  document.getElementById('digitalBarcodeModal').classList.remove('hidden');
}

function quickMarkScannedFromModal(){
  if(!currentModalDigitalCode) return;
  var code = currentModalDigitalCode;
  document.getElementById('digitalBarcodeModal').classList.add('hidden');
  handleCode(code);
}

function filterManifest(mode,btn){
  filterMode=mode;
  document.querySelectorAll('.fbtn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  renderManifest();
}

function markScanned(code, scanDetails){
  manifestItems.forEach(function(it){
    var tMatch=it.tracking&&(it.tracking===code||code.includes(it.tracking)||it.tracking.includes(code));
    var oMatch=it.order&&(it.order===code||code.includes(it.order)||it.order.includes(code));
    if(tMatch||oMatch){
      if(it.tracking)scannedMap.set(it.tracking, scanDetails);
      if(it.order)scannedMap.set(it.order, scanDetails);
    }
  });
  renderManifest();
}
function unmarkScanned(code){
  manifestItems.forEach(function(it){
    var tMatch=it.tracking&&(it.tracking===code||code.includes(it.tracking)||it.tracking.includes(code));
    var oMatch=it.order&&(it.order===code||code.includes(it.order)||it.order.includes(code));
    if(tMatch||oMatch){
      if(it.tracking)scannedMap.delete(it.tracking);
      if(it.order)scannedMap.delete(it.order);
    }
  });
  renderManifest();
}

var currentProofUrl = '';
function updateStagingUI(proof, isSaved) {
  // Reset staging proof if confirmed on a previous day (local time)
  if (proof && proof.confirmed && proof.confirmedAt) {
    var confirmedDate = new Date(proof.confirmedAt);
    var today = new Date();
    if (confirmedDate.toDateString() !== today.toDateString()) {
      proof = null; // ถ่ายใหม่ทุกวัน
    }
  }
  var card = document.getElementById('stagingCard');
  var unconf = document.getElementById('stagingUnconfirmed');
  var conf = document.getElementById('stagingConfirmed');
  var s1 = document.getElementById('step1Indicator');
  var s2 = document.getElementById('step2Indicator');
  var s3 = document.getElementById('step3Indicator');
  // Elements gated behind staging confirmation
  var gatedIds = ['statsRow','progWrap','scanCard','manifestBox','saveSectionBottom'];
  
  if (proof && proof.confirmed) {
    if (card) { card.style.borderColor = 'var(--green)'; card.style.background = 'rgba(34,197,94,.06)'; }
    if (unconf) unconf.style.display = 'none';
    if (conf) conf.style.display = 'block';
    
    var timeStr = formatThaiTime(proof.confirmedAt);
    var methodStr = proof.method === 'pin' ? ' (ผ่าน PIN แอดมิน)' : ' (ถ่ายรูปยืนยัน)';
    var metaEl = document.getElementById('stagingProofMeta');
    if (metaEl) metaEl.textContent = 'โดย ' + (proof.confirmedBy || '-') + ' เวลา ' + timeStr + methodStr;
    
    currentProofUrl = proof.photoUrl || proof.photoBase64 || '';
    var vBtn = document.getElementById('viewProofPhotoBtn');
    if (vBtn) vBtn.style.display = currentProofUrl ? 'inline-flex' : 'none';
    
    if (s1) { s1.className = 'step-item done'; document.getElementById('step1Badge').textContent = '✓'; }
    if (s2) { s2.className = isSaved ? 'step-item done' : 'step-item active'; }
    if (s3) { s3.className = isSaved ? 'step-item done' : 'step-item'; }
    
    // Reveal scan/stats/manifest/save gated elements
    gatedIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('hidden');
    });

    if (!isSaved) {
      scanInput.disabled = false;
      scanInput.placeholder = 'ยิงแสกนเนอร์ได้เลย…';
    }
  } else {
    if (card) { card.style.borderColor = 'var(--yellow)'; card.style.background = 'rgba(245,158,11,.05)'; }
    if (unconf) unconf.style.display = 'block';
    if (conf) conf.style.display = 'none';
    currentProofUrl = '';
    
    if (s1) { s1.className = 'step-item active'; document.getElementById('step1Badge').textContent = '1'; }
    if (s2) { s2.className = 'step-item'; }
    if (s3) { s3.className = 'step-item'; }
    
    // Hide all gated elements until staging confirmed
    gatedIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    scanInput.disabled = true;
    scanInput.placeholder = '⚠️ กรุณายืนยันจุดวางพัสดุก่อนเริ่มยิง';
  }
}

function handleStagingPhotoUpload(event) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var base64 = e.target.result;
    showBanner('⏳ กำลังบันทึกรูปยืนยัน...', 'ok');
    fetch('/api/staging-proof', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId: currentRoundId, imageBase64: base64, user: user })
    })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(d.ok) {
        showBanner('✅ บันทึกรูปยืนยันเรียบร้อยแล้ว!', 'ok');
        beepOK();
        loadManifest(currentRoundId);
      } else {
        alert(d.err || 'บันทึกรูปไม่สำเร็จ');
      }
    })
    .catch(function(err){ alert('เกิดข้อผิดพลาด: ' + err.message); });
  };
  reader.readAsDataURL(file);
}

function showPinRequestBox() {
  var pBox = document.getElementById('pinBox');
  if (pBox) pBox.style.display = 'block';
  fetch('/api/request-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roundId: currentRoundId, user: user })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.ok) {
      showBanner('🔔 ส่งคำขอ PIN ไปยังกระดิ่ง Admin แล้ว', 'ok');
      var pIn = document.getElementById('workerPinInput');
      if(pIn) { pIn.focus(); }
    } else {
      alert(d.err || 'ส่งคำขอไม่สำเร็จ');
    }
  });
}

function submitWorkerPin() {
  var pin = (document.getElementById('workerPinInput').value || '').trim();
  if (!pin) { alert('กรุณากรอกรหัส PIN'); return; }
  fetch('/api/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roundId: currentRoundId, pin: pin, user: user })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.ok) {
      showBanner('✅ ปลดล็อกสำเร็จแล้ว!', 'ok');
      beepOK();
      loadManifest(currentRoundId);
    } else {
      alert(d.err || 'รหัส PIN ไม่ถูกต้อง');
    }
  })
  .catch(function(err){ alert('เกิดข้อผิดพลาด: ' + err.message); });
}

function viewCurrentProofPhoto() {
  if (!currentProofUrl) return;
  var img = document.getElementById('proofPhotoImg');
  if (img) img.src = currentProofUrl;
  var meta = document.getElementById('stagingProofMeta');
  var dt = document.getElementById('proofPhotoDetails');
  if (dt && meta) dt.textContent = meta.textContent;
  var modal = document.getElementById('proofPhotoModal');
  if (modal) modal.classList.remove('hidden');
}

function loadManifest(roundId){
  fetch('/api/history').then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return;
    if(d.validateCarrierMismatch !== undefined) sysValidateCarrier = d.validateCarrierMismatch !== false;
    if(d.carrierPrefixes) dynamicCarrierPrefixes = d.carrierPrefixes;
    var round=d.history.find(function(r){return r.id===roundId;});
    if(!round){
      document.getElementById('manifestBox').classList.add('hidden');
      var sBot = document.getElementById('saveSectionBottom');
      if (sBot) sBot.classList.add('hidden');
      return;
    }
    manifestItems=round.items||[];
    scannedMap=new Map();
    (round.scans||[]).forEach(function(s){
      scannedMap.set(s.code, s);
    });
    renderManifest();
    checkPendingRecalls(roundId);
    document.getElementById('manifestBox').classList.remove('hidden');

    function updateSaveButtons(isSaved, savedBy) {
      var btn = document.getElementById('saveRoundBtnBottom');
      if (btn) {
        if (isSaved) {
          btn.disabled = true;
          btn.textContent = '🔒 ปิดยอดแล้ว (โดย ' + (savedBy || '-') + ')';
          btn.className = 'btn btn-gray btn-full';
        } else {
          btn.disabled = false;
          btn.textContent = '💾 บันทึกปิดยอด (Save)';
          btn.className = 'btn btn-blue btn-full';
        }
      }
      var sec = document.getElementById('saveSectionBottom');
      if (sec) sec.classList.remove('hidden');
    }

    var reopenedEl = document.getElementById('reopenedBanner');
    var reopenedTxt = document.getElementById('reopenedBannerText');
    if (round.reopenedCount > 0 && !round.isSaved) {
      if (reopenedEl) {
        reopenedEl.classList.remove('hidden');
        if (reopenedTxt) reopenedTxt.textContent = '📢 มีงานเพิ่มเข้ามา ' + round.reopenedCount + ' รายการ! (รอบถูกปลดล็อกให้ยิงต่อเรียบร้อย)';
      }
    } else {
      if (reopenedEl) reopenedEl.classList.add('hidden');
    }

    if (round.isSaved) {
      updateSaveButtons(true, round.savedBy);
      scanInput.disabled = true;
      scanInput.placeholder = '🔒 กลุ่มขนส่งนี้ปิดยอดไปแล้ว';
      updateStagingUI(round.stagingProof, true);
    } else {
      updateSaveButtons(false);
      updateStagingUI(round.stagingProof, false);
    }
  });
}

var currentCompletionBase64 = '';

function saveRound(){
  // เปิด Modal Checklist ตรวจสอบความเรียบร้อยก่อน
  openPreCloseModal();
}

function openPreCloseModal(){
  document.getElementById('chkCleanBelt').checked = false;
  document.getElementById('chkLabelStuck').checked = false;
  document.getElementById('chkCorrectPallet').checked = false;
  document.getElementById('btnConfirmChecklist').disabled = true;
  document.getElementById('preCloseChecklistModal').style.display = 'flex';
}

function closePreCloseModal(){
  document.getElementById('preCloseChecklistModal').style.display = 'none';
}

function validatePreCloseChecklist(){
  var c1 = document.getElementById('chkCleanBelt').checked;
  var c2 = document.getElementById('chkLabelStuck').checked;
  var c3 = document.getElementById('chkCorrectPallet').checked;
  document.getElementById('btnConfirmChecklist').disabled = !(c1 && c2 && c3);
}

function proceedToCompletionProof(){
  closePreCloseModal();
  realExecuteSaveRound();
}

function realExecuteSaveRound(){
  if(!currentRoundId) return;
  var b2 = document.getElementById('saveRoundBtnBottom');
  if(b2) b2.disabled = true;

  // 1. Check pending recalls first
  fetch('/api/blacklist/pending-recalls?roundId=' + encodeURIComponent(currentRoundId))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.ok && d.pendingRecalls && d.pendingRecalls.length > 0) {
        if(b2) b2.disabled = false;
        triggerUrgentRecallModal(d.pendingRecalls[0]);
        return;
      }

      // 2. Check missing items directly from live manifest
      var activeItems = manifestItems.filter(function(it){ return it.recallState !== 'RECALLED' && it.recallState !== 'PENDING_RECALL'; });
      var missingList = activeItems.filter(function(it){
        return !scannedMap.has(it.tracking) && !scannedMap.has(it.order);
      });

      if (missingList.length > 0 || activeItems.length === 0) {
        if(b2) b2.disabled = false;
        // Missing items! Show rejection modal with list
        document.getElementById('saveRejectMsg').textContent = 'ไม่สามารถปิดยอดได้ ขาด ' + missingList.length + ' รายการ';
        var tbody = document.getElementById('saveRejectBody');
        tbody.innerHTML = missingList.map(function(it) {
          return '<tr><td>' + escapeHtml(it.order || '—') + '</td><td>' + escapeHtml(it.tracking || '—') + '</td><td>' + escapeHtml(it.carrierName || '-') + '</td></tr>';
        }).join('');
        document.getElementById('saveRejectModal').classList.remove('hidden');
        return;
      }

      // 3. Complete 100%! Open Completion Proof Modal (Mandatory photo)
      if(b2) b2.disabled = false;
      var curRound = (roundListCache || []).find(function(r){ return r.id === currentRoundId; });
      var name = (curRound && curRound.name) || document.getElementById('roundSelLabel').textContent || 'กลุ่มขนส่ง';
      openCompletionModal(name);
    })
    .catch(function(err){
      if(b2) b2.disabled = false;
      alert('เกิดข้อผิดพลาดในการตรวจสอบข้อมูล: ' + err.message);
    });
}

function openCompletionModal(carrierName) {
  currentCompletionBase64 = '';
  document.getElementById('compCarrierLabel').textContent = carrierName;
  document.getElementById('compPreviewBox').style.display = 'none';
  document.getElementById('compTakeBtnBox').style.display = 'block';
  var submitBtn = document.getElementById('compSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.className = 'btn btn-gray btn-full';
  var modal = document.getElementById('completionProofModal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

function closeCompletionModal() {
  var modal = document.getElementById('completionProofModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
  currentCompletionBase64 = '';
}

function handleCompletionPhoto(event) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    currentCompletionBase64 = e.target.result;
    document.getElementById('compPreviewImg').src = currentCompletionBase64;
    document.getElementById('compPreviewBox').style.display = 'block';
    document.getElementById('compTakeBtnBox').style.display = 'none';
    var submitBtn = document.getElementById('compSubmitBtn');
    submitBtn.disabled = false;
    submitBtn.className = 'btn btn-green btn-full';
  };
  reader.readAsDataURL(file);
}

function submitCompletionSave() {
  if (!currentCompletionBase64) {
    alert('กรุณาถ่ายรูปกองพัสดุเพื่อยืนยันก่อนปิดยอด');
    return;
  }
  closeCompletionModal();
  executeSaveRound(currentCompletionBase64);
}

function executeSaveRound(imageBase64){
  var b2 = document.getElementById('saveRoundBtnBottom');
  if(b2) b2.disabled = true;

  fetch('/api/save-round', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roundId: currentRoundId, user: user, imageBase64: imageBase64 })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if(b2) b2.disabled = false;
    if (d.ok) {
      loadManifest(currentRoundId);
      loadRoundList();
      window.celebrated = false;
      if(typeof confetti !== 'undefined') confetti({particleCount:100, spread:70, origin:{y:0.6}});
      showBanner('🎉 ปิดยอดสำเร็จพร้อมบันทึกรูปถ่ายเรียบร้อย!', 'ok');
      beepOK();
    } else if (d.result === 'reject') {
      document.getElementById('saveRejectMsg').textContent = d.msg;
      var tbody = document.getElementById('saveRejectBody');
      tbody.innerHTML = (d.missingItems || []).map(function(it) {
        return '<tr><td>' + escapeHtml(it.order) + '</td><td>' + escapeHtml(it.tracking) + '</td><td>' + escapeHtml(it.carrierName) + '</td></tr>';
      }).join('');
      document.getElementById('saveRejectModal').classList.remove('hidden');
    } else {
      alert(d.err || 'Error saving round');
    }
  })
  .catch(function(err){
    if(b2) b2.disabled = false;
    alert('เกิดข้อผิดพลาดในการเชื่อมต่อ: ' + err.message);
  });
}

// ── Round selector ────────────────────────────────────────────────────────────
function loadRoundList(){
  fetch('/api/history').then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return;
    roundListCache = d.history || []; // เก็บไว้ใช้ใน saveRound และ detectCurrentRoundCarrier
    
    // Update button label
    var current = d.history.find(r => r.id === currentRoundId);
    if(current) {
      document.getElementById('roundSelLabel').textContent = 'รอบ — '+escapeHtml(current.name.substring(0,25));
    } else {
      document.getElementById('roundSelLabel').textContent = 'เลือกใบส่งมอบ...';
    }

    var list = document.getElementById('scanRoundList');
    if(!d.history.length) {
       list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีรอบ</div>';
       return;
    }
    
    list.innerHTML = generateFoldersHTML(d.history, function(r, num){
      var pct = r.total>0 ? Math.round(r.done/r.total*100) : 0;
      var label = 'รอบ #'+num+' — '+escapeHtml(r.name)+(r.isCurrent?' ★':'');
      var badgeCls = pct===100?'bg-green':(pct>0?'bg-blue':'bg-muted');
      var badge = '<span class="badge '+badgeCls+'">'+r.done+'/'+r.total+'</span>';
      return '<div class="rc-item '+(r.id===currentRoundId?'active':'')+'" style="display:flex;justify-content:space-between;padding:.6rem .5rem;border-bottom:1px solid var(--border);cursor:pointer" onclick="selectScanRound(\\''+r.id+'\\')">' + 
               '<div style="font-size:.8rem;font-weight:600;color:'+(r.id===currentRoundId?'var(--blue)':'var(--text)')+'">'+label+'</div>'+badge+
             '</div>';
    });
  });
}

function selectScanRound(id) {
  document.getElementById('scanRoundModal').style.display = 'none';
  switchRound(id);
}

function switchRound(id){
  if(!id)return;
  currentRoundId=id;
  // Update presence on server
  reportPresence();
  fetch('/api/set-round',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:id})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.ok){
        fetch('/get-stats?roundId='+id).then(function(r){return r.json();}).then(function(s){
          updateStats(s.total,s.done);
          scannedSet=new Set(s.scanned||[]);
          loadManifest(id);
          loadRoundList();
        });
      }
    });
}

// ── Presence (real-time who is scanning) ─────────────────────────────────────
function reportPresence(){
  if(!user||!currentRoundId)return;
  fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({user:user,roundId:currentRoundId})});
}

function loadPresence(){
  fetch('/api/presence').then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return;
    var list=document.getElementById('presenceList');
    list.innerHTML=d.users.map(function(u){
  var isMe=u.user===user;
  var roundNameHtml = u.roundName ? ' <span style="font-size:.65rem;opacity:.7">(' + escapeHtml(u.roundName.substring(0,12)) + ')</span>' : '';
  return '<span class="presence-chip'+(isMe?' me':'')+'">'+
    '<span class="pdot"></span>'+escapeHtml(u.user)+
    roundNameHtml +
  '</span>';
}).join('');
    document.getElementById('presenceBar').classList.remove('hidden');
  });
}

// Heartbeat every 8s
reportPresence();
setInterval(function(){reportPresence();loadPresence();},8000);
loadPresence();

// ── Show UI ───────────────────────────────────────────────────────────────────
function showUI(total,done){\
  document.getElementById('noManifest').classList.add('hidden');
  // Only show the header steps, carrier selector, and staging card
  // Scan/stats/manifest/save are revealed later by updateStagingUI after staging confirmed
  ['stepNav','roundSelector','stagingCard'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.classList.remove('hidden');
  });
  // Hide the scan/stats/table/save sections until staging is confirmed
  ['statsRow','progWrap','scanCard','manifestBox','saveSectionBottom'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.classList.add('hidden');
  });
  updateStats(total,done);
  loadRoundList();
  scanInput.focus();
}

// ── Focus guard ───────────────────────────────────────────────────────────────
if(document.getElementById('roundSelBtn')) {
  document.getElementById('roundSelBtn').addEventListener('focus',function(){});
  document.getElementById('roundSelBtn').addEventListener('blur',function(){
    setTimeout(function(){if(document.getElementById('scanRoundModal').style.display==='none')scanInput.focus();},200);
  });
}
document.addEventListener('click',function(e){
  if(e.target&&(e.target.id==='roundSelBtn'||e.target.closest('#roundSelBtn')||e.target.tagName==='OPTION'||e.target.classList.contains('fbtn')))return;
  if(document.getElementById('scanRoundModal').style.display!=='none')return;
  if(document.getElementById('urgentRecallModal')&&document.getElementById('urgentRecallModal').style.display!=='none')return;
  scanInput.focus();
});
setInterval(function(){
  if(document.getElementById('scanRoundModal').style.display!=='none')return;
  if(document.getElementById('urgentRecallModal')&&document.getElementById('urgentRecallModal').style.display!=='none')return;
  var a=document.activeElement;
  if(a&&(a.id==='roundSelBtn'||a.tagName==='SELECT'||a.classList.contains('fbtn')))return;
  if(a!==scanInput)scanInput.focus();
},700);

// ── Function 2: Carrier Prefix Validator (barcode prefix mismatch check) ────
var DEFAULT_CARRIER_PREFIXES = {
  'FLASH': ['FXTH','FX','THLTS','THLAS'],
  'SPX': ['SPXTH','SPX'],
  'KERRY': ['KR'],
  'J&T': ['JT','601'],
  'DHL': ['DHL'],
  'LAZADA': ['LAZ','1Z'],
  'NIM': ['NIM'],
  'BEST': ['BES']
};
function getActiveCarrierPrefixes(){
  return (typeof dynamicCarrierPrefixes === 'object' && dynamicCarrierPrefixes) ? dynamicCarrierPrefixes : DEFAULT_CARRIER_PREFIXES;
}
function detectCarrierFromCode(code){
  var c = code.toUpperCase();
  var prefixesMap = getActiveCarrierPrefixes();
  for(var carrier in prefixesMap){
    var prefixes = prefixesMap[carrier];
    if(Array.isArray(prefixes)){
      for(var i=0;i<prefixes.length;i++){
        if(c.startsWith(prefixes[i])) return carrier;
      }
    }
  }
  return null;
}
function detectCurrentRoundCarrier(){
  if(!currentRoundId) return null;
  // Use roundListCache (populated by loadRoundList)
  var r = roundListCache.find(function(x){ return x.id === currentRoundId; });
  if(r && r.name){
    var nm = r.name.toUpperCase();
    var prefixesMap = getActiveCarrierPrefixes();
    for(var carrier in prefixesMap){
      if(nm.indexOf(carrier) !== -1) return carrier;
    }
  }
  return null;
}

// ── Scan handler ──────────────────────────────────────────────────────────────
function handleCode(code){
  if(!code||code.length<5)return;
  if(code.length>30){beepDup();showBanner('⚠️ โค้ดยาวผิดปกติ','dup');return;}
  var now=Date.now();
  // Function 2: Anti-Bounce — reject same code within 400ms
  if(code===lastCode&&now-lastTime<400)return;
  // Legacy 1500ms dup guard for same barcode (different from anti-bounce)
  if(code===lastCode&&now-lastTime<1500)return;
  lastCode=code;lastTime=now;

  // Function 8: Carrier Prefix Validator (with Admin Toggle & Smart Manifest Check)
  if(typeof sysValidateCarrier === 'undefined' || sysValidateCarrier){
    var cUpper = String(code || '').trim().toUpperCase();
    var isInCurrentManifest = Array.isArray(manifestItems) && manifestItems.some(function(it){
      var tr = String(it.tracking || '').trim().toUpperCase();
      var ord = String(it.order || it.orderId || it.id || '').trim().toUpperCase();
      return (tr && tr === cUpper) || (ord && ord === cUpper);
    });
    if(!isInCurrentManifest){
      var scannedCarrier = detectCarrierFromCode(code);
      var roundCarrier = detectCurrentRoundCarrier();
      if(scannedCarrier && roundCarrier && scannedCarrier !== roundCarrier){
        beepErr();
        triggerScreenAlarmFlash();
        showBanner('🚨 ผิดขนส่ง! บาร์โค้ดนี้ของ ' + scannedCarrier + ' (รอบปัจจุบันคือ ' + roundCarrier + ')', 'err');
        speakVoice('ผิดขนส่ง ' + scannedCarrier);
        return;
      }
    }
  }

  var isGlobal = false;
  fetch('/check',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({code:code,user:user,roundId:currentRoundId,globalScan:isGlobal})})
    .then(function(r){return r.json();})
    .then(function(d){
      document.getElementById('lastCode').textContent='🔍 '+escapeHtml(code);
      
      // Visual Flash Diagnostics
      var sc = document.getElementById('scanCard');
      if (sc) {
        sc.classList.remove('flash-ok','flash-dup','flash-err');
        void sc.offsetWidth; // trigger reflow
        sc.classList.add(d.result === 'ok' ? 'flash-ok' : (d.result === 'dup' ? 'flash-dup' : 'flash-err'));
      }
      
      // Auto-switch round if global scan matched another round
      if(d.roundId && d.roundId !== currentRoundId && (d.result==='ok'||d.result==='dup')) {
        currentRoundId = d.roundId;
        if(document.getElementById('roundSel')) document.getElementById('roundSel').value = currentRoundId;
        loadRoundList(); // Update button label and modal
        if(voiceEnabled && 'speechSynthesis' in window) {
          var u = new SpeechSynthesisUtterance("เปลี่ยนรอบอัตโนมัติ");
          u.lang = 'th-TH'; u.rate = 1.2; window.speechSynthesis.speak(u);
        }
        scannedSet = new Set(d.scanned || []);
        loadManifest(currentRoundId);
      }

      // B5: Update today's scans
      if (d.todayCount !== undefined) {
        var tb = document.getElementById('todayScansBadge');
        if (tb) { tb.textContent = '🔥 วันนี้ ' + d.todayCount + ' ชิ้น'; tb.style.display = 'inline-block'; tb.classList.remove('hidden'); }
      }

      updateStats(d.total,d.done);
      
      // B10: Track history
      sessionHistory.unshift({code: code, res: d.result, time: Date.now()});
      if(sessionHistory.length > 50) sessionHistory.pop(); // Keep last 50
      
      if(d.result==='recalled_ok'){
        closeUrgentRecallModal();
        beepOK();
        showBanner(d.msg,'ok');
        speakVoice("ดึงพัสดุคืนสำเร็จแล้วค่ะ ขอบคุณค่ะ");
        loadManifest(currentRoundId);
      }
      else if(d.result==='err_intercepted'){
        playSiren();
        setTimeout(stopSiren, 2800);
        showBanner(d.msg,'err');
        speakVoice("ออเดอร์นี้ถูกยกเลิกแล้ว ห้ามส่ง กรุณาแยกกล่องออกทันที");
        loadManifest(currentRoundId);
      }
      else if(d.result==='ok'){
        beepOK(); showBanner(d.msg,'ok'); markScanned(code, {code: code, user: d.scannedBy, time: d.scanTime});
        document.getElementById('undoBtn').style.display='inline-flex';
        // B8: 100% Completion Celebration
        if(d.done >= d.total && d.total > 0 && !window.celebrated) {
          window.celebrated = true;
          if(navigator.vibrate) navigator.vibrate([200,100,200,100,500]);
          showBanner('✅ ยิงครบแล้ว! สามารถกดบันทึกปิดยอดได้เลย', 'ok');
          speakVoice('ยิงครบหมดแล้ว กดปิดยอดได้เลยค่ะ');
        }
      }
      else if(d.result==='dup'){
        beepDup();
        var msg = d.msg;
        if (d.scannedBy) {
          var timeStr = formatThaiTime(d.scanTime);
          msg += ' (โดย ' + d.scannedBy + ' เวลา ' + timeStr + ')';
          speakVoice('แสกนซ้ำ โดย ' + d.scannedBy + ' เวลา ' + timeStr);
        } else {
          speakVoice('แสกนซ้ำ');
        }
        showBanner(msg,'dup');
      }
      else if(d.result==='err_blacklist'){
        beepBlacklist();
        showBanner(d.msg,'err');
      }
      else if(d.result==='err'){
        beepErr();
        showBanner('❌ ' + d.msg + ' (ตรวจกลุ่มขนส่ง หรือชื่อบนกล่อง)','err');
      }
    })
    .catch(function(err){
      // Function 3: Offline fallback — queue scan when network fails
      queueOfflineScan(code, currentRoundId, user);
    });
}


function undoScan(){
  showModalConfirm('คุณต้องการยกเลิกการแสกนล่าสุดหรือไม่?', 'ยกเลิกการแสกน', 'question').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/undo-scan',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({roundId:currentRoundId, user:user})})
    .then(r=>r.json()).then(d=>{
      if(!d.ok){alert(d.err);return;}
      document.getElementById('undoBtn').style.display='none'; // ซ่อนปุ่มหลัง undo ไปแล้ว
      unmarkScanned(d.code);
      updateStats(d.total,d.done);
      window.celebrated = false;
      showBanner('↩️ ยกเลิกการแสกน ' + escapeHtml(d.code), 'dup');
    });
  });
}

scanInput.addEventListener('keypress',function(e){
  if(e.key!=='Enter')return;
  var code=scanInput.value.trim().toUpperCase();
  scanInput.value='';
  handleCode(code);
});

// Feature 1: Camera Scanner
var html5QrcodeScanner = null; // legacy scanner holder; custom scanner below owns camera runtime
function toggleCamera(){
  var r = document.getElementById('reader');
  if(r.style.display==='block'){
    if(html5QrcodeScanner) {
      html5QrcodeScanner.clear().catch(e=>{});
      html5QrcodeScanner = null;
    }
    r.style.display='none';
    document.getElementById('camBtn').textContent='📷';
  } else {
    r.style.display='block';
    document.getElementById('camBtn').textContent='❌';
    // Replaced by the custom Html5Qrcode flow below.
  }
}


// ── Feature 10: Real-time Sync ────────────────────────────────────────────────
function isLocalhostHost(hostname){
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
function isCameraSecureContext(){
  return window.isSecureContext || isLocalhostHost(location.hostname);
}
function setCameraButtons(text, disabled){
  document.querySelectorAll('.camBtn,#camBtn').forEach(function(btn){
    btn.textContent = text;
    btn.disabled = !!disabled;
  });
}
function showCameraNotice(title, body){
  var n = document.getElementById('cameraNotice');
  if(!n) return;
  n.innerHTML = '<strong>' + title + '</strong>' + body;
  n.style.display = 'block';
}
function hideCameraNotice(){
  var n = document.getElementById('cameraNotice');
  if(n) n.style.display = 'none';
}
function getCameraErrorMessage(err){
  var name = (err && (err.name || err.message)) || '';
  if(name.indexOf('camera-lib-timeout') >= 0) {
    return 'โหลดระบบกล้องไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้าอีกครั้ง';
  }
  if(name.indexOf('NotAllowed') >= 0 || name.indexOf('Permission') >= 0) {
    return 'ยังไม่ได้อนุญาตกล้อง กรุณากด Allow/อนุญาต แล้วลองเปิดกล้องอีกครั้ง';
  }
  if(name.indexOf('NotFound') >= 0 || name.indexOf('DevicesNotFound') >= 0) {
    return 'ไม่พบกล้องบนอุปกรณ์นี้ หรือกล้องถูกใช้งานโดยแอปอื่นอยู่';
  }
  if(name.indexOf('NotReadable') >= 0 || name.indexOf('TrackStart') >= 0) {
    return 'เปิดกล้องไม่ได้ อาจมีกล้องถูกใช้งานอยู่หรือระบบล็อกสิทธิ์กล้อง';
  }
  if(name.indexOf('Overconstrained') >= 0) {
    return 'กล้องไม่รองรับเงื่อนไขที่เว็บขอ ลองเปลี่ยนกล้องหรือเปิดใหม่อีกครั้ง';
  }
  return 'เปิดกล้องไม่ได้ กรุณาตรวจสอบสิทธิ์กล้องและลองใหม่อีกครั้ง';
}
var html5QrCode = null;
var cameraDevices = [];
var activeCameraId = '';
var scanMode = localStorage.getItem('spx_scan_mode') || 'auto';
var scanActive = false;
var torchOn = false;
var lastCameraText = '';
var lastCameraAt = 0;

function getFormatsForMode(mode){
  var F = Html5QrcodeSupportedFormats;
  if(mode === 'qr') return [F.QR_CODE];
  if(mode === 'barcode') return [F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR];
  return [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.DATA_MATRIX];
}
function waitForCameraLib(){
  return new Promise(function(resolve, reject){
    var tries = 0;
    var timer = setInterval(function(){
      if(typeof Html5Qrcode !== 'undefined' && typeof Html5QrcodeSupportedFormats !== 'undefined') {
        clearInterval(timer);
        resolve();
      } else if(++tries > 30) {
        clearInterval(timer);
        reject(new Error('camera-lib-timeout'));
      }
    }, 100);
  });
}
function updateScanModeButtons(){
  document.querySelectorAll('#scanModeBtns button').forEach(function(btn){
    btn.classList.toggle('active', btn.getAttribute('data-mode') === scanMode);
  });
}
function setCameraMeta(text){
  var m = document.getElementById('cameraMeta');
  if(m) m.textContent = text || '';
}
function pickBackCamera(cameras){
  var preferred = cameras.find(function(c){
    return /back|rear|environment|หลัง/i.test(c.label || '');
  });
  return preferred || cameras[cameras.length - 1] || null;
}
function renderCameraSelect(){
  var sel = document.getElementById('cameraSelect');
  if(!sel) return;
  sel.innerHTML = '';
  cameraDevices.forEach(function(cam, idx){
    var opt = document.createElement('option');
    opt.value = cam.id;
    opt.textContent = cam.label || ('Camera ' + (idx + 1));
    if(cam.id === activeCameraId) opt.selected = true;
    sel.appendChild(opt);
  });
}
async function loadCameras(){
  await waitForCameraLib();
  cameraDevices = await Html5Qrcode.getCameras();
  var saved = localStorage.getItem('spx_camera_id');
  var savedCam = cameraDevices.find(function(c){ return c.id === saved; });
  var backCam = pickBackCamera(cameraDevices);
  activeCameraId = (savedCam || backCam || {}).id || '';
  renderCameraSelect();
  return cameraDevices;
}
function getScannerConfig(){
  return {
    fps: 14,
    qrbox: function(viewfinderWidth, viewfinderHeight) {
      var width = Math.floor(Math.min(viewfinderWidth * 0.92, 430));
      var height = scanMode === 'qr' ? Math.floor(Math.min(viewfinderHeight * 0.72, width)) : Math.floor(Math.min(viewfinderHeight * 0.46, 220));
      if(scanMode === 'auto') height = Math.floor(Math.min(viewfinderHeight * 0.58, 280));
      return { width: Math.max(width, 240), height: Math.max(height, 120) };
    },
    aspectRatio: 1.777778,
    disableFlip: true,
    formatsToSupport: getFormatsForMode(scanMode),
    experimentalFeatures: { useBarCodeDetectorIfSupported: true }
  };
}
function getCameraConfig(){
  if(activeCameraId) return { deviceId: { exact: activeCameraId } };
  return { facingMode: { ideal: 'environment' } };
}
async function stopCamera(){
  if(html5QrCode && scanActive) {
    try { await html5QrCode.stop(); } catch(e) {}
  }
  if(html5QrCode) {
    try { html5QrCode.clear(); } catch(e) {}
  }
  scanActive = false;
  torchOn = false;
  document.getElementById('reader').style.display='none';
  document.getElementById('cameraPanel').style.display='none';
  document.getElementById('torchBtn').style.display='none';
  setCameraButtons('📷 กล้อง', false);
}
function onCameraScanSuccess(txt, result){
  var now = Date.now();
  var code = String(txt || '').trim().toUpperCase();
  if(!code) return;
  if(code === lastCameraText && now - lastCameraAt < 1400) return;
  lastCameraText = code;
  lastCameraAt = now;
  if(navigator.vibrate) navigator.vibrate(80);
  var format = result && result.result && result.result.format ? result.result.format.formatName : '';
  setCameraMeta(format ? ('อ่านได้: ' + format + ' • ' + code) : ('อ่านได้: ' + code));
  handleCode(code);
}
async function startCamera(){
  await waitForCameraLib();
  if(!cameraDevices.length) await loadCameras();
  var reader = document.getElementById('reader');
  reader.style.display='block';
  document.getElementById('cameraPanel').style.display='flex';
  updateScanModeButtons();
  setCameraButtons('กำลังเปิด...', true);
  html5QrCode = new Html5Qrcode('reader', { formatsToSupport: getFormatsForMode(scanMode), verbose: false });
  try {
    await html5QrCode.start(getCameraConfig(), getScannerConfig(), onCameraScanSuccess, function(){});
  } catch(e) {
    if(!activeCameraId) throw e;
    activeCameraId = '';
    localStorage.removeItem('spx_camera_id');
    renderCameraSelect();
    await html5QrCode.start({ facingMode: { ideal: 'environment' } }, getScannerConfig(), onCameraScanSuccess, function(){});
  }
  scanActive = true;
  setCameraButtons('❌ ปิดกล้อง', false);
  var current = cameraDevices.find(function(c){ return c.id === activeCameraId; });
  setCameraMeta('กำลังใช้: ' + ((current && current.label) || 'กล้องหลัง') + ' • โหมด ' + scanMode.toUpperCase());
  try {
    var caps = html5QrCode.getRunningTrackCapabilities ? html5QrCode.getRunningTrackCapabilities() : {};
    document.getElementById('torchBtn').style.display = caps && caps.torch ? 'inline-flex' : 'none';
  } catch(e) {
    document.getElementById('torchBtn').style.display = 'none';
  }
}
function initCameraState(){
  if(isCameraSecureContext()) {
    hideCameraNotice();
    setCameraButtons('📷 กล้อง', false);
    updateScanModeButtons();
    return;
  }
  setCameraButtons('📷 กล้อง', true);
  showCameraNotice(
    'กล้องต้องใช้ HTTPS',
    'มือถือ/เครื่องอื่นเปิดผ่าน <code>' + location.origin + '</code> จึงยังใช้กล้องไม่ได้ กรุณาเปิดลิงก์ <code>https://...trycloudflare.com</code> จากหน้าต่าง Cloudflare Tunnel แทน หรือใช้ <code>http://localhost:3001</code> บนคอมเครื่องที่รันระบบ'
  );
}
toggleCamera = async function(){
  if(scanActive){
    await stopCamera();
    return;
  }
  if(!isCameraSecureContext()) {
    initCameraState();
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraNotice('เปิดกล้องไม่ได้', getCameraErrorMessage({ name: 'NotFoundError' }));
    return;
  }
  try {
    hideCameraNotice();
    await startCamera();
  } catch(e) {
    await stopCamera();
    setCameraButtons('📷 กล้อง', false);
    showCameraNotice('เปิดกล้องไม่ได้', getCameraErrorMessage(e));
  }
};
async function restartCameraIfRunning(){
  if(!scanActive) return;
  await stopCamera();
  await startCamera();
}
async function setScanMode(mode){
  scanMode = mode;
  localStorage.setItem('spx_scan_mode', mode);
  updateScanModeButtons();
  await restartCameraIfRunning();
}
async function selectCamera(id){
  activeCameraId = id;
  localStorage.setItem('spx_camera_id', id);
  renderCameraSelect();
  await restartCameraIfRunning();
}
async function switchCamera(){
  if(!cameraDevices.length) await loadCameras();
  if(!cameraDevices.length) return;
  var idx = cameraDevices.findIndex(function(c){ return c.id === activeCameraId; });
  var next = cameraDevices[(idx + 1) % cameraDevices.length] || cameraDevices[0];
  await selectCamera(next.id);
}
async function toggleTorch(){
  if(!html5QrCode || !scanActive) return;
  try {
    torchOn = !torchOn;
    await html5QrCode.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
    document.getElementById('torchBtn').textContent = torchOn ? '💡 ปิดไฟ' : '🔦 ไฟ';
  } catch(e) {
    showCameraNotice('ไฟฉายใช้ไม่ได้', 'มือถือหรือ browser นี้ไม่รองรับการเปิดไฟฉายจากหน้าเว็บ');
  }
}

// ── Urgent Recall Camera Handler ─────────────────────────────────────────────
var recallQrCode = null;
var recallCameraActive = false;

async function stopRecallCamera(){
  if(recallQrCode && recallCameraActive){
    try { await recallQrCode.stop(); } catch(e){}
  }
  if(recallQrCode){
    try { recallQrCode.clear(); } catch(e){}
  }
  recallQrCode = null;
  recallCameraActive = false;
  var rdr = document.getElementById('recallReader');
  if(rdr) rdr.style.display = 'none';
  var btn = document.getElementById('recallCamBtn');
  if(btn){
    btn.innerHTML = '📷 สแกนด้วยกล้อง';
    btn.style.background = '#2563eb';
  }
}

async function toggleRecallCamera(){
  if(recallCameraActive){
    await stopRecallCamera();
    return;
  }
  var btn = document.getElementById('recallCamBtn');
  if(btn) btn.innerHTML = '⏳ กำลังเปิดกล้อง...';
  try{
    await waitForCameraLib();
    var rdr = document.getElementById('recallReader');
    if(rdr) rdr.style.display = 'block';
    recallQrCode = new Html5Qrcode('recallReader', { formatsToSupport: getFormatsForMode('barcode'), verbose: false });
    var cfg = { fps: 10, qrbox: { width: 250, height: 180 }, aspectRatio: 1.333333 };
    await recallQrCode.start(
      { facingMode: { ideal: 'environment' } },
      cfg,
      function(txt){
        var code = String(txt || '').trim().toUpperCase();
        if(!code) return;
        var inp = document.getElementById('recallVerifyInput');
        if(inp) inp.value = code;
        stopRecallCamera();
        verifyRecallBox(code);
      },
      function(){}
    );
    recallCameraActive = true;
    if(btn){
      btn.innerHTML = '❌ ปิดกล้อง';
      btn.style.background = '#64748b';
    }
  }catch(e){
    console.error('Recall camera start error:', e);
    if(btn){
      btn.innerHTML = '📷 สแกนด้วยกล้อง';
      btn.style.background = '#2563eb';
    }
    var errEl = document.getElementById('recallVerifyError');
    if(errEl) errEl.textContent = '❌ เปิดกล้องไม่สำเร็จ: ' + (e.message || e);
  }
}

var evtSource = new EventSource('/api/stream');
evtSource.onmessage = function(e){
  if(e.data === 'update' && currentRoundId) {
    fetch('/get-stats?roundId='+currentRoundId).then(function(r){return r.json();}).then(function(s){
      updateStats(s.total,s.done);
      scannedSet=new Set(s.scanned||[]);
      loadManifest(currentRoundId);
      loadRoundList();
    });
  }
};
evtSource.addEventListener('recall-alert', function(e){
  try {
    var data = JSON.parse(e.data);
    // If targeted to this round or global
    if (!data.roundId || !currentRoundId || data.roundId === currentRoundId) {
      triggerUrgentRecallModal(data);
    }
  } catch(err){}
});
evtSource.addEventListener('recall-confirmed', function(e){
  try {
    var data = JSON.parse(e.data);
    onRecallConfirmed(data);
  } catch(err){}
});
// Function 1: SSE listener for round-reopened (Smart Batch Versioning)
evtSource.addEventListener('round-reopened', function(e){
  try {
    var data = JSON.parse(e.data);
    // Only react if this event affects the current round
    if (!data.roundId || data.roundId === currentRoundId) {
      // Reload manifest to reflect new items and unlock scan
      loadManifest(currentRoundId);
      loadRoundList();
      // Play voice + banner
      var addedCount = data.addedCount || 0;
      var roundName = data.roundName || 'กลุ่มขนส่ง';
      showBanner('📢 มีงานเพิ่มเข้า ' + addedCount + ' รายการ! (' + roundName + ') — ปลดล็อกให้ยิงต่อแล้ว', 'ok');
      speakVoice('มีงานเพิ่มเข้ามา ' + addedCount + ' รายการ กรุณายิงสแกนต่อด้วยค่ะ');
      // Vibration feedback
      if (navigator.vibrate) navigator.vibrate([100, 80, 100, 80, 300]);
    }
  } catch(err){}
});


function checkPendingRecalls(roundId) {
  if (!roundId) return;
  fetch('/api/blacklist/pending-recalls?roundId=' + encodeURIComponent(roundId))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.ok && d.pendingRecalls && d.pendingRecalls.length > 0) {
        triggerUrgentRecallModal(d.pendingRecalls[0]);
      }
    })
    .catch(function(){});
}

// Enter key on recall verification input (double-safe: direct attach + DOMContentLoaded fallback)
(function attachRecallVerifyListener() {
  function bindRecallVerifyKey() {
    var vi = document.getElementById('recallVerifyInput');
    if (vi && !vi._recallKeyBound) {
      vi._recallKeyBound = true;
      vi.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          var c = vi.value.trim().toUpperCase();
          vi.value = '';
          verifyRecallBox(c);
        }
      });
    }
  }
  // Try immediately (DOM already rendered in inline script context)
  bindRecallVerifyKey();
  // Also bind on DOMContentLoaded in case element isn't ready yet
  document.addEventListener('DOMContentLoaded', bindRecallVerifyKey);
})();

// ── Init ──────────────────────────────────────────────────────────────────────
fetch('/api/settings').then(function(r){return r.json();}).then(function(d){
  if(d.ok && d.settings) {
    voiceEnabled = d.settings.voiceEnabled !== false;
  }
});

initCameraState();

fetch('/get-stats').then(function(r){return r.json();}).then(function(d){
  loadRoundList();
  if(d.total>0 || d.roundId){
    currentRoundId=d.roundId||'';
    showUI(d.total||0, d.done||0);
    scannedSet=new Set(d.scanned||[]);
    loadManifest(currentRoundId);
    if(d.todayCount !== undefined) {
      var tb = document.getElementById('todayScansBadge');
      if (tb) { tb.textContent = '🔥 วันนี้ ' + d.todayCount + ' ชิ้น'; tb.style.display = 'inline-block'; tb.classList.remove('hidden'); }
    }
    reportPresence();
  } else {
    // If no active round from get-stats, fetch history to check if rounds exist
    fetch('/api/history').then(function(hr){return hr.json();}).then(function(hd){
      if(hd.ok && hd.history && hd.history.length > 0){
        var firstRound = hd.history[0];
        currentRoundId = firstRound.id;
        showUI(firstRound.total||0, firstRound.done||0);
        loadManifest(firstRound.id);
      } else {
        // Truly no rounds at all
        document.getElementById('noManifest').classList.remove('hidden');
        var rs = document.getElementById('roundSelector');
        if(rs) rs.classList.remove('hidden');
      }
    }).catch(function(){
      document.getElementById('noManifest').classList.remove('hidden');
      var rs = document.getElementById('roundSelector');
      if(rs) rs.classList.remove('hidden');
    });
  }
});
</script>
<script src="https://unpkg.com/html5-qrcode"></script>
<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
</body></html>`);
});

// ══════════════════════════════════════════════════════════════════════════════
// PAGE: ADMIN — ไม่มีรหัส ต้องเลือกชื่อก่อน
// ══════════════════════════════════════════════════════════════════════════════
app.get('/admin', (_req, res) => {
  const employees = ["หนุ่ย", "หยก", "ซิน", "ภู", "ปอ"];
  const avatars   = ["🧑‍💼", "👩‍💼", "🧑‍🔧", "👨‍💼", "👩‍🔧"];
  const pEmps     = JSON.stringify(employees);
  const pAvatars  = JSON.stringify(avatars);

  const css = `
<style>
body{display:flex;flex-direction:column;min-height:100vh}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:.7rem 1.1rem;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.app-title{font-weight:800;font-size:1rem;display:flex;align-items:center;gap:.5rem}
.round-badge{font-size:.78rem;color:var(--muted);font-weight:400}
.user-chip{background:var(--surface2);border:1px solid var(--border);border-radius:9999px;padding:.25rem .8rem;font-size:.8rem;font-weight:600;display:flex;align-items:center;gap:.3rem}
.tab-bar{background:var(--surface);border-bottom:1px solid var(--border);padding:.5rem .85rem;display:flex;gap:.3rem;overflow-x:auto;position:sticky;top:52px;z-index:9}
.tab{padding:.5rem .95rem;border-radius:.6rem;font-size:.82rem;font-weight:600;cursor:pointer;color:var(--muted);border:none;background:transparent;white-space:nowrap;transition:.15s}
.tab:hover{color:var(--text);background:var(--surface2)}
.tab.active{background:var(--blue);color:#fff}
.pane{display:none;padding:1.1rem;max-width:960px;margin:0 auto;width:100%}
.pane.active{display:block}
.sec-title{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:.8rem;display:flex;align-items:center;gap:.35rem}
.drop-zone{border:2px dashed var(--border);border-radius:1rem;padding:2.25rem 1.5rem;text-align:center;cursor:pointer;transition:.2s;margin-bottom:1rem}
.drop-zone:hover,.drop-zone.drag{border-color:var(--blue);background:rgba(59,130,246,.06)}
.drop-zone input{display:none}
.dz-icon{font-size:2.4rem;margin-bottom:.4rem}
.dz-hint{color:var(--muted);font-size:.875rem}
.file-list{margin-top:.6rem;display:flex;flex-wrap:wrap;gap:.4rem;justify-content:center}
.file-chip{background:var(--surface2);border:1px solid var(--blue);border-radius:9999px;padding:.2rem .65rem;font-size:.73rem;color:var(--blue2);font-family:monospace}
.tbl-wrap{overflow-x:auto;border-radius:.75rem;border:1px solid var(--border);max-height:360px;overflow-y:auto}
.edit-input{background:var(--surface2);border:1px solid var(--border);border-radius:.4rem;color:var(--text);padding:.28rem .5rem;font-size:.76rem;font-family:monospace;outline:none}
.edit-input:focus{border-color:var(--blue)}
.round-card{background:var(--surface2);border:1px solid var(--border);border-radius:1rem;padding:.95rem 1.05rem;margin-bottom:.7rem;transition:.15s}
.round-card:hover{border-color:var(--blue)}
.round-meta{font-size:.74rem;color:var(--muted);margin-bottom:.55rem}
.miss-list{font-size:.72rem;font-family:monospace;background:var(--bg);border-radius:.5rem;padding:.55rem;max-height:120px;overflow-y:auto;margin-top:.55rem;display:none;border:1px solid var(--border)}
.miss-list.open{display:block}
.round-actions{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.55rem}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:.7rem;margin-bottom:1rem}
.kpi-card{background:var(--surface2);border:1px solid var(--border);border-radius:1rem;padding:1.05rem;text-align:center}
.kav{font-size:2rem;margin-bottom:.25rem}
.kname{font-size:.95rem;font-weight:700;margin-bottom:.4rem}
.ktotal{font-size:1.7rem;font-weight:900;color:var(--blue);margin:.15rem 0}
.krow{display:flex;justify-content:space-between;font-size:.75rem;padding:.18rem 0;border-bottom:1px solid rgba(128,128,128,.08)}
.krow:last-child{border:none}
.sum-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:.6rem}
.sum-card{background:var(--surface2);border:1px solid var(--border);border-radius:.875rem;padding:.85rem;text-align:center}
.slbl{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
.sval{font-size:1.35rem;font-weight:900}
.log-line{font-size:.76rem;font-family:monospace;min-height:1.1em;margin-top:.45rem;padding:.35rem .6rem;border-radius:.4rem;background:var(--surface2);color:var(--muted)}
.alog-row{display:grid;grid-template-columns:2rem 1fr 1fr;gap:.5rem;padding:.4rem .6rem;border-bottom:1px solid rgba(128,128,128,.06);font-size:.78rem;align-items:center}
.alog-row:nth-child(even){background:rgba(128,128,128,.04)}
.alog-head{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;display:grid;grid-template-columns:2rem 1fr 1fr;gap:.5rem;padding:.4rem .6rem;border-bottom:2px solid var(--border)}
.date-row{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.85rem}
.date-row input[type=date]{width:auto;padding:.4rem .6rem;font-size:.82rem}
.export-bar{background:var(--surface2);border:1px solid var(--border);border-radius:.875rem;padding:.75rem 1rem;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.85rem}
/* Modal CSS moved to sharedHead */

/* ── Mobile Hamburger ───────────────────────── */
.hamburger-btn{display:none;background:none;border:1px solid var(--border);border-radius:.5rem;color:var(--text);font-size:1.3rem;cursor:pointer;padding:.3rem .5rem;line-height:1}

/* ── Mobile Responsive ──────────────────────── */
@media(max-width:768px){
  .hamburger-btn{display:flex;align-items:center;justify-content:center}
  .topbar{padding:.5rem .7rem;gap:.3rem}
  .app-title{font-size:.85rem}
  .round-badge{display:none}
  .topbar .flex.gap-sm{gap:.25rem}
  .topbar .btn-gray.btn-sm{font-size:.7rem;padding:.25rem .5rem}
  .user-chip{padding:.2rem .55rem;font-size:.7rem}
  .tab-bar{padding:.4rem .55rem;gap:.2rem;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .tab-bar::-webkit-scrollbar{display:none}
  .tab{padding:.45rem .65rem;font-size:.72rem;border-radius:.5rem}
  .pane{padding:.65rem}
  .card{padding:.85rem;border-radius:1rem}
  .btn{padding:.55rem .85rem;font-size:.8rem;border-radius:.6rem}
  .btn-sm{padding:.35rem .6rem;font-size:.7rem}
  .btn-full{padding:.65rem!important}
  .drop-zone{padding:1.5rem 1rem}
  .dz-icon{font-size:1.8rem}
  .dz-hint{font-size:.78rem}
  .tbl-wrap{max-height:280px;border-radius:.6rem}
  table{font-size:.72rem}
  th{padding:.4rem .45rem;font-size:.6rem}
  td{padding:.35rem .45rem}
  .round-card{padding:.7rem .8rem;border-radius:.85rem}
  .kpi-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.5rem}
  .kpi-card{padding:.75rem;border-radius:.85rem}
  .sum-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:.4rem}
  .sum-card{padding:.65rem;border-radius:.65rem}
  .modal{max-width:95vw;padding:1rem;border-radius:1rem}
  .modal-title{font-size:.9rem}
  #confirmLayout{grid-template-columns:1fr!important}
  .date-row{gap:.4rem}
  .date-row input[type=date]{font-size:.75rem;padding:.3rem .4rem}
  .sec-title{font-size:.62rem;margin-bottom:.6rem}
  input,select{padding:.5rem .7rem;font-size:.82rem}
  .export-bar{padding:.6rem .75rem;gap:.4rem}
  .folder-summary{padding:.5rem .6rem;font-size:.8rem}
  .folder-content{padding:.4rem .5rem}
}
@media(max-width:480px){
  .tab{padding:.4rem .5rem;font-size:.65rem}
  .pane{padding:.45rem}
  .card{padding:.7rem}
  .kpi-grid{grid-template-columns:1fr 1fr}
  .sum-grid{grid-template-columns:1fr 1fr}
  .round-card{margin-bottom:.5rem}
}
</style>`;

  const body = `
<div class="topbar">
  <div class="app-title">📦 SPX Admin Panel <span class="round-badge" id="curRoundBadge"></span></div>
  <div class="flex gap-sm" style="align-items:center">
    <button class="btn btn-gray btn-sm" id="bellBtn" onclick="openBellCenter()" style="position:relative;font-size:1.15rem;padding:.3rem .6rem;line-height:1" title="การแจ้งเตือน & ขอ PIN (รหัส 15806)">
      🔔<span id="bellBadge" style="display:none;position:absolute;top:-5px;right:-5px;background:var(--red);color:#fff;border-radius:9999px;font-size:.65rem;font-weight:900;padding:.1rem .35rem;border:2px solid var(--surface)">0</span>
    </button>
    <div class="user-chip" id="adminUserChip">👤 <span id="adminUserName">-</span></div>
    <button class="theme-btn" id="themeBtn" onclick="toggleTheme()">☀️</button>
    <a href="/" class="btn btn-gray btn-sm">← หน้าพนักงาน</a>
  </div>
</div>
<div class="tab-bar" id="tabBar">
  <button class="tab active" data-tab="upload">📤 อัปโหลด & กลุ่มขนส่ง</button>
  <button class="tab" data-tab="edit">✏️ แก้ไขรายการ</button>
  <button class="tab" data-tab="recall">🚨 Recall Hub</button>
  <button class="tab" data-tab="kpi">📊 KPI</button>
  <button class="tab" data-tab="export">📥 Export</button>
  <button class="tab" data-tab="confirm">🖨️ ใบยืนยัน</button>
  <button class="tab" data-tab="accesslog">🔍 ผู้ใช้งาน</button>
  <button class="tab" data-tab="settings">⚙️ ตั้งค่าระบบ</button>
</div>

<div class="pane active" id="pane-upload">
<!-- Bar ด้านบน: ปุ่มดาวน์โหลดไฟล์ตัวอย่าง Template -->
  <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:.85rem;padding:.75rem 1rem;margin-bottom:1rem;flex-wrap:wrap;gap:.6rem">
    <div>
      <div style="font-weight:700;font-size:.88rem">📄 ไฟล์ตัวอย่างใบส่งมอบ & ใบปะหน้าที่ระบบรองรับ</div>
      <div style="font-size:.73rem;color:var(--muted)">ดาวน์โหลดตัวอย่างไฟล์ PDF เพื่อทดสอบหรือใช้จัดเตรียมเอกสารก่อนนำเข้า</div>
    </div>
    <button class="btn btn-gray btn-sm" onclick="showTemplateModal()" style="font-weight:600;display:flex;align-items:center;gap:.35rem">
      📥 โหลด Template ที่รองรับ
    </button>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:1rem;margin-bottom:1.25rem">
    <!-- กล่องที่ 1: อัปโหลดใบส่งมอบเดิม -->
    <div class="card" style="display:flex;flex-direction:column;justify-content:space-between">
      <div>
        <div class="sec-title">📤 1. อัปโหลดใบส่งมอบ (เดิม)</div>
        <div class="drop-zone" id="dropZone">
          <input type="file" id="fileInput" accept=".pdf" multiple>
          <div class="dz-icon">📁</div>
          <div class="dz-hint">คลิกหรือลากไฟล์ PDF ใบส่งมอบเดิม</div>
          <div class="file-list" id="fileList"></div>
        </div>
        <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:.75rem">
          <label style="display:flex;align-items:center;gap:.4rem;font-size:.82rem;color:var(--muted);cursor:pointer">
            <input type="checkbox" id="mergeCheck" style="width:auto"> รวมเป็นกลุ่มเดียว
          </label>
        </div>
      </div>
      <div>
        <button class="btn btn-blue btn-full" id="upBtn" disabled>⬆️ ดึงข้อมูลจาก PDF ใบส่งมอบ</button>
        <div class="log-line" id="upLog">รอการอัปโหลด…</div>
      </div>
    </div>

    <!-- กล่องที่ 2: อัปโหลดใบปะหน้าหลายขนส่ง (ใหม่) -->
    <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;border:1px solid rgba(59,130,246,0.3)">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem">
          <div class="sec-title" style="margin:0;color:var(--blue2)">🏷️ 2. อัปโหลดใบปะหน้า (รองรับหลายขนส่ง)</div>
          <span class="badge bg-blue" style="font-size:.65rem">ใหม่</span>
        </div>
        <div style="font-size:.72rem;color:var(--muted);margin-bottom:.6rem">
          รองรับ SPX, Flash, TikTok, Lazada, SPX ส่งด่วน (อ่านทุกหน้า, แยกเจ้า และสรุปยอดก่อนนำเข้า)
        </div>

        <!-- ตัวเลือกวิธีอ่าน: ข้อความ vs QR/Barcode -->
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:.6rem;padding:.5rem .75rem;margin-bottom:.75rem">
          <div style="font-size:.7rem;font-weight:700;color:var(--muted);margin-bottom:.35rem">⚡ รูปแบบการอ่านข้อมูล:</div>
          <div style="display:flex;flex-direction:column;gap:.35rem;font-size:.78rem">
            <label style="display:flex;align-items:center;gap:.45rem;cursor:pointer">
              <input type="radio" name="labelParseMode" value="text" checked onchange="onLabelModeChange(this.value)">
              <span><b>🔍 ค้นหาด้วยข้อความ</b> <span style="color:var(--green);font-size:.7rem">(เร็ว เบา ไม่ล่มบน Render — แนะนำ)</span></span>
            </label>
            <label style="display:flex;align-items:center;gap:.45rem;cursor:pointer">
              <input type="radio" name="labelParseMode" value="barcode" onchange="onLabelModeChange(this.value)">
              <span><b>📷 สแกน QR / Barcode</b> <span style="color:var(--yellow);font-size:.7rem">(สำหรับเอกสารที่เป็นภาพสแกนล้วน)</span></span>
            </label>
          </div>
          <div id="barcodeWarnNotice" style="display:none;margin-top:.4rem;padding:.4rem .6rem;background:rgba(234,179,8,.1);border:1px solid rgba(234,179,8,.3);border-radius:.4rem;font-size:.7rem;color:var(--yellow)">
            ⚠️ <b>ข้อจำกัดบน Render:</b> จำกัดประมวลผลไม่เกิน 20 หน้า เพื่อป้องกันหน่วยความจำ (RAM 512MB) เต็มแล้วเซิร์ฟเวอร์ตัดการทำงาน
          </div>
        </div>

        <div class="drop-zone" id="labelDropZone" style="border-color:rgba(59,130,246,0.4)" onclick="document.getElementById('labelFileInput').click()">
          <input type="file" id="labelFileInput" accept=".pdf" multiple>
          <div class="dz-icon">🏷️</div>
          <div class="dz-hint">คลิกหรือลากไฟล์ PDF ใบปะหน้าพัสดุ (เลือกได้หลายไฟล์)</div>
          <div class="file-list" id="labelFileList"></div>
        </div>
      </div>
      <div>
        <button class="btn btn-blue btn-full" id="labelUpBtn" disabled style="background:#2563eb">🔍 วิเคราะห์และตรวจสอบใบปะหน้า</button>
        <div class="log-line" id="labelUpLog">รอเลือกไฟล์ใบปะหน้า…</div>
      </div>
    </div>
  </div>
  <div class="card" id="upResult" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.85rem">
      <div class="sec-title" style="margin:0">รายการที่ดึงได้ <span id="upCount" class="badge bg-blue">0</span></div>
      <div style="display:flex;gap:.4rem">
        <button class="btn btn-blue btn-sm" onclick="location.href='/scan'">📡 ไปหน้าแสกน</button>
        <button class="btn btn-gray btn-sm" onclick="document.getElementById('roundsSection').scrollIntoView({behavior:'smooth'})">📋 ดูกลุ่มขนส่ง</button>
      </div>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Tracking</th><th>Order</th><th>ที่มา</th></tr></thead><tbody id="upTable"></tbody></table></div>
  </div>
  <div id="roundsSection" style="margin-top:1.25rem">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.85rem">
        <div class="sec-title" style="margin:0">📋 จัดการกลุ่มขนส่งทั้งหมด</div>
        <div style="display:flex;gap:.4rem">
          <button class="btn btn-green btn-sm" onclick="showAddRoundModal()">➕ สร้างกลุ่มขนส่งใหม่</button>
          <button class="btn btn-gray btn-sm" onclick="loadRounds()">🔄</button>
        </div>
      </div>
      <div id="roundsList"><div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด…</div></div>
    </div>
  </div>

</div></div>

<div class="pane" id="pane-edit">
  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">✏️ เลือกกลุ่มขนส่งที่ต้องการแก้ไข</div>
    <div id="editRoundList" style="max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:.5rem;padding-right:.3rem">
      <div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด…</div>
    </div>
  </div>
  <div class="card" id="editCard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.85rem">
      <div class="sec-title" style="margin:0">รายการ <span id="editCount" class="badge bg-blue">0</span></div>
      <div style="display:flex;gap:.4rem">
        <button class="btn btn-green btn-sm" onclick="addItem()">+ เพิ่ม</button>
        <button class="btn btn-blue btn-sm" onclick="saveAll()">💾 บันทึก</button>
      </div>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Tracking</th><th>Order</th><th>สถานะ</th><th></th></tr></thead><tbody id="editTable"></tbody></table></div>
    <div class="log-line" id="editLog"></div>
  </div>
</div>

<div class="pane" id="pane-recall">
  <div class="card" style="margin-bottom:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;flex-wrap:wrap;gap:.5rem">
      <div class="sec-title" style="margin-bottom:0">🚨 ศูนย์จัดการออเดอร์ยกเลิก &amp; ดึงคืนพัสดุ (Recall &amp; Blacklist Hub)</div>
      <div style="display:flex;gap:.5rem">
        <button class="btn btn-red btn-sm" onclick="openCancelOrderModal()" style="display:inline-flex;align-items:center;gap:.35rem">
          ➕ บันทึกออเดอร์ยกเลิก / ระงับส่ง
        </button>
        <button class="btn btn-gray btn-sm" onclick="loadBlacklistHub()">🔄 รีเฟรช</button>
      </div>
    </div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:.8rem">
      บันทึกออเดอร์ที่ลูกค้ายกเลิก/แอดมินระงับ รองรับการวางทีละหลายสิบรายการพร้อมกัน ระบบจะตรวจจับย้อนหลัง หากพัสดุถูกยิงลงกองไปแล้ว จะส่งสัญญาณไซเรนสั่งพนักงานไปดึงกล่องคืนทันที!
    </div>

    <!-- Status Tabs -->
    <div style="display:flex;gap:.4rem;margin-bottom:.8rem;flex-wrap:wrap" id="recallFilterTabs">
      <button class="btn btn-sm btn-blue" id="tabAllRecalls" onclick="setRecallFilter('all')">ทั้งหมด (<span id="cntAllRecalls">0</span>)</button>
      <button class="btn btn-sm btn-gray" id="tabPendingRecalls" onclick="setRecallFilter('PENDING_RECALL')">🚨 ต้องดึงคืนด่วน (<span id="cntPendingRecalls">0</span>)</button>
      <button class="btn btn-sm btn-gray" id="tabPendingScans" onclick="setRecallFilter('PENDING_SCAN')">⏳ รอสกัดกั้น (<span id="cntPendingScans">0</span>)</button>
      <button class="btn btn-sm btn-gray" id="tabRecalled" onclick="setRecallFilter('RECALLED')">✅ ดึงคืนสำเร็จ (<span id="cntRecalled">0</span>)</button>
      <button class="btn btn-sm btn-gray" id="tabRestored" onclick="setRecallFilter('RESTORED')">↩️ กู้คืนแล้ว (<span id="cntRestored">0</span>)</button>
    </div>

    <!-- Table Container -->
    <div style="max-height:calc(100vh - 280px);overflow-y:auto;border:1px solid var(--border);border-radius:.8rem">
      <table class="m-table" style="font-size:.78rem">
        <thead>
          <tr>
            <th style="width:115px">สถานะ</th>
            <th>รหัสคำสั่งซื้อ / Tracking</th>
            <th>กองขนส่ง / รอบ</th>
            <th>สาเหตุ</th>
            <th>เวลาแจ้ง</th>
            <th>ผลการดึงคืน</th>
            <th style="text-align:center;width:110px">จัดการ</th>
          </tr>
        </thead>
        <tbody id="blacklistTableBody">
          <tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--muted)">กำลังโหลดข้อมูล...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="pane" id="pane-kpi">
  <div class="card" style="margin-bottom:1rem" id="carrierSummaryCard">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.85rem">
      <div class="sec-title" style="margin:0">📊 สรุปยอดขนส่งรายวัน (วันนี้) <span class="badge bg-green" style="font-size:0.75rem;vertical-align:middle;margin-left:8px">🟢 Live</span></div>
      <button class="btn btn-gray btn-sm" onclick="loadDashboard()">🔄</button>
    </div>
    <div id="carrierSummaryGrid" style="display:flex;flex-direction:column;gap:.5rem">
      <div style="text-align:center;padding:1rem;color:var(--muted)">กำลังโหลด…</div>
    </div>
  </div>
  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">📈 สถิติย้อนหลัง 7 วัน</div>
    <div style="position:relative;height:250px;width:100%">
      <canvas id="dashboardChart"></canvas>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:1rem">
    <div class="card">
      <div class="sec-title">🏆 กระดานผู้นำ (Leaderboard)</div>
      <div id="dashLeaderboard"></div>
    </div>
    <div class="card">
      <div class="sec-title">📦 สัดส่วนขนส่ง (ทั้งหมด)</div>
      <div style="position:relative;height:200px;width:100%">
        <canvas id="carrierChart"></canvas>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.85rem">
      <div class="sec-title" style="margin:0">📊 KPI พนักงาน</div>
      <button class="btn btn-gray btn-sm" onclick="loadKpi()">🔄</button>
    </div>
    <div class="date-row">
      <span style="font-size:.8rem;color:var(--muted)">ช่วงวันที่:</span>
      <input type="date" id="kpiFrom">
      <span style="font-size:.8rem;color:var(--muted)">ถึง</span>
      <input type="date" id="kpiTo">
      <button class="btn btn-blue btn-sm" onclick="loadKpi()">ดู</button>
      <button class="btn btn-gray btn-sm" onclick="clearKpiRange()">ทั้งหมด</button>
    </div>
    <div class="kpi-grid" id="kpiGrid"></div>
  </div>
  <div class="card"><div class="sec-title">🏆 สรุปทีม</div><div class="sum-grid" id="kpiSum"></div></div>
</div>

<div class="pane" id="pane-export">
  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">1. เลือกกลุ่มขนส่งที่ต้องการส่งออก</div>
    <div class="date-row" style="margin-bottom:.6rem">
      <span style="font-size:.8rem;color:var(--muted)">กรองวันที่:</span>
      <input type="date" id="expFrom" onchange="document.getElementById('exportPreviewArea').style.display='none'; selectExportRound('all')">
      <span style="font-size:.8rem;color:var(--muted)">ถึง</span>
      <input type="date" id="expTo" onchange="document.getElementById('exportPreviewArea').style.display='none'; selectExportRound('all')">
    </div>
    
    <div class="round-card" id="erc-export-all" style="margin-bottom:.8rem;cursor:pointer;padding:.75rem 1rem;transition:0.2s;border-color:var(--blue);box-shadow:0 0 0 2px rgba(59,130,246,0.3)" onclick="selectExportRound('all')">
      <div style="font-weight:700;font-size:1rem;display:flex;align-items:center;gap:.5rem">✅ ส่งออกทั้งหมดตามช่วงวันที่ด้านบน</div>
      <div style="font-size:.8rem;color:var(--muted);margin-top:.3rem">จะทำการดึงข้อมูลทุกกลุ่มขนส่งที่อยู่ในช่วงวันที่คุณกำหนดมารวมกัน (แนะนำ)</div>
    </div>
    
    <div style="font-size:.8rem;color:var(--muted);margin-bottom:.5rem;font-weight:700">หรือ เลือกเจาะจงเฉพาะบางกลุ่มขนส่ง:</div>
    <div id="exportRoundList" style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:.5rem;padding:.5rem;border:1px solid var(--border);border-radius:.5rem;background:rgba(0,0,0,0.02)">
      <div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด…</div>
    </div>
  </div>

  <div class="card" id="exportActionCard">
    <div class="sec-title">2. ดูตัวอย่างและดาวน์โหลด</div>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem">
      <button class="btn btn-blue" onclick="previewExport('items')">👀 Preview รายการพัสดุ</button>
      <button class="btn btn-green" onclick="previewExport('scanlog')">👀 Preview Log การยิง</button>
      <button class="btn btn-gray" onclick="previewExport('kpi')">👀 Preview KPI พนักงาน</button>
    </div>
    
    <div id="exportPreviewArea" style="display:none;border:1px solid var(--border);border-radius:.875rem;padding:.85rem;background:var(--surface2)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem;flex-wrap:wrap;gap:.5rem">
        <div style="font-weight:700;font-size:.9rem" id="epTitle">ตัวอย่างข้อมูล</div>
        <div style="font-size:.75rem;color:var(--muted)" id="epCount">แสดง 50 รายการแรก</div>
      </div>
      <div class="tbl-wrap" style="max-height:250px;margin-bottom:1rem">
        <table style="width:100%;font-size:.8rem;border-collapse:collapse;text-align:left">
          <thead style="background:var(--bg);position:sticky;top:0;z-index:1"><tr id="epThead"></tr></thead>
          <tbody id="epTbody"></tbody>
        </table>
      </div>
      <button class="btn btn-green" style="width:100%;font-size:1rem;padding:.75rem;font-weight:700;display:flex;justify-content:center;gap:.5rem;align-items:center" onclick="doDownloadExport()" id="epDownloadBtn">⬇️ ดาวน์โหลดไฟล์ Excel ทันที</button>
    </div>
    <div class="log-line" id="expLog" style="display:none;margin-top:.75rem"></div>
  </div>
</div>

<div class="pane" id="pane-accesslog">
  <div class="card">
    <div style="display:flex;justify-content:space-between;margin-bottom:.85rem">
      <div class="sec-title" style="margin:0">🔍 ประวัติการเข้าใช้งาน Admin</div>
      <button class="btn btn-gray btn-sm" onclick="loadAccessLog()">🔄</button>
    </div>
    <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.85rem" id="alogSummary"></div>
    <div class="tbl-wrap">
      <div class="alog-head"><span>#</span><span>ผู้ใช้งาน</span><span>เวลา</span></div>
      <div id="alogList" style="max-height:400px;overflow-y:auto"></div>
    </div>
  </div>
</div>

<div class="pane" id="pane-confirm">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;align-items:start" id="confirmLayout">

    <!-- LEFT: Round Selection -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.85rem;flex-wrap:wrap;gap:.5rem">
        <div class="sec-title" style="margin:0">📋 เลือกรอบที่ต้องการพิมพ์</div>
        <div style="display:flex;gap:.35rem">
          <button class="btn btn-gray btn-sm" onclick="selectAllConfirmRounds(true)">เลือกทั้งหมด</button>
          <button class="btn btn-gray btn-sm" onclick="selectAllConfirmRounds(false)">ยกเลิกทั้งหมด</button>
        </div>
      </div>
      
      <!-- Date & Time Filters -->
      <div style="display:flex;gap:.5rem;margin-bottom:.85rem;flex-wrap:wrap;align-items:center">
        <span style="font-size:.75rem;color:var(--muted)">กรองวันที่:</span>
        <input type="date" id="cfFilterDate" style="padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.8rem" onchange="renderConfirmRounds()">
        <span style="font-size:.75rem;color:var(--muted);margin-left:.5rem">เวลา:</span>
        <input type="time" id="cfFilterTimeFrom" style="padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.8rem" onchange="renderConfirmRounds()">
        <span style="font-size:.75rem;color:var(--muted)">ถึง</span>
        <input type="time" id="cfFilterTimeTo" style="padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:.8rem" onchange="renderConfirmRounds()">
        <button class="btn btn-gray btn-sm" onclick="clearConfirmFilters()" style="margin-left:auto">❌ ล้างกรอง</button>
      </div>

      <div id="confirmRoundList" style="max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:.5rem;padding-right:.3rem">
        <div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด…</div>
      </div>
    </div>

    <!-- RIGHT: Settings + Summary + Actions -->
    <div style="display:flex;flex-direction:column;gap:.8rem">

      <!-- Items Per Page Control -->
      <div class="card">
        <div class="sec-title" style="margin-bottom:.65rem">⚙️ ตั้งค่าการพิมพ์</div>
        
        <!-- Carrier Filter -->
        <div style="margin-bottom:1rem">
          <div style="font-size:.8rem;color:var(--muted);margin-bottom:.4rem">กรองขนส่ง (เลือกเฉพาะที่ต้องการพิมพ์):</div>
          <div id="cfCarrierFilters" style="display:flex;flex-wrap:wrap;gap:.5rem">
            <!-- Checkboxes injected by JS -->
          </div>
        </div>

        <div style="margin-bottom:.75rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem">
            <label style="font-size:.8rem;color:var(--muted)">จำนวน Order ต่อหน้า</label>
            <span id="ippDisplay" style="font-size:1.05rem;font-weight:900;color:var(--blue)">50</span>
          </div>
          <input type="range" id="ippSlider" min="10" max="100" step="2" value="50"
            style="width:100%;accent-color:var(--blue);cursor:pointer"
            oninput="onIppChange(this.value)">
          <div style="display:flex;justify-content:space-between;font-size:.65rem;color:var(--muted);margin-top:.2rem">
            <span>10</span><span>50 (แนะนำ)</span><span>100</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem">
          <label style="font-size:.8rem;color:var(--muted);white-space:nowrap">หรือพิมพ์ตัวเลข:</label>
          <input type="number" id="ippInput" value="50" min="10" max="200"
            style="width:80px;padding:.3rem .5rem;font-size:.875rem;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:.4rem"
            oninput="onIppChange(this.value, true)">
          <span style="font-size:.75rem;color:var(--muted)">order/หน้า</span>
        </div>
      </div>

      <!-- Live Summary Card -->
      <div class="card" id="confirmSummaryCard" style="display:none">
        <div class="sec-title" style="margin-bottom:.65rem">📊 สรุปที่เลือก</div>
        <div id="confirmSummaryBody"></div>
      </div>

      <!-- Validation Warnings -->
      <div id="confirmWarnings" style="display:none"></div>

      <!-- Action Buttons -->
      <div style="display:flex;flex-direction:column;gap:.5rem">
        <button class="btn btn-blue btn-full" id="previewConfirmBtn" onclick="openConfirmPreview()" disabled
          style="font-size:.9rem;padding:.75rem">
          👁️ Preview ก่อนพิมพ์
        </button>
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-green" id="printConfirmBtn" onclick="printDeliveryConfirm()" disabled
            style="flex:1;font-size:.875rem">
            🖨️ พิมพ์ใบยืนยัน
          </button>
          <button class="btn btn-gray" id="pdfConfirmBtn" onclick="exportDeliveryPDF()" disabled
            style="flex:1;font-size:.875rem">
            📄 Export PDF
          </button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ═══ DELIVERY CONFIRM PREVIEW MODAL ═══ -->
<div class="modal-bg" id="confirmPreviewModal" style="display:none" onclick="if(event.target===this)closeConfirmPreview()">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:1.25rem;
    width:min(92vw,860px);max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,.55);
    display:flex;flex-direction:column">
    <!-- Modal Header -->
    <div style="padding:1.1rem 1.4rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--surface);z-index:10">
      <div style="font-size:1rem;font-weight:800;display:flex;align-items:center;gap:.5rem">
        👁️ Preview ใบยืนยันการจัดส่ง
      </div>
      <button class="btn btn-gray btn-sm" onclick="closeConfirmPreview()">✕ ปิด</button>
    </div>
    <!-- Stats row -->
    <div id="previewStatsRow" style="padding:.85rem 1.4rem;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:.6rem"></div>
    <!-- Warnings -->
    <div id="previewWarningsRow" style="display:none;padding:.5rem 1.4rem;border-bottom:1px solid var(--border)"></div>
    <!-- Per-carrier preview -->
    <div id="previewCarrierContent" style="padding:1rem 1.4rem;display:flex;flex-direction:column;gap:1.25rem"></div>
    <!-- Footer actions -->
    <div style="padding:.9rem 1.4rem;border-top:1px solid var(--border);display:flex;gap:.6rem;position:sticky;bottom:0;background:var(--surface)">
      <button class="btn btn-green" style="flex:1" onclick="closeConfirmPreview();printDeliveryConfirm()">🖨️ พิมพ์เลย</button>
      <button class="btn btn-gray" style="flex:1" onclick="closeConfirmPreview();exportDeliveryPDF()">📄 Export PDF</button>
      <button class="btn btn-gray" onclick="closeConfirmPreview()">ยกเลิก</button>
    </div>
  </div>
</div>

<div class="pane" id="pane-settings">
  <div id="settingsLockScreen" style="display:none;flex-direction:column;align-items:center;justify-content:center;padding:3rem 1.5rem">
    <div class="card" style="max-width:320px;width:100%;text-align:center">
      <div style="font-size:3rem;margin-bottom:.5rem">🔒</div>
      <div class="sec-title" style="justify-content:center;margin-bottom:1.5rem;font-size:.85rem">ตั้งค่าระบบ</div>
      <div style="font-size:.75rem;color:var(--muted);margin-bottom:1rem">กรุณาใส่รหัสผ่านผู้ดูแลระบบเพื่อเข้าถึงการตั้งค่า</div>
      <input type="password" id="adminPasswordInput" placeholder="รหัสผ่าน..." style="margin-bottom:1rem;text-align:center;font-size:1rem;letter-spacing:2px">
      <button class="btn btn-blue btn-full" onclick="verifyAdminPassword()" id="adminLoginBtn">ปลดล็อก</button>
      <div id="adminLoginErr" style="color:var(--red);font-size:.75rem;margin-top:.8rem;display:none">รหัสผ่านไม่ถูกต้อง</div>
    </div>
  </div>
  <div id="settingsContentWrapper" style="display:none">
  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">💬 LINE Messaging API</div>
    <div class="form-group" style="margin-bottom:1rem">
      <div style="font-size:.8rem;color:var(--green);background:rgba(34,197,94,0.1);padding:.5rem;border-radius:.5rem;border:1px solid var(--green)">
        🔒 LINE Token และ Group ID ถูกย้ายไปตั้งค่าอย่างปลอดภัยในไฟล์ Environment (Secret) แล้ว
      </div>
    </div>
    <div class="form-group" style="margin-bottom:1rem">
      <label style="display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:.9rem;cursor:pointer">
        <input type="checkbox" id="setLineNotifyOnComplete" style="width:1.2rem;height:1.2rem;accent-color:var(--blue)"> 
        แจ้งเตือนเมื่อสแกนครบ 100%
      </label>
      <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem;padding-left:1.8rem">ส่งข้อความอัตโนมัติเมื่อรอบนั้นสแกนสำเร็จครบ 100%</div>
    </div>
    <div class="form-group" style="margin-bottom:1rem">
      <label class="form-label" style="font-weight:700">รูปแบบข้อความแจ้งเตือน 100%</label>
      <select id="setLineMessageStyle" style="width:100%;padding:.5rem;border-radius:.5rem;border:1px solid var(--border)">
        <option value="flex">รูปแบบการ์ดสวยงาม (Flex Message / รูปภาพ)</option>
        <option value="text">ข้อความธรรมดา (Text)</option>
      </select>
    </div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-green btn-sm" onclick="testLineNotify()">🔔 ทดสอบส่ง LINE</button>
      <button class="btn btn-blue btn-sm" onclick="triggerLineSummary()">📊 ส่งสรุปยอดวันนี้เข้า LINE ตอนนี้เลย</button>
    </div>
    <div class="log-line" id="lineTestLog" style="display:none;margin-top:.75rem"></div>
  </div>

  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">🛠️ ตั้งค่าระบบอื่นๆ</div>
    <div class="form-group" style="margin-bottom:1rem">
      <div style="font-size:.8rem;color:var(--green);background:rgba(34,197,94,0.1);padding:.5rem;border-radius:.5rem;border:1px solid var(--green)">
        🔒 รหัสผ่าน Admin (หลัก) ถูกย้ายไปตั้งค่าอย่างปลอดภัยในไฟล์ Environment (Secret) แล้ว
      </div>
    </div>

    <div class="form-group" style="margin-bottom:1rem">
      <label style="display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:.9rem;cursor:pointer">
        <input type="checkbox" id="setAutoCleanEn" style="width:1.2rem;height:1.2rem;accent-color:var(--blue)"> 
        เปิดใช้งานลบข้อมูลเก่าอัตโนมัติ (Auto-Clean)
      </label>
      <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem;padding-left:1.8rem">ประหยัดพื้นที่จัดเก็บ โดยลบข้อมูลรอบแสกนที่เก่ากว่าที่กำหนด</div>
    </div>
    
    <div class="form-group" style="margin-bottom:1rem;padding-left:1.8rem">
      <label class="form-label">ลบข้อมูลที่เก่ากว่า (วัน):</label>
      <div style="display:flex;align-items:center;gap:.5rem">
        <input type="number" id="setAutoCleanDays" min="1" max="365" style="width:80px">
        <button class="btn btn-red btn-sm" onclick="triggerAutoCleanNow()">🧹 ล้างข้อมูลเดี๋ยวนี้</button>
      </div>
    </div>

    <div class="form-group" style="margin-bottom:1rem">
      <label style="display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:.9rem;cursor:pointer">
        <input type="checkbox" id="setVoiceEn" style="width:1.2rem;height:1.2rem;accent-color:var(--blue)"> 
        เปิดใช้งานเสียงพูดภาษาไทยอัจฉริยะ (Voice Assistant)
      </label>
    </div>

    <div class="form-group" style="margin-bottom:1rem">
      <label style="display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:.9rem;cursor:pointer">
        <input type="checkbox" id="setThermalMode" style="width:1.2rem;height:1.2rem;accent-color:var(--blue)"> 
        เปิดใช้งานโหมดเครื่องพิมพ์ใบเสร็จ (Thermal Printer Mode)
      </label>
      <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem;padding-left:1.8rem">บีบขนาดหน้ากระดาษให้พอดีกับเครื่องพิมพ์สลิป/สติกเกอร์</div>
    </div>

    <div class="form-group" style="margin-bottom:1rem">
      <label style="display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:.9rem;cursor:pointer">
        <input type="checkbox" id="setValidateCarrierMismatch" style="width:1.2rem;height:1.2rem;accent-color:var(--blue)"> 
        🚨 ตรวจจับและแจ้งเตือนเมื่อยิงผิดขนส่ง (Carrier Mismatch Validator)
      </label>
      <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem;padding-left:1.8rem">แจ้งเตือนเสียงและหน้าจอแดงเมื่อยิงบาร์โค้ดของขนส่งอื่น (ยกเว้นพัสดุที่มีในรายการรอบปัจจุบัน จะยอมรับเสมอ)</div>
    </div>

    <!-- Carrier Rules Manager -->
    <div style="border-top:1px solid var(--border);padding-top:1rem;margin-top:.5rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <div>
          <div style="font-weight:700;font-size:.88rem">🏷️ คำนำหน้าบาร์โค้ดของขนส่ง (Carrier Prefixes)</div>
          <div style="font-size:.7rem;color:var(--muted)">กำหนด Prefix เพื่อตรวจจับขนส่ง คั่นด้วยจุลภาค (เช่น FXTH, FX)</div>
        </div>
        <button class="btn btn-gray btn-sm" type="button" onclick="addCarrierRuleRow()" style="font-size:.75rem">➕ เพิ่มขนส่ง</button>
      </div>
      <div id="carrierRulesContainer" style="display:flex;flex-direction:column;gap:.45rem;max-height:260px;overflow-y:auto;padding-right:.2rem"></div>
    </div>
  </div>



  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">💾 Backup & Restore ข้อมูล</div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:1rem">ดาวน์โหลดข้อมูลทั้งหมดเก็บไว้เพื่อความปลอดภัย หรือกู้คืนข้อมูลกลับมาเมื่อมีปัญหา</div>
    <div style="display:flex;gap:.5rem">
      <a href="/api/backup" download="delivery_backup.json" class="btn btn-blue btn-sm">⬇️ ดาวน์โหลด Backup</a>
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('restoreFile').click()">⬆️ อัปโหลด Restore</button>
      <input type="file" id="restoreFile" accept=".json" style="display:none" onchange="doRestore(this)">
    </div>
  </div>

  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">⏱️ ตั้งเวลาส่งสรุปอัตโนมัติ (Auto-Print)</div>
    <div class="form-group" style="margin-bottom:1rem">
      <label style="display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:.9rem;cursor:pointer">
        <input type="checkbox" id="setAutoPrintEn" style="width:1.2rem;height:1.2rem;accent-color:var(--blue)" onchange="document.getElementById('autoPrintConfigArea').style.opacity=this.checked?1:0.5"> 
        เปิดใช้งาน Auto-Print + LINE Notify
      </label>
      <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem;padding-left:1.8rem">เมื่อถึงเวลาที่กำหนด ระบบจะส่งสรุปยอดจัดส่งประจำวันเข้ากลุ่ม LINE ให้อัตโนมัติ</div>
    </div>
    
    <div id="autoPrintConfigArea" style="padding-left:1.8rem;transition:opacity .2s">
      <div class="form-group" style="margin-bottom:1rem">
        <label class="form-label" style="font-weight:700">⏰ เวลาที่จะส่งรายงาน</label>
        <input type="time" id="setPrintTime" style="max-width:150px">
        <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem">ระบบจะส่งรายงานเข้า LINE ทุกวันตามเวลานี้</div>
      </div>
      
      <div class="form-group" style="margin-bottom:1rem">
        <label class="form-label" style="font-weight:700">🚫 ซ่อนขนส่งต่อไปนี้จากรายงาน</label>
        <input type="text" id="setExcludeCarriers" placeholder="เช่น ด่วน, ส่งทันที, ด่วนคลัง">
        <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem">คั่นด้วยเครื่องหมายจุลภาค (,) — รอบที่ชื่อขึ้นต้นด้วยคำเหล่านี้จะไม่ถูกรวมเข้าในรายงาน</div>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">👥 จัดการผู้ดูแลระบบ (Multi-Admin)</div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:1rem">เพิ่ม/ลบ ผู้ใช้งานที่มีสิทธิ์เข้าถึงหน้า Admin</div>
    <div style="display:flex;gap:.5rem;margin-bottom:1rem;flex-wrap:wrap">
      <input type="text" id="newAdminName" placeholder="ชื่อผู้ใช้งาน..." style="flex:1;min-width:120px">
      <input type="password" id="newAdminPwd" placeholder="รหัสผ่าน..." style="flex:1;min-width:120px">
      <select id="newAdminRole" style="width:120px;padding:.5rem;border-radius:.5rem;border:1px solid var(--border)">
        <option value="admin">Admin</option>
        <option value="viewer">Viewer</option>
      </select>
      <button class="btn btn-blue btn-sm" onclick="addAdmin()">➕ เพิ่ม</button>
    </div>
    <div id="adminList" style="display:flex;flex-direction:column;gap:.4rem;max-height:200px;overflow-y:auto"></div>
  </div>

  <div class="card" style="margin-bottom:1rem">
    <div class="sec-title">🔗 Webhook (Integration)</div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:1rem">ส่งข้อมูลแบบ Real-time ไปยังระบบอื่น (เช่น Make, Zapier, ระบบของคุณเอง) เมื่อสแกนสำเร็จหรือจบรอบ</div>
    <div class="form-group" style="margin-bottom:1rem">
      <label class="form-label" style="font-weight:700">Webhook URL</label>
      <input type="text" id="setWebhookUrl" placeholder="https://..." style="width:100%">
    </div>
    <button class="btn btn-gray btn-sm" onclick="testWebhook()">🔔 ทดสอบ Webhook</button>
  </div>

  <div style="display:flex;gap:.6rem;flex-wrap:wrap">
    <button class="btn btn-blue" style="flex:1;font-size:.95rem;padding:.75rem" onclick="saveSettings()">💾 บันทึกการตั้งค่าทั้งหมด</button>
  </div>
    <div class="log-line" id="settingsLog" style="display:none;margin-top:.75rem"></div>
  </div> <!-- end settingsContentWrapper -->
</div>

<!-- Modal: ตรวจสอบสรุปใบปะหน้าก่อนนำเข้า -->
<div class="modal-bg" id="labelPreviewModal" style="display:none" onclick="if(event.target===this)closeLabelPreviewModal()">
  <div class="modal" style="max-width:760px;width:95vw;max-height:88vh;display:flex;flex-direction:column">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:.6rem">
      <div class="modal-title" style="margin:0">📊 ตรวจสอบผลการวิเคราะห์ใบปะหน้า</div>
      <button class="btn btn-gray btn-sm" onclick="closeLabelPreviewModal()">✕</button>
    </div>

    <div style="overflow-y:auto;flex:1;padding-right:.4rem">
      <!-- Summary stats bar -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:.6rem;margin-bottom:1rem">
        <div class="sum-card">
          <div class="slbl">ไฟล์ทั้งหมด</div>
          <div class="sval" id="lpFilesCount" style="color:var(--text)">0</div>
        </div>
        <div class="sum-card">
          <div class="slbl">จำนวนหน้า</div>
          <div class="sval" id="lpPagesCount" style="color:var(--text)">0</div>
        </div>
        <div class="sum-card">
          <div class="slbl">ออเดอร์ที่สมบูรณ์</div>
          <div class="sval" id="lpValidCount" style="color:var(--green)">0</div>
        </div>
        <div class="sum-card">
          <div class="slbl">อ่านไม่ได้ / ผิดพลาด</div>
          <div class="sval" id="lpUnrecCount" style="color:var(--red)">0</div>
        </div>
      </div>

      <!-- Carrier breakdowns -->
      <div style="font-size:.78rem;font-weight:700;margin-bottom:.4rem;color:var(--muted);text-transform:uppercase">
        📦 จำแนกตามขนส่ง (จะถูกแยกสร้างเป็น Round ละขนส่ง):
      </div>
      <div id="lpCarrierList" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem"></div>

      <!-- Warnings & Duplicates accordion/sections -->
      <div id="lpWarningsArea" style="margin-bottom:1rem"></div>

      <!-- Preview table of items -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem">
        <div style="font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase">📋 รายการที่จะนำเข้าระบบ (แก้ไข/ลบ/เพิ่มได้โดยตรง):</div>
        <button type="button" class="btn btn-green btn-sm" onclick="addCustomLabelItem()" style="padding:.2rem .6rem;font-size:.75rem">+ เพิ่มรายการเอง</button>
      </div>
      <div class="tbl-wrap" style="max-height:220px">
        <table>
          <thead>
            <tr><th style="width:35px">#</th><th style="width:160px">ขนส่ง</th><th>Order No.</th><th>Tracking</th><th style="width:130px">ไฟล์ / หน้า</th><th style="width:45px;text-align:center">ลบ</th></tr>
          </thead>
          <tbody id="lpPreviewTable"></tbody>
        </table>
      </div>
    </div>

    <div style="display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.25rem;border-top:1px solid var(--border);padding-top:.85rem">
      <button class="btn btn-gray" onclick="closeLabelPreviewModal()">ยกเลิก</button>
      <button class="btn btn-blue" id="btnConfirmLabelImport" onclick="doConfirmLabelImport()">✅ ยืนยันนำเข้าระบบ (<span id="lpConfirmCount">0</span> รายการ)</button>
    </div>
  </div>
</div>

<!-- Modal ดาวน์โหลด Template PDF -->
<div class="modal-bg" id="templateModal" style="display:none" onclick="if(event.target===this)closeTemplateModal()">
  <div class="modal" style="max-width:620px;width:95%">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.85rem;border-bottom:1px solid var(--border);padding-bottom:.6rem">
      <div class="modal-title" style="margin:0">📥 ดาวน์โหลด Template ที่ระบบรองรับ</div>
      <button class="btn btn-gray btn-sm" onclick="closeTemplateModal()" style="padding:.2rem .5rem">✕</button>
    </div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:.85rem">
      เลือกแท็บเพื่อดาวน์โหลดไฟล์ PDF ตัวอย่างของแต่ละประเภทเอกสารและแต่ละขนส่ง:
    </div>

    <!-- Toggle เลือกกลุ่ม Template -->
    <div style="display:flex;gap:.5rem;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:.5rem">
      <button id="btnTplManifest" class="btn btn-blue btn-sm" onclick="switchTemplateTab('manifest')" style="font-weight:700">
        📋 1. ใบส่งมอบขนส่ง (Manifest)
      </button>
      <button id="btnTplLabel" class="btn btn-gray btn-sm" onclick="switchTemplateTab('label')" style="font-weight:700">
        🏷️ 2. ใบปะหน้าพัสดุ (Shipping Labels)
      </button>
    </div>

    <!-- รายการกลุ่มที่ 1: ใบส่งมอบ (Manifest) -->
    <div id="tplManifestSection" style="display:flex;flex-direction:column;gap:.6rem;max-height:420px;overflow-y:auto;padding-right:.2rem">
      <!-- Feature 1: แนบใบปะหน้า เพื่อสร้างใบส่งมอบ A4 -->
      <div style="background:rgba(59,130,246,0.08);border:1.5px dashed var(--blue);border-radius:.85rem;padding:.85rem;text-align:center;margin-bottom:.4rem">
        <div style="font-weight:800;font-size:.88rem;color:var(--blue2);margin-bottom:.2rem">⚡ สร้างใบส่งมอบ (Manifest) จากไฟล์ใบปะหน้า</div>
        <div style="font-size:.72rem;color:var(--muted);margin-bottom:.6rem">แนบไฟล์ PDF ใบปะหน้า (Shopee, TikTok, Lazada, Flash, SPX) ระบบจะดึงเลขออเดอร์ทั้งหมดสร้างเป็นใบส่งมอบ A4 พร้อมพิมพ์ทันที</div>
        <input type="file" id="genManifestInput" accept=".pdf" style="display:none" onchange="generateManifestFromLabels(this)">
        <button class="btn btn-blue btn-sm" onclick="document.getElementById('genManifestInput').click()" id="btnGenManifest">
          📄 แนบไฟล์ใบปะหน้าเพื่อสร้างใบส่งมอบ
        </button>
      </div>
      <div style="font-size:.74rem;color:var(--blue2);font-weight:700;margin-bottom:.2rem">
        📌 รูปแบบใบส่งมอบขนส่ง (นำเข้าผ่านกล่องที่ 1 — อัปโหลดใบส่งมอบเดิม):
      </div>

      <!-- 1.1 SPX Express ใบส่งมอบ -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.65rem .85rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.85rem;color:#f97316">📦 ใบส่งมอบ SPX Express</div>
          <div style="font-size:.7rem;color:var(--muted)">ตาราง 2 คอลัมน์ (No., Order No., Tracking) รองรับทั้ง Shopee & TikTok</div>
        </div>
        <a href="/api/templates/download/ตัวอย่าง_ใบส่งมอบ_SPX_Express.pdf" download="ตัวอย่าง_ใบส่งมอบ_SPX_Express.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 1.2 Flash Express ใบส่งมอบ -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.65rem .85rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.85rem;color:#eab308">⚡ ใบส่งมอบ Flash Express</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบส่งมอบพัสดุมาตรฐานของ Flash Express ที่ออกจากระบบ Shopee/TikTok</div>
        </div>
        <a href="/api/templates/download/ตัวอย่าง_ใบส่งมอบ_Flash_Express.pdf" download="ตัวอย่าง_ใบส่งมอบ_Flash_Express.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 1.3 Flash Express Bulky ใบส่งมอบ -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.65rem .85rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.85rem;color:#ca8a04">📦 ใบส่งมอบ Flash Express Bulky</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบส่งมอบสำหรับสินค้าขนาดใหญ่ (Bulky) ของ Flash Express</div>
        </div>
        <a href="/api/templates/download/ตัวอย่าง_ใบส่งมอบ_Flash_Express_Bulky.pdf" download="ตัวอย่าง_ใบส่งมอบ_Flash_Express_Bulky.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>
    </div>

    <!-- รายการกลุ่มที่ 2: ใบปะหน้า (Labels) -->
    <div id="tplLabelSection" style="display:none;flex-direction:column;gap:.6rem;max-height:420px;overflow-y:auto;padding-right:.2rem">
      <!-- Feature 2: แนบใบส่งมอบ เพื่อสร้างใบปะหน้าพัสดุพร้อมบาร์โค้ด -->
      <div style="background:rgba(249,115,22,0.08);border:1.5px dashed #f97316;border-radius:.85rem;padding:.85rem;text-align:center;margin-bottom:.4rem">
        <div style="font-weight:800;font-size:.88rem;color:#f97316;margin-bottom:.2rem">⚡ สร้างใบปะหน้าพัสดุ (Labels) จากไฟล์ใบส่งมอบ</div>
        <div style="font-size:.72rem;color:var(--muted);margin-bottom:.6rem">แนบไฟล์ PDF ใบส่งมอบ (SPX, Flash, Bulky) ระบบจะสร้างใบปะหน้ามาตรฐานพร้อม Barcode Code128 สำหรับยิงสแกนได้จริง</div>
        <input type="file" id="genLabelInput" accept=".pdf" style="display:none" onchange="generateLabelsFromManifest(this)">
        <button class="btn btn-sm" style="background:#ea580c;color:#fff" onclick="document.getElementById('genLabelInput').click()" id="btnGenLabels">
          🏷️ แนบไฟล์ใบส่งมอบเพื่อสร้างใบปะหน้า
        </button>
      </div>
      <div style="font-size:.74rem;color:var(--blue2);font-weight:700;margin-bottom:.2rem">
        📌 รูปแบบใบปะหน้าพัสดุ (นำเข้าผ่านกล่องที่ 2 — อัปโหลดใบปะหน้าหลายขนส่ง):
      </div>

      <!-- 2.1 SPX Shopee -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.84rem;color:#f97316">📦 SPX Shopee (Standard)</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบปะหน้ามาตรฐาน มีทั้ง Order No. (26...) และ Tracking (TH2...)</div>
        </div>
        <a href="/api/templates/download/SPX_shopee.pdf" download="SPX_shopee.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 2.2 SPX ส่งด่วน (SHP Food / Instant) -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.84rem;color:#f97316">⚡ SPX ส่งด่วน (SHP Food)</div>
          <div style="font-size:.7rem;color:var(--muted)">มีเฉพาะเลขออเดอร์ (26...) และรหัสอ้างอิง ไม่มี Tracking</div>
        </div>
        <a href="/api/templates/download/SPX_no_tacking_ส่งด่วน.pdf" download="SPX_no_tacking_ส่งด่วน.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 2.3 SPX ด่วนคลัง -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.84rem;color:#f97316">🏢 SPX ด่วนคลัง (APWET)</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบปะหน้า SPX ด่วนคลัง มีเลขออเดอร์และ Tracking</div>
        </div>
        <a href="/api/templates/download/SPX_got_tacking_ด่วนคลัง.pdf" download="SPX_got_tacking_ด่วนคลัง.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 2.4 Flash Shopee -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.84rem;color:#eab308">⚡ Flash Express (Shopee)</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบปะหน้า Flash ขึ้นต้นด้วย TH3... พร้อมเลขออเดอร์</div>
        </div>
        <a href="/api/templates/download/FLASH_Shopee.pdf" download="FLASH_Shopee.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 2.5 Flash TikTok -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.84rem;color:#db2777">🎵 Flash Express (TikTok Shop)</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบปะหน้า TikTok รหัส THT... พร้อม Order ID 18 หลัก</div>
        </div>
        <a href="/api/templates/download/FLASH_Tiktok.pdf" download="FLASH_Tiktok.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>

      <!-- 2.6 Lazada (LEX) -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border:1px solid var(--border);border-radius:.6rem">
        <div>
          <div style="font-weight:700;font-size:.84rem;color:#0284c7">🛍️ Lazada Express (LEX)</div>
          <div style="font-size:.7rem;color:var(--muted)">ใบปะหน้า Lazada รหัส LEX... พร้อม Order No. 16 หลัก</div>
        </div>
        <a href="/api/templates/download/lazada.pdf" download="lazada.pdf" class="btn btn-blue btn-sm">⬇️ โหลด</a>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;margin-top:1rem;border-top:1px solid var(--border);padding-top:.75rem">
      <button class="btn btn-gray btn-sm" onclick="closeTemplateModal()">ปิดหน้าต่าง</button>
    </div>
  </div>
</div>



<div class="modal-bg" id="addRoundModal" style="display:none" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-title">➕ สร้างรอบใหม่</div>
    <div style="margin-bottom:1rem;display:grid;grid-template-columns:1fr 1fr;gap:.5rem">
      <button class="btn btn-gray btn-sm" onclick="doAddRoundPreset('SPX')" style="font-weight:700;color:#f97316;border-color:#fdba74">⚡ SPX</button>
      <button class="btn btn-gray btn-sm" onclick="doAddRoundPreset('Flash')" style="font-weight:700;color:#ca8a04;border-color:#fde047">⚡ Flash</button>
      <button class="btn btn-gray btn-sm" onclick="doAddRoundPreset('Flash Tiktok')" style="font-weight:700;color:#000;border-color:#a8a29e">⚡ Flash Tiktok</button>
      <button class="btn btn-gray btn-sm" onclick="doAddRoundPreset('Flash สั่งจ่าย')" style="font-weight:700;color:#ca8a04;border-color:#fde047">⚡ Flash สั่งจ่าย</button>
      <button class="btn btn-gray btn-sm" onclick="doAddRoundPreset('ส่งทันที')" style="font-weight:700;color:#2563eb;border-color:#93c5fd">🚀 ส่งทันที</button>
      <button class="btn btn-gray btn-sm" onclick="doAddRoundPreset('ด่วน')" style="font-weight:700;color:#dc2626;border-color:#fca5a5">🔥 ด่วน</button>
    </div>
    <div style="text-align:center;font-size:.7rem;color:var(--muted);margin-bottom:.5rem">— หรือพิมพ์ชื่อรอบเอง —</div>
    <div class="form-group">
      <label class="form-label">ชื่อรอบ</label>
      <input id="newRoundName" placeholder="เช่น รอบเช้า 15/01/2568" style="width:100%">
    </div>
    <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem">
      <button class="btn btn-gray btn-sm" onclick="closeModal()">ยกเลิก</button>
      <button class="btn btn-blue btn-sm" onclick="doAddRound()">✅ สร้าง</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="renameModal" style="display:none" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-title">✏️ เปลี่ยนชื่อรอบ</div>
    <div class="form-group">
      <label class="form-label">ชื่อใหม่</label>
      <input id="renameInput" placeholder="ชื่อรอบ" style="width:100%">
      <input type="hidden" id="renameRoundId">
    </div>
    <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem">
      <button class="btn btn-gray btn-sm" onclick="closeModal()">ยกเลิก</button>
      <button class="btn btn-blue btn-sm" onclick="doRenameRound()">💾 บันทึก</button>
    </div>
  </div>
</div>

<!-- Bell Passcode Modal (15806) -->
<div class="modal-bg" id="bellPasscodeModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="max-width:340px;text-align:center">
    <div style="font-size:2.4rem;margin-bottom:.4rem">🔔</div>
    <div class="modal-title" style="margin-bottom:.4rem">กระดิ่งแจ้งเตือน Admin</div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:1rem">กรุณากรอกรหัสผ่านเพื่อเข้าดูกระดิ่ง</div>
    <input type="password" id="bellPasscodeInput" placeholder="รหัสผ่าน..." style="text-align:center;font-size:1.2rem;letter-spacing:4px;margin-bottom:.8rem" onkeypress="if(event.key==='Enter')submitBellPasscode()">
    <div id="bellPasscodeErr" style="color:var(--red);font-size:.75rem;margin-bottom:.6rem;display:none">รหัสไม่ถูกต้อง</div>
    <div style="display:flex;gap:.5rem">
      <button class="btn btn-gray btn-sm" style="flex:1" onclick="document.getElementById('bellPasscodeModal').style.display='none'">ยกเลิก</button>
      <button class="btn btn-blue btn-sm" style="flex:1" onclick="submitBellPasscode()">เข้าใช้งาน</button>
    </div>
  </div>
</div>

<!-- Bell Notifications Center Modal -->
<div class="modal-bg" id="bellCenterModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="max-width:680px;width:95vw;max-height:85vh;display:flex;flex-direction:column;padding:1.2rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem;border-bottom:1px solid var(--border);padding-bottom:.6rem">
      <div style="font-weight:800;font-size:1.05rem;display:flex;align-items:center;gap:.4rem">
        🔔 ศูนย์แจ้งเตือน & ยืนยันจุดวางพัสดุ
      </div>
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('bellCenterModal').style.display='none'">✕</button>
    </div>
    
    <div style="display:flex;gap:.4rem;margin-bottom:1rem;flex-wrap:wrap">
      <button class="btn btn-blue btn-sm" id="bellTabPins" onclick="switchBellTab('pins')">🔑 คำขอ PIN (<span id="bellPinCount">0</span>)</button>
      <button class="btn btn-gray btn-sm" id="bellTabProofs" onclick="switchBellTab('proofs')">📸 รูปยืนยันจุดวาง (<span id="bellProofCount">0</span>)</button>
      <button class="btn btn-gray btn-sm" id="bellTabRecalls" onclick="switchBellTab('recalls')" style="position:relative">
        🚨 ออเดอร์ยกเลิก (<span id="bellRecallCount">0</span>)
        <span id="bellRecallBadge" style="display:none;position:absolute;top:-4px;right:-4px;background:var(--red);color:#fff;border-radius:50%;width:14px;height:14px;font-size:.6rem;line-height:14px;text-align:center">!</span>
      </button>
      <button class="btn btn-gray btn-sm" onclick="fetchBellData()" style="margin-left:auto">🔄 รีเฟรช</button>
    </div>

    <!-- Pins Tab -->
    <div id="bellPinsArea" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.6rem">
      <div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด...</div>
    </div>

    <!-- Proofs Tab -->
    <div id="bellProofsArea" style="flex:1;overflow-y:auto;display:none;flex-direction:column;gap:.6rem">
      <div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด...</div>
    </div>

    <!-- Recalls Tab -->
    <div id="bellRecallsArea" style="flex:1;overflow-y:auto;display:none;flex-direction:column;gap:.6rem">
      <div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด...</div>
    </div>
  </div>
</div>

<!-- Text Import Modal -->
<div class="modal-bg" id="textImportModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="max-width:620px;width:95vw;max-height:85vh;display:flex;flex-direction:column;padding:1.2rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem;border-bottom:1px solid var(--border);padding-bottom:.6rem">
      <div style="font-weight:800;font-size:1.05rem;display:flex;align-items:center;gap:.4rem">
        📝 นำเข้าข้อมูลด้วยข้อความ (Text Import)
      </div>
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('textImportModal').style.display='none'">✕</button>
    </div>
    <div style="font-size:.76rem;color:var(--muted);margin-bottom:.6rem">
      วางข้อความที่มีชื่อขนส่งและเลขออเดอร์ ระบบจะแยกกลุ่มขนส่งและเลขออเดอร์ให้อัตโนมัติ (และจะผสาน Tracking ให้หากอัปโหลด PDF ใบปะหน้าทีหลัง)
    </div>
    <textarea id="textImportArea" rows="7" placeholder="วางข้อความที่นี่ เช่น:&#10;Order Shopee 02/10/2026 ค่ะ&#10;ขนส่ง Flash Express เรียกรถเข้ารับ&#10;Flash Express - 261002HC8GJ8X3&#10;...&#10;ขนส่ง SPX Express เรียกรถเข้ารับ&#10;SPX Express - 261002HDURW106" style="width:100%;font-family:monospace;font-size:.8rem;padding:.6rem;border-radius:.6rem;border:1px solid var(--border);background:var(--surface2);color:var(--text);resize:vertical"></textarea>
    
    <div style="display:flex;gap:.5rem;margin-top:.8rem">
      <button class="btn btn-blue" onclick="doParseTextOrders()" id="parseTextBtn" style="flex:1">🔍 ตรวจสอบข้อความ (Preview)</button>
      <button class="btn btn-gray" onclick="clearTextImport()">ล้างข้อความ</button>
    </div>

    <!-- Preview Section -->
    <div id="textImportPreview" style="display:none;margin-top:1rem;border-top:1px solid var(--border);padding-top:.8rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
        <div style="font-weight:700;font-size:.88rem">ผลการตรวจสอบ: <span id="textTotalCount" class="badge bg-green">0 รายการ</span></div>
      </div>
      <div id="textPreviewList" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:.4rem;margin-bottom:.8rem"></div>
      <button class="btn btn-green btn-full" onclick="doConfirmTextImport()" id="confirmTextImportBtn" style="font-weight:800;font-size:.95rem;padding:.7rem">
        📥 ยืนยันการนำเข้าระบบ
      </button>
    </div>
    <div class="log-line" id="textImportLog" style="display:none;margin-top:.6rem"></div>
  </div>
</div>

<!-- Admin Proof Photo Modal -->
<div class="modal-bg" id="adminProofPhotoModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="width:92%;max-width:540px;background:var(--surface);text-align:center;padding:1.1rem">
    <div class="modal-title" id="adminProofModalTitle" style="margin-bottom:.8rem">📸 รูปยืนยันจุดวางพัสดุ</div>
    <img id="adminProofModalImg" src="" style="width:100%;max-height:60vh;object-fit:contain;border-radius:.8rem;border:1px solid var(--border)">
    <div id="adminProofModalMeta" style="font-size:.75rem;color:var(--muted);margin-top:.5rem"></div>
    <button class="btn btn-gray btn-full" onclick="document.getElementById('adminProofPhotoModal').style.display='none'" style="margin-top:.8rem">ปิด</button>
  </div>
</div>

<!-- Admin Proof History Modal (Feature 1) -->
<div class="modal-bg" id="adminProofHistoryModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="width:95%;max-width:620px;max-height:85vh;display:flex;flex-direction:column;background:var(--surface);padding:1.2rem;border-radius:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem">
      <div class="modal-title" id="adminProofHistoryTitle" style="font-size:1.05rem;font-weight:800;color:var(--blue);margin:0">📜 ประวัติรูปถ่ายปิดยอดหลายเวอร์ชัน</div>
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('adminProofHistoryModal').style.display='none'">✕</button>
    </div>
    <div id="adminProofHistoryList" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.8rem;padding-right:.3rem"></div>
    <button class="btn btn-gray btn-full" onclick="document.getElementById('adminProofHistoryModal').style.display='none'" style="margin-top:.8rem">ปิด</button>
  </div>
</div>

<!-- Discrepancy & Shortage Report Modal (Feature 3) -->
<div class="modal-bg" id="shortageReportModal" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="modal" style="width:95%;max-width:600px;max-height:85vh;display:flex;flex-direction:column;background:var(--surface);padding:1.2rem;border-radius:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem">
      <div class="modal-title" id="shortageReportTitle" style="font-size:1.05rem;font-weight:800;color:var(--yellow);margin:0">📋 รายงานพัสดุตกหล่น/ขาดส่งมอบ</div>
      <button class="btn btn-gray btn-sm" onclick="document.getElementById('shortageReportModal').style.display='none'">✕</button>
    </div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:.6rem">สามารถคัดลอกข้อความด้านล่างส่งให้ฝ่ายบริการลูกค้า (CS) หรือพิมพ์เป็นเอกสารส่งมอบได้ทันที</div>
    <textarea id="shortageReportText" readonly style="flex:1;min-height:220px;font-family:monospace;font-size:.8rem;padding:.7rem;border-radius:.6rem;background:var(--surface2);border:1px solid var(--border);color:var(--text);resize:vertical"></textarea>
    <div style="display:flex;gap:.5rem;margin-top:.8rem">
      <button class="btn btn-blue" style="flex:1" onclick="copyShortageText()">📋 คัดลอกข้อความ (ส่งไลน์/CS)</button>
      <button class="btn btn-gray" onclick="printShortageReport()">🖨️ พิมพ์</button>
      <button class="btn btn-gray" onclick="document.getElementById('shortageReportModal').style.display='none'">ปิด</button>
    </div>
  </div>
</div>

<!-- Cancel Order / Recall Modal -->
<div class="modal-bg" id="cancelOrderModal" style="display:none" onclick="if(event.target===this)closeCancelOrderModal()">
  <div class="modal" style="max-width:580px;width:95vw;max-height:90vh;display:flex;flex-direction:column;padding:1.4rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:.6rem">
      <div style="font-weight:800;font-size:1.1rem;display:flex;align-items:center;gap:.4rem">
        🚨 เพิ่มออเดอร์ยกเลิก / ระงับส่งพัสดุ
      </div>
      <button class="btn btn-gray btn-sm" onclick="closeCancelOrderModal()">✕</button>
    </div>
    
    <div style="font-size:0.8rem;color:var(--muted);margin-bottom:.8rem">
      รองรับทั้งการกรอกทีละเลข หรือวางข้อความยาวๆ พร้อมกันหลายบรรทัด (เช่น ข้อความสรุปออเดอร์ หรือข้อความจาก Shopee/TikTok/Lazada)
    </div>

    <div style="margin-bottom:.9rem">
      <label style="font-size:.8rem;font-weight:700;display:block;margin-bottom:.3rem">
        📋 เลขออเดอร์ หรือ Tracking (บรรทัดละ 1 เลข หรือวางข้อความ):
      </label>
      <textarea id="cancelOrderInput" rows="6" placeholder="ตัวอย่าง:&#10;261002HC8GJ8X3&#10;TH370797E9XK1H&#10;Flash Express - 261001GJET0MGW&#10;SPX Express - 261002HDURW106" style="width:100%;font-family:monospace;font-size:.85rem;padding:.6rem;border-radius:.6rem;border:1px solid var(--border);background:var(--surface2);color:var(--text);box-sizing:border-box"></textarea>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin-bottom:1rem">
      <div>
        <label style="font-size:.8rem;font-weight:700;display:block;margin-bottom:.3rem">
          🏷️ สาเหตุการยกเลิก/ระงับ:
        </label>
        <select id="cancelReasonSelect" onchange="toggleCustomReasonInput()" style="width:100%;padding:.5rem;border-radius:.6rem;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:.85rem">
          <option value="ลูกค้ายกเลิกคำสั่งซื้อ">ลูกค้ายกเลิกคำสั่งซื้อ</option>
          <option value="แอดมินระงับการจัดส่ง">แอดมินระงับการจัดส่ง</option>
          <option value="ที่อยู่จัดส่งผิด / ลูกค้าขอเปลี่ยน">ที่อยู่จัดส่งผิด / ลูกค้าขอเปลี่ยน</option>
          <option value="สินค้าหมด / ชำรุด">สินค้าหมด / ชำรุด</option>
          <option value="other">อื่นๆ (พิมพ์เอง)</option>
        </select>
        <input type="text" id="cancelReasonCustom" placeholder="ระบุเหตุผล..." style="width:100%;margin-top:.4rem;display:none;padding:.45rem;border-radius:.6rem;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:.85rem;box-sizing:border-box">
      </div>
      <div>
        <label style="font-size:.8rem;font-weight:700;display:block;margin-bottom:.3rem">
          📁 รอบ / กลุ่มขนส่งเป้าหมาย:
        </label>
        <select id="cancelRoundSelect" style="width:100%;padding:.5rem;border-radius:.6rem;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:.85rem">
          <option value="">ค้นหาอัตโนมัติทุกรอบ</option>
        </select>
      </div>
    </div>

    <!-- Alert / Result Box -->
    <div id="cancelResultBox" style="display:none;padding:.75rem;border-radius:.6rem;margin-bottom:.9rem;font-size:.82rem"></div>

    <div style="display:flex;gap:.6rem;justify-content:flex-end">
      <button class="btn btn-gray btn-sm" onclick="closeCancelOrderModal()">ปิด</button>
      <button class="btn btn-red btn-sm" id="btnSubmitCancelOrder" onclick="submitCancelOrders()" style="display:inline-flex;align-items:center;gap:.4rem">
        🚀 บันทึกเข้าระบบ & แจ้งเตือนดึงคืน
      </button>
    </div>
  </div>
</div>`;

  const js = `<script>
var employees=${pEmps};
var avatars=${pAvatars};
var adminUser=localStorage.getItem('spx_user')||'';
var currentUser=adminUser||'admin';
document.getElementById('adminUserName').textContent=adminUser||'ไม่ระบุ';
var thBtn=document.getElementById('themeBtn');
var thVal=localStorage.getItem('spx_theme')||'dark';
if(thBtn)thBtn.textContent=thVal==='dark'?'☀️':'🌙';

function formatThaiTime(isoDate){
  if(!isoDate) return '—';
  var d = new Date(isoDate);
  var hh = String(d.getHours()).padStart(2,'0');
  var mm = String(d.getMinutes()).padStart(2,'0');
  return hh + ':' + mm + ' น.';
}

if(adminUser){fetch('/api/log-admin-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:adminUser})});}
fetch('/get-stats').then(r=>r.json()).then(d=>{if(d.roundName)document.getElementById('curRoundBadge').textContent='— '+d.roundName;});
setupDrop();
loadBlacklistHub();

// Tab delegation — no onclick needed in HTML
document.getElementById('tabBar').addEventListener('click', function(e) {
  var btn = e.target.closest('[data-tab]');
  if (!btn) return;
  switchTab(btn.dataset.tab, btn);
});

// ── Keyboard Hotkeys ─────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.altKey) {
    const keyMap = {
      '1': 'upload', '2': 'edit', '3': 'kpi',
      '4': 'export', '5': 'confirm', '6': 'accesslog', '7': 'settings'
    };
    if (keyMap[e.key]) {
      e.preventDefault();
      const btn = document.querySelector('.tab[data-tab="'+keyMap[e.key]+'"]');
      if (btn) btn.click();
    }
  }
});

let liveDashboardTimer = null;

function switchTab(name,btn){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('pane-'+name).classList.add('active');
  
  if (liveDashboardTimer) { clearInterval(liveDashboardTimer); liveDashboardTimer = null; }
  
  if(name==='upload')  { loadRounds(); }
  if(name==='rounds')   loadRounds();
  if(name==='kpi')       { 
    loadKpi(); loadDashboard(); 
    liveDashboardTimer = setInterval(() => { loadKpi(); loadDashboard(); }, 15000); // C6: Auto refresh every 15s
  }
  if(name==='edit')      loadEditList();
  if(name==='accesslog') loadAccessLog();
  if(name==='export')    loadExportRoundList();
  if(name==='confirm')   loadConfirmRounds();
  if(name==='settings')  { resetSettingsLock(); }
}

// ── Settings ─────────────────────────────────────────────────────────────────
let globalThermalMode = false;
function loadSettings(){
  fetch('/api/settings').then(r=>r.json()).then(d=>{
    if(!d.ok||!d.settings)return;
    document.getElementById('setLineNotifyOnComplete').checked = d.settings.lineNotifyOnComplete !== false;
    document.getElementById('setLineMessageStyle').value = d.settings.lineMessageStyle || 'flex';
    document.getElementById('setWebhookUrl').value = d.settings.webhookUrl || '';
    
    document.getElementById('setPrintTime').value = d.settings.printTime || '15:00';
    document.getElementById('setAutoPrintEn').checked = !!d.settings.autoPrintEnabled;
    document.getElementById('autoPrintConfigArea').style.opacity = d.settings.autoPrintEnabled ? 1 : 0.5;
    document.getElementById('setExcludeCarriers').value = (d.settings.excludeCarriers||[]).join(', ');
    
    document.getElementById('setAutoCleanEn').checked = !!d.settings.autoCleanEnabled;
    document.getElementById('setAutoCleanDays').value = d.settings.autoCleanDays || 30;
    document.getElementById('setVoiceEn').checked = d.settings.voiceEnabled !== false;
    document.getElementById('setThermalMode').checked = !!d.settings.thermalMode;
    document.getElementById('setValidateCarrierMismatch').checked = d.settings.validateCarrierMismatch !== false;
    globalThermalMode = !!d.settings.thermalMode;
    renderCarrierRulesEditor(d.settings.carrierPrefixes);
  });
  loadBlacklist();
  loadAdmins();
}

function loadAdmins() {
  fetch('/api/admins').then(r=>r.json()).then(d=>{
    if(!d.ok)return;
    const list = document.getElementById('adminList');
    if(!d.admins.length) {
      list.innerHTML = '<div style="font-size:.75rem;color:var(--muted)">ยังไม่มี Admin เพิ่มเติม</div>';
      return;
    }
    list.innerHTML = d.admins.map(a => 
      '<div style="display:flex;justify-content:space-between;padding:.4rem;background:var(--surface2);border-radius:.5rem;align-items:center">' +
      '<div style="font-size:.8rem"><b>' + escapeHtml(a.name) + '</b> <span class="badge bg-'+(a.role==='admin'?'blue':'gray')+'">' + escapeHtml(a.role) + '</span></div>' +
      '<button class="btn btn-red btn-sm" onclick="removeAdmin(\\\''+escapeHtml(a.name)+'\\\')">🗑</button>' +
      '</div>'
    ).join('');
  });
}
function addAdmin() {
  const n = document.getElementById('newAdminName').value.trim();
  const p = document.getElementById('newAdminPwd').value;
  const r = document.getElementById('newAdminRole').value;
  if(!n || !p) return alert('กรุณากรอกชื่อและรหัสผ่าน');
  fetch('/api/admins/add', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,password:p,role:r})})
    .then(res=>res.json()).then(d=>{
      if(d.ok){ document.getElementById('newAdminName').value=''; document.getElementById('newAdminPwd').value=''; loadAdmins(); }
      else alert(d.err);
    });
}
function removeAdmin(name) {
  showModalConfirm('ยืนยันลบ Admin: ' + name + ' ?', 'ยืนยันลบ Admin', 'warning').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/admins/remove', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
      .then(res=>res.json()).then(d=>{ if(d.ok) loadAdmins(); });
  });
}
function testWebhook() {
  const url = document.getElementById('setWebhookUrl').value.trim();
  if(!url) return alert('กรุณากรอก Webhook URL');
  fetch('/api/webhook/test', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})
    .then(res=>res.json()).then(d=>{
      if(d.ok) alert('✅ ทดสอบส่ง Webhook สำเร็จ!');
      else alert('❌ ส่ง Webhook ล้มเหลว: ' + d.err);
    });
}

// ── Dynamic Carrier Rules Editor ─────────────────────────────────────────────
var defaultCarrierRulesObj = {
  'FLASH': ['FXTH','FX','THLTS','THLAS'],
  'SPX': ['SPXTH','SPX'],
  'KERRY': ['KR'],
  'J&T': ['JT','601'],
  'DHL': ['DHL'],
  'LAZADA': ['LAZ','1Z'],
  'NIM': ['NIM'],
  'BEST': ['BES']
};

function renderCarrierRulesEditor(rules){
  var c = document.getElementById('carrierRulesContainer');
  if(!c) return;
  var data = (rules && typeof rules === 'object' && Object.keys(rules).length > 0) ? rules : defaultCarrierRulesObj;
  c.innerHTML = Object.keys(data).map(function(carrier){
    var prefixes = Array.isArray(data[carrier]) ? data[carrier].join(', ') : '';
    return '<div class="carrier-rule-row" style="display:flex;gap:.4rem;align-items:center;background:var(--surface2);padding:.4rem .6rem;border-radius:.6rem;border:1px solid var(--border)">' +
      '<input type="text" class="cr-name" value="' + escapeHtml(carrier) + '" placeholder="ชื่อขนส่ง (เช่น FLASH)" style="width:110px;font-weight:700;font-size:.8rem;padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text)">' +
      '<input type="text" class="cr-prefixes" value="' + escapeHtml(prefixes) + '" placeholder="คำนำหน้าคั่นด้วยจุลภาค (เช่น FXTH, FX)" style="flex:1;font-size:.8rem;padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text)">' +
      '<button type="button" class="btn btn-red btn-sm" onclick="this.closest(\\\'.carrier-rule-row\\\').remove()" style="padding:.2rem .45rem;font-size:.75rem">🗑</button>' +
    '</div>';
  }).join('');
}

function addCarrierRuleRow(){
  var c = document.getElementById('carrierRulesContainer');
  if(!c) return;
  var div = document.createElement('div');
  div.className = 'carrier-rule-row';
  div.style.cssText = 'display:flex;gap:.4rem;align-items:center;background:var(--surface2);padding:.4rem .6rem;border-radius:.6rem;border:1px solid var(--border)';
  div.innerHTML = '<input type="text" class="cr-name" value="" placeholder="ชื่อขนส่ง" style="width:110px;font-weight:700;font-size:.8rem;padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text)">' +
    '<input type="text" class="cr-prefixes" value="" placeholder="Prefix เช่น TH, SPX" style="flex:1;font-size:.8rem;padding:.3rem .5rem;border-radius:.4rem;border:1px solid var(--border);background:var(--surface);color:var(--text)">' +
    '<button type="button" class="btn btn-red btn-sm" onclick="this.closest(\\\'.carrier-rule-row\\\').remove()" style="padding:.2rem .45rem;font-size:.75rem">🗑</button>';
  c.appendChild(div);
}

function getCarrierRulesFromUI(){
  var rows = document.querySelectorAll('.carrier-rule-row');
  var res = {};
  rows.forEach(function(row){
    var name = (row.querySelector('.cr-name').value || '').trim().toUpperCase();
    var pStr = (row.querySelector('.cr-prefixes').value || '').trim().toUpperCase();
    if(name){
      var list = pStr.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      res[name] = list;
    }
  });
  return Object.keys(res).length > 0 ? res : defaultCarrierRulesObj;
}

var currentRecallFilter = 'all';
var allBlacklistData = [];

function setRecallFilter(filter) {
  currentRecallFilter = filter;
  ['tabAllRecalls','tabPendingRecalls','tabPendingScans','tabRecalled','tabRestored'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) { el.classList.remove('btn-blue'); el.classList.add('btn-gray'); }
  });
  var activeBtnId = filter === 'all' ? 'tabAllRecalls' :
                    (filter === 'PENDING_RECALL' ? 'tabPendingRecalls' :
                    (filter === 'PENDING_SCAN' ? 'tabPendingScans' :
                    (filter === 'RECALLED' ? 'tabRecalled' : 'tabRestored')));
  var ab = document.getElementById(activeBtnId);
  if(ab) { ab.classList.remove('btn-gray'); ab.classList.add('btn-blue'); }
  renderBlacklistTable();
}

function loadBlacklistHub() {
  fetch('/api/blacklist').then(function(r){ return r.json(); }).then(function(d){
    if(!d.ok) return;
    allBlacklistData = d.blacklist || [];
    var counts = d.counts || {};
    var cAll = document.getElementById('cntAllRecalls');
    var cPen = document.getElementById('cntPendingRecalls');
    var cScan = document.getElementById('cntPendingScans');
    var cRec = document.getElementById('cntRecalled');
    var cRes = document.getElementById('cntRestored');
    if(cAll) cAll.textContent = counts.total || 0;
    if(cPen) cPen.textContent = counts.pendingRecall || 0;
    if(cScan) cScan.textContent = counts.pendingScan || 0;
    if(cRec) cRec.textContent = counts.recalled || 0;
    if(cRes) cRes.textContent = counts.restored || 0;
    renderBlacklistTable();
  });
}
function loadBlacklist() { loadBlacklistHub(); } // alias

function renderBlacklistTable() {
  var tbody = document.getElementById('blacklistTableBody');
  if(!tbody) return;
  
  var filtered = allBlacklistData.filter(function(item){
    if(currentRecallFilter === 'all') return true;
    return item.state === currentRecallFilter;
  });

  if(!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:var(--muted)">ไม่พบรายการในหมวดหมู่นี้</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(function(item){
    var badge = '';
    if(item.state === 'PENDING_RECALL') {
      badge = '<span class="badge bg-red" style="font-size:0.7rem;animation:pulse 1s infinite">🚨 ต้องดึงคืนด่วน</span>';
    } else if(item.state === 'PENDING_SCAN') {
      badge = '<span class="badge bg-yellow" style="font-size:0.7rem">⏳ รอสกัดกั้น</span>';
    } else if(item.state === 'RECALLED') {
      badge = '<span class="badge bg-green" style="font-size:0.7rem">✅ ดึงคืนสำเร็จ</span>';
    } else if(item.state === 'RESTORED') {
      badge = '<span class="badge bg-gray" style="font-size:0.7rem">↩️ กู้คืนแล้ว</span>';
    } else {
      badge = '<span class="badge bg-red" style="font-size:0.7rem">⛔ ระงับ</span>';
    }

    var orderDisplay = item.orderCode ? '<span style="font-weight:700">'+escapeHtml(item.orderCode)+'</span>' : '—';
    var trackDisplay = item.code ? '<span style="font-size:0.75rem;color:var(--muted)">'+escapeHtml(item.code)+'</span>' : '';
    var codeCombo = '<div>' + orderDisplay + (trackDisplay ? '<br>' + trackDisplay : '') + '</div>';

    var carrierDisplay = item.carrierName || item.roundName || '—';
    var reasonDisplay = escapeHtml(item.reason || 'ระงับการส่ง');
    var addedDisplay = '<span style="font-size:0.75rem">' + formatThaiTime(item.addedAt) + '<br><span style="color:var(--muted)">โดย ' + escapeHtml(item.addedBy||'admin') + '</span></span>';
    
    var recallDisplay = item.recalledAt ? 
      ('<span style="font-size:0.75rem;color:var(--green)">สำเร็จ: ' + formatThaiTime(item.recalledAt) + '<br><span style="color:var(--muted)">โดย ' + escapeHtml(item.recalledBy||'พนักงาน') + '</span></span>') :
      '<span style="color:var(--muted)">—</span>';

    var keyForAction = item.code || item.orderCode;
    var actions = '<div style="display:flex;gap:.3rem;justify-content:center">';
    if(item.state !== 'RESTORED') {
      actions += '<button class="btn btn-gray btn-sm" onclick="restoreBlacklistItem(\\''+escapeHtml(keyForAction)+'\\')" style="padding:.2rem .4rem;font-size:0.7rem" title="กู้คืนให้กลับมาส่งได้">↩️ กู้คืน</button>';
    }
    actions += '<button class="btn btn-red btn-sm" onclick="deleteBlacklistItem(\\''+escapeHtml(keyForAction)+'\\')" style="padding:.2rem .4rem;font-size:0.7rem" title="ลบถาวร">🗑️</button>';
    actions += '</div>';

    return '<tr>' +
      '<td>' + badge + '</td>' +
      '<td>' + codeCombo + '</td>' +
      '<td>' + escapeHtml(carrierDisplay) + '</td>' +
      '<td>' + reasonDisplay + '</td>' +
      '<td>' + addedDisplay + '</td>' +
      '<td>' + recallDisplay + '</td>' +
      '<td style="text-align:center">' + actions + '</td>' +
    '</tr>';
  }).join('');
}

function openCancelOrderModal() {
  document.getElementById('cancelOrderInput').value = '';
  document.getElementById('cancelReasonSelect').value = 'ลูกค้ายกเลิกคำสั่งซื้อ';
  document.getElementById('cancelReasonCustom').value = '';
  document.getElementById('cancelReasonCustom').style.display = 'none';
  document.getElementById('cancelResultBox').style.display = 'none';

  // Populate round options
  fetch('/api/history').then(function(r){ return r.json(); }).then(function(d){
    var sel = document.getElementById('cancelRoundSelect');
    if(sel && d.ok) {
      sel.innerHTML = '<option value="">ค้นหาอัตโนมัติทุกรอบ</option>' +
        (d.history || []).map(function(r){
          return '<option value="'+r.id+'">รอบ: '+escapeHtml(r.name)+'</option>';
        }).join('');
    }
  });

  document.getElementById('cancelOrderModal').style.display = 'flex';
  setTimeout(function(){ document.getElementById('cancelOrderInput').focus(); }, 120);
}

function closeCancelOrderModal() {
  document.getElementById('cancelOrderModal').style.display = 'none';
}

function toggleCustomReasonInput() {
  var sel = document.getElementById('cancelReasonSelect');
  var cus = document.getElementById('cancelReasonCustom');
  if(sel && cus) {
    cus.style.display = sel.value === 'other' ? 'block' : 'none';
    if(sel.value === 'other') cus.focus();
  }
}

function submitCancelOrders() {
  var raw = document.getElementById('cancelOrderInput').value.trim();
  if(!raw) return alert('กรุณาระบุเลขออเดอร์หรือ Tracking');

  var sel = document.getElementById('cancelReasonSelect');
  var reason = sel.value === 'other' ? 
    (document.getElementById('cancelReasonCustom').value.trim() || 'ลูกค้ายกเลิกคำสั่งซื้อ') : 
    sel.value;

  var roundId = document.getElementById('cancelRoundSelect').value;
  var btn = document.getElementById('btnSubmitCancelOrder');
  var resBox = document.getElementById('cancelResultBox');

  btn.disabled = true;
  btn.textContent = '⏳ กำลังบันทึก & ตรวจจับ...';

  fetch('/api/blacklist/add-canceled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orders: raw,
      reason: reason,
      roundId: roundId,
      user: adminUser || 'admin'
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    btn.disabled = false;
    btn.textContent = '🚀 บันทึกเข้าระบบ & แจ้งเตือนดึงคืน';

    if(!d.ok) {
      alert(d.err || 'บันทึกไม่สำเร็จ');
      return;
    }

    var s = d.summary;
    resBox.style.display = 'block';
    if(s.urgentRecallCount > 0) {
      resBox.style.background = 'rgba(239,68,68,.15)';
      resBox.style.border = '1px solid var(--red)';
      resBox.style.color = '#fca5a5';
      resBox.innerHTML = '🚨 <strong>ตรวจพบพัสดุถูกสแกนลงกองแล้ว ' + s.urgentRecallCount + ' รายการ!</strong><br>' +
        'ระบบส่งสัญญาณไซเรนสั่งพนักงานไปดึงกล่องคืนทันที (รายการใหม่ทั้งหมด: ' + s.totalAdded + ' ชิ้น)';
    } else {
      resBox.style.background = 'rgba(34,197,94,.15)';
      resBox.style.border = '1px solid var(--green)';
      resBox.style.color = '#86efac';
      resBox.innerHTML = '✅ บันทึกออเดอร์ยกเลิกสำเร็จ ' + s.totalAdded + ' รายการ (ระบบจะดักจับเมื่อพนักงานสแกน)';
    }

    loadBlacklistHub();
    updateBellBadge();
    setTimeout(function(){
      closeCancelOrderModal();
    }, 2000);
  })
  .catch(function(err){
    btn.disabled = false;
    btn.textContent = '🚀 บันทึกเข้าระบบ & แจ้งเตือนดึงคืน';
    alert('เกิดข้อผิดพลาด: ' + err.message);
  });
}

function restoreBlacklistItem(code) {
  showModalConfirm('ยืนยันกู้คืนรายการ ' + code + ' ให้กลับมาจัดส่งได้ตามปกติ?', 'กู้คืนพัสดุ', 'question').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/blacklist/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, user: adminUser || 'admin' })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.ok) { loadBlacklistHub(); updateBellBadge(); }
    else alert(d.err || 'กู้คืนไม่สำเร็จ');
  });
  });
}

function deleteBlacklistItem(code) {
  showModalConfirm('ลบรายการ ' + code + ' ออกจากระบบถาวร?', 'ยืนยันลบถาวร', 'warning').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/blacklist/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, user: adminUser || 'admin' })
  })
  .then(function(r){ return r.json(); })
  .then(function(d){
    if(d.ok) { loadBlacklistHub(); updateBellBadge(); }
  });
  });
}
function doRestore(input) {
  if(!input.files||!input.files[0])return;
  showModalConfirm('คำเตือน: การ Restore จะเขียนทับข้อมูลปัจจุบันทั้งหมด ยืนยัน?', 'ยืนยันการกู้คืน', 'warning').then(function(confirmed){
    if(!confirmed) { input.value=''; return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      fetch('/api/restore', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
        .then(r=>r.json()).then(d=>{
          if(d.ok) { alert('กู้คืนข้อมูลสำเร็จ! ระบบจะรีเฟรช'); location.reload(); }
          else alert('Restore failed: '+d.err);
        });
    } catch(err) { alert('ไฟล์ไม่ถูกต้อง'); }
  };
  reader.readAsText(input.files[0]);
  input.value='';
  });
}
function saveSettings(){
  var btn = event.target;
  btn.textContent = '⏳ กำลังบันทึก...';
  var payload = {
    lineNotifyOnComplete: document.getElementById('setLineNotifyOnComplete').checked,
    lineMessageStyle: document.getElementById('setLineMessageStyle').value,
    webhookUrl: document.getElementById('setWebhookUrl').value,
    printTime: document.getElementById('setPrintTime').value,
    autoPrintEnabled: document.getElementById('setAutoPrintEn').checked,
    excludeCarriers: document.getElementById('setExcludeCarriers').value.split(',').map(s=>s.trim()).filter(Boolean),
    autoCleanEnabled: document.getElementById('setAutoCleanEn').checked,
    autoCleanDays: parseInt(document.getElementById('setAutoCleanDays').value) || 30,
    voiceEnabled: document.getElementById('setVoiceEn').checked,
    thermalMode: document.getElementById('setThermalMode').checked,
    validateCarrierMismatch: document.getElementById('setValidateCarrierMismatch').checked,
    carrierPrefixes: getCarrierRulesFromUI()
  };
  fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(r=>r.json()).then(d=>{
      btn.textContent = '💾 บันทึกการตั้งค่า';
      var log = document.getElementById('settingsLog');
      log.style.display = 'block';
      if(d.ok){
        log.textContent = '✅ บันทึกการตั้งค่าเรียบร้อย';
        log.style.color = 'var(--green)';
      } else {
        log.textContent = '❌ เกิดข้อผิดพลาด';
        log.style.color = 'var(--red)';
      }
      setTimeout(()=>log.style.display='none', 3000);
    });
}
function testLineNotify(){
  var log = document.getElementById('lineTestLog');
  log.style.display = 'block';
  log.textContent = '⏳ กำลังส่งข้อความทดสอบ...';
  log.style.color = 'var(--muted)';
  var payload = {};
  fetch('/api/test-line',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(r=>r.json()).then(d=>{
      if(d.ok){
        log.textContent = '✅ ส่งข้อความทดสอบเข้า LINE สำเร็จ!';
        log.style.color = 'var(--green)';
      } else {
        log.textContent = '❌ ส่งไม่สำเร็จ: ' + (d.err || 'Token ไม่ถูกต้อง — กรุณาตรวจสอบข้อมูล');
        log.style.color = 'var(--red)';
      }
      setTimeout(()=>log.style.display='none', 5000);
    }).catch(()=>{
      log.textContent = '❌ เชื่อมต่อไม่ได้';
      log.style.color = 'var(--red)';
    });
}
function triggerLineSummary(){
  var log = document.getElementById('lineTestLog');
  log.style.display = 'block';
  log.textContent = '⏳ กำลังส่งสรุปยอดวันนี้เข้า LINE...';
  log.style.color = 'var(--muted)';
  var payload = {};
  fetch('/api/trigger-line',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(r=>r.json()).then(d=>{
      if(d.ok){
        log.textContent = '✅ ส่งสรุปยอดเข้า LINE สำเร็จ! (' + (d.summary ? d.summary.totalItems + ' พัสดุ, ' + d.summary.totalRounds + ' รอบ' : 'ไม่มีรอบวันนี้') + ')';
        log.style.color = 'var(--green)';
      } else {
        log.textContent = '❌ ส่งไม่สำเร็จ: ' + (d.err || 'Token ไม่ถูกต้อง');
        log.style.color = 'var(--red)';
      }
      setTimeout(()=>log.style.display='none', 5000);
    }).catch(()=>{
      log.textContent = '❌ เชื่อมต่อไม่ได้';
      log.style.color = 'var(--red)';
    });
}
function triggerAutoCleanNow(){
  showModalConfirm('คุณแน่ใจหรือไม่ว่าจะล้างข้อมูลที่เก่ากว่าที่กำหนด? การกระทำนี้ไม่สามารถย้อนกลับได้', 'ยืนยันล้างข้อมูลเก่า', 'warning').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/auto-clean',{method:'POST'}).then(r=>r.json()).then(d=>{
      if(d.ok){
        alert('ลบไปแล้ว ' + d.removed + ' รอบ (เหลือ ' + d.remaining + ' รอบ)');
        if(d.removed > 0) loadRounds();
      } else alert('เกิดข้อผิดพลาด');
    });
  });
}

// ── Admin Lock Screen ────────────────────────────────────────────────────────
function resetSettingsLock() {
  // Check if password is set. If not set, unlock immediately
  fetch('/api/verify-admin', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: ''})})
    .then(r => r.json()).then(d => {
      if (d.ok) {
        // No password set — go directly to settings
        document.getElementById('settingsLockScreen').style.display = 'none';
        document.getElementById('settingsContentWrapper').style.display = 'block';
        loadSettings();
      } else {
        // Password is set — show lock screen
        document.getElementById('settingsLockScreen').style.display = 'flex';
        document.getElementById('settingsContentWrapper').style.display = 'none';
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminLoginErr').style.display = 'none';
        setTimeout(function(){ document.getElementById('adminPasswordInput').focus(); }, 200);
      }
    });
}
function verifyAdminPassword() {
  var pwd = document.getElementById('adminPasswordInput').value;
  var btn = document.getElementById('adminLoginBtn');
  var err = document.getElementById('adminLoginErr');
  btn.textContent = 'กำลังตรวจสอบ...';
  fetch('/api/verify-admin', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pwd})})
    .then(r => r.json()).then(d => {
      btn.textContent = 'ปลดล็อก';
      if (d.ok) {
        document.getElementById('settingsLockScreen').style.display = 'none';
        document.getElementById('settingsContentWrapper').style.display = 'block';
        err.style.display = 'none';
        loadSettings();
      } else {
        err.style.display = 'block';
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').focus();
      }
    });
}
document.getElementById('adminPasswordInput').addEventListener('keypress', function(e) {
  if (e.key === 'Enter') verifyAdminPassword();
});

// ── Drop Zone ──────────────────────────────────────────────────────────────
var selectedFiles=[];
function setupDrop(){
  var dz=document.getElementById('dropZone'), fi=document.getElementById('fileInput');
  dz.addEventListener('click',()=>fi.click());
  fi.addEventListener('change',()=>updateFiles(fi.files));
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag');});
  dz.addEventListener('dragleave',()=>dz.classList.remove('drag'));
  dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('drag');updateFiles(Array.from(e.dataTransfer.files).filter(f=>f.name.endsWith('.pdf')));});
  document.getElementById('upBtn').addEventListener('click',doUpload);
}
function updateFiles(fl){
  selectedFiles=Array.from(fl);
  document.getElementById('fileList').innerHTML=selectedFiles.map(f=>'<span class="file-chip">📄 '+escapeHtml(f.name)+'</span>').join('');
  document.getElementById('upBtn').disabled=selectedFiles.length===0;
}
function doUpload(){
  if(!selectedFiles.length)return;
  var btn=document.getElementById('upBtn'), log=document.getElementById('upLog');
  btn.disabled=true; btn.textContent='⏳ กำลังประมวลผล…';
  log.textContent='กำลังประมวลผล '+selectedFiles.length+' ไฟล์…'; log.style.color='var(--muted)';
  var merge=document.getElementById('mergeCheck').checked;
  var enc=btoa(unescape(encodeURIComponent(adminUser)));
  function onDone(d){
    showUploadResult(d,log);
    btn.disabled=false;
    btn.textContent='⬆️ ดึงข้อมูลจาก PDF';
    loadRounds();
    fetch('/get-stats').then(r=>r.json()).then(d=>{if(d.roundName)document.getElementById('curRoundBadge').textContent='— '+d.roundName;});
  }
  function onErr(){log.textContent='❌ การเชื่อมต่อผิดพลาด';log.style.color='var(--red)';btn.disabled=false;btn.textContent='⬆️ ดึงข้อมูลจาก PDF';}
  if(merge){
    var form=new FormData(); selectedFiles.forEach(f=>form.append('pdfs',f));
    var xhr=new XMLHttpRequest(); xhr.open('POST','/upload-multi'); xhr.setRequestHeader('x-admin-user',enc);
    xhr.onload=()=>{try{onDone(JSON.parse(xhr.responseText));}catch(e){onErr();}};xhr.onerror=onErr;xhr.send(form);
  } else {
    var allItems=[],totalCount=0,totalDup=0,totalEnriched=0,totalIncomplete=0,idx=0;
    function uploadNext(){
      if(idx>=selectedFiles.length){
        onDone({ok:true,count:totalCount,dupCount:totalDup,enrichedCount:totalEnriched,incompleteCount:totalIncomplete,items:allItems});
        return;
      }
      var form=new FormData(); form.append('pdf',selectedFiles[idx]);
      var xhr=new XMLHttpRequest(); xhr.open('POST','/upload'); xhr.setRequestHeader('x-admin-user',enc);
      xhr.onload=()=>{
        try{
          var d=JSON.parse(xhr.responseText);
          if(d.ok){
            allItems=allItems.concat(d.items||[]);
            totalCount+=(d.count||0);
            totalDup+=(d.dupCount||0);
            totalEnriched+=(d.enrichedCount||0);
            totalIncomplete+=(d.incompleteCount||0);
          }
        }catch(e){}
        log.textContent='ประมวลผล '+(idx+1)+'/'+selectedFiles.length+' ไฟล์…'; idx++; uploadNext();
      };
      xhr.onerror=onErr; xhr.send(form);
    }
    uploadNext();
  }
}
function showUploadResult(d,log){
  if(!d.ok){log.textContent='❌ '+(d.err||'เกิดข้อผิดพลาด');log.style.color='var(--red)';return;}
  var totalParsed = (d.items||[]).length;
  var msg = '';
  if (d.count > 0) {
    msg = '✅ นำเข้าสำเร็จ '+d.count+' รายการใหม่';
    if (d.dupCount > 0) msg += ' (พบ '+d.dupCount+' รายการเดิมที่มีอยู่แล้ว)';
    if (d.enrichedCount > 0) msg += ' (ผสานข้อมูลเดิม '+d.enrichedCount+' รายการ)';
  } else if (d.dupCount > 0 || (totalParsed > 0 && d.count === 0)) {
    msg = 'ℹ️ ตรวจพบ '+totalParsed+' รายการในไฟล์ (ทั้งหมดมีอยู่ในระบบแล้ว '+d.dupCount+' รายการ ระบบข้ามเพื่อไม่ให้นับยอดซ้ำ)';
  } else {
    msg = '⚠️ ไม่พบรายการพัสดุในไฟล์ PDF';
  }

  if (d.incompleteCount > 0) msg += ' — ⚠️ ไม่สมบูรณ์ '+d.incompleteCount+' รายการ (ขาด Order หรือ Tracking กรุณาตรวจที่แท็บ "แก้ไขรายการ")';
  log.textContent=msg; 
  log.style.color = d.count > 0 ? 'var(--green)' : (totalParsed > 0 ? 'var(--blue)' : 'var(--yellow)');
  document.getElementById('upCount').textContent = totalParsed;
  document.getElementById('upTable').innerHTML=(d.items||[]).map((it,i)=>{
    var bad = !it.tracking || !it.order;
    return '<tr'+(bad?' style="background:rgba(239,68,68,.12)"':'')+'>'+
      '<td style="color:var(--muted)">'+(i+1)+(bad?' ⚠️':'')+'</td>'+
      '<td style="font-family:monospace;color:var(--blue2)">'+escapeHtml(it.tracking||'⚠️ ว่าง')+'</td>'+
      '<td style="font-family:monospace">'+escapeHtml(it.order||'⚠️ ว่าง')+'</td>'+
      '<td style="font-size:.7rem;color:var(--muted)">'+escapeHtml(it.src||'')+'</td></tr>';
  }).join('');
  document.getElementById('upResult').style.display='block';
}

// ── Rounds ─────────────────────────────────────────────────────────────────
// ── Multi-Carrier Shipping Label Drop Zone & Preview Handler ─────────────────
var selectedLabelFiles = [];
var currentLabelAnalysis = null;

function setupLabelDrop(){
  var dz = document.getElementById('labelDropZone'), fi = document.getElementById('labelFileInput');
  if(!dz || !fi) return;
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => updateLabelFiles(fi.files));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag');
    updateLabelFiles(Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.pdf')));
  });
  document.getElementById('labelUpBtn').addEventListener('click', doAnalyzeLabels);
}

function updateLabelFiles(fl){
  selectedLabelFiles = Array.from(fl);
  var list = document.getElementById('labelFileList');
  list.innerHTML = selectedLabelFiles.map(f => '<span class="file-chip">🏷️ ' + escapeHtml(f.name) + '</span>').join('');
  document.getElementById('labelUpBtn').disabled = selectedLabelFiles.length === 0;
  var log = document.getElementById('labelUpLog');
  log.textContent = selectedLabelFiles.length > 0 ? 'เลือกแล้ว ' + selectedLabelFiles.length + ' ไฟล์ (พร้อมวิเคราะห์)' : 'รอเลือกไฟล์ใบปะหน้า…';
  log.style.color = 'var(--muted)';
}

var labelParseMode = 'text';

function onLabelModeChange(val) {
  labelParseMode = val;
  var warn = document.getElementById('barcodeWarnNotice');
  if (warn) warn.style.display = val === 'barcode' ? 'block' : 'none';
}

function showTemplateModal() {
  document.getElementById('templateModal').style.display = 'flex';
}

function closeTemplateModal() {
  document.getElementById('templateModal').style.display = 'none';
}

// ── Document Conversion & Generation Helpers ──────────────────────────────
function generateManifestFromLabels(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var btn = document.getElementById('btnGenManifest');
  var origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ กำลังประมวลผลใบปะหน้า...';

  var fd = new FormData();
  fd.append('labelPdf', file);

  fetch('/api/templates/generate-manifest-from-labels', {
    method: 'POST',
    body: fd
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    btn.innerHTML = origText;
    input.value = '';
    if (!d.ok) {
      alert(d.err || 'ไม่สามารถสร้างใบส่งมอบได้');
      return;
    }
    openManifestPrintWindow(d);
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.innerHTML = origText;
    input.value = '';
    alert('เกิดข้อผิดพลาด: ' + err.message);
  });
}

function openManifestPrintWindow(data) {
  var items = data.items || [];
  var today = new Date();
  var todayStr = today.toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' });
  var timeStr = String(today.getHours()).padStart(2,'0') + ':' + String(today.getMinutes()).padStart(2,'0') + ' น.';
  var printedBy = (typeof adminUser !== 'undefined' && adminUser) ? adminUser : 'เจ้าหน้าที่คลัง';

  var rowsHtml = items.map(function(it, idx) {
    return '<tr>' +
      '<td style="text-align:center;padding:6px 8px;border:1px solid #cbd5e1;">' + (idx + 1) + '</td>' +
      '<td style="padding:6px 8px;border:1px solid #cbd5e1;font-weight:600;font-family:monospace;font-size:13px;">' + escapeHtml(it.order || '—') + '</td>' +
      '<td style="padding:6px 8px;border:1px solid #cbd5e1;font-weight:700;font-family:monospace;font-size:13px;color:#1e40af;">' + escapeHtml(it.tracking || '—') + '</td>' +
      '<td style="text-align:center;padding:6px 8px;border:1px solid #cbd5e1;">' + escapeHtml(it.carrier || data.carrier) + '</td>' +
      '<td style="text-align:center;padding:6px 8px;border:1px solid #cbd5e1;color:#64748b;">[  ] ปกติ</td>' +
    '</tr>';
  }).join('');

  var win = window.open('', '_blank');
  if (!win) {
    alert('กรุณาอนุญาต Pop-up บนเบราว์เซอร์เพื่อแสดงหน้าใบส่งมอบ');
    return;
  }

  var doc = win.document;
  doc.open();
  doc.write('<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">' +
    '<title>ใบส่งมอบพัสดุ (Manifest) - ' + escapeHtml(data.carrier) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700;800&display=swap" rel="stylesheet">' +
    '<style>' +
      '@page { size: A4 portrait; margin: 12mm 15mm; }' +
      '* { box-sizing: border-box; }' +
      'body { font-family: "Sarabun", Tahoma, sans-serif; color: #0f172a; margin: 0; padding: 20px; font-size: 13px; }' +
      '.no-print { margin-bottom: 20px; padding: 12px; background: #f1f5f9; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #cbd5e1; }' +
      '@media print { .no-print { display: none !important; } body { padding: 0; } }' +
      'table { width: 100%; border-collapse: collapse; margin-top: 15px; }' +
      'th { background: #f8fafc; font-weight: 700; padding: 8px; border: 1px solid #94a3b8; font-size: 12px; }' +
      '.btn { background: #2563eb; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 14px; }' +
      '.btn:hover { background: #1d4ed8; }' +
    '</style></head><body>' +
    '<div class="no-print">' +
      '<div><b>📋 เอกสารใบส่งมอบพัสดุสร้างเสร็จสมบูรณ์ (' + items.length + ' รายการ)</b><div style="font-size:12px;color:#64748b">อ้างอิงจากไฟล์: ' + escapeHtml(data.filename) + '</div></div>' +
      '<button class="btn" id="printBtn">🖨️ สั่งพิมพ์ / บันทึก PDF</button>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:12px;">' +
      '<div>' +
        '<h2 style="margin:0;font-size:22px;font-weight:800;color:#1e3a8a;">📋 ใบส่งมอบพัสดุ (Delivery Manifest)</h2>' +
        '<div style="font-size:14px;color:#334155;margin-top:4px;">ผู้ให้บริการขนส่ง: <b>' + escapeHtml(data.carrier) + '</b></div>' +
      '</div>' +
      '<div style="text-align:right;font-size:12px;color:#475569;">' +
        '<div>วันที่: <b>' + todayStr + '</b></div>' +
        '<div>เวลา: <b>' + timeStr + '</b></div>' +
        '<div>จำนวนทั้งหมด: <b style="font-size:16px;color:#2563eb;">' + items.length + '</b> รายการ</div>' +
      '</div>' +
    '</div>' +
    '<table>' +
      '<thead>' +
        '<tr>' +
          '<th style="width:45px;text-align:center;">ลำดับ</th>' +
          '<th style="text-align:left;">เลขคำสั่งซื้อ (Order No.)</th>' +
          '<th style="text-align:left;">หมายเลขติดตามพัสดุ (Tracking No.)</th>' +
          '<th style="width:100px;text-align:center;">ขนส่ง</th>' +
          '<th style="width:80px;text-align:center;">ผลการตรวจ</th>' +
        '</tr>' +
      '</thead>' +
      '<tbody>' + rowsHtml + '</tbody>' +
    '</table>' +
    '<div style="margin-top:35px;display:grid;grid-template-columns:1fr 1fr;gap:40px;page-break-inside:avoid;">' +
      '<div style="border:1px solid #cbd5e1;border-radius:8px;padding:15px;text-align:center;">' +
        '<div style="font-weight:700;margin-bottom:45px;">เจ้าหน้าที่คลังผู้ส่งมอบพัสดุ</div>' +
        '<div style="border-bottom:1px dashed #94a3b8;width:75%;margin:0 auto 6px;"></div>' +
        '<div style="font-size:12px;color:#475569;">(' + escapeHtml(printedBy) + ')</div>' +
        '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">วันที่ _____/_____/_________</div>' +
      '</div>' +
      '<div style="border:1px solid #cbd5e1;border-radius:8px;padding:15px;text-align:center;">' +
        '<div style="font-weight:700;margin-bottom:45px;">พนักงานขนส่งผู้รับมอบพัสดุ (' + escapeHtml(data.carrier) + ')</div>' +
        '<div style="border-bottom:1px dashed #94a3b8;width:75%;margin:0 auto 6px;"></div>' +
        '<div style="font-size:12px;color:#475569;">(______________________________)</div>' +
        '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">วันที่ _____/_____/_________</div>' +
      '</div>' +
    '</div>' +
    '</body></html>');
  doc.close();

  var pBtn = doc.getElementById('printBtn');
  if (pBtn) pBtn.onclick = function() { win.print(); };
}

function generateLabelsFromManifest(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var btn = document.getElementById('btnGenLabels');
  var origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ กำลังประมวลผลใบส่งมอบ...';

  var fd = new FormData();
  fd.append('manifestPdf', file);

  fetch('/api/templates/generate-labels-from-manifest', {
    method: 'POST',
    body: fd
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.disabled = false;
    btn.innerHTML = origText;
    input.value = '';
    if (!d.ok) {
      alert(d.err || 'ไม่สามารถสร้างใบปะหน้าได้');
      return;
    }
    openLabelsPrintWindow(d);
  })
  .catch(function(err) {
    btn.disabled = false;
    btn.innerHTML = origText;
    input.value = '';
    alert('เกิดข้อผิดพลาด: ' + err.message);
  });
}

function openLabelsPrintWindow(data) {
  var items = data.items || [];
  var today = new Date();
  var todayStr = today.toLocaleDateString('th-TH');

  var labelsHtml = items.map(function(it, idx) {
    var safeId = 'bc_' + idx;
    return '<div class="label-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:5px;margin-bottom:8px;">' +
        '<span style="font-weight:900;font-size:16px;color:#000;">' + escapeHtml(it.carrier || data.carrier) + '</span>' +
        '<span style="font-size:11px;color:#666;">' + (idx + 1) + '/' + items.length + '</span>' +
      '</div>' +
      '<div style="text-align:center;margin:6px 0;">' +
        '<svg id="' + safeId + '" style="max-width:100%;height:52px;"></svg>' +
      '</div>' +
      '<div style="font-size:12px;margin-top:6px;border-top:1px dashed #aaa;padding-top:6px;">' +
        '<div><b>Tracking:</b> <span style="font-family:monospace;font-weight:700;">' + escapeHtml(it.tracking || '—') + '</span></div>' +
        '<div style="margin-top:2px;"><b>Order ID:</b> <span style="font-family:monospace;">' + escapeHtml(it.order || '—') + '</span></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:#888;margin-top:8px;">' +
        '<span>มาตรฐานการจัดส่ง</span><span>' + todayStr + '</span>' +
      '</div>' +
    '</div>';
  }).join('');

  var win = window.open('', '_blank');
  if (!win) {
    alert('กรุณาอนุญาต Pop-up บนเบราว์เซอร์เพื่อแสดงใบปะหน้า');
    return;
  }

  var doc = win.document;
  doc.open();
  doc.write('<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">' +
    '<title>ใบปะหน้าพัสดุ (Shipping Labels) - ' + escapeHtml(data.carrier) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700;800&display=swap" rel="stylesheet">' +
    '<style>' +
      '* { box-sizing: border-box; }' +
      'body { font-family: "Sarabun", Tahoma, sans-serif; color: #000; margin: 0; padding: 20px; background: #f8fafc; }' +
      '.no-print { margin-bottom: 20px; padding: 12px; background: #fff; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #cbd5e1; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }' +
      '@media print { .no-print { display: none !important; } body { padding: 0; background: #fff; } }' +
      '.labels-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 15px; }' +
      '@media print { .labels-grid { display: block; } .label-card { page-break-inside: avoid; margin-bottom: 20px; } }' +
      '.label-card { background: #fff; border: 2px solid #000; border-radius: 8px; padding: 12px; width: 100%; max-width: 320px; margin: 0 auto; box-shadow: 0 2px 6px rgba(0,0,0,0.05); }' +
      '.btn { background: #ea580c; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 14px; }' +
      '.btn:hover { background: #c2410c; }' +
    '</style></head><body>' +
    '<div class="no-print">' +
      '<div><b>🏷️ ใบปะหน้าพัสดุพร้อมบาร์โค้ดสร้างเสร็จสมบูรณ์ (' + items.length + ' ชิ้น)</b><div style="font-size:12px;color:#64748b">อ้างอิงจากใบส่งมอบ: ' + escapeHtml(data.filename) + ' | ขนส่ง: ' + escapeHtml(data.carrier) + '</div></div>' +
      '<button class="btn" id="printBtn">🖨️ สั่งพิมพ์ใบปะหน้า / Barcode</button>' +
    '</div>' +
    '<div class="labels-grid">' + labelsHtml + '</div>' +
    '</body></html>');
  doc.close();

  var pBtn = doc.getElementById('printBtn');
  if (pBtn) pBtn.onclick = function() { win.print(); };

  // Dynamically inject JsBarcode script into child window to avoid script tag issues in parent
  var s = doc.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js';
  s.onload = function() {
    items.forEach(function(it, idx) {
      var val = it.tracking || it.order || '';
      if (val && win.JsBarcode) {
        try {
          win.JsBarcode('#bc_' + idx, val, {
            format: 'CODE128',
            lineColor: '#000',
            width: 1.8,
            height: 48,
            displayValue: true,
            fontSize: 12,
            margin: 2
          });
        } catch(e) { console.error(e); }
      }
    });
  };
  doc.head.appendChild(s);
}

function switchTemplateTab(tab) {
  var isManifest = tab === 'manifest';
  document.getElementById('tplManifestSection').style.display = isManifest ? 'flex' : 'none';
  document.getElementById('tplLabelSection').style.display = isManifest ? 'none' : 'flex';
  
  var btnM = document.getElementById('btnTplManifest');
  var btnL = document.getElementById('btnTplLabel');
  if (isManifest) {
    btnM.className = 'btn btn-blue btn-sm';
    btnL.className = 'btn btn-gray btn-sm';
  } else {
    btnM.className = 'btn btn-gray btn-sm';
    btnL.className = 'btn btn-blue btn-sm';
  }
}

function doAnalyzeLabels(){
  if (!selectedLabelFiles.length) return;
  var btn = document.getElementById('labelUpBtn'), log = document.getElementById('labelUpLog');
  btn.disabled = true;
  btn.textContent = labelParseMode === 'barcode' ? '⏳ กำลังสแกน QR/Barcode…' : '⏳ กำลังวิเคราะห์ข้อความ…';
  log.textContent = 'กำลังประมวลผล ' + selectedLabelFiles.length + ' ไฟล์ (โหมด: ' + (labelParseMode === 'barcode' ? '📷 QR/Barcode' : '🔍 ข้อความ') + ')…';
  log.style.color = 'var(--blue2)';

  var form = new FormData();
  selectedLabelFiles.forEach(f => form.append('labels', f));
  form.append('parseMode', labelParseMode);
  var enc = btoa(unescape(encodeURIComponent(adminUser || '')));

  fetch('/api/labels/analyze', {
    method: 'POST',
    headers: { 'x-admin-user': enc },
    body: form
  })
  .then(r => r.json())
  .then(d => {
    btn.disabled = false; btn.textContent = '🔍 วิเคราะห์และตรวจสอบใบปะหน้า';
    if (!d.ok) {
      log.textContent = '❌ ' + (d.err || 'การวิเคราะห์ล้มเหลว');
      log.style.color = 'var(--red)';
      return;
    }
    log.textContent = '✅ วิเคราะห์สำเร็จ: พบ ' + d.totalValid + ' ออเดอร์ที่สมบูรณ์';
    log.style.color = 'var(--green)';
    showLabelPreviewModal(d);
  })
  .catch(err => {
    btn.disabled = false; btn.textContent = '🔍 วิเคราะห์และตรวจสอบใบปะหน้า';
    log.textContent = '❌ ข้อผิดพลาดในการเชื่อมต่อ: ' + err.message;
    log.style.color = 'var(--red)';
  });
}

function showLabelPreviewModal(data){
  currentLabelAnalysis = data;
  refreshLabelPreviewModalUI();
  document.getElementById('labelPreviewModal').style.display = 'flex';
}

function refreshLabelPreviewModalUI(){
  if (!currentLabelAnalysis) return;
  var items = currentLabelAnalysis.items || [];
  
  // Recalculate Carrier breakdown
  var byCarrier = {};
  items.forEach(function(it){
    var c = it.carrier || 'อื่นๆ';
    byCarrier[c] = (byCarrier[c] || 0) + 1;
  });
  currentLabelAnalysis.byCarrier = byCarrier;
  currentLabelAnalysis.totalValid = items.length;

  document.getElementById('lpFilesCount').textContent = currentLabelAnalysis.filesCount || 1;
  document.getElementById('lpPagesCount').textContent = currentLabelAnalysis.totalPages || items.length;
  document.getElementById('lpValidCount').textContent = items.length;
  document.getElementById('lpUnrecCount').textContent = ((currentLabelAnalysis.unrecognized || []).length + (currentLabelAnalysis.duplicatesInFiles || []).length);
  document.getElementById('lpConfirmCount').textContent = items.length;
  
  // Carrier breakdown badges
  var cList = document.getElementById('lpCarrierList');
  cList.innerHTML = Object.entries(byCarrier).map(function(e){
    var col = getCarrierColor(e[0]);
    return '<span class="badge" style="background:rgba('+hexToRgb(col)+',.15);color:'+col+';border:1px solid rgba('+hexToRgb(col)+',.35);font-size:.78rem;padding:.3rem .65rem">' +
      escapeHtml(e[0]) + ': <b>' + e[1] + '</b> ออเดอร์</span>';
  }).join('');

  // Warnings Area
  var warnHtml = '';
  var dups = currentLabelAnalysis.duplicatesInFiles || [];
  if (dups.length > 0) {
    warnHtml += '<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:.6rem;padding:.6rem .8rem;margin-bottom:.5rem;font-size:.75rem">' +
      '<div style="color:var(--red);font-weight:700;margin-bottom:.3rem">⚠️ พบรายการซ้ำในชุดไฟล์เดียวกัน (' + dups.length + ' รายการ - ข้ามอัตโนมัติ):</div>' +
      dups.slice(0, 5).map(function(d){
        return '<div style="color:var(--muted)">• ' + escapeHtml(d.key) + ' (' + escapeHtml(d.file) + ' หน้า ' + d.page + ' ซ้ำกับ ' + escapeHtml(d.dupWith) + ')</div>';
      }).join('') +
      (dups.length > 5 ? '<div style="color:var(--muted)">...และอีก ' + (dups.length - 5) + ' รายการ</div>' : '') +
      '</div>';
  }
  var unrec = currentLabelAnalysis.unrecognized || [];
  if (unrec.length > 0) {
    warnHtml += '<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:.6rem;padding:.6rem .8rem;margin-bottom:.5rem;font-size:.75rem">' +
      '<div style="color:var(--red);font-weight:700;margin-bottom:.3rem">❌ หน้าที่ไม่สามารถอ่านเลข Order/Tracking ได้ (' + unrec.length + ' หน้า):</div>' +
      unrec.slice(0, 5).map(function(u){
        return '<div style="color:var(--muted)">• ' + escapeHtml(u.file) + ' หน้า ' + u.page + ' — ' + escapeHtml(u.reason) + '</div>';
      }).join('') +
      (unrec.length > 5 ? '<div style="color:var(--muted)">...และอีก ' + (unrec.length - 5) + ' หน้า</div>' : '') +
      '</div>';
  }
  document.getElementById('lpWarningsArea').innerHTML = warnHtml;

  var carriers = ['Flash Express', 'Flash Express (TikTok)', 'SPX Express', 'SPX ด่วนคลัง', 'SPX ส่งด่วน', 'Lazada Express', 'J&T Express', 'Kerry Express', 'อื่นๆ'];

  // Items table preview with editable input fields
  document.getElementById('lpPreviewTable').innerHTML = items.map(function(it, i){
    var optHtml = carriers.map(function(c){
      return '<option value="' + c + '" ' + (it.carrier === c ? 'selected' : '') + '>' + c + '</option>';
    }).join('');

    return '<tr>' +
      '<td style="color:var(--muted);font-size:.75rem">' + (i + 1) + '</td>' +
      '<td>' +
        '<select onchange="updateLabelItemCarrier(' + i + ', this.value)" style="width:100%;padding:.25rem .4rem;font-size:.75rem;border-radius:.4rem;background:var(--surface2);color:var(--text);border:1px solid var(--border)">' +
          optHtml +
        '</select>' +
      '</td>' +
      '<td>' +
        '<input type="text" value="' + escapeHtml(it.order || '') + '" placeholder="Order ID" onchange="updateLabelItemOrder(' + i + ', this.value)" style="width:100%;padding:.25rem .4rem;font-size:.78rem;font-family:monospace;border-radius:.4rem;background:var(--surface2);color:var(--text);border:1px solid var(--border)">' +
      '</td>' +
      '<td>' +
        '<input type="text" value="' + escapeHtml(it.tracking || '') + '" placeholder="Tracking No." onchange="updateLabelItemTracking(' + i + ', this.value)" style="width:100%;padding:.25rem .4rem;font-size:.78rem;font-family:monospace;border-radius:.4rem;background:var(--surface2);color:var(--blue2);border:1px solid var(--border)">' +
      '</td>' +
      '<td style="font-size:.68rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px" title="' + escapeHtml(it.src) + '">' +
        escapeHtml(it.src || 'เพิ่มเอง') + (it.page ? ' (น.' + it.page + ')' : '') +
      '</td>' +
      '<td style="text-align:center">' +
        '<button type="button" class="btn btn-red btn-sm" onclick="removeLabelItem(' + i + ')" style="padding:.2rem .45rem;font-size:.7rem" title="ลบรายการนี้">🗑️</button>' +
      '</td>' +
      '</tr>';
  }).join('');

  document.getElementById('btnConfirmLabelImport').disabled = items.length === 0;
}

function updateLabelItemCarrier(index, val){
  if (!currentLabelAnalysis || !currentLabelAnalysis.items[index]) return;
  currentLabelAnalysis.items[index].carrier = val;
  refreshLabelPreviewModalUI();
}

function updateLabelItemOrder(index, val){
  if (!currentLabelAnalysis || !currentLabelAnalysis.items[index]) return;
  currentLabelAnalysis.items[index].order = val.trim();
  currentLabelAnalysis.items[index].scanKey = currentLabelAnalysis.items[index].tracking || val.trim();
}

function updateLabelItemTracking(index, val){
  if (!currentLabelAnalysis || !currentLabelAnalysis.items[index]) return;
  currentLabelAnalysis.items[index].tracking = val.trim();
  currentLabelAnalysis.items[index].scanKey = val.trim() || currentLabelAnalysis.items[index].order;
}

function removeLabelItem(index){
  if (!currentLabelAnalysis || !currentLabelAnalysis.items) return;
  currentLabelAnalysis.items.splice(index, 1);
  refreshLabelPreviewModalUI();
}

function addCustomLabelItem(){
  if (!currentLabelAnalysis) {
    currentLabelAnalysis = { items: [], filesCount: 1, totalPages: 1, unrecognized: [], duplicatesInFiles: [] };
  }
  currentLabelAnalysis.items.unshift({
    carrier: 'SPX Express',
    order: '',
    tracking: '',
    scanKey: '',
    src: 'เพิ่มเอง',
    page: '-'
  });
  refreshLabelPreviewModalUI();
}

function closeLabelPreviewModal(){
  document.getElementById('labelPreviewModal').style.display = 'none';
}

function doConfirmLabelImport(){
  if (!currentLabelAnalysis || !currentLabelAnalysis.items || !currentLabelAnalysis.items.length) return;
  var btn = document.getElementById('btnConfirmLabelImport');
  btn.disabled = true; btn.textContent = '⏳ กำลังบันทึกและสร้าง Round…';

  var baseName = selectedLabelFiles.length === 1 ? selectedLabelFiles[0].name : 'ชุดใบปะหน้า (' + selectedLabelFiles.length + ' ไฟล์)';
  var enc = btoa(unescape(encodeURIComponent(adminUser || '')));

  fetch('/api/labels/confirm-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-user': enc },
    body: JSON.stringify({
      items: currentLabelAnalysis.items,
      baseFileName: baseName
    })
  })
  .then(r => r.json())
  .then(d => {
    btn.disabled = false; btn.textContent = '✅ ยืนยันนำเข้าระบบ';
    if (!d.ok) {
      alert('❌ นำเข้าไม่สำเร็จ: ' + (d.err || 'เกิดข้อผิดพลาด'));
      return;
    }
    closeLabelPreviewModal();
    // ล้างไฟล์ที่เลือก
    selectedLabelFiles = [];
    document.getElementById('labelFileList').innerHTML = '';
    document.getElementById('labelUpBtn').disabled = true;
    var log = document.getElementById('labelUpLog');
    log.textContent = '✅ นำเข้าสำเร็จ ' + d.totalImported + ' รายการ (สร้าง ' + d.rounds.length + ' รอบแยกตามขนส่ง)';
    log.style.color = 'var(--green)';

    // โหลดประวัติรอบใหม่และอัปเดต Badge
    loadRounds();
    fetch('/get-stats').then(r=>r.json()).then(st => {
      if(st.roundName) document.getElementById('curRoundBadge').textContent = '— ' + st.roundName;
    });

    // แสดงข้อความสรุปและแนะนำการพิมพ์ใบส่งมอบ
    var roundSummary = d.rounds.map(function(r){ return '• ' + r.name + ' (' + r.count + ' รายการ)'; }).join('\\n');
    alert('🎉 นำเข้าระบบเรียบร้อยแล้ว!\\n\\nสร้างรอบแยกตามขนส่งสำเร็จ:\\n' + roundSummary + '\\n\\nคุณสามารถไปที่แท็บ "🖨️ ใบยืนยัน" เพื่อพิมพ์ใบส่งมอบ หรือไปที่หน้าพนักงานเพื่อเริ่มแสกนได้ทันที');
  })
  .catch(err => {
    btn.disabled = false; btn.textContent = '✅ ยืนยันนำเข้าระบบ';
    alert('❌ ข้อผิดพลาดในการเชื่อมต่อ: ' + err.message);
  });
}

// ── Rounds ─────────────────────────────────────────────────────────────────

function loadRounds(){
  var list=document.getElementById('roundsList');
  list.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">กำลังโหลด…</div>';
  fetch('/api/history').then(r=>r.json()).then(d=>{
    if(!d.ok||!d.history.length){list.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีรอบ</div>';return;}
    list.innerHTML=generateFoldersHTML(d.history, function(r, num){
      var pct=r.total>0?Math.round(r.done/r.total*100):0;
      var sb=r.isSaved?'<span class="badge bg-green">✅ ปิดยอดแล้ว</span>':(r.isComplete?'<span class="badge bg-blue">🟢 ครบแล้ว</span>':'<span class="badge bg-yellow">⚠️ ขาด '+r.missing+'</span>');
      var cur=r.isCurrent?'<span class="badge bg-blue">🔵 ปัจจุบัน</span>':'';
      var by=r.uploadedBy?'<span style="font-size:.7rem;color:var(--muted)"> — โดย '+escapeHtml(r.uploadedBy)+'</span>':'';
      var mh=r.missingItems&&r.missingItems.length?'<div class="miss-list" id="ml-'+r.id+'">'+r.missingItems.map(it=>'<div>• '+(it.tracking?escapeHtml(it.tracking):'')+(it.order?' / '+escapeHtml(it.order):'')+'</div>').join('')+'</div>':'';
      return '<div class="round-card" data-id="'+r.id+'" style="margin-bottom:.35rem">'+
        '<div class="rc-name" style="font-weight:700;font-size:.9rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem">'+num+'. '+escapeHtml(r.name)+' '+sb+cur+'</div>'+
        '<div class="round-meta">📅 '+new Date(r.uploadedAt).toLocaleString('th-TH')+by+'</div>'+
        '<div class="progress" style="margin-bottom:.5rem"><div class="progress-fill" style="width:'+pct+'%"></div></div>'+
        '<div style="font-size:.77rem;color:var(--muted);margin-bottom:.45rem">แสกน '+r.done+'/'+r.total+' ('+pct+'%)</div>'+
        '<div class="round-actions">'+
          (!r.isCurrent?'<button class="btn btn-gray btn-sm rc-set" data-id="'+r.id+'">🎯 ตั้งเป็นปัจจุบัน</button>':'')+
          '<button class="btn btn-gray btn-sm rc-rename" data-id="'+r.id+'" data-name="'+escapeHtml(r.name).replace(/"/g,'&quot;')+'">✏️ เปลี่ยนชื่อ</button>'+
          '<button class="btn btn-gray btn-sm rc-edit" data-id="'+r.id+'">⚙️ แก้ไขรายการ</button>'+
          (r.missingItems&&r.missingItems.length?'<button class="btn btn-gray btn-sm rc-miss" data-id="'+r.id+'">📋 รายการขาด</button>':'')+
          (r.missingItems&&r.missingItems.length?'<button class="btn btn-yellow btn-sm rc-shortage-report" data-id="'+r.id+'" data-name="'+escapeHtml(r.name)+'">📋 รายงานของขาด (ส่ง CS)</button>':'')+
          (r.completionProof&&(r.completionProof.photoUrl||r.completionProof.photoBase64)?'<button class="btn btn-blue btn-sm rc-proof" data-url="'+escapeHtml(r.completionProof.photoUrl||r.completionProof.photoBase64)+'" data-name="'+escapeHtml(r.name)+'" data-by="'+escapeHtml(r.completionProof.confirmedBy||'-')+'">🖼️ ดูรูปปิดยอด</button>':'')+
          (r.completionHistory&&r.completionHistory.length>0?'<button class="btn btn-gray btn-sm rc-proof-history" data-history="'+escapeHtml(encodeURIComponent(JSON.stringify(r.completionHistory)))+'" data-name="'+escapeHtml(r.name)+'">📜 ประวัติรูป ('+r.completionHistory.length+' รอบก่อน)</button>':'')+
          '<a href="/pass/'+r.id+'" target="_blank" class="btn btn-blue btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:.3rem">🚚 ตั๋วคนขับ</a>'+
          (r.isSaved?'<button class="btn btn-red btn-sm rc-unlock" data-id="'+r.id+'" data-name="'+escapeHtml(r.name).replace(/"/g,'&quot;')+'">🔓 ปลดล็อก</button>':'')+
          '<button class="btn btn-red btn-sm rc-del" data-id="'+r.id+'" data-name="'+escapeHtml(r.name).replace(/"/g,'&quot;')+'">🗑 ลบ</button>'+
        '</div>'+mh+'</div>';
    });
    // Event delegation — no more inline onclick with escaping
    list.querySelectorAll('.rc-set').forEach(b=>b.addEventListener('click',()=>setRound(b.dataset.id)));
    list.querySelectorAll('.rc-rename').forEach(b=>b.addEventListener('click',()=>showRenameModal(b.dataset.id,b.dataset.name)));
    list.querySelectorAll('.rc-edit').forEach(b=>b.addEventListener('click',()=>quickEditRound(b.dataset.id)));
    list.querySelectorAll('.rc-miss').forEach(b=>b.addEventListener('click',()=>toggleMiss(b.dataset.id)));
    list.querySelectorAll('.rc-shortage-report').forEach(b=>b.addEventListener('click',()=>openShortageReportModal(b.dataset.id,b.dataset.name)));
    list.querySelectorAll('.rc-proof').forEach(b=>b.addEventListener('click',()=>openAdminProofView(b.dataset.url, 'การกระจายพัสดุ: ' + b.dataset.name, 'พนักงาน ' + b.dataset.by)));
    list.querySelectorAll('.rc-proof-history').forEach(b=>b.addEventListener('click',()=>openProofHistoryModal(b.dataset.history, b.dataset.name)));
    list.querySelectorAll('.rc-unlock').forEach(b=>b.addEventListener('click',()=>unlockRound(b.dataset.id,b.dataset.name)));
    list.querySelectorAll('.rc-del').forEach(b=>b.addEventListener('click',()=>deleteRound(b.dataset.id,b.dataset.name)));
  });
}
function quickEditRound(id) {
  document.querySelector('[data-tab=edit]').click();
  setTimeout(() => loadEditRound(id), 100);
}
function toggleMiss(id){var el=document.getElementById('ml-'+id);if(el)el.classList.toggle('open');}
function setRound(id){
  fetch('/api/set-round',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:id})})
    .then(()=>{loadRounds();fetch('/get-stats').then(r=>r.json()).then(d=>{if(d.roundName)document.getElementById('curRoundBadge').textContent='— '+d.roundName;});});
}
function deleteRound(id,name){
  showModalConfirm('ลบกลุ่ม "'+name+'" ?<br>ข้อมูลการยิงทั้งหมดจะหายไป', 'ยืนยันลบกลุ่มขนส่ง', 'warning').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/delete-round',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:id})})
    .then(r=>r.json()).then(d=>{if(d.ok)loadRounds();else alert('ลบไม่ได้: '+d.err);});
  });
}
function unlockRound(id,name){
  showModalConfirm('ปลดล็อกกลุ่ม "'+name+'" เพื่อให้ยิงต่อใช่หรือไม่?', 'ปลดล็อกกลุ่มขนส่ง', 'question').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/unlock-round',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:id})})
    .then(r=>r.json()).then(d=>{
       if(d.ok) { loadRounds(); loadDashboard(); } else alert(d.err);
    });
  });
}
function closeModal(){document.querySelectorAll('.modal-bg').forEach(m=>m.style.display='none');}
function showAddRoundModal(){document.getElementById('newRoundName').value='';document.getElementById('addRoundModal').style.display='flex';}
function doAddRoundPreset(prefix){
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  document.getElementById('newRoundName').value = prefix + ' ' + timeStr + ' น.';
  doAddRound();
}
function doAddRound(){
  var name=document.getElementById('newRoundName').value.trim(); if(!name)return;
  fetch('/api/add-round',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,user:adminUser})})
    .then(r=>r.json()).then(d=>{
      if(d.ok){closeModal();loadRounds();fetch('/get-stats').then(r=>r.json()).then(d=>{if(d.roundName)document.getElementById('curRoundBadge').textContent='— '+d.roundName;});}
      else alert('สร้างไม่ได้: '+d.err);
    });
}
function showRenameModal(id,name){document.getElementById('renameRoundId').value=id;document.getElementById('renameInput').value=name;document.getElementById('renameModal').style.display='flex';}
function doRenameRound(){
  var id=document.getElementById('renameRoundId').value;
  var name=document.getElementById('renameInput').value.trim(); if(!name)return;
  fetch('/api/rename-round',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:id,name})})
    .then(r=>r.json()).then(d=>{if(d.ok){closeModal();loadRounds();}else alert('เปลี่ยนไม่ได้: '+d.err);});
}
// Enter key in modals
document.addEventListener('keydown',e=>{if(e.key==='Enter'){if(document.getElementById('addRoundModal').style.display!=='none')doAddRound();if(document.getElementById('renameModal').style.display!=='none')doRenameRound();}if(e.key==='Escape')closeModal();});

// ── Edit ───────────────────────────────────────────────────────────────────
var editRoundId=null,editItems=[];
function loadEditList(){
  fetch('/api/history').then(r=>r.json()).then(d=>{
    var list=document.getElementById('editRoundList');
    if(!d.ok||!d.history.length){list.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีรอบ</div>';return;}
    list.innerHTML=generateFoldersHTML(d.history, function(r, num){
      var pct=r.total>0?Math.round(r.done/r.total*100):0;
      var sb=r.isComplete?'<span class="badge bg-green">✅ ครบแล้ว</span>':'<span class="badge bg-yellow">⚠️ ขาด '+r.missing+'</span>';
      var cur=r.isCurrent?'<span class="badge bg-blue">🔵 ปัจจุบัน</span>':'';
      return '<div class="round-card" id="erc-'+r.id+'" style="margin-bottom:.35rem;cursor:pointer;padding:.65rem .85rem;transition:0.2s" onclick="loadEditRound(\\''+r.id+'\\')">'+
        '<div class="rc-name" style="font-weight:700;font-size:.9rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.3rem">'+num+'. '+escapeHtml(r.name)+' '+sb+cur+'</div>'+
        '<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">'+
          '<span style="font-size:.77rem;color:var(--muted)">แสกน '+r.done+'/'+r.total+' ('+pct+'%)</span>'+
          '<span style="font-size:.65rem;color:var(--muted);margin-left:auto">📅 '+new Date(r.uploadedAt).toLocaleString('th-TH')+'</span>'+
        '</div></div>';
    });
  });
}
function loadEditRound(id){
  if(!id){document.getElementById('editCard').style.display='none';return;}
  editRoundId=id;
  document.querySelectorAll('#editRoundList .round-card').forEach(c=>{c.style.borderColor='var(--border)';c.style.boxShadow='none';});
  var el=document.getElementById('erc-'+id);
  if(el){el.style.borderColor='var(--blue)';el.style.boxShadow='0 0 0 2px rgba(59,130,246,0.3)';}
  
  fetch('/api/history').then(r=>r.json()).then(d=>{
    var round=d.history.find(r=>r.id===id); if(!round)return;
    editItems=round.items;
    document.getElementById('editCount').textContent=editItems.length;
    document.getElementById('editCard').style.display='block';
    renderEditTable(round.scannedKeys||[]);
  });
}
function renderEditTable(sk){
  document.getElementById('editTable').innerHTML=editItems.map((it,i)=>{
    var sc=sk.includes(it.tracking)||sk.includes(it.order);
    var incomplete = !it.tracking || !it.order;
    return '<tr id="er-'+it.id+'"'+(incomplete?' style="background:rgba(239,68,68,.1)"':'')+'><td style="color:var(--muted);font-size:.7rem">'+(i+1)+(incomplete?' ⚠️':'')+'</td>'+
      '<td><input class="edit-input" id="et-'+it.id+'" value="'+escapeHtml(it.tracking)+'" placeholder="⚠️ TH..." style="width:150px'+(it.tracking?'':';border-color:var(--red)')+'"></td>'+
      '<td><input class="edit-input" id="eo-'+it.id+'" value="'+escapeHtml(it.order)+'" placeholder="⚠️ 260505..." style="width:150px'+(it.order?'':';border-color:var(--red)')+'"></td>'+
      '<td style="text-align:center">'+(sc?'<span class="badge bg-green">✅</span>':'<span class="badge bg-muted">⏳</span>')+'</td>'+
      '<td><button class="btn btn-red btn-sm" data-del-id="'+it.id+'">🗑</button></td></tr>';
  }).join('');
  // Event delegation for delete buttons
  document.getElementById('editTable').querySelectorAll('[data-del-id]').forEach(function(b){
    b.addEventListener('click', function(){ delItem(b.dataset.delId); });
  });
}

async function saveAll(){
  var log=document.getElementById('editLog'); log.textContent='⏳ บันทึก…'; log.style.color='var(--muted)';
  var ok=0;
  for(var it of editItems){
    var t=document.getElementById('et-'+it.id)?.value||'';
    var o=document.getElementById('eo-'+it.id)?.value||'';
    var r=await fetch('/api/edit-item',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:editRoundId,itemId:it.id,tracking:t,order:o})});
    var d=await r.json(); if(d.ok)ok++;
  }
  log.textContent='✅ บันทึกแล้ว '+ok+'/'+editItems.length; log.style.color='var(--green)';
}
function addItem(){
  fetch('/api/add-item',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:editRoundId,tracking:'',order:''})})
    .then(r=>r.json()).then(d=>{if(d.ok){editItems.push(d.item);document.getElementById('editCount').textContent=editItems.length;renderEditTable([]);}});
}
function delItem(id){
  showModalConfirm('ลบรายการนี้?', 'ยืนยันลบรายการ', 'warning').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/delete-item',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roundId:editRoundId,itemId:id})})
    .then(r=>r.json()).then(d=>{if(d.ok){editItems=editItems.filter(i=>i.id!==id);document.getElementById('editCount').textContent=editItems.length;document.getElementById('er-'+id)?.remove();}});
  });
}

// ── KPI ────────────────────────────────────────────────────────────────────
function clearKpiRange(){document.getElementById('kpiFrom').value='';document.getElementById('kpiTo').value='';loadKpi();}
function exportKpiPerEmployeeExcel(){
  fetch('/api/history').then(r=>r.json()).then(d=>{
    if(!d.ok || !d.history) { alert('ไม่พบข้อมูลประวัติ'); return; }
    
    // คำนวณยอดสแกนแยกตามพนักงาน
    var empStats = {};
    d.history.forEach(function(round){
      (round.scans || []).forEach(function(s){
        var emp = s.user || 'ไม่ระบุ';
        empStats[emp] = empStats[emp] || { name: emp, totalScans: 0, roundsCount: new Set(), lastActive: s.at };
        empStats[emp].totalScans++;
        empStats[emp].roundsCount.add(round.id);
        if (new Date(s.at) > new Date(empStats[emp].lastActive)) empStats[emp].lastActive = s.at;
      });
    });

    var rows = [
      ['รายงานผลงานและสถิติการสแกนรายบุคคล (KPI Worker Performance)'],
      ['วันที่พิมพ์รายงาน:', new Date().toLocaleString('th-TH')],
      [''],
      ['ลำดับ', 'ชื่อพนักงาน', 'ยอดสแกนสำเร็จ (ชิ้น)', 'จำนวนรอบที่ร่วมทำงาน', 'สแกนล่าสุดเมื่อ']
    ];

    Object.values(empStats).sort((a,b)=>b.totalScans - a.totalScans).forEach(function(e, idx){
      rows.push([
        idx + 1,
        e.name,
        e.totalScans,
        e.roundsCount.size,
        e.lastActive ? new Date(e.lastActive).toLocaleString('th-TH') : '-'
      ]);
    });

    var ws = XLSX.utils.aoa_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Worker_KPI');
    XLSX.writeFile(wb, 'รายงาน_KPI_รายบุคคล_' + new Date().toISOString().slice(0,10) + '.xlsx');
  });
}

function loadKpi(){
  var from=document.getElementById('kpiFrom').value, to=document.getElementById('kpiTo').value;
  var url='/api/kpi'+(from||to?'-range?'+(from?'from='+from:'')+(from&&to?'&':'')+(to?'to='+to:''):'');
  fetch(url).then(r=>r.json()).then(d=>{
    if(!d.ok)return;
    var k=d.kpi, rangeLabel=d.from||d.to?' ('+( d.from||'ต้น')+' – '+(d.to||'ปัจจุบัน')+')':'';
    document.getElementById('kpiGrid').innerHTML=employees.map((name,i)=>{
      var kk=k[name]||{ok:0,dup:0,err:0};
      var total=(kk.ok||0)+(kk.dup||0)+(kk.err||0);
      var rate=total>0?Math.round((kk.ok||0)/total*100):0;
      return '<div class="kpi-card"><div class="kav">'+avatars[i%avatars.length]+'</div><div class="kname">'+escapeHtml(name)+'</div>'+
        '<div class="ktotal">'+total+'</div><div style="font-size:.68rem;color:var(--muted);margin-bottom:.45rem">แสกนทั้งหมด'+rangeLabel+'</div>'+
        '<div class="krow"><span>✅ สำเร็จ</span><span style="color:var(--green);font-weight:700">'+(kk.ok||0)+'</span></div>'+
        '<div class="krow"><span>⚠️ ซ้ำ</span><span style="color:var(--yellow);font-weight:700">'+(kk.dup||0)+'</span></div>'+
        '<div class="krow"><span>❌ ไม่พบ</span><span style="color:var(--red);font-weight:700">'+(kk.err||0)+'</span></div>'+
        '<div class="krow"><span>🎯 Accuracy</span><span style="color:var(--blue2);font-weight:700">'+rate+'%</span></div></div>';
    }).join('');
    var tots=employees.reduce((a,n)=>{var kk=k[n]||{};a.ok+=(kk.ok||0);a.dup+=(kk.dup||0);a.err+=(kk.err||0);return a;},{ok:0,dup:0,err:0});
    var gt=tots.ok+tots.dup+tots.err, tr=gt>0?Math.round(tots.ok/gt*100):0;
    var top=employees.reduce((b,n)=>((k[n]?.ok||0)>(k[b]?.ok||0)?n:b),employees[0]);
    document.getElementById('kpiSum').innerHTML=[
      ['🔢 รวมทั้งหมด',gt,'var(--blue)'],['✅ สำเร็จ',tots.ok,'var(--green)'],
      ['⚠️ ซ้ำ',tots.dup,'var(--yellow)'],['❌ ผิด',tots.err,'var(--red)'],
      ['🎯 Accuracy',tr+'%','var(--blue2)'],['🏆 Top Scanner',top,'var(--purple)']
    ].map(x=>'<div class="sum-card"><div class="slbl">'+x[0]+'</div><div class="sval" style="color:'+x[2]+'">'+x[1]+'</div></div>').join('');
  });
}

// ── Export ─────────────────────────────────────────────────────────────────
var exportRoundId = 'all';
var currentExportData = null;

function loadExportRoundList(){
  fetch('/api/history').then(r=>r.json()).then(d=>{
    var list=document.getElementById('exportRoundList');
    if(!d.ok||!d.history.length){list.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีรอบ</div>';return;}
      
    var foldersHTML = generateFoldersHTML(d.history, function(r, num){
      var pct=r.total>0?Math.round(r.done/r.total*100):0;
      var sb=r.isComplete?'<span class="badge bg-green">✅ ครบ</span>':'<span class="badge bg-yellow">⚠️ ขาด '+r.missing+'</span>';
      return '<div class="round-card" id="erc-export-'+r.id+'" style="margin-bottom:.35rem;cursor:pointer;padding:.65rem .85rem;transition:0.2s" onclick="selectExportRound(\\''+r.id+'\\')">'+
        '<div class="rc-name" style="font-weight:700;font-size:.85rem;margin-bottom:.3rem;">#'+num+'. '+escapeHtml(r.name)+'</div>'+
        '<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">'+sb+'<span style="font-size:.7rem;color:var(--muted)">'+r.total+' รายการ ('+pct+'%)</span><span style="font-size:.65rem;color:var(--muted);margin-left:auto">📅 '+new Date(r.uploadedAt).toLocaleString('th-TH')+'</span></div></div>';
    });
    
    list.innerHTML = foldersHTML;
  });
}

function selectExportRound(id){
  exportRoundId = id;
  document.querySelectorAll('#pane-export .round-card').forEach(c=>{c.style.borderColor='var(--border)';c.style.boxShadow='none';});
  var el = document.getElementById('erc-export-'+id);
  if(el){el.style.borderColor='var(--blue)';el.style.boxShadow='0 0 0 2px rgba(59,130,246,0.3)';}
  document.getElementById('exportPreviewArea').style.display='none';
  document.getElementById('expLog').style.display='none';
}

function renderPreviewTable(headers, rows, totalRows) {
  var limit = Math.min(rows.length, 50);
  document.getElementById('epTitle').textContent = 'ตัวอย่างข้อมูล (' + totalRows + ' แถว)';
  document.getElementById('epCount').textContent = rows.length > 50 ? 'แสดง 50 รายการแรก' : 'แสดงทั้งหมด';
  
  var thHtml = headers.map(h=>'<th style="padding:.5rem;border-bottom:1px solid var(--border)">'+escapeHtml(h)+'</th>').join('');
  document.getElementById('epThead').innerHTML = thHtml;
  
  var trHtml = '';
  for(var i=0; i<limit; i++){
    trHtml += '<tr style="border-bottom:1px solid rgba(128,128,128,0.1)">' + rows[i].map(c=>'<td style="padding:.4rem;white-space:nowrap">'+escapeHtml(c||'')+'</td>').join('') + '</tr>';
  }
  document.getElementById('epTbody').innerHTML = trHtml;
  document.getElementById('exportPreviewArea').style.display='block';
  document.getElementById('exportPreviewArea').scrollIntoView({behavior:'smooth'});
}

function doDownloadExport() {
  if(!currentExportData) return;
  downloadXLSX(currentExportData.headers, currentExportData.rows, currentExportData.filename);
  var log = document.getElementById('expLog');
  log.style.display='block';
  log.textContent='✅ ดาวน์โหลดสำเร็จ: '+currentExportData.filename; 
  log.style.color='var(--green)';
}

function previewExport(type){
  var log=document.getElementById('expLog');
  var from=document.getElementById('expFrom').value, to=document.getElementById('expTo').value;
  
  log.style.display='block';
  log.textContent='⏳ กำลังดึงข้อมูล...'; log.style.color='var(--muted)';
  document.getElementById('exportPreviewArea').style.display='none';
  
  if(type==='kpi'){
    var url='/api/kpi'+(from||to?'-range?'+(from?'from='+from:'')+(from&&to?'&':'')+(to?'to='+to:''):'');
    fetch(url).then(r=>r.json()).then(d=>{
      if(!d.ok){log.textContent='❌ '+d.err;log.style.color='var(--red)';return;}
      log.style.display='none';
      var headers=['พนักงาน','สำเร็จ','ซ้ำ','ไม่พบ','รวม','Accuracy %'];
      var rows=employees.map(name=>{var kk=d.kpi[name]||{ok:0,dup:0,err:0};var total=(kk.ok||0)+(kk.dup||0)+(kk.err||0);var rate=total>0?Math.round((kk.ok||0)/total*100):0;return[name,kk.ok||0,kk.dup||0,kk.err||0,total,rate];});
      var filename='kpi_'+(from||'all')+'_to_'+(to||'now')+'.xlsx';
      currentExportData = { headers:headers, rows:rows, filename:filename };
      renderPreviewTable(headers, rows, rows.length);
    });
    return;
  }
  
  var roundId = exportRoundId || 'all';
  var qs = '?from='+(from||'')+'&to='+(to||'');
  
  fetch('/api/export/'+roundId+qs).then(r=>r.json()).then(d=>{
    if(!d.ok){log.textContent='❌ '+d.err;log.style.color='var(--red)';return;}
    log.style.display='none';
    var headers,rows,filename;
    var suffix = roundId==='all' ? ('All_'+(from||'Any')+'_to_'+(to||'Any')) : d.round.name;
    
    if(type==='items'){
      headers=['No.','ชื่อรอบ','Order No.','Tracking No.','สถานะ','ยิงโดย','วันที่ยิง'];
      rows=d.items.map((it,i)=>[i+1,it.roundName,it.order,it.tracking,it.status,it.scannedBy,it.scannedAt?new Date(it.scannedAt).toLocaleString('th-TH'):'']);
      filename='items_'+suffix+'_'+new Date().toISOString().slice(0,10)+'.xlsx';
    } else {
      var scanRows=d.scanLog;
      if(from)scanRows=scanRows.filter(s=>s.date>=from);
      if(to)  scanRows=scanRows.filter(s=>s.date<=to);
      headers=['ชื่อรอบ','รหัสพัสดุ','พนักงาน','ผลลัพธ์','วันที่','เวลา'];
      rows=scanRows.map(s=>[s.roundName,s.code,s.user,s.result==='ok'?'สำเร็จ':s.result==='dup'?'ซ้ำ':'ไม่พบ',s.date,s.time?new Date(s.time).toLocaleTimeString('th-TH'):'']);
      filename='scanlog_'+suffix+'_'+new Date().toISOString().slice(0,10)+'.xlsx';
    }
    
    currentExportData = { headers:headers, rows:rows, filename:filename };
    renderPreviewTable(headers, rows, rows.length);
  });
}
function downloadXLSX(headers,rows,filename){
  var wsData=[headers].concat(rows);
  var ws=XLSX.utils.aoa_to_sheet(wsData);
  var colWidths=headers.map(function(h,i){var max=String(h).length;
    rows.forEach(function(r){var len=String(r[i]||'').length;if(len>max)max=len;});
    return {wch:Math.min(max+2,40)};
  });
  ws['!cols']=colWidths;
  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Sheet1');
  XLSX.writeFile(wb,filename);
}

// ── Access log ─────────────────────────────────────────────────────────────
function loadAccessLog(){
  fetch('/api/admin-log').then(r=>r.json()).then(d=>{
    if(!d.ok)return;
    var logs=d.logs, counts={};
    logs.forEach(l=>counts[l.user]=(counts[l.user]||0)+1);
    document.getElementById('alogSummary').innerHTML=Object.keys(counts).map(u=>'<span class="badge bg-blue" style="font-size:.8rem;padding:.25rem .75rem">'+escapeHtml(u)+' — '+counts[u]+' ครั้ง</span>').join('');
    if(!logs.length){document.getElementById('alogList').innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีประวัติ</div>';return;}
    document.getElementById('alogList').innerHTML=logs.slice().reverse().map((l,i)=>{
      var av=avatars[employees.indexOf(l.user)%avatars.length]||'👤';
      return '<div class="alog-row"><span style="color:var(--muted);font-size:.72rem">'+(logs.length-i)+'</span><span style="font-weight:600">'+av+' '+escapeHtml(l.user)+'</span><span style="color:var(--muted);font-size:.75rem">'+new Date(l.time).toLocaleString('th-TH')+'</span></div>';
    }).join('');
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// DELIVERY CONFIRMATION PRINT SYSTEM
// ══════════════════════════════════════════════════════════════════════════════
var confirmData=null, confirmIpp=50, ippDebounce=null;
var carrierColors={'SPX Express':'#1d4ed8','SPX ส่งทันที':'#2563eb','SPX ด่วน':'#3b82f6','SPX ด่วนคลัง':'#60a5fa','Flash Express':'#b45309','J&T Express':'#7c3aed','Kerry Express':'#065f46','TikTok Shop':'#9d174d','อื่นๆ':'#374151'};
function getCarrierColor(n){return carrierColors[n]||'#374151';}
function hexToRgb(hex){hex=hex.replace('#','');var r=parseInt(hex.substring(0,2),16),g=parseInt(hex.substring(2,4),16),b=parseInt(hex.substring(4,6),16);return r+','+g+','+b;}

var allHistoryConfirm = [];

// ── Init Carrier Filters ────────────────────────────────────────────────────
function initCarrierFilters(){
  var cfs=document.getElementById('cfCarrierFilters');
  var carriers=['SPX Express','SPX ส่งทันที','SPX ด่วน','SPX ด่วนคลัง','Flash Express','J&T Express','Kerry Express','TikTok Shop','อื่นๆ'];
  cfs.innerHTML=carriers.map(function(c){
    return '<label style="display:flex;align-items:center;gap:.3rem;font-size:.75rem;cursor:pointer;background:var(--surface2);padding:.25rem .5rem;border-radius:.4rem;border:1px solid var(--border)">'+
      '<input type="checkbox" value="'+c+'" checked onchange="scheduleConfirmUpdate()" class="cf-carrier-chk" style="accent-color:'+getCarrierColor(c)+'"> '+c+'</label>';
  }).join('');
}
initCarrierFilters();

// ── Load rounds into checkbox list ──────────────────────────────────────────
function loadConfirmRounds(){
  fetch('/api/history').then(r=>r.json()).then(d=>{
    if(d.ok) { allHistoryConfirm = d.history; renderConfirmRounds(); }
  });
}

function clearConfirmFilters(){
  document.getElementById('cfFilterDate').value='';
  document.getElementById('cfFilterTimeFrom').value='';
  document.getElementById('cfFilterTimeTo').value='';
  renderConfirmRounds();
}

function renderConfirmRounds(){
  var list=document.getElementById('confirmRoundList');
  if(!allHistoryConfirm.length){list.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีรอบ</div>';return;}
  
  var fDate=document.getElementById('cfFilterDate').value;
  var fTimeF=document.getElementById('cfFilterTimeFrom').value;
  var fTimeT=document.getElementById('cfFilterTimeTo').value;

  var filtered = allHistoryConfirm.filter(function(r){
    var dt = new Date(r.uploadedAt);
    var ymd = dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
    var hhmm = String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0');
    if(fDate && ymd !== fDate) return false;
    if(fTimeF && hhmm < fTimeF) return false;
    if(fTimeT && hhmm > fTimeT) return false;
    return true;
  });

  if(!filtered.length){list.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted)">ไม่พบรอบที่ตรงกับตัวกรอง</div>';return;}

  list.innerHTML=generateFoldersHTML(filtered, function(r, num){
    var pct=r.total>0?Math.round(r.done/r.total*100):0;
    var sb=r.isComplete?'<span class="badge bg-green" style="font-size:.62rem">✅ ครบ</span>':'<span class="badge bg-yellow" style="font-size:.62rem">⚠️ ขาด '+r.missing+'</span>';
    var cb=r.isCurrent?'<span class="badge bg-blue" style="font-size:.62rem">ปัจจุบัน</span>':'';
    return '<label class="round-card" style="display:flex;align-items:center;gap:1rem;margin-bottom:.35rem;cursor:pointer;padding:.65rem .85rem">'+
      '<input type="checkbox" id="confirm-chk-'+r.id+'" value="'+r.id+'" style="width:1.25rem;height:1.25rem;accent-color:var(--blue);cursor:pointer;flex-shrink:0" onchange="scheduleConfirmUpdate()">'+
      '<div style="flex:1;min-width:0">'+
        '<div class="rc-name" style="font-weight:700;font-size:.85rem;margin-bottom:.3rem;color:var(--text);">'+num+'. '+escapeHtml(r.name)+'</div>'+
        '<div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">'+
          sb+cb+'<span style="font-size:.7rem;color:var(--muted)">'+r.total+' รายการ ('+pct+'%)</span>'+
          '<span style="font-size:.65rem;color:var(--muted);margin-left:auto">📅 '+new Date(r.uploadedAt).toLocaleString('th-TH')+'</span>'+
        '</div>'+
      '</div></label>';
  });
}

function selectAllConfirmRounds(on){document.querySelectorAll('[id^="confirm-chk-"]').forEach(function(cb){cb.checked=on;});scheduleConfirmUpdate();}

// ── Items Per Page: real-time slider + number input sync ────────────────────
function onIppChange(val,fromInput){
  var n=Math.max(10,Math.min(200,parseInt(val)||50));
  confirmIpp=n;
  document.getElementById('ippDisplay').textContent=n;
  if(!fromInput)document.getElementById('ippInput').value=n;
  else document.getElementById('ippSlider').value=Math.min(n,100);
  scheduleConfirmUpdate();
}
function scheduleConfirmUpdate(){clearTimeout(ippDebounce);ippDebounce=setTimeout(updateConfirmSummary,350);}

// ── Update Live Summary ──────────────────────────────────────────────────────
function updateConfirmSummary(){
  var ids=[];
  document.querySelectorAll('[id^="confirm-chk-"]:checked').forEach(function(cb){ids.push(cb.value);});
  
  var selCarriers=[];
  document.querySelectorAll('.cf-carrier-chk:checked').forEach(function(cb){selCarriers.push(cb.value);});

  var summaryCard=document.getElementById('confirmSummaryCard');
  var warnDiv=document.getElementById('confirmWarnings');
  var previewBtn=document.getElementById('previewConfirmBtn');
  var printBtn=document.getElementById('printConfirmBtn');
  var pdfBtn=document.getElementById('pdfConfirmBtn');
  if(!ids.length || !selCarriers.length){summaryCard.style.display='none';warnDiv.style.display='none';previewBtn.disabled=true;printBtn.disabled=true;pdfBtn.disabled=true;confirmData=null;return;}
  
  fetch('/api/delivery-confirm?rounds='+ids.join(',')+'&itemsPerPage='+confirmIpp+'&carriers='+encodeURIComponent(selCarriers.join(',')))
    .then(function(r){return r.json();})
    .then(function(d){
      confirmData=d;
      if(!d.ok){warnDiv.style.display='block';warnDiv.innerHTML='<div class="badge bg-red" style="font-size:.8rem;padding:.4rem .8rem">❌ '+d.err+'</div>';return;}
      var st=d.stats;
      var cRows=Object.entries(st.carriers).map(function(e){
        var col=getCarrierColor(e[0]);var pages=Math.ceil(e[1]/confirmIpp);
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:.4rem .55rem;border-radius:.5rem;margin-bottom:.3rem;background:rgba('+hexToRgb(col)+',.1);border:1px solid rgba('+hexToRgb(col)+',.25)">'+
          '<span style="font-weight:600;font-size:.8rem;color:'+col+'">'+e[0]+'</span>'+
          '<div style="display:flex;gap:.4rem;align-items:center">'+
            '<span class="badge" style="background:rgba('+hexToRgb(col)+',.15);color:'+col+';border:1px solid rgba('+hexToRgb(col)+',.3)">'+e[1]+' order</span>'+
            '<span style="font-size:.68rem;color:var(--muted)">'+pages+' หน้า</span>'+
          '</div></div>';
      }).join('');
      summaryCard.style.display='block';
      document.getElementById('confirmSummaryBody').innerHTML=
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.75rem">'+
          '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:.65rem;padding:.65rem;text-align:center">'+
            '<div style="font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem">รอบที่เลือก</div>'+
            '<div style="font-size:1.5rem;font-weight:900;color:var(--blue)">'+st.totalRounds+'</div></div>'+
          '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:.65rem;padding:.65rem;text-align:center">'+
            '<div style="font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem">Orders รวม</div>'+
            '<div style="font-size:1.5rem;font-weight:900;color:var(--green)">'+st.totalOrders+'</div></div>'+
        '</div>'+
        '<div style="font-size:.72rem;color:var(--muted);margin-bottom:.45rem;font-weight:600">แยกตาม Carrier:</div>'+
        cRows+
        '<div style="font-size:.7rem;color:var(--muted);text-align:right;margin-top:.3rem">รวม '+st.totalPages+' หน้า ('+confirmIpp+' order/หน้า)</div>';
      if(d.warnings&&d.warnings.length){
        warnDiv.style.display='block';
        warnDiv.innerHTML=d.warnings.map(function(w){return '<div style="font-size:.75rem;color:var(--yellow);background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.25);border-radius:.5rem;padding:.35rem .65rem;margin-bottom:.3rem">⚠️ '+w+'</div>';}).join('');
      }else{warnDiv.style.display='none';}
      previewBtn.disabled=(st.totalOrders===0);printBtn.disabled=(st.totalOrders===0);pdfBtn.disabled=(st.totalOrders===0);
    });
}

// ── Preview Modal ───────────────────────────────────────────────────────────
function openConfirmPreview(){
  if(!confirmData||!confirmData.ok)return;
  var d=confirmData,st=d.stats;
  document.getElementById('previewStatsRow').innerHTML=
    '<span class="badge bg-blue" style="font-size:.8rem;padding:.35rem .8rem">📋 '+st.totalRounds+' รอบ</span>'+
    '<span class="badge bg-green" style="font-size:.8rem;padding:.35rem .8rem">📦 '+st.totalOrders+' orders</span>'+
    '<span class="badge bg-muted" style="font-size:.8rem;padding:.35rem .8rem">📄 '+st.totalPages+' หน้า ('+confirmIpp+'/หน้า)</span>'+
    Object.entries(st.carriers).map(function(e){return '<span class="badge bg-muted" style="font-size:.78rem">'+e[0]+': '+e[1]+'</span>';}).join('');
  var wrow=document.getElementById('previewWarningsRow');
  if(d.warnings&&d.warnings.length){wrow.style.display='block';wrow.innerHTML=d.warnings.map(function(w){return '<div style="font-size:.75rem;color:var(--yellow);margin-bottom:.2rem">⚠️ '+w+'</div>';}).join('');}
  else{wrow.style.display='none';}
  var content=document.getElementById('previewCarrierContent');
  content.innerHTML=Object.entries(d.byCarrier).map(function(entry){
    var carrier=entry[0],items=entry[1],col=getCarrierColor(carrier);
    var pageCount=Math.ceil(items.length/confirmIpp);
    var rows=items.slice(0,10).map(function(it,i){
      return '<tr style="border-bottom:1px solid rgba(128,128,128,.1)">'+
        '<td style="padding:.35rem .55rem;color:var(--muted);font-size:.68rem">'+(i+1)+'</td>'+
        '<td style="padding:.35rem .55rem;font-family:monospace;font-size:.72rem">'+(it.hasOrder?escapeHtml(it.order):'<span style="color:var(--muted)">—</span>')+'</td>'+
        '<td style="padding:.35rem .55rem;font-family:monospace;font-size:.72rem">'+(it.hasTracking?escapeHtml(it.tracking):'<span style="color:var(--muted)">—</span>')+'</td>'+
        '</tr>';
    }).join('');
    var more=items.length>10?'<tr><td colspan="3" style="text-align:center;padding:.5rem;font-size:.72rem;color:var(--muted)">… และอีก '+(items.length-10)+' รายการ</td></tr>':'';
    return '<div style="border:1px solid rgba('+hexToRgb(col)+',.35);border-radius:.85rem;overflow:hidden">'+
      '<div style="background:rgba('+hexToRgb(col)+',.12);padding:.6rem .9rem;display:flex;align-items:center;justify-content:space-between">'+
        '<span style="font-weight:700;font-size:.875rem;color:'+col+'">'+carrier+'</span>'+
        '<div style="display:flex;gap:.4rem">'+
          '<span class="badge" style="background:rgba('+hexToRgb(col)+',.15);color:'+col+'">'+items.length+' orders</span>'+
          '<span class="badge bg-muted">'+pageCount+' หน้า</span>'+
        '</div></div>'+
      '<table style="width:100%;border-collapse:collapse">'+
        '<thead><tr style="background:var(--surface2)">'+
          '<th style="padding:.4rem .55rem;font-size:.65rem;color:var(--muted);text-align:left">#</th>'+
          '<th style="padding:.4rem .55rem;font-size:.65rem;color:var(--muted);text-align:left">Order No.</th>'+
          '<th style="padding:.4rem .55rem;font-size:.65rem;color:var(--muted);text-align:left">Tracking No.</th>'+
        '</tr></thead><tbody>'+rows+more+'</tbody></table></div>';
  }).join('');
  document.getElementById('confirmPreviewModal').style.display='flex';
}
function closeConfirmPreview(){document.getElementById('confirmPreviewModal').style.display='none';}

// ── Generate Full Print HTML (uses template.txt layout) ────────────────────
function generateDeliveryConfirmHTML(byCarrier,ipp){
  var today=new Date();
  var todayTH=today.toLocaleDateString('th-TH',{day:'2-digit',month:'2-digit',year:'numeric'});
  var printedBy=adminUser||'—';
  var carrierKeys=Object.keys(byCarrier);
  
  var pages=carrierKeys.map(function(carrier,ci){
    var items=byCarrier[carrier];if(!items.length)return '';
    var pbStyle=ci<carrierKeys.length-1?'page-break-after:always;':'';
    
    if (globalThermalMode) {
      // ────────────────────────────────────────────────────────
      // THERMAL PRINTER MODE (80mm)
      // ────────────────────────────────────────────────────────
      var orderRows = items.map(function(o, i){
        var dO=o.hasOrder?o.order:'—', dT=o.hasTracking?o.tracking:'—';
        return '<div style="border-bottom:1px dashed #000;padding:4px 0;font-size:10px">'+
          '<div style="display:flex;justify-content:space-between"><span>'+(i+1)+'. Order:</span><b>'+escapeHtml(dO)+'</b></div>'+
          '<div style="display:flex;justify-content:space-between"><span>Track:</span><b>'+escapeHtml(dT)+'</b></div>'+
          '</div>';
      }).join('');
      
      return '<div class="print-page-break" style="'+pbStyle+'padding:10px;font-family:\\'Sarabun\\',\\'Prompt\\',Tahoma,sans-serif;color:#000;width:72mm;margin:0 auto">'+
        '<h2 style="font-size:16px;text-align:center;margin:0 0 5px 0">ใบยืนยันการจัดส่ง</h2>'+
        '<div style="font-size:11px;margin-bottom:8px;text-align:center">'+
          '<div><b>Siam Board Games Store</b></div>'+
          '<div>ขนส่ง: <b>'+escapeHtml(carrier)+'</b></div>'+
          '<div>วันที่: '+todayTH+' | จำนวน: <b>'+items.length+'</b></div>'+
        '</div>'+
        '<div style="border-top:2px solid #000;border-bottom:2px solid #000;padding:2px 0;margin-bottom:8px;text-align:center;font-size:12px;font-weight:bold">รายการพัสดุ</div>'+
        orderRows +
        '<div style="margin-top:15px;font-size:10px;text-align:center">'+
          '<div>ลงชื่อพนักงานขนส่ง</div>'+
          '<div style="margin:15px 0 5px 0">................................................</div>'+
          '<div style="font-size:9px;color:#666">พิมพ์: '+escapeHtml(printedBy)+' '+today.toLocaleString('th-TH')+'</div>'+
        '</div>'+
        '</div>';
    } else {
      // ────────────────────────────────────────────────────────
      // A4 PRINTER MODE (Default)
      // ────────────────────────────────────────────────────────
      var orderRows=[];
      for(var i=0;i<items.length;i+=2){
        var o1=items[i],o2=items[i+1];
        var d1o=o1.hasOrder?o1.order:'—',d1t=o1.hasTracking?o1.tracking:'—';
        var d2o=o2?(o2.hasOrder?o2.order:'—'):'',d2t=o2?(o2.hasTracking?o2.tracking:'—'):'';
        orderRows.push(
          '<tr style="border:1px solid #000">'+
            '<td style="padding:6px 10px;border-right:1px solid #000;text-align:center;width:28px;font-size:12px">'+(i+1)+'</td>'+
            '<td style="padding:6px 10px;border-right:1px solid #000;font-family:monospace;font-size:12px;font-weight:600">'+escapeHtml(d1o)+'</td>'+
            '<td style="padding:6px 10px;border-right:1px solid #000;font-family:monospace;font-size:12px">'+escapeHtml(d1t)+'</td>'+
            '<td style="padding:6px 10px;border-right:1px solid #000;width:60px"></td>'+
            (o2
              ?'<td style="padding:6px 10px;border-right:1px solid #000;text-align:center;width:28px;font-size:12px">'+(i+2)+'</td>'+
                '<td style="padding:6px 10px;border-right:1px solid #000;font-family:monospace;font-size:12px;font-weight:600">'+escapeHtml(d2o)+'</td>'+
                '<td style="padding:6px 10px;border-right:1px solid #000;font-family:monospace;font-size:12px">'+escapeHtml(d2t)+'</td>'+
                '<td style="padding:6px 10px;width:60px"></td>'
              :'<td colspan="4"></td>'
            )+'</tr>'
        );
      }
      return '<div class="print-page-break" style="'+pbStyle+'padding:30px 36px;font-family:\\'Sarabun\\',\\'Prompt\\',Tahoma,sans-serif;color:#000;max-width:210mm">'+
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px">'+
          '<h1 style="font-size:26px;font-weight:900;margin:0;letter-spacing:-.5px">ใบยืนยันการจัดส่ง</h1>'+
          '<img src="/logo.png" style="height:48px;object-fit:contain" onerror="this.style.display=\\'none\\'">'+
        '</div>'+
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-bottom:20px;font-size:13px">'+
          '<div>'+
            '<div style="margin-bottom:5px"><span style="display:inline-block;width:110px;color:#555">ชื่อผู้ขาย:</span><b>Siam Board Games Store</b></div>'+
            '<div style="margin-bottom:5px"><span style="display:inline-block;width:110px;color:#555">เบอร์ติดต่อ:</span><b>66942518805</b></div>'+
            '<div style="margin-bottom:5px"><span style="display:inline-block;width:110px;color:#555">สถานที่รับสินค้า:</span><b style="font-size:11px">เลขที่ 29/1 ซอยรามคำแหง 32 แขวงหัวหมาก เขตบางกะปิ กรุงเทพฯ</b></div>'+
          '</div>'+
          '<div>'+
            '<div style="margin-bottom:5px"><span style="display:inline-block;width:80px;color:#555">ชื่อขนส่ง:</span><b>'+escapeHtml(carrier)+'</b></div>'+
            '<div style="margin-bottom:5px"><span style="display:inline-block;width:80px;color:#555">วันที่:</span><b>'+todayTH+'</b></div>'+
            '<div style="margin-bottom:5px"><span style="display:inline-block;width:80px;color:#555">จำนวนพัสดุ:</span><b>'+items.length+'</b></div>'+
          '</div>'+
        '</div>'+
        '<div style="font-size:13px;margin-bottom:12px;color:#333"><b>ตารางรายการสินค้า</b></div>'+
        '<table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid #000">'+
          '<thead><tr style="border:1px solid #000;background:#f5f5f5">'+
            '<th style="padding:7px 10px;border:1px solid #000;width:28px">No.</th>'+
            '<th style="padding:7px 10px;border:1px solid #000">หมายเลขคำสั่งซื้อ</th>'+
            '<th style="padding:7px 10px;border:1px solid #000">หมายเลขติดตามพัสดุ</th>'+
            '<th style="padding:7px 10px;border:1px solid #000;width:60px">หมายเหตุ</th>'+
          '</tr></thead><tbody>'+orderRows.join('')+'</tbody></table>'+
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:32px;font-size:13px">'+
          '<div>'+
            '<div style="margin-bottom:16px"><span style="color:#555">ชื่อผู้ขาย: </span><span style="display:inline-block;width:160px;border-bottom:1px solid #000">&nbsp;</span></div>'+
            '<div><span style="color:#555">ลายเซ็นผู้ขาย: </span><span style="display:inline-block;width:148px;border-bottom:1px solid #000">&nbsp;</span></div>'+
            '<div style="margin-top:10px"><span style="color:#555">หมายเลขเอกสาร: </span><span style="display:inline-block;width:140px;border-bottom:1px solid #000">&nbsp;</span></div>'+
          '</div>'+
          '<div>'+
            '<div style="margin-bottom:16px"><span style="color:#555">ชื่อพนักงานผู้เข้ารับพัสดุ: </span><span style="display:inline-block;width:110px;border-bottom:1px solid #000">&nbsp;</span></div>'+
            '<div style="margin-bottom:16px"><span style="color:#555">ลายเซ็นผู้เข้ารับพัสดุ: </span><span style="display:inline-block;width:118px;border-bottom:1px solid #000">&nbsp;</span></div>'+
            '<div><span style="color:#555">วันและเวลาที่เข้ารับพัสดุ: </span><span style="display:inline-block;width:100px;border-bottom:1px solid #000">&nbsp;</span></div>'+
          '</div>'+
        '</div>'+
        '<div style="margin-top:20px;font-size:11px;color:#666;border-top:1px solid #ddd;padding-top:10px">'+
          '<b>หมายเหตุ:</b> ใบยืนยันการจัดส่งฉบับนี้เป็นหนึ่งในหลักฐานที่ใช้ยืนยันการจัดส่งสินค้าให้แก่ขนส่งตามรายละเอียดที่ระบุในตารางรายการสินค้าข้างต้นเท่านั้น'+
        '</div>'+
        '<div style="font-size:11px;color:#888;margin-top:6px;text-align:right">พิมพ์โดย: '+escapeHtml(printedBy)+' | '+today.toLocaleString('th-TH')+'</div>'+
      '</div>';
    }
  }).join('');
  return '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>ใบยืนยันการจัดส่ง</title>'+
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700;900&display=swap" rel="stylesheet">'+
    '<style>body{margin:0;padding:0;font-family:\\'Sarabun\\',Tahoma,sans-serif;}'+
    '@media print{.print-page-break{page-break-after:always;}.print-page-break:last-child{page-break-after:avoid;}body{margin:0;}@page{margin:8mm 10mm;}}'+
    '</style></head><body>'+pages+'</body></html>';
}

// ── Print via hidden iframe ─────────────────────────────────────────────────
function printDeliveryConfirm(){
  if(!confirmData||!confirmData.ok||!confirmData.stats.totalOrders){alert('กรุณาเลือกรอบก่อน');return;}
  var html=generateDeliveryConfirmHTML(confirmData.byCarrier,confirmIpp);
  var iframe=document.getElementById('printFrame');
  if(!iframe){iframe=document.createElement('iframe');iframe.id='printFrame';iframe.style.cssText='position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none';document.body.appendChild(iframe);}
  var doc=iframe.contentDocument||iframe.contentWindow.document;
  doc.open();doc.write(html);doc.close();
  setTimeout(function(){try{iframe.contentWindow.focus();iframe.contentWindow.print();}catch(e){console.error('[print]',e);}},600);
}

// ── Export PDF (new window → Save as PDF) ──────────────────────────────────
function exportDeliveryPDF(){
  if(!confirmData||!confirmData.ok||!confirmData.stats.totalOrders){alert('กรุณาเลือกรอบก่อน');return;}
  var html=generateDeliveryConfirmHTML(confirmData.byCarrier,confirmIpp);
  var win=window.open('','_blank');
  if(!win){alert('กรุณาอนุญาต popup สำหรับ export PDF');return;}
  win.document.open();win.document.write(html);win.document.close();
  win.onload=function(){setTimeout(function(){win.print();},400);};
}

// ── Dashboard ─────────────────────────────────────────────────────────────
let dashboardChartIns = null;
let carrierChartIns = null;
function loadDashboard(){
  fetch('/api/dashboard-stats').then(r=>r.json()).then(d=>{
    if(!d.ok)return;
    
    // 1. Leaderboard
    var lbHtml = d.leaderboard.map((lb, i) => {
      var trophy = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
      return '<div style="display:flex;justify-content:space-between;padding:.5rem;border-bottom:1px solid var(--border);align-items:center">' +
        '<div><span style="font-size:1.2rem">'+trophy+'</span> '+avatars[employees.indexOf(lb.name)]+' <b>'+escapeHtml(lb.name)+'</b></div>' +
        '<div style="text-align:right"><div style="color:var(--green);font-weight:900">'+lb.ok+'</div><div style="font-size:.65rem;color:var(--muted)">จาก '+lb.total+' ('+lb.rate+'%)</div></div>' +
        '</div>';
    }).join('');
    document.getElementById('dashLeaderboard').innerHTML = lbHtml || '<div style="text-align:center;padding:1rem;color:var(--muted)">ไม่มีข้อมูล</div>';

    // 1.5 Carrier Summary
    if (d.todayCarriers) {
      var tcHtml = Object.keys(d.todayCarriers).map(carrier => {
        var tc = d.todayCarriers[carrier];
        var status = tc.isSaved ? '✅ ปิดแล้ว' : (tc.done > 0 ? '⏳ ยิงอยู่' : '🔴 ยังไม่ยิง');
        var color = tc.isSaved ? 'var(--green)' : (tc.done > 0 ? 'var(--yellow)' : 'var(--red)');
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:.6rem .8rem;background:var(--surface2);border-radius:.6rem;border-left:4px solid '+color+'">' +
          '<div style="font-weight:700;font-size:.9rem">'+escapeHtml(carrier)+'</div>' +
          '<div style="text-align:right;font-size:.85rem"><span style="color:var(--blue);font-weight:700">'+tc.done+'</span> / '+tc.total+' <span style="margin-left:.8rem;font-size:.75rem;color:'+color+';font-weight:bold">'+status+'</span></div>' +
        '</div>';
      }).join('');
      document.getElementById('carrierSummaryGrid').innerHTML = tcHtml || '<div style="text-align:center;padding:1rem;color:var(--muted)">ยังไม่มีข้อมูลของวันนี้</div>';
    }

    // 2. Bar Chart (Last 7 Days)
    var ctx1 = document.getElementById('dashboardChart');
    if(dashboardChartIns) dashboardChartIns.destroy();
    dashboardChartIns = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: d.last7.map(x => x.date.slice(5)), // MM-DD
        datasets: [
          { label: 'พัสดุที่แสกน (เสร็จ)', data: d.last7.map(x => x.done), backgroundColor: '#10b981' },
          { label: 'ขาดแสกน', data: d.last7.map(x => x.missing), backgroundColor: '#fbbf24' }
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true } } }
    });

    // 3. Doughnut Chart (Carriers)
    var ctx2 = document.getElementById('carrierChart');
    if(carrierChartIns) carrierChartIns.destroy();
    var cLabels = Object.keys(d.carrierDist);
    var cData = Object.values(d.carrierDist);
    var cColors = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];
    carrierChartIns = new Chart(ctx2, {
      type: 'doughnut',
      data: { labels: cLabels, datasets: [{ data: cData, backgroundColor: cColors, borderWidth: 1, borderColor: '#fff' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 10 } } } } }
    });
  });
}

// ── Admin Bell Center & PIN Approval ──────────────────────────────────────────
var bellPasscode = sessionStorage.getItem('bell_passcode') || '';
var activeBellTab = 'pins';
var bellData = { pendingRequests: [], proofs: [] };

function updateBellBadge() {
  fetch('/api/admin/bell-count').then(r => r.json()).then(d => {
    if (!d.ok) return;
    var badge = document.getElementById('bellBadge');
    var bellBtn = document.getElementById('bellBtn');
    if (!badge) return;
    if (d.count > 0) {
      badge.textContent = d.count;
      badge.style.display = 'inline-block';
      if (bellBtn) { bellBtn.style.color = 'var(--yellow)'; }
    } else {
      badge.style.display = 'none';
      if (bellBtn) { bellBtn.style.color = ''; }
    }
  }).catch(function(){});
}

function openBellCenter() {
  if (bellPasscode === '15806') {
    fetchBellData();
    document.getElementById('bellCenterModal').style.display = 'flex';
  } else {
    document.getElementById('bellPasscodeInput').value = '';
    document.getElementById('bellPasscodeErr').style.display = 'none';
    document.getElementById('bellPasscodeModal').style.display = 'flex';
    setTimeout(function() { document.getElementById('bellPasscodeInput').focus(); }, 150);
  }
}

function submitBellPasscode() {
  var code = (document.getElementById('bellPasscodeInput').value || '').trim();
  if (code === '15806') {
    bellPasscode = '15806';
    sessionStorage.setItem('bell_passcode', '15806');
    document.getElementById('bellPasscodeModal').style.display = 'none';
    fetchBellData();
    document.getElementById('bellCenterModal').style.display = 'flex';
  } else {
    document.getElementById('bellPasscodeErr').style.display = 'block';
  }
}

function switchBellTab(tab) {
  activeBellTab = tab;
  var bPins    = document.getElementById('bellTabPins');
  var bProofs  = document.getElementById('bellTabProofs');
  var bRecalls = document.getElementById('bellTabRecalls');
  var aPins    = document.getElementById('bellPinsArea');
  var aProofs  = document.getElementById('bellProofsArea');
  var aRecalls = document.getElementById('bellRecallsArea');

  bPins.className    = 'btn btn-gray btn-sm';
  bProofs.className  = 'btn btn-gray btn-sm';
  if (bRecalls) bRecalls.className = 'btn btn-gray btn-sm';
  aPins.style.display    = 'none';
  aProofs.style.display  = 'none';
  if (aRecalls) aRecalls.style.display = 'none';

  if (tab === 'pins') {
    bPins.className = 'btn btn-blue btn-sm';
    aPins.style.display = 'flex';
  } else if (tab === 'proofs') {
    bProofs.className = 'btn btn-blue btn-sm';
    aProofs.style.display = 'flex';
  } else if (tab === 'recalls') {
    if (bRecalls) bRecalls.className = 'btn btn-red btn-sm';
    if (aRecalls) aRecalls.style.display = 'flex';
  }
}

function fetchBellData() {
  fetch('/api/admin/bell-notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: bellPasscode })
  })
  .then(r => r.json())
  .then(d => {
    if (!d.ok) {
      if (d.err === 'รหัสเข้ากระดิ่งไม่ถูกต้อง') {
        sessionStorage.removeItem('bell_passcode');
        bellPasscode = '';
        document.getElementById('bellCenterModal').style.display = 'none';
        openBellCenter();
      } else {
        alert(d.err);
      }
      return;
    }
    bellData = d;
    document.getElementById('bellPinCount').textContent = (d.pendingRequests || []).length;
    document.getElementById('bellProofCount').textContent = (d.proofs || []).length;
    var recallList = d.pendingRecalls || [];
    var recallCountEl = document.getElementById('bellRecallCount');
    var recallBadgeEl = document.getElementById('bellRecallBadge');
    if (recallCountEl) recallCountEl.textContent = recallList.length;
    if (recallBadgeEl) recallBadgeEl.style.display = recallList.length > 0 ? 'block' : 'none';
    updateBellBadge();
    renderBellPins(d.pendingRequests || []);
    renderBellProofs(d.proofs || []);
    renderBellRecalls(recallList);
  })
  .catch(err => { console.error('fetchBellData error:', err); });
}

function renderBellRecalls(recalls) {
  var area = document.getElementById('bellRecallsArea');
  if (!area) return;
  if (!recalls.length) {
    area.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted)">✅ ไม่มีออเดอร์ยกเลิกที่รอดึงคืน</div>';
    return;
  }
  area.innerHTML = recalls.map(function(r) {
    var addedAt   = r.addedAt   ? new Date(r.addedAt).toLocaleString('th-TH')   : '-';
    var recalledAt = r.recalledAt ? new Date(r.recalledAt).toLocaleString('th-TH') : null;
    var stateLabel = {
      PENDING_SCAN:   '<span class="badge" style="background:var(--blue);color:#fff;font-size:.68rem">⏳ รอยิงอีกครั้ง</span>',
      PENDING_RECALL: '<span class="badge" style="background:var(--red);color:#fff;font-size:.68rem;animation:recallPulse 1s infinite">🚨 รอดึงคืน</span>',
      RECALLED:       '<span class="badge" style="background:var(--green);color:#fff;font-size:.68rem">✅ ดึงคืนแล้ว</span>',
      RESTORED:       '<span class="badge" style="background:var(--muted);color:#fff;font-size:.68rem">↩️ คืนสถานะ</span>'
    }[r.state] || '<span class="badge bg-gray">' + (r.state||'?') + '</span>';

    return '<div class="card" style="padding:.85rem;border-left:4px solid var(--red);margin-bottom:.5rem">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap">' +
        '<div style="flex:1">' +
          '<div style="font-weight:800;font-size:.88rem;color:var(--text)">🚫 ' + escapeHtml(r.orderCode || r.code || '-') + '</div>' +
          (r.code && r.code !== r.orderCode ? '<div style="font-size:.73rem;color:var(--muted);margin-top:.15rem">Tracking: ' + escapeHtml(r.code) + '</div>' : '') +
          '<div style="font-size:.73rem;color:var(--blue);font-weight:600;margin-top:.2rem">ขนส่ง: ' + escapeHtml(r.carrierName || r.roundName || '-') + '</div>' +
          '<div style="font-size:.68rem;color:var(--muted);margin-top:.15rem">เหตุผล: ' + escapeHtml(r.reason || '-') + '</div>' +
          '<div style="font-size:.68rem;color:var(--muted);margin-top:.1rem">เพิ่มเมื่อ: ' + addedAt + ' (โดย ' + escapeHtml(r.addedBy || '-') + ')</div>' +
          (recalledAt ? '<div style="font-size:.68rem;color:var(--green);margin-top:.1rem">ดึงคืนเมื่อ: ' + recalledAt + ' (โดย ' + escapeHtml(r.recalledBy || '-') + ')</div>' : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.3rem">' +
          stateLabel +
          (r.state !== 'RECALLED' && r.state !== 'RESTORED'
            ? '<button class="btn btn-green btn-sm" style="font-size:.7rem" onclick="adminConfirmRecall(\\\'' + escapeHtml(r.code||r.orderCode) + '\\\')">✅ ยืนยันดึงคืนแล้ว</button>'
            : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function adminConfirmRecall(code) {
  showModalConfirm('ยืนยันว่าดึงกล่อง "' + code + '" คืนจากกองแล้วใช่ไหม?', 'ยืนยันดึงกล่องคืน', 'question').then(function(confirmed){
    if(!confirmed) return;
    fetch('/api/blacklist/recall-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, user: (typeof currentUser !== 'undefined' && currentUser ? currentUser : (typeof adminUser !== 'undefined' && adminUser ? adminUser : 'admin')), passcode: bellPasscode })
  })
  .then(r => r.json())
  .then(d => {
    if (d.ok) { fetchBellData(); loadBlacklistHub(); }
    else alert(d.err || 'ไม่สามารถยืนยันได้');
  })
  .catch(err => alert('Error: ' + err.message));
  });
}


function renderBellPins(pins) {
  var area = document.getElementById('bellPinsArea');
  if (!pins.length) {
    area.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted)">🎉 ไม่มีคำขอ PIN ค้างอยู่ (พนักงานทุกคนยืนยันเรียบร้อยแล้ว)</div>';
    return;
  }
  area.innerHTML = pins.map(function(p) {
    var timeStr = new Date(p.requestedAt).toLocaleTimeString('th-TH');
    return '<div class="card" style="padding:.85rem;border-left:4px solid var(--yellow);margin-bottom:.5rem">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">' +
        '<div>' +
          '<div style="font-weight:800;font-size:.92rem;color:var(--text)">👤 ' + escapeHtml(p.user) + ' ขอปลดล็อก PIN</div>' +
          '<div style="font-size:.75rem;color:var(--blue);font-weight:600;margin-top:.2rem">กลุ่ม: ' + escapeHtml(p.roundName) + '</div>' +
          '<div style="font-size:.68rem;color:var(--muted);margin-top:.2rem">เวลาขอ: ' + timeStr + ' น.</div>' +
        '</div>' +
        '<div id="pinBox_' + p.id + '">' +
          '<button class="btn btn-green btn-sm" onclick="approveAndRevealPin(\\\'' + p.id + '\\\')">🔑 แสดงรหัส PIN</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function approveAndRevealPin(reqId) {
  fetch('/api/admin/approve-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: reqId, passcode: bellPasscode })
  })
  .then(r => r.json())
  .then(d => {
    if (d.ok) {
      var box = document.getElementById('pinBox_' + reqId);
      if (box) {
        box.innerHTML = '<div style="text-align:center;background:var(--surface2);border:1.5px solid var(--green);border-radius:.6rem;padding:.3rem .6rem">' +
          '<div style="font-size:.65rem;color:var(--muted)">รหัส PIN:</div>' +
          '<div style="font-size:1.3rem;font-weight:900;color:var(--green);letter-spacing:4px">' + d.pin + '</div>' +
        '</div>';
      }
    } else {
      alert(d.err || 'ไม่สามารถดึงรหัสได้');
    }
  });
}

function renderBellProofs(proofs) {
  var area = document.getElementById('bellProofsArea');
  if (!proofs.length) {
    area.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted)">ยังไม่มีรูปยืนยันส่งเข้ามา</div>';
    return;
  }
  area.innerHTML = proofs.map(function(item) {
    if (item.type === 'completion') {
      var p = item.completionProof;
      var timeStr = new Date(p.confirmedAt).toLocaleTimeString('th-TH');
      var dateStr = new Date(p.confirmedAt).toLocaleDateString('th-TH');
      var photo = p.photoUrl || p.photoBase64 || '';
      var histBtn = (item.history && item.history.length > 0)
        ? ' <button class="btn btn-gray btn-sm" onclick="openProofHistoryModal(\\\'' + escapeHtml(encodeURIComponent(JSON.stringify(item.history))) + '\\\',\\\'' + escapeHtml(item.roundName) + '\\\')">📜 ประวัติ (' + item.history.length + ' รอบก่อน)</button>'
        : '';
      var reBadge = item.isReopened ? ' <span class="badge bg-yellow" style="font-size:.68rem">🟡 กำลังยิงงานเพิ่ม</span>' : '';
      var verBadge = item.version > 1 ? ' <span class="badge bg-blue" style="font-size:.68rem">V' + item.version + '</span>' : '';

      return '<div class="card" style="padding:.85rem;border-left:4px solid var(--blue);margin-bottom:.5rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">' +
          '<div>' +
            '<div style="font-weight:800;font-size:.88rem;color:var(--text)">📦 พนักงาน <b>' + escapeHtml(p.confirmedBy || '-') + '</b> ได้ถ่ายรูปยืนยันการกระจายพัสดุตามขนส่ง <b>' + escapeHtml(item.roundName) + '</b>' + verBadge + reBadge + '</div>' +
            '<div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">บันทึกเมื่อ: ' + dateStr + ' ' + timeStr + ' น.</div>' +
          '</div>' +
          '<div style="display:flex;gap:.35rem">' + imgBtn + histBtn + '</div>' +
        '</div>' +
      '</div>';
    } else {
      var p = item.stagingProof;
      var timeStr = new Date(p.confirmedAt).toLocaleTimeString('th-TH');
      var dateStr = new Date(p.confirmedAt).toLocaleDateString('th-TH');
      var hasImg = !!p.photoUrl;
      var imgBtn = hasImg 
        ? '<button class="btn btn-blue btn-sm" onclick="openAdminProofView(\\\'' + escapeHtml(p.photoUrl) + '\\\',\\\'' + escapeHtml(item.roundName) + '\\\',\\\'' + escapeHtml(p.confirmedBy) + ' (' + timeStr + ')\\\')">🖼️ ดูรูปถ่าย</button>'
        : '<span class="badge bg-gray" style="font-size:.7rem">ปลดล็อกผ่าน PIN</span>';

      return '<div class="card" style="padding:.85rem;border-left:4px solid var(--green);margin-bottom:.5rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">' +
          '<div>' +
            '<div style="font-weight:800;font-size:.88rem;color:var(--text)">📍 ' + escapeHtml(item.roundName) + '</div>' +
            '<div style="font-size:.72rem;color:var(--muted);margin-top:.25rem">ยืนยันโดย: <b>' + escapeHtml(p.confirmedBy || '-') + '</b> (' + dateStr + ' ' + timeStr + ' น.)</div>' +
          '</div>' +
          '<div>' + imgBtn + '</div>' +
        '</div>' +
      '</div>';
    }
  }).join('');
}

function openAdminProofView(url, roundName, meta) {
  document.getElementById('adminProofModalTitle').textContent = '📸 ' + roundName;
  document.getElementById('adminProofModalImg').src = url;
  document.getElementById('adminProofModalMeta').textContent = meta;
  document.getElementById('adminProofPhotoModal').style.display = 'flex';
}

function openProofHistoryModal(historyEncoded, roundName) {
  var listEl = document.getElementById('adminProofHistoryList');
  document.getElementById('adminProofHistoryTitle').textContent = '📜 ประวัติรูปถ่ายปิดยอด: ' + roundName;
  var history = [];
  try {
    history = JSON.parse(decodeURIComponent(historyEncoded));
  } catch(e) {
    history = [];
  }
  
  if (!history.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--muted)">ไม่มีประวัติเวอร์ชันก่อนหน้า</div>';
  } else {
    listEl.innerHTML = history.map(function(v, idx) {
      var photo = v.photoUrl || v.photoBase64 || '';
      var timeStr = v.closedAt ? new Date(v.closedAt).toLocaleString('th-TH') : (v.confirmedAt ? new Date(v.confirmedAt).toLocaleString('th-TH') : '-');
      var imgHtml = photo 
        ? '<img src="' + escapeHtml(photo) + '" style="max-height:160px;max-width:100%;border-radius:.6rem;border:1px solid var(--border);cursor:pointer;object-fit:cover" onclick="openAdminProofView(\\\'' + escapeHtml(photo) + '\\\',\\\'รอบที่ ' + (v.version || (idx+1)) + ' — ' + escapeHtml(roundName) + '\\\',\\\'โดย ' + escapeHtml(v.confirmedBy || v.closedBy || '-') + ' (' + timeStr + ')\\\')">'
        : '<div style="padding:1rem;background:var(--surface2);border-radius:.6rem;color:var(--muted);font-size:.8rem">ไม่มีไฟล์รูปถ่าย</div>';

      return '<div style="background:var(--surface2);padding:.85rem;border-radius:.8rem;border:1px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">' +
          '<b style="color:var(--blue);font-size:.9rem">🏷️ เวอร์ชันที่ ' + (v.version || (idx + 1)) + '</b>' +
          '<span style="font-size:.72rem;color:var(--muted)">ปิดเมื่อ: ' + timeStr + '</span>' +
        '</div>' +
        '<div style="font-size:.75rem;color:var(--muted);margin-bottom:.6rem">บันทึกโดย: <b>' + escapeHtml(v.confirmedBy || v.closedBy || '-') + '</b></div>' +
        '<div>' + imgHtml + '</div>' +
      '</div>';
    }).join('');
  }
  
  document.getElementById('adminProofHistoryModal').style.display = 'flex';
}

function openShortageReportModal(roundId, roundName) {
  fetch('/api/history').then(r=>r.json()).then(d=>{
    if(!d.ok) return;
    var r = d.history.find(x => x.id === roundId);
    if (!r) return;
    var st = r.missingItems || [];
    var nowStr = new Date().toLocaleString('th-TH');
    document.getElementById('shortageReportTitle').textContent = '📋 รายงานพัสดุตกหล่น/ขาดส่งมอบ: ' + roundName;
    
    var lines = [
      '====================================================',
      '📋 รายงานพัสดุตกหล่น / ขาดส่งมอบ (DISCREPANCY REPORT)',
      'กลุ่มขนส่ง: ' + roundName,
      'วันที่-เวลาตรวจสอบ: ' + nowStr,
      'สรุปยอด: สแกนได้ ' + r.done + ' / ทั้งหมด ' + r.total + ' ชิ้น (ขาด ' + r.missing + ' รายการ)',
      '====================================================',
      ''
    ];

    if (!st.length) {
      lines.push('✅ ไม่มีรายการตกหล่น ทุกชิ้นส่งมอบครบ 100%');
    } else {
      st.forEach(function(it, idx) {
        lines.push((idx + 1) + '. Order: ' + (it.order || '—') + ' | Tracking: ' + (it.tracking || '—'));
      });
    }

    lines.push('');
    lines.push('====================================================');
    lines.push('ลงชื่อผู้ตรวจสอบ: .......................................');
    lines.push('ลงชื่อพนักงานขับรถ: .....................................');
    
    document.getElementById('shortageReportText').value = lines.join('\\n');
    document.getElementById('shortageReportModal').style.display = 'flex';
  });
}

function copyShortageText() {
  var ta = document.getElementById('shortageReportText');
  ta.select();
  document.execCommand('copy');
  alert('📋 คัดลอกรายงานของขาดเรียบร้อยแล้ว! สามารถนำไปวางส่งใน LINE หรือระบบ CS ได้ทันที');
}

function printShortageReport() {
  var content = document.getElementById('shortageReportText').value;
  var w = window.open('', '_blank');
  w.document.write('<html><head><title>รายงานพัสดุขาดส่งมอบ</title><style>body{font-family:monospace;white-space:pre-wrap;padding:2rem;line-height:1.5}</style></head><body>' + escapeHtml(content) + '</body></html>');
  w.document.close();
  w.focus();
  w.print();
}

// ── Text Import ─────────────────────────────────────────────────────────────
var parsedTextGroups = null;

function openTextImportModal() {
  document.getElementById('textImportModal').style.display = 'flex';
  document.getElementById('textImportArea').focus();
}

function clearTextImport() {
  document.getElementById('textImportArea').value = '';
  document.getElementById('textImportPreview').style.display = 'none';
  document.getElementById('textImportLog').style.display = 'none';
  parsedTextGroups = null;
}

function doParseTextOrders() {
  var txt = document.getElementById('textImportArea').value.trim();
  if (!txt) { alert('กรุณากรอกข้อความ'); return; }
  var btn = document.getElementById('parseTextBtn');
  btn.disabled = true;
  btn.textContent = 'กำลังตรวจสอบ...';

  fetch('/api/parse-text-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: txt })
  })
  .then(r => r.json())
  .then(d => {
    btn.disabled = false;
    btn.textContent = '🔍 ตรวจสอบข้อความ (Preview)';
    if (!d.ok) { alert(d.err || 'เกิดข้อผิดพลาดในการอ่านข้อความ'); return; }
    
    parsedTextGroups = d.groups;
    document.getElementById('textTotalCount').textContent = d.totalOrders + ' รายการ';
    var list = document.getElementById('textPreviewList');
    list.innerHTML = (d.summary || []).map(function(s) {
      return '<div style="background:var(--surface2);padding:.6rem .8rem;border-radius:.6rem;border:1px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem">' +
          '<b style="font-size:.85rem;color:var(--blue)">' + escapeHtml(s.carrier) + '</b>' +
          '<span class="badge bg-blue" style="font-size:.72rem">' + s.count + ' รายการ</span>' +
        '</div>' +
        '<div style="font-size:.7rem;font-family:monospace;color:var(--muted);word-break:break-all">' +
          escapeHtml(s.orders.slice(0, 5).join(', ')) + (s.orders.length > 5 ? '... (และอีก ' + (s.orders.length - 5) + ' รายการ)' : '') +
        '</div>' +
      '</div>';
    }).join('');
    
    document.getElementById('textImportPreview').style.display = 'block';
  })
  .catch(err => {
    btn.disabled = false;
    btn.textContent = '🔍 ตรวจสอบข้อความ (Preview)';
    alert('ข้อผิดพลาด: ' + err.message);
  });
}

function doConfirmTextImport() {
  if (!parsedTextGroups || !Object.keys(parsedTextGroups).length) {
    alert('ไม่มีข้อมูลที่พร้อมนำเข้า');
    return;
  }
  var btn = document.getElementById('confirmTextImportBtn');
  btn.disabled = true;
  btn.textContent = 'กำลังนำเข้า...';
  var log = document.getElementById('textImportLog');
  log.style.display = 'block';
  log.textContent = 'กำลังสร้างกลุ่มขนส่งและบันทึกออเดอร์...';

  fetch('/api/import-text-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: parsedTextGroups, user: adminUser })
  })
  .then(r => r.json())
  .then(d => {
    btn.disabled = false;
    btn.textContent = '📥 ยืนยันการนำเข้าระบบ';
    if (d.ok) {
      log.textContent = '✅ นำเข้าสำเร็จ! เพิ่มใหม่ ' + d.totalAdded + ' รายการ (ผสาน Tracking เดิม ' + d.totalEnriched + ' รายการ)';
      setTimeout(function() {
        document.getElementById('textImportModal').style.display = 'none';
        clearTextImport();
        loadRounds();
      }, 1500);
    } else {
      log.textContent = '❌ ' + (d.err || 'เกิดข้อผิดพลาดในการนำเข้า');
    }
  })
  .catch(err => {
    btn.disabled = false;
    btn.textContent = '📥 ยืนยันการนำเข้าระบบ';
    log.textContent = '❌ เกิดข้อผิดพลาด: ' + err.message;
  });
}

// ── Admin Real-time SSE ─────────────────────────────────────────────────────
var adminEvtSource = new EventSource('/api/stream');
adminEvtSource.onmessage = function(e) {
  if (e.data === 'pin-request') {
    updateBellBadge();
    if (document.getElementById('bellCenterModal').style.display === 'flex' && bellPasscode === '15806') {
      fetchBellData();
    }
    // Notification Audio Beep/Chime
    try {
      var bellCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = bellCtx.createOscillator();
      var g = bellCtx.createGain();
      o.connect(g); g.connect(bellCtx.destination);
      o.type = 'sine'; o.frequency.value = 587.33; // D5
      g.gain.setValueAtTime(0.3, bellCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.01, bellCtx.currentTime + 0.3);
      o.start(); o.stop(bellCtx.currentTime + 0.3);
    } catch(err){}
  } else if (e.data === 'update') {
    if (document.getElementById('pane-upload').classList.contains('active')) loadRounds();
    if (document.getElementById('pane-kpi').classList.contains('active')) { loadKpi(); loadDashboard(); }
    if (document.getElementById('pane-settings') && document.getElementById('pane-settings').classList.contains('active')) loadBlacklistHub();
    updateBellBadge();
  }
};
adminEvtSource.addEventListener('recall-alert', function(e){
  loadBlacklistHub();
  updateBellBadge();
  if (document.getElementById('bellCenterModal').style.display === 'flex' && bellPasscode === '15806') {
    fetchBellData();
  }
  try {
    var bellCtx = new (window.AudioContext || window.webkitAudioContext)();
    var o = bellCtx.createOscillator(), g = bellCtx.createGain();
    o.connect(g); g.connect(bellCtx.destination);
    o.type = 'sawtooth'; o.frequency.value = 750;
    g.gain.setValueAtTime(0.3, bellCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, bellCtx.currentTime + 0.4);
    o.start(); o.stop(bellCtx.currentTime + 0.4);
  } catch(err){}
});
adminEvtSource.addEventListener('recall-confirmed', function(e){
  loadBlacklistHub();
  updateBellBadge();
  if (document.getElementById('bellCenterModal').style.display === 'flex' && bellPasscode === '15806') {
    fetchBellData();
  }
});
// Feature 1: Admin listens for round-reopened to reload rounds list
adminEvtSource.addEventListener('round-reopened', function(e){
  try {
    var data = JSON.parse(e.data);
    loadRounds(); // Refresh the round list to show updated counts
    updateBellBadge();
    // Play a chime to alert admin
    try {
      var ctx2 = new (window.AudioContext || window.webkitAudioContext)();
      var o2 = ctx2.createOscillator(), g2 = ctx2.createGain();
      o2.connect(g2); g2.connect(ctx2.destination);
      o2.type = 'sine'; o2.frequency.value = 660;
      g2.gain.setValueAtTime(0.25, ctx2.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.01, ctx2.currentTime + 0.4);
      o2.start(); o2.stop(ctx2.currentTime + 0.4);
    } catch(err2){}
  } catch(err){}
});
setupLabelDrop();
updateBellBadge();
setInterval(updateBellBadge, 10000);

</script>`;

  const xlsxCdn = `<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"><\/script>\n<script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>`;
  res.send(sharedHead('SPX Admin') + css + body + xlsxCdn + js);
});

function extractCarrierName(filename) {
  let name = filename;
  name = name.replace(/^\d{8}\s*/, '');
  name = name.replace(/ใบส่งมอบขนส่ง\s*/, '');
  name = name.replace(/\s*\d*\s*(\(\d+\))*\.pdf$/i, '');
  return name.trim() || 'Unknown Carrier';
}

function checkAndAutoReopenRound(round, addedCount, sourceUser) {
  if (!round || !round.isSaved || addedCount <= 0) return false;
  
  round.completionHistory = round.completionHistory || [];
  if (round.completionProof) {
    round.completionHistory.push({
      version: round.completionHistory.length + 1,
      photoUrl: round.completionProof.photoUrl || '',
      photoBase64: round.completionProof.photoBase64 || '',
      confirmedAt: round.completionProof.confirmedAt || round.savedAt || new Date().toISOString(),
      confirmedBy: round.completionProof.confirmedBy || round.savedBy || 'พนักงาน',
      closedAt: round.savedAt,
      closedBy: round.savedBy
    });
  }
  
  round.isSaved = false;
  round.savedAt = null;
  round.savedBy = null;
  round.completionProof = null; // Reset so new close requires a new photo proof
  round.reopenedAt = new Date().toISOString();
  round.reopenedCount = (round.reopenedCount || 0) + addedCount;
  round.reopenedReason = 'มีงานเพิ่ม ' + addedCount + ' รายการ';
  
  scheduleSave();
  broadcastUpdate('round-reopened', {
    roundId: round.id,
    roundName: round.name,
    addedCount,
    historyCount: round.completionHistory.length
  });
  
  logAudit(sourceUser || 'system', 'round-auto-reopened', {
    roundId: round.id,
    roundName: round.name,
    addedCount,
    historyCount: round.completionHistory.length
  });
  
  return true;
}

function addItemsToCarrierRound(carrierName, newItems, uploadedBy) {
  const todayDateStr = new Date().toISOString().slice(0, 10);
  let round = rounds.find(r => (r.carrierName === carrierName || r.name === carrierName) && r.uploadedAt.startsWith(todayDateStr));
  const wasSaved = round ? !!round.isSaved : false;

  if (!round) {
    round = {
      id: genId(),
      name: carrierName,
      carrierName: carrierName,
      uploadedAt: new Date().toISOString(),
      uploadedBy: uploadedBy || '',
      items: [],
      scans: [],
      isSaved: false,
      stagingProof: dailyStagingProof || null,
      completionHistory: []
    };
    rounds.push(round);
  } else {
    round.uploadedBy = uploadedBy || round.uploadedBy;
  }

  let addedCount = 0;
  let dupCount = 0;
  let enrichedCount = 0;
  const nowIso = new Date().toISOString();

  for (const item of newItems) {
    const existing = round.items.find(i => 
      (item.order && i.order && i.order === item.order) || 
      (item.tracking && i.tracking && i.tracking === item.tracking)
    );
    if (!existing) {
      // Function 4: Auto-Blacklist Check at Import
      const bl = blacklist.find(b => 
        (item.tracking && b.tracking === item.tracking) || 
        (item.order && b.order === item.order)
      );
      if (bl) {
        item.recallState = 'PENDING_RECALL';
        item.blacklistReason = bl.reason || 'ออเดอร์ยกเลิก';
        bl.roundId = round.id;
      } else {
        item.recallState = item.recallState || 'NONE';
      }

      // Function 5 & Feature 7: Timestamped Audit Trail & Diff Tagging
      item.importedAt = nowIso;
      item.importedBy = uploadedBy || 'system';
      item.isNewAddition = wasSaved; // If round was already saved, mark as late arrival!

      round.items.push(item);
      addedCount++;
    } else {
      // Function 1: Auto-Enrichment on Locked / Existing Rounds
      let enriched = false;
      if (!existing.tracking && item.tracking) {
        existing.tracking = item.tracking;
        enriched = true;
      }
      if (!existing.order && item.order) {
        existing.order = item.order;
        enriched = true;
      }
      if (enriched) {
        existing.enrichedAt = nowIso;
        enrichedCount++;
      } else {
        dupCount++;
      }
    }
  }

  // Feature 1: Auto-Reopen if round was saved and new items arrived
  if (wasSaved && addedCount > 0) {
    checkAndAutoReopenRound(round, addedCount, uploadedBy);
  }
  
  return { round, addedCount, dupCount, enrichedCount };
}

app.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok:false, err:'ไม่พบไฟล์' });
    const runs  = await extractPdfRuns(req.file.buffer);
    const raw   = extractItems(runs);
    const origName = Buffer.from(req.file.originalname,'latin1').toString('utf8');
    const items = raw.map(it => ({ ...it, src: origName }));
    const incompleteCount = items.filter(it => !it.order || !it.tracking).length;
    const _u = req.headers['x-admin-user'] || '';
    const uploadedBy = _u ? Buffer.from(_u, 'base64').toString('utf8') : '';
    
    const carrierName = extractCarrierName(origName);
    const { round, addedCount, dupCount } = addItemsToCarrierRound(carrierName, items, uploadedBy);
    
    currentRoundId = round.id;
    scheduleSave();
    logAudit(uploadedBy || 'system', 'upload-pdf', { filename: origName, carrier: carrierName, added: addedCount, dup: dupCount, incomplete: incompleteCount });
    res.json({ ok:true, count:addedCount, dupCount, incompleteCount, items, roundId:round.id });
  } catch(err) { res.json({ ok:false, err:'PDF Error: '+err.message }); }
});

// Multi PDF upload
const uploadMulti = multer({ storage: multer.memoryStorage() });
app.post('/upload-multi', uploadMulti.array('pdfs'), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.json({ ok:false, err:'ไม่พบไฟล์' });
    const _u = req.headers['x-admin-user'] || '';
    const uploadedBy = _u ? Buffer.from(_u, 'base64').toString('utf8') : '';
    
    let totalAdded = 0;
    let totalDup = 0;
    let totalIncomplete = 0;
    let allItems = [];
    let lastRoundId = null;

    for (const file of req.files) {
      const origName = Buffer.from(file.originalname,'latin1').toString('utf8');
      const runs  = await extractPdfRuns(file.buffer);
      const items = extractItems(runs).map(it => ({ ...it, src: origName }));
      totalIncomplete += items.filter(it => !it.order || !it.tracking).length;
      allItems = allItems.concat(items);
      
      const carrierName = extractCarrierName(origName);
      const { round, addedCount, dupCount } = addItemsToCarrierRound(carrierName, items, uploadedBy);
      totalAdded += addedCount;
      totalDup += dupCount;
      lastRoundId = round.id;
    }
    
    if (lastRoundId) currentRoundId = lastRoundId;
    scheduleSave();
    logAudit(uploadedBy || 'system', 'upload-multi', { files: req.files.length, added: totalAdded, dup: totalDup, incomplete: totalIncomplete });
    res.json({ ok:true, count:totalAdded, dupCount:totalDup, incompleteCount:totalIncomplete, items:allItems, roundId:lastRoundId });
  } catch(err) { res.json({ ok:false, err:'PDF Error: '+err.message }); }
});

// ── Multi-Carrier Shipping Label Analysis & Import Endpoints ───────────────



app.post('/api/labels/analyze', uploadLabels.array('labels'), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.json({ ok:false, err:'ไม่พบไฟล์ใบปะหน้า' });

    const parseMode = req.body.parseMode || 'text';
    const MAX_BARCODE_PAGES = 20; // จำกัดหน้าสำหรับโหมด QR/Barcode เพื่อป้องกัน Render OOM

    let totalPages = 0;
    const items = [];
    const unrecognized = [];
    const duplicatesInFiles = [];
    const duplicatesWithRounds = [];
    const fileSeen = new Map(); // key -> { file, page }

    // Map existing items in system for cross-round duplicate warning
    const existingOrders = new Map();
    rounds.forEach(r => {
      (r.items || []).forEach(it => {
        if (it.order) existingOrders.set(it.order, r.name);
        if (it.tracking) existingOrders.set(it.tracking, r.name);
      });
    });

    for (const file of req.files) {
      const origName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const pages = await extractAllPdfPages(file.buffer);
      totalPages += pages.length;

      if (parseMode === 'barcode' && totalPages > MAX_BARCODE_PAGES) {
        return res.json({
          ok: false,
          err: `โหมดสแกน QR/Barcode จำกัดไม่เกิน ${MAX_BARCODE_PAGES} หน้าต่อครั้ง (ไฟล์ของคุณมี ${totalPages} หน้า) เพื่อป้องกัน Render เมมโมรี่เต็ม แนะนำให้สลับใช้โหมด "ค้นหาด้วยข้อความ"`
        });
      }

      for (const page of pages) {
        const parsed = parseShippingLabelPage(page.runs, page.pageNum);
        // Anomaly Detection: ตรวจจับเลข Tracking ผิดปกติ
        if (parsed.ok && parsed.tracking) {
          const tr = parsed.tracking;
          let anomalyReason = '';
          if (parsed.carrier.includes('Flash') && !/^TH[0-9A-Z]{12,14}$/.test(tr)) {
            anomalyReason = 'รูปแบบ Tracking Flash ผิดปกติ (' + tr + ')';
          } else if (parsed.carrier.includes('SPX') && !/^TH2[0-9A-Z]{11,13}$/.test(tr)) {
            anomalyReason = 'รูปแบบ Tracking SPX ผิดปกติ (' + tr + ')';
          }
          if (anomalyReason) {
            unrecognized.push({ file: origName, page: page.pageNum, reason: anomalyReason });
          }
        }
        if (!parsed.ok) {
          unrecognized.push({
            file: origName,
            page: page.pageNum,
            reason: 'ไม่พบหมายเลข Order หรือ Tracking ที่รองรับ'
          });
          continue;
        }

        const dupKey = parsed.order || parsed.tracking;
        if (fileSeen.has(dupKey)) {
          const prev = fileSeen.get(dupKey);
          duplicatesInFiles.push({
            key: dupKey,
            carrier: parsed.carrier,
            file: origName,
            page: page.pageNum,
            dupWith: `${prev.file} (หน้า ${prev.page})`
          });
          continue; // ข้ามรายการซ้ำในชุดไฟล์เดียวกัน
        }
        fileSeen.set(dupKey, { file: origName, page: page.pageNum });

        // ตรวจสอบซ้ำกับรอบอื่นที่มีอยู่แล้ว (เตือน แต่ยังนำเข้าได้)
        if (existingOrders.has(dupKey)) {
          duplicatesWithRounds.push({
            key: dupKey,
            order: parsed.order,
            tracking: parsed.tracking,
            carrier: parsed.carrier,
            existingRound: existingOrders.get(dupKey)
          });
        }

        items.push({
          order: parsed.order,
          tracking: parsed.tracking,
          carrier: parsed.carrier,
          src: origName,
          page: page.pageNum
        });
      }
    }

    // Group summary by carrier
    const byCarrier = {};
    items.forEach(it => {
      byCarrier[it.carrier] = (byCarrier[it.carrier] || 0) + 1;
    });

    res.json({
      ok: true,
      filesCount: req.files.length,
      totalPages,
      totalValid: items.length,
      byCarrier,
      items,
      unrecognized,
      duplicatesInFiles,
      duplicatesWithRounds
    });
  } catch(err) {
    res.json({ ok:false, err: 'เกิดข้อผิดพลาดในการวิเคราะห์ใบปะหน้า: ' + err.message });
  }
});

app.post('/api/labels/confirm-import', async (req, res) => {
  try {
    const { items, baseFileName } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.json({ ok:false, err:'ไม่มีรายการที่จะนำเข้า' });
    }
    const _u = req.headers['x-admin-user'] || '';
    const uploadedBy = _u ? Buffer.from(_u, 'base64').toString('utf8') : '';

    // จัดกลุ่มตามขนส่ง เพื่อสร้าง round แยกตามเจ้า
    const carrierGroups = {};
    items.forEach(it => {
      const c = it.carrier || 'อื่นๆ';
      if (!carrierGroups[c]) carrierGroups[c] = [];
      carrierGroups[c].push({
        id: genId(),
        order: it.order || '',
        tracking: it.tracking || '',
        src: it.src || baseFileName || 'ใบปะหน้า'
      });
    });

    const createdRounds = [];
    const todayDateStr = new Date().toISOString().slice(0, 10);

    for (const [carrier, cItems] of Object.entries(carrierGroups)) {
      // สร้างชื่อรอบ: ชื่อไฟล์ - ชื่อขนส่ง (หรือถ้าไม่มีชื่อไฟล์ก็ใช้ชื่อขนส่ง)
      let cleanBase = (baseFileName || '').replace(/\.pdf$/i, '').trim();
      let roundName = cleanBase ? `${cleanBase} - ${carrier}` : `${carrier} (${todayDateStr})`;
      
      const newRound = {
        id: genId(),
        name: roundName,
        carrierName: carrier,
        uploadedAt: new Date().toISOString(),
        uploadedBy: uploadedBy || '',
        items: cItems,
        scans: [],
        isSaved: false
      };
      rounds.push(newRound);
      createdRounds.push({ id: newRound.id, name: roundName, count: cItems.length, carrier });
    }

    if (createdRounds.length > 0) {
      currentRoundId = createdRounds[0].id;
    }
    scheduleSave();
    logAudit(uploadedBy || 'system', 'import-labels', {
      total: items.length,
      rounds: createdRounds.map(r => `${r.name} (${r.count})`).join(', ')
    });

    res.json({ ok:true, rounds: createdRounds, totalImported: items.length });
  } catch(err) {
    res.json({ ok:false, err: 'เกิดข้อผิดพลาดในการนำเข้า: ' + err.message });
  }
});

// ── Download Template PDFs Endpoint ─────────────────────────────────────────
app.get('/api/templates/download/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename || '');
  const dir1 = path.join(__dirname, 'template_manifest');
  const dir2 = path.join(__dirname, 'template_tacking');
  let filePath = path.join(dir1, safeFilename);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(dir2, safeFilename);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Template file not found');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(filePath);
});

// ── Document Conversion Endpoints (Cross Template Generation) ──────────────
// 1. ใบปะหน้า -> สร้างใบส่งมอบ (Manifest)
app.post('/api/templates/generate-manifest-from-labels', uploadLabels.single('labelPdf'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, err: 'กรุณาแนบไฟล์ PDF ใบปะหน้า' });
    const origName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const pages = await extractAllPdfPages(req.file.buffer);
    if (!pages || !pages.length) return res.json({ ok: false, err: 'ไม่สามารถอ่านหน้า PDF ได้' });

    const items = [];
    const seen = new Set();
    let carrierName = '';

    for (const page of pages) {
      const parsed = parseShippingLabelPage(page.runs, page.pageNum);
      if (parsed.ok) {
        if (!carrierName && parsed.carrier && parsed.carrier !== 'อื่นๆ') {
          carrierName = parsed.carrier;
        }
        const key = (parsed.order || '') + '|' + (parsed.tracking || '');
        if (key !== '|' && !seen.has(key)) {
          seen.add(key);
          items.push({
            order: parsed.order || '',
            tracking: parsed.tracking || '',
            carrier: parsed.carrier || 'ทั่วไป'
          });
        }
      }
    }

    if (!items.length) {
      return res.json({ ok: false, err: 'ไม่พบข้อมูลเลขออเดอร์หรือ Tracking จากใบปะหน้าที่แนบมา' });
    }

    res.json({
      ok: true,
      filename: origName,
      carrier: carrierName || 'รวมขนส่ง',
      items: items,
      total: items.length
    });
  } catch (err) {
    res.json({ ok: false, err: 'เกิดข้อผิดพลาดในการประมวลผล: ' + err.message });
  }
});

// 2. ใบส่งมอบ -> สร้างใบปะหน้า (Shipping Labels)
app.post('/api/templates/generate-labels-from-manifest', upload.single('manifestPdf'), async (req, res) => {
  try {
    if (!req.file) return res.json({ ok: false, err: 'กรุณาแนบไฟล์ PDF ใบส่งมอบ' });
    const origName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const runs = await extractPdfRuns(req.file.buffer);
    const raw = extractItems(runs);

    if (!raw || !raw.length) {
      return res.json({ ok: false, err: 'ไม่พบรายการออเดอร์ในไฟล์ใบส่งมอบ' });
    }

    const carrierName = extractCarrierName(origName);
    const seen = new Set();
    const items = [];

    raw.forEach(it => {
      const key = (it.order || '') + '|' + (it.tracking || '');
      if (key !== '|' && !seen.has(key)) {
        seen.add(key);
        items.push({
          order: it.order || '',
          tracking: it.tracking || '',
          carrier: it.carrier || carrierName || 'พัสดุด่วน'
        });
      }
    });

    res.json({
      ok: true,
      filename: origName,
      carrier: carrierName || 'พัสดุด่วน',
      items: items,
      total: items.length
    });
  } catch (err) {
    res.json({ ok: false, err: 'เกิดข้อผิดพลาดในการประมวลผล: ' + err.message });
  }
});


app.post('/api/parse-text-orders', (req, res) => {
  try {
    const rawText = req.body.text || '';
    if (!rawText.trim()) return res.json({ ok: false, err: 'กรุณากรอกข้อความ' });
    const groups = parseTextOrders(rawText);
    let totalOrders = 0;
    const summary = Object.keys(groups).map(carrier => {
      const count = groups[carrier].length;
      totalOrders += count;
      return { carrier, count, orders: groups[carrier] };
    });
    res.json({ ok: true, summary, totalOrders, groups });
  } catch(e) {
    res.json({ ok: false, err: e.message });
  }
});

app.post('/api/import-text-orders', (req, res) => {
  try {
    const groups = req.body.groups || {};
    const _u = req.headers['x-admin-user'] || '';
    const uploadedBy = _u ? Buffer.from(_u, 'base64').toString('utf8') : (req.body.user || 'Admin');
    
    let totalAdded = 0;
    let totalEnriched = 0;
    let totalDup = 0;
    const resultSummary = [];
    let lastRoundId = null;

    for (const carrier of Object.keys(groups)) {
      const orders = groups[carrier] || [];
      const newItems = orders.map(ord => {
        if (typeof ord === 'object' && ord !== null) {
          return {
            id: genId(),
            order: String(ord.order || ''),
            tracking: String(ord.tracking || ''),
            src: ord.src || 'Text Import'
          };
        }
        return {
          id: genId(),
          order: String(ord),
          tracking: '',
          src: 'Text Import'
        };
      });
      const { round, addedCount, dupCount, enrichedCount } = addItemsToCarrierRound(carrier, newItems, uploadedBy);
      totalAdded += addedCount;
      totalEnriched += (enrichedCount || 0);
      totalDup += dupCount;
      lastRoundId = round.id;
      resultSummary.push({ carrier, added: addedCount, enriched: enrichedCount || 0, dup: dupCount, roundId: round.id });
    }

    if (lastRoundId) currentRoundId = lastRoundId;
    scheduleSave();
    broadcastUpdate();
    logAudit(uploadedBy, 'import-text-orders', { totalAdded, totalEnriched, totalDup, carriers: Object.keys(groups).length });
    res.json({ ok: true, totalAdded, totalEnriched, totalDup, resultSummary });
  } catch(e) {
    res.json({ ok: false, err: e.message });
  }
});

// ─── STAGING PROOF & PC PIN BYPASS API ──────────────────────────────────────
app.post('/api/staging-proof', (req, res) => {
  try {
    const { roundId, imageBase64, user } = req.body;
    const r = getRound(roundId) || currentRound();
    if (!r) return res.json({ ok: false, err: 'ไม่พบกลุ่มขนส่ง' });

    let photoUrl = '';
    if (imageBase64) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const filename = `staging_${Date.now()}.jpg`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      photoUrl = `/uploads/proofs/${filename}`;
    }

    dailyStagingProof = {
      confirmed: true,
      photoUrl: photoUrl,
      photoBase64: imageBase64 ? imageBase64.substring(0, 1000000) : '',
      confirmedAt: new Date().toISOString(),
      confirmedBy: user || 'พนักงาน',
      method: 'camera'
    };

    // Propagate to all rounds so all carriers are immediately unlocked
    rounds.forEach(round => {
      round.stagingProof = dailyStagingProof;
    });

    scheduleSave();
    broadcastUpdate();
    logAudit(user || 'system', 'staging-proof', { method: 'camera' });
    res.json({ ok: true, msg: 'ยืนยันสถานที่จุดรอกระจายสาขาเรียบร้อย!', stagingProof: dailyStagingProof });
  } catch(e) {
    res.json({ ok: false, err: e.message });
  }
});

app.post('/api/request-pin', (req, res) => {
  try {
    const { roundId, user } = req.body;
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const reqItem = {
      id: genId(),
      roundId: roundId || 'global',
      roundName: 'สถานที่จุดรอกระจายสาขา',
      user: user || 'พนักงาน (PC)',
      pin,
      requestedAt: new Date().toISOString(),
      status: 'pending'
    };

    pendingPinRequests = pendingPinRequests.filter(p => p.status !== 'pending');
    pendingPinRequests.unshift(reqItem);
    if (pendingPinRequests.length > 50) pendingPinRequests.pop();

    broadcastUpdate('pin-request');
    res.json({ ok: true, msg: 'ส่งคำขอไปยังกระดิ่งแอดมินแล้ว กรุณาแจ้งแอดมินเพื่อรับรหัส PIN', requestId: reqItem.id });
  } catch(e) {
    res.json({ ok: false, err: e.message });
  }
});

app.get('/api/admin/bell-count', (_req, res) => {
  const pinCount = pendingPinRequests.filter(p => p.status === 'pending').length;
  const recallCount = blacklist.filter(b => b.state === 'PENDING_RECALL').length;
  res.json({ ok: true, count: pinCount + recallCount, pinCount, recallCount });
});

app.post('/api/admin/bell-notifications', (req, res) => {
  const passcode = req.body.passcode || req.headers['x-bell-passcode'] || '';
  if (passcode !== '15806') {
    return res.json({ ok: false, err: 'รหัสเข้ากระดิ่งไม่ถูกต้อง' });
  }

  const pending = pendingPinRequests.filter(p => p.status === 'pending');
  const pendingRecalls = blacklist.filter(b => b.state === 'PENDING_RECALL');
  
  const allProofs = [];
  if (dailyStagingProof && dailyStagingProof.confirmed) {
    allProofs.push({
      roundId: 'global-staging',
      roundName: 'สถานที่จุดรอกระจายสาขา (เริ่มต้น)',
      type: 'staging',
      stagingProof: dailyStagingProof
    });
  }

  rounds.forEach(r => {
    if (r.completionProof && r.completionProof.confirmed && (r.completionProof.photoUrl || r.completionProof.photoBase64)) {
      allProofs.push({
        roundId: r.id,
        roundName: r.carrierName || r.name,
        type: 'completion',
        completionProof: r.completionProof,
        history: r.completionHistory || [],
        version: (r.completionHistory ? r.completionHistory.length : 0) + 1
      });
    } else if (r.completionHistory && r.completionHistory.length > 0) {
      const last = r.completionHistory[r.completionHistory.length - 1];
      allProofs.push({
        roundId: r.id,
        roundName: r.carrierName || r.name,
        type: 'completion',
        completionProof: last,
        history: r.completionHistory || [],
        version: r.completionHistory.length,
        isReopened: true
      });
    }
  });

  res.json({ ok: true, pendingRequests: pending, pendingRecalls, proofs: allProofs });
});

app.post('/api/admin/approve-pin', (req, res) => {
  const { requestId, passcode } = req.body;
  if (passcode !== '15806') return res.json({ ok: false, err: 'รหัสไม่ถูกต้อง' });
  const item = pendingPinRequests.find(p => p.id === requestId);
  if (!item) return res.json({ ok: false, err: 'ไม่พบคำขอ' });
  res.json({ ok: true, pin: item.pin, user: item.user, roundName: item.roundName });
});

app.post('/api/verify-pin', (req, res) => {
  const { pin, user } = req.body;
  const pinTrimmed = (pin || '').trim();
  const pinReq = pendingPinRequests.find(p => p.pin === pinTrimmed && p.status === 'pending');
  if (!pinReq) {
    return res.json({ ok: false, err: 'รหัส PIN ไม่ถูกต้อง หรือยังไม่ได้รับอนุมัติ' });
  }

  pinReq.status = 'approved';
  dailyStagingProof = {
    confirmed: true,
    photoUrl: '',
    photoBase64: '',
    confirmedAt: new Date().toISOString(),
    confirmedBy: user || pinReq.user,
    method: 'pin'
  };

  rounds.forEach(round => {
    round.stagingProof = dailyStagingProof;
  });

  scheduleSave();
  broadcastUpdate();
  logAudit(user || 'system', 'staging-pin-bypass', { pin: pinTrimmed });
  res.json({ ok: true, msg: 'ปลดล็อกเรียบร้อย เริ่มยิงได้ทุกขนส่ง!', stagingProof: dailyStagingProof });
});

app.post('/check', (req, res) => {
  const code       = (req.body.code || '').trim().toUpperCase();
  const user       = req.body.user || '';
  const reqRoundId = req.body.roundId || currentRoundId;
  const globalScan = false; // Disabled per feedback

  if (!code || code.length < 5 || code.length > 30)
    return res.json({ result:'err', msg:'⚠️ รหัสไม่ถูกต้อง', ...statsPayload() });

  // 1. Dual-Key Recall Check: Worker scanned box that is in PENDING_RECALL (Retrieval Mission Confirmed!)
  const pendingRecallItem = blacklist.find(b => 
    (b.code === code || b.orderCode === code || (b.code && code.includes(b.code)) || (b.orderCode && code.includes(b.orderCode))) &&
    b.state === 'PENDING_RECALL'
  );
  if (pendingRecallItem) {
    pendingRecallItem.state = 'RECALLED';
    pendingRecallItem.recalledAt = new Date().toISOString();
    pendingRecallItem.recalledBy = user;

    // Update in all rounds
    rounds.forEach(r => {
      const it = (r.items || []).find(x => 
        x.tracking === code || x.order === code || 
        x.tracking === pendingRecallItem.code || x.order === pendingRecallItem.orderCode
      );
      if (it) {
        it.recallState = 'RECALLED';
        it.recalledAt = pendingRecallItem.recalledAt;
        it.recalledBy = user;
      }
    });

    scheduleSave();
    broadcastUpdate('recall-confirmed', { 
      code: pendingRecallItem.code || code, 
      orderCode: pendingRecallItem.orderCode || code, 
      user,
      reason: pendingRecallItem.reason
    });
    logAudit(user || 'system', 'recall-confirmed', { code, orderCode: pendingRecallItem.orderCode });

    const targetR = getRound(pendingRecallItem.roundId) || getRound(reqRoundId) || currentRound();
    return res.json({
      result: 'recalled_ok',
      msg: '🎉 ดึงพัสดุคืนสำเร็จ! ออเดอร์ ' + (pendingRecallItem.orderCode || pendingRecallItem.code) + ' ถูกตัดออกจากรอบแล้ว',
      recalledItem: pendingRecallItem,
      ...statsPayload(targetR)
    });
  }

  // 2. Dual-Key Intercept: Canceled / Blacklisted items
  const blacklisted = blacklist.find(b => 
    (b.code === code || b.orderCode === code || (b.code && code.includes(b.code)) || (b.orderCode && code.includes(b.orderCode))) &&
    b.state !== 'RESTORED'
  );
  if (blacklisted) {
    if (blacklisted.state === 'PENDING_SCAN') {
      // Passive Blocker: Intercept before scanned into pile!
      blacklisted.state = 'RECALLED'; // Worker has the box and must separate it
      blacklisted.recalledAt = new Date().toISOString();
      blacklisted.recalledBy = user;

      rounds.forEach(r => {
        const it = (r.items || []).find(x => 
          x.tracking === code || x.order === code || 
          x.tracking === blacklisted.code || x.order === blacklisted.orderCode
        );
        if (it) {
          it.recallState = 'RECALLED';
          it.recalledAt = blacklisted.recalledAt;
          it.recalledBy = user;
        }
      });

      scheduleSave();
      broadcastUpdate();
      logAudit(user || 'system', 'scan-intercepted', { code, reason: blacklisted.reason });

      const targetR = getRound(blacklisted.roundId) || getRound(reqRoundId) || currentRound();
      return res.json({
        result: 'err_intercepted',
        msg: `⛔ ออเดอร์นี้ถูกยกเลิกแล้ว ห้ามส่ง! (${blacklisted.reason || 'ระงับการจัดส่ง'}) กรุณาแยกกล่องออกทันที`,
        reason: blacklisted.reason,
        order: blacklisted.orderCode || code,
        tracking: blacklisted.code || code,
        carrierName: blacklisted.carrierName || blacklisted.roundName || '',
        ...statsPayload(targetR)
      });
    } else {
      return res.json({
        result: 'err_blacklist',
        msg: `⛔ พัสดุนี้ถูกระงับ/ยกเลิกแล้ว! (${blacklisted.reason || 'Blacklist'})`,
        ...statsPayload()
      });
    }
  }

  let round;
  let matched;

  if (globalScan) {
    // ลูปหาจากรอบล่าสุดไปเก่าสุด
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i];
      // Exact match ก่อน
      let found = r.items.find(it =>
        (it.tracking && String(it.tracking) === code) ||
        (it.order && String(it.order) === code)
      );
      if (!found) {
        // Fallback: substring match
        found = r.items.find(it => {
          const tr = it.tracking ? String(it.tracking) : '';
          const or = it.order ? String(it.order) : '';
          return (tr && (tr.includes(code) || code.includes(tr))) ||
                 (or && (or.includes(code) || code.includes(or)));
        });
      }
      if (found) {
        round = r;
        matched = found;
        break;
      }
    }
    if (!round) {
      return res.json({ result:'err', msg:'❌ ไม่พบในใบส่งมอบใดๆ เลย', ...statsPayload() });
    }
  } else {
    round = getRound(reqRoundId) || currentRound();
    if (!round) return res.json({ result:'err', msg:'❌ ยังไม่มีใบส่งมอบ', ...statsPayload() });
    matched = round.items.find(it =>
      (it.tracking && String(it.tracking) === code) ||
      (it.order    && String(it.order)    === code)
    );
    if (!matched) {
      matched = round.items.find(it => {
        const tr = it.tracking ? String(it.tracking) : '';
        const or = it.order    ? String(it.order)    : '';
        return (tr && (tr.includes(code) || code.includes(tr))) ||
               (or && (or.includes(code) || code.includes(or)));
      });
    }
    if (!matched) {
      round.scans.push({ code, user, time:new Date().toISOString(), result:'err' });
      recordKpi(user,'err');
      return res.json({ result:'err', msg:'❌ ไม่พบในใบส่งมอบ', ...statsPayload(round) });
    }
  }
  
  if (round.isSaved) {
    return res.json({ result:'err', msg:'🔒 กลุ่มขนส่งนี้ปิดยอดไปแล้ว ไม่สามารถแสกนเพิ่มได้', ...statsPayload(round) });
  }

  const key    = matched.tracking || matched.order;
  const prevOk = round.scans.find(s => s.result==='ok' &&
    (s.code===matched.tracking||s.code===matched.order||s.code===key));
  
  if (prevOk) {
    round.scans.push({ code, user, time:new Date().toISOString(), result:'dup' });
    recordKpi(user,'dup');
    const scanTimeStr = new Date(prevOk.time).toLocaleTimeString('th-TH');
    return res.json({ result:'dup', msg:'⚠️ ถูกยิงไปแล้วโดย ' + prevOk.user + ' เวลา ' + scanTimeStr, roundId: round.id, scannedBy: prevOk.user, scanTime: prevOk.time, ...statsPayload(round) });
  }

  const newScan = { code:key, user, time:new Date().toISOString(), result:'ok' };
  round.scans.push(newScan);
  recordKpi(user,'ok');
  scheduleSave();
  broadcastUpdate(); // SSE Real-time
  
  // Calculate new stats for this specific round
  const st = roundStats(round);
  const okScans = round.scans.filter(s=>s.result==='ok');

  return res.json({ 
    result:'ok', 
    msg:'✅ ถูกต้อง — พัสดุอยู่ในใบส่งมอบ', 
    roundId: round.id,
    todayCount: getTodayScans(),
    total: st.total,
    done: st.done,
    scanned: st.scannedKeys,
    scannedDetails: okScans,
    scannedBy: user,
    scanTime: newScan.time
  });
});

app.post('/api/save-round', (req, res) => {
  const { roundId, user, imageBase64 } = req.body;
  const round = getRound(roundId);
  if (!round) return res.json({ ok: false, err: 'ไม่พบรอบข้อมูล' });
  if (round.isSaved) return res.json({ ok: false, err: 'กลุ่มขนส่งนี้ปิดยอดไปแล้ว' });

  // Function 8: Prevent Leakage on Close (block saveRound if PENDING_RECALL items exist in pile)
  const pendingRecalls = (round.items || []).filter(it => it.recallState === 'PENDING_RECALL');
  if (pendingRecalls.length > 0) {
    const list = pendingRecalls.map(it => it.order || it.tracking).join(', ');
    logAudit(user || 'system', 'save-round-blocked-recall', { roundId, pendingRecalls: pendingRecalls.length });
    return res.json({ 
      ok: false, 
      result: 'reject', 
      msg: `🚨 ไม่สามารถปิดยอดได้! มีพัสดุยื่นยกเลิกที่ยังไม่ได้ดึงออกจากกอง ${pendingRecalls.length} ชิ้น (${list}) กรุณานำออกจากกองและสแกนยืนยันก่อนปิดยอด` 
    });
  }

  const st = roundStats(round);
  const okScans = (round.scans || []).filter(s => s.result === 'ok');
  const uniqueScanned = new Set(okScans.map(s => s.code));

  if (st.isComplete && st.total > 0) {
    let completionPhotoUrl = '';
    if (imageBase64) {
      try {
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filename = `completion_${round.id}_${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        completionPhotoUrl = `/uploads/proofs/${filename}`;
      } catch(err) {
        console.error('[completion photo save error]', err.message);
      }
    }

    if (completionPhotoUrl || imageBase64) {
      round.completionProof = {
        confirmed: true,
        photoUrl: completionPhotoUrl,
        photoBase64: imageBase64 ? imageBase64.substring(0, 1000000) : '',
        confirmedAt: new Date().toISOString(),
        confirmedBy: user || 'พนักงาน'
      };
    } else {
      round.completionProof = null;
    }

    round.isSaved = true;
    round.savedAt = new Date().toISOString();
    round.savedBy = user;
    
    // C7: LINE Notify on 100% Save
    if (!round.lineNotified) {
      round.lineNotified = true;
      if (sysSettings.lineNotifyOnComplete !== false) {
        const msg = buildCompletionFlex(round, uniqueScanned.size);
        const payload = typeof msg === 'string' ? msg : [msg];
        sendLineNotify(payload).catch(e => console.error('[C7]', e.message));
      }
      triggerWebhook('round_complete', { roundId: round.id, name: round.name, total: st.total });
    }
    
    scheduleSave();
    broadcastUpdate();
    logAudit(user || 'system', 'save-round', { roundId, result: 'success', hasPhoto: !!completionPhotoUrl });
    return res.json({ ok: true, msg: '✅ ปิดยอดสำเร็จ!', completionProof: round.completionProof });
  } else {
    // Collect missing items from activeItems only
    const missingItems = st.missingItems.map(it => ({
      order: it.order || '—',
      tracking: it.tracking || '—',
      carrierName: round.carrierName || round.name
    }));

    logAudit(user || 'system', 'save-round', { roundId, result: 'reject', missingCount: missingItems.length });
    return res.json({ ok: false, result: 'reject', missingItems, msg: 'ไม่สามารถปิดยอดได้ ขาด ' + missingItems.length + ' รายการ' });
  }
});

app.post('/api/unlock-round', (req, res) => {
  const { roundId } = req.body;
  const round = getRound(roundId);
  if (!round) return res.json({ ok: false, err: 'ไม่พบรอบข้อมูล' });
  round.isSaved = false;
  round.savedBy = null;
  round.savedAt = null;
  round.completionProof = null;
  scheduleSave();
  broadcastUpdate();
  logAudit(req.body.user || 'system', 'unlock-round', { roundId });
  res.json({ ok: true, msg: 'ปลดล็อกเรียบร้อย' });
});

// Feature 8: Undo Scan Endpoint
app.post('/api/undo-scan', (req, res) => {
  const { roundId, user } = req.body;
  const r = getRound(roundId) || currentRound();
  if (!r) return res.json({ ok: false, err: 'ไม่พบรอบ' });
  
  // หาการแสกนล่าสุดของรอบนี้
  if (r.scans.length === 0) return res.json({ ok: false, err: 'ไม่มีประวัติให้ยกเลิก' });
  const lastScan = r.scans.pop(); // เอาอันล่าสุดออก

  // ลด KPI ของคนที่แสกน (ถ้ามี)
  if (lastScan.user && kpi[lastScan.user]) {
    const k = kpi[lastScan.user];
    if (k[lastScan.result] > 0) k[lastScan.result]--;
    const day = lastScan.time ? lastScan.time.slice(0,10) : new Date().toISOString().slice(0,10);
    if (k.daily && k.daily[day] && k.daily[day][lastScan.result] > 0) {
      k.daily[day][lastScan.result]--;
    }
  }

  scheduleSave();
  broadcastUpdate(); // SSE Real-time
  res.json({ ok: true, code: lastScan.code, result: lastScan.result, ...statsPayload(r) });
});

app.get('/get-stats', (req, res) => {
  // support ?roundId=xxx so multiple users can track different rounds
  const rId = req.query.roundId || currentRoundId;
  const r   = getRound(rId) || currentRound();
  if (!r) return res.json({ total:0, done:0, scanned:[], roundName:'', stagingProof: null });
  const st = roundStats(r);
  res.json({ 
    total: st.total, 
    totalOriginal: st.totalOriginal,
    done: st.done, 
    scanned: st.scannedKeys, 
    roundName: r.name, 
    roundId: r.id, 
    todayCount: getTodayScans(), 
    isSaved: r.isSaved, 
    stagingProof: r.stagingProof || null,
    recalledCount: st.recalledCount,
    pendingRecallCount: st.pendingRecallCount
  });
});

app.get('/api/history', (_req, res) => {
  res.json({
    ok: true,
    validateCarrierMismatch: sysSettings.validateCarrierMismatch !== false,
    carrierPrefixes: sysSettings.carrierPrefixes || null,
    history: rounds.slice().reverse().map(r => {
    const st = roundStats(r);
    return { id:r.id, name:r.name, uploadedAt:r.uploadedAt, uploadedBy:r.uploadedBy||'',
             total:st.total, totalOriginal:st.totalOriginal, done:st.done, missing:st.missing, missingItems:st.missingItems,
             isComplete:st.isComplete, isCurrent:r.id===currentRoundId,
             items:r.items, scannedKeys:st.scannedKeys,
             recalledCount:st.recalledCount, pendingRecallCount:st.pendingRecallCount,
             isSaved: r.isSaved, savedBy: r.savedBy, savedAt: r.savedAt, scans: st.scans,
             stagingProof: r.stagingProof || null,
             completionProof: r.completionProof || null,
             completionHistory: r.completionHistory || [],
             reopenedCount: r.reopenedCount || 0,
             reopenedAt: r.reopenedAt || null,
             reopenedReason: r.reopenedReason || '' };
  })});
});

app.get('/api/kpi', (_req, res) => res.json({ ok:true, kpi, employees:EMPLOYEES }));

// ─── BACKUP / RESTORE (C1) ────────────────────────────────────────────────────
app.get('/api/backup', (req, res) => {
  res.json({ rounds, sysSettings, blacklist, kpi, EMPLOYEES });
});
app.post('/api/restore', (req, res) => {
  try {
    const data = req.body;
    if (data.rounds) rounds = data.rounds;
    if (data.sysSettings) sysSettings = { ...sysSettings, ...data.sysSettings };
    if (data.blacklist) blacklist = data.blacklist;
    if (data.kpi) kpi = data.kpi;
    scheduleSave();
    logAudit(req.body.user || 'system', 'restore', {});
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// ─── UPGRADED BLACKLIST & CANCELED ORDER RECALL SYSTEM ─────────────────────────
function normalizeBlacklist() {
  blacklist = (blacklist || []).map(b => {
    if (typeof b === 'string') {
      return { code: b, orderCode: '', addedAt: new Date().toISOString(), addedBy: 'admin', reason: 'ระงับการจัดส่ง', state: 'PENDING_SCAN' };
    }
    return {
      code: b.code || '',
      orderCode: b.orderCode || '',
      addedAt: b.addedAt || new Date().toISOString(),
      addedBy: b.addedBy || 'admin',
      reason: b.reason || 'ระงับการจัดส่ง',
      roundId: b.roundId || '',
      roundName: b.roundName || '',
      carrierName: b.carrierName || '',
      state: b.state || 'PENDING_SCAN',
      scannedBeforeCancel: !!b.scannedBeforeCancel,
      recalledAt: b.recalledAt || null,
      recalledBy: b.recalledBy || null
    };
  });
}

app.get('/api/blacklist', (req, res) => {
  normalizeBlacklist();
  const counts = {
    total: blacklist.length,
    pendingRecall: blacklist.filter(b => b.state === 'PENDING_RECALL').length,
    pendingScan: blacklist.filter(b => b.state === 'PENDING_SCAN').length,
    recalled: blacklist.filter(b => b.state === 'RECALLED').length,
    restored: blacklist.filter(b => b.state === 'RESTORED').length
  };
  res.json({ ok: true, blacklist, counts });
});

app.get('/api/blacklist/pending-recalls', (req, res) => {
  normalizeBlacklist();
  const rId = req.query.roundId;
  let list = blacklist.filter(b => b.state === 'PENDING_RECALL');
  if (rId) list = list.filter(b => !b.roundId || b.roundId === rId);
  res.json({ ok: true, pendingRecalls: list });
});

app.post('/api/blacklist/add-canceled', (req, res) => {
  try {
    normalizeBlacklist();
    const rawOrders = (req.body.orders || '').trim();
    const reason    = (req.body.reason || 'ลูกค้ายกเลิกคำสั่งซื้อ').trim();
    const user      = req.body.user || 'admin';
    const reqRoundId = req.body.roundId || '';

    if (!rawOrders) return res.json({ ok: false, err: 'กรุณาระบุเลขออเดอร์หรือ Tracking' });

    // Split by newlines, commas, semicolons
    const rawLines = rawOrders.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    const processedCodes = [];
    const summary = { totalAdded: 0, urgentRecallCount: 0, pendingScanCount: 0, items: [] };

    rawLines.forEach(line => {
      // Clean string: e.g. "Flash Express - 261002HC8GJ8X3" -> "261002HC8GJ8X3"
      let cleanCode = line;
      if (cleanCode.includes('-')) {
        const parts = cleanCode.split('-');
        cleanCode = parts[parts.length - 1].trim();
      }
      cleanCode = cleanCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (!cleanCode || cleanCode.length < 5) return;
      if (processedCodes.includes(cleanCode)) return;
      processedCodes.push(cleanCode);

      // Dual-Key Intercept Search across rounds
      let foundItem = null;
      let targetRound = null;

      if (reqRoundId) {
        const r = getRound(reqRoundId);
        if (r) {
          const it = (r.items || []).find(x => 
            (x.tracking && x.tracking.toUpperCase() === cleanCode) ||
            (x.order && x.order.toUpperCase() === cleanCode)
          );
          if (it) { foundItem = it; targetRound = r; }
        }
      }

      if (!foundItem) {
        for (let i = rounds.length - 1; i >= 0; i--) {
          const r = rounds[i];
          const it = (r.items || []).find(x => 
            (x.tracking && x.tracking.toUpperCase() === cleanCode) ||
            (x.order && x.order.toUpperCase() === cleanCode)
          );
          if (it) {
            foundItem = it;
            targetRound = r;
            break;
          }
        }
      }

      let trackingNo = '';
      let orderId = '';
      let roundId = targetRound ? targetRound.id : '';
      let roundName = targetRound ? targetRound.name : '';
      let carrierName = targetRound ? (targetRound.carrierName || targetRound.name) : '';

      if (foundItem) {
        trackingNo = foundItem.tracking || '';
        orderId = foundItem.order || '';
      } else {
        if (/^(TH|LEX|THT|KER|SPX|FLASH)/i.test(cleanCode)) {
          trackingNo = cleanCode;
        } else {
          orderId = cleanCode;
        }
      }

      // Retroactive Recall Check: Was this item already scanned with result 'ok'?
      let alreadyScanned = false;
      let scannedByIndex = -1;
      let scannerUser = '';

      if (targetRound && Array.isArray(targetRound.scans)) {
        scannedByIndex = targetRound.scans.findIndex(s => 
          s.result === 'ok' && (
            (trackingNo && s.code === trackingNo) ||
            (orderId && s.code === orderId) ||
            s.code === cleanCode
          )
        );
        if (scannedByIndex !== -1) {
          alreadyScanned = true;
          scannerUser = targetRound.scans[scannedByIndex].user || '';
        }
      }

      const state = alreadyScanned ? 'PENDING_RECALL' : 'PENDING_SCAN';

      if (foundItem) {
        foundItem.recallState = state;
        foundItem.canceledAt = new Date().toISOString();
        foundItem.cancelReason = reason;
        foundItem.canceledBy = user;
      }

      if (alreadyScanned && targetRound) {
        // Unmark scan from round.scans
        const removedScan = targetRound.scans.splice(scannedByIndex, 1)[0];
        if (removedScan && removedScan.user && kpi[removedScan.user] && kpi[removedScan.user].ok > 0) {
          kpi[removedScan.user].ok--;
        }
        summary.urgentRecallCount++;
      } else {
        summary.pendingScanCount++;
      }

      // Add or update in blacklist
      const existingIdx = blacklist.findIndex(b => 
        (trackingNo && b.code === trackingNo) ||
        (orderId && b.orderCode === orderId) ||
        b.code === cleanCode || b.orderCode === cleanCode
      );

      const entry = {
        code: trackingNo || cleanCode,
        orderCode: orderId || (trackingNo ? '' : cleanCode),
        addedAt: new Date().toISOString(),
        addedBy: user,
        reason,
        roundId,
        roundName,
        carrierName,
        state,
        scannedBeforeCancel: alreadyScanned,
        recalledAt: null,
        recalledBy: null
      };

      if (existingIdx !== -1) {
        blacklist[existingIdx] = { ...blacklist[existingIdx], ...entry };
      } else {
        blacklist.unshift(entry);
      }

      summary.totalAdded++;
      summary.items.push(entry);

      // Real-time broadcast if urgent recall needed
      if (alreadyScanned) {
        broadcastUpdate('recall-alert', {
          roundId,
          roundName,
          carrierName,
          code: trackingNo || cleanCode,
          orderCode: orderId || cleanCode,
          tracking: trackingNo,
          reason,
          state: 'PENDING_RECALL',
          scannerUser
        });
      }
    });

    scheduleSave();
    broadcastUpdate();
    logAudit(user, 'blacklist-add-canceled', { count: summary.totalAdded, urgent: summary.urgentRecallCount, reason });
    res.json({ ok: true, summary });
  } catch(e) {
    res.json({ ok: false, err: e.message });
  }
});

app.post('/api/blacklist/recall-confirm', (req, res) => {
  normalizeBlacklist();
  const rawCode = (req.body.code || '').trim().toUpperCase();
  const user = req.body.user || 'worker';
  if (!rawCode) return res.json({ ok: false, err: 'กรุณาระบุรหัสพัสดุ' });

  // Match code against PENDING_RECALL or PENDING_SCAN
  const item = blacklist.find(b => 
    (b.code === rawCode || b.orderCode === rawCode || (b.code && rawCode.includes(b.code)) || (b.orderCode && rawCode.includes(b.orderCode))) &&
    (b.state === 'PENDING_RECALL' || b.state === 'PENDING_SCAN')
  );

  if (!item) {
    return res.json({ ok: false, err: 'ไม่พบรายการยกเลิกที่ตรงกับรหัส ' + rawCode });
  }

  item.state = 'RECALLED';
  item.recalledAt = new Date().toISOString();
  item.recalledBy = user;

  // Update in round items
  rounds.forEach(r => {
    const it = (r.items || []).find(x => 
      x.tracking === rawCode || x.order === rawCode || 
      x.tracking === item.code || x.order === item.orderCode
    );
    if (it) {
      it.recallState = 'RECALLED';
      it.recalledAt = item.recalledAt;
      it.recalledBy = user;
    }
  });

  scheduleSave();
  broadcastUpdate('recall-confirmed', { 
    code: item.code, 
    orderCode: item.orderCode, 
    carrierName: item.carrierName,
    roundId: item.roundId,
    user 
  });
  logAudit(user, 'recall-confirmed', { code: item.code, orderCode: item.orderCode });

  const targetR = getRound(item.roundId) || currentRound();
  res.json({ ok: true, msg: '🎉 ยืนยันการดึงพัสดุคืนสำเร็จ!', item, ...statsPayload(targetR) });
});

app.post('/api/blacklist/restore', (req, res) => {
  normalizeBlacklist();
  const rawCode = (req.body.code || '').trim().toUpperCase();
  const user = req.body.user || 'admin';
  const item = blacklist.find(b => b.code === rawCode || b.orderCode === rawCode);
  if (!item) return res.json({ ok: false, err: 'ไม่พบรายการใน Blacklist' });

  item.state = 'RESTORED';
  item.restoredAt = new Date().toISOString();
  item.restoredBy = user;

  rounds.forEach(r => {
    const it = (r.items || []).find(x => 
      x.tracking === rawCode || x.order === rawCode || 
      x.tracking === item.code || x.order === item.orderCode
    );
    if (it) {
      delete it.recallState;
      delete it.canceledAt;
      delete it.cancelReason;
    }
  });

  scheduleSave();
  broadcastUpdate();
  logAudit(user, 'blacklist-restore', { code: item.code, orderCode: item.orderCode });
  res.json({ ok: true, msg: 'กู้คืนพัสดุเรียบร้อย' });
});

app.post('/api/blacklist/add', (req, res) => {
  normalizeBlacklist();
  const code = (req.body.code || '').trim().toUpperCase();
  const reason = (req.body.reason || 'Blacklist').trim();
  const user = req.body.user || 'admin';
  if (!code) return res.json({ok:false, err:'Missing code'});
  if (!blacklist.find(b => b.code === code || b.orderCode === code)) {
    blacklist.push({ 
      code, 
      orderCode: '', 
      addedAt: new Date().toISOString(), 
      addedBy: user,
      reason,
      state: 'PENDING_SCAN',
      roundId: '',
      roundName: '',
      carrierName: ''
    });
    scheduleSave();
    logAudit(user, 'blacklist-add', { code });
  }
  res.json({ok:true});
});

app.post('/api/blacklist/remove', (req, res) => {
  normalizeBlacklist();
  const code = (req.body.code || '').trim().toUpperCase();
  const item = blacklist.find(b => b.code === code || b.orderCode === code);
  blacklist = blacklist.filter(b => b.code !== code && b.orderCode !== code);

  // Clear recallState if needed
  rounds.forEach(r => {
    const it = (r.items || []).find(x => 
      x.tracking === code || x.order === code || 
      (item && (x.tracking === item.code || x.order === item.orderCode))
    );
    if (it) {
      delete it.recallState;
      delete it.canceledAt;
      delete it.cancelReason;
    }
  });

  scheduleSave();
  broadcastUpdate();
  logAudit(req.body.user || 'system', 'blacklist-remove', { code });
  res.json({ok:true});
});

// ─── AUTO-CLEAN OLD ROUNDS ───────────────────────────────────────────────────
app.post('/api/auto-clean', (req, res) => {
  const days = sysSettings.autoCleanDays || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const before = rounds.length;
  rounds = rounds.filter(r => new Date(r.uploadedAt) >= cutoff);
  const removed = before - rounds.length;
  if (removed > 0) scheduleSave();
  logAudit(req.body.user || 'system', 'auto-clean', { days, removed, remaining: rounds.length });
  res.json({ ok: true, removed, remaining: rounds.length });
});

// ─── ADMIN PASSWORD VERIFICATION ─────────────────────────────────────────────
// (Replaced by C8 Multi-Admin verify-admin below)

// ─── DASHBOARD STATS ─────────────────────────────────────────────────────────
app.get('/api/dashboard-stats', (_req, res) => {
  const now = new Date();
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const dayRounds = rounds.filter(r => {
      const dt = new Date(r.uploadedAt);
      const ry = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
      return ry === ymd;
    });
    let items = 0, done = 0;
    dayRounds.forEach(r => {
      const st = roundStats(r);
      items += st.total;
      done += st.done;
    });
    last7.push({ date: ymd, rounds: dayRounds.length, items, done, missing: items - done });
  }
  // Carrier distribution
  const carrierDist = {};
  rounds.forEach(r => {
    const carrier = detectCarrier(r.carrierName || r.name, (r.items && r.items[0] && r.items[0].tracking) || '');
    const count = (r.items && r.items.length) || 0;
    if (count > 0) {
      carrierDist[carrier] = (carrierDist[carrier] || 0) + count;
    }
  });
  
  // Today Carriers
  const todayDateStr = now.toISOString().slice(0, 10);
  const todayCarriers = {};
  rounds.forEach(r => {
    if (r.uploadedAt && r.uploadedAt.startsWith(todayDateStr)) {
      const carrier = detectCarrier(r.carrierName || r.name, (r.items && r.items[0] && r.items[0].tracking) || '');
      if (!todayCarriers[carrier]) {
        todayCarriers[carrier] = { total: 0, done: 0, isSaved: false, roundId: r.id };
      }
      const st = roundStats(r);
      todayCarriers[carrier].total += st.total;
      todayCarriers[carrier].done += st.done;
      if (r.isSaved) todayCarriers[carrier].isSaved = true;
    }
  });

  // Employee leaderboard
  const leaderboard = EMPLOYEES.map(name => {
    const k = kpi[name] || { ok: 0, dup: 0, err: 0 };
    const total = (k.ok||0) + (k.dup||0) + (k.err||0);
    const rate = total > 0 ? Math.round((k.ok||0) / total * 100) : 0;
    return { name, ok: k.ok||0, dup: k.dup||0, err: k.err||0, total, rate };
  }).sort((a, b) => b.ok - a.ok);
  
  res.json({ ok: true, last7, carrierDist, leaderboard, todayCarriers });
});

app.post('/api/edit-item', (req, res) => {
  const { roundId, itemId, tracking, order } = req.body;
  const r = getRound(roundId); if (!r) return res.json({ ok:false, err:'ไม่พบรอบ' });
  const item = r.items.find(i => i.id===itemId); if (!item) return res.json({ ok:false, err:'ไม่พบรายการ' });
  if (tracking!==undefined) item.tracking = tracking.toUpperCase().trim();
  if (order!==undefined)    item.order    = order.toUpperCase().trim();
  scheduleSave();
  logAudit(req.body.user || 'system', 'edit-item', { roundId, itemId, tracking, order });
  res.json({ ok:true, item });
});

app.post('/api/add-item', (req, res) => {
  const r = getRound(req.body.roundId||currentRoundId);
  if (!r) return res.json({ ok:false, err:'ไม่พบรอบ' });
  const item = { 
    id: genId(), 
    tracking: (req.body.tracking||'').toUpperCase().trim(), 
    order: (req.body.order||'').toUpperCase().trim(),
    importedAt: new Date().toISOString(),
    importedBy: req.body.user || 'Admin',
    isNewAddition: !!r.isSaved
  };
  r.items.push(item);
  if (r.isSaved) {
    checkAndAutoReopenRound(r, 1, req.body.user || 'Admin');
  }
  scheduleSave();
  broadcastUpdate();
  logAudit(req.body.user || 'system', 'add-item', { roundId: r.id, item });
  res.json({ ok:true, item });
});

app.post('/api/delete-item', (req, res) => {
  const r = getRound(req.body.roundId); if (!r) return res.json({ ok:false, err:'ไม่พบรอบ' });
  r.items = r.items.filter(i => i.id!==req.body.itemId);
  scheduleSave();
  logAudit(req.body.user || 'system', 'delete-item', { roundId: r.id, itemId: req.body.itemId });
  res.json({ ok:true });
});

app.post('/api/set-round', (req, res) => {
  if (!getRound(req.body.roundId)) return res.json({ ok:false, err:'ไม่พบรอบ' });
  currentRoundId = req.body.roundId;
  scheduleSave();
  res.json({ ok:true });
});

app.post('/api/log-admin-access', (req, res) => {
  const user = req.body.user || 'unknown';
  adminLog.push({ user, time: new Date().toISOString() });
  scheduleSave();
  res.json({ ok: true });
});

app.get('/api/admin-log', (_req, res) => {
  res.json({ ok: true, logs: adminLog });
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({ ok:true, settings: sysSettings });
});
app.post('/api/settings', (req, res) => {
  const s = req.body;
  if(s) {
    if(s.printTime !== undefined) sysSettings.printTime = s.printTime;
    if(s.autoPrintEnabled !== undefined) sysSettings.autoPrintEnabled = !!s.autoPrintEnabled;
    if(Array.isArray(s.excludeCarriers)) sysSettings.excludeCarriers = s.excludeCarriers;
    if(s.autoCleanEnabled !== undefined) sysSettings.autoCleanEnabled = !!s.autoCleanEnabled;
    if(s.autoCleanDays !== undefined) sysSettings.autoCleanDays = Math.max(1, parseInt(s.autoCleanDays) || 30);
    if(s.voiceEnabled !== undefined) sysSettings.voiceEnabled = !!s.voiceEnabled;
    if(s.thermalMode !== undefined) sysSettings.thermalMode = !!s.thermalMode;
    if(s.validateCarrierMismatch !== undefined) sysSettings.validateCarrierMismatch = !!s.validateCarrierMismatch;
    if(s.carrierPrefixes && typeof s.carrierPrefixes === 'object') {
      sysSettings.carrierPrefixes = s.carrierPrefixes;
    }
    // C7
    if(s.lineNotifyOnComplete !== undefined) sysSettings.lineNotifyOnComplete = !!s.lineNotifyOnComplete;
    if(s.lineMessageStyle !== undefined) sysSettings.lineMessageStyle = s.lineMessageStyle;
    // C10
    if(s.webhookUrl !== undefined) sysSettings.webhookUrl = s.webhookUrl.trim();
    scheduleSave();
    startScheduler(); // restart scheduler with new printTime
  }
  res.json({ ok:true, settings: sysSettings });
});

// ─── C8: Multi-Admin Management ────────────────────────────────────────────────
app.get('/api/admins', (req, res) => res.json({ ok:true, admins: sysSettings.admins || [] }));
app.post('/api/admins/add', (req, res) => {
  const { name, password, role } = req.body;
  if (!name || !password) return res.json({ ok:false, err:'Missing name or password' });
  if (!sysSettings.admins) sysSettings.admins = [];
  sysSettings.admins = sysSettings.admins.filter(a => a.name !== name);
  sysSettings.admins.push({ name, password, role: role || 'admin' });
  scheduleSave();
  logAudit(req.body.user || 'system', 'admin-add', { name, role });
  res.json({ ok:true });
});
app.post('/api/admins/remove', (req, res) => {
  const { name } = req.body;
  sysSettings.admins = (sysSettings.admins || []).filter(a => a.name !== name);
  scheduleSave();
  logAudit(req.body.user || 'system', 'admin-remove', { name });
  res.json({ ok:true });
});
// Update C8 verify-admin to check admins list too
app.post('/api/verify-admin', (req, res) => {
  const { password } = req.body;
  if (!sysSettings.adminPassword && !(sysSettings.admins && sysSettings.admins.length)) return res.json({ ok: true });
  if (sysSettings.adminPassword && password === sysSettings.adminPassword) return res.json({ ok: true, role: 'superadmin' });
  const found = (sysSettings.admins || []).find(a => a.password === password);
  if (found) return res.json({ ok: true, role: found.role, name: found.name });
  res.json({ ok: false });
});

// ─── C9: Audit Log ─────────────────────────────────────────────────────────────
app.get('/api/audit-log', (req, res) => res.json({ ok:true, logs: editLog }));

// ─── C10: Webhook test endpoint ───────────────────────────────────────────────
app.post('/api/webhook/test', async (req, res) => {
  const url = (req.body.url || sysSettings.webhookUrl || '').trim();
  if (!url) return res.json({ ok:false, err:'No webhook URL configured' });
  try {
    const tmp = sysSettings.webhookUrl;
    sysSettings.webhookUrl = url;
    triggerWebhook('test', { message: 'DeliveryDry Webhook Test', timestamp: new Date().toISOString() });
    sysSettings.webhookUrl = tmp;
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, err: e.message }); }
});

// Test LINE connection
app.post('/api/test-line', async (req, res) => {
  try {
    const backupToken = sysSettings.lineToken;
    const backupGroupId = sysSettings.lineGroupId;
    
    // override temporarily for test
    if (req.body.lineToken) sysSettings.lineToken = req.body.lineToken.trim();
    if (req.body.lineGroupId) sysSettings.lineGroupId = req.body.lineGroupId.trim();

    const result = await sendLineNotify('\n🔔 ทดสอบการเชื่อมต่อ LINE Messaging API สำเร็จ!\n📦 SPX Scanner พร้อมส่งรายงานแล้ว');
    
    // restore
    sysSettings.lineToken = backupToken;
    sysSettings.lineGroupId = backupGroupId;
    
    res.json({ ok: result.status === 200 || !result.status, result });
  } catch(e) {
    res.json({ ok:false, err: e.message });
  }
});

// Manually trigger daily summary to LINE
app.post('/api/trigger-line', async (req, res) => {
  try {
    const backupToken = sysSettings.lineToken;
    const backupGroupId = sysSettings.lineGroupId;
    
    // override temporarily for test
    if (req.body.lineToken) sysSettings.lineToken = req.body.lineToken.trim();
    if (req.body.lineGroupId) sysSettings.lineGroupId = req.body.lineGroupId.trim();

    const summary = buildDailySummary();
    const msg = formatLineMessage(summary);
    const result = await sendLineNotify(msg);
    
    // restore
    sysSettings.lineToken = backupToken;
    sysSettings.lineGroupId = backupGroupId;
    
    res.json({ ok: result.status === 200 || !result.status, result, summary });
  } catch(e) {
    res.json({ ok:false, err: e.message });
  }
});

// Auto-print endpoint: returns today's rounds (filtered) for auto-print
app.get('/api/auto-print', (req, res) => {
  const summary = buildDailySummary();
  if (!summary) return res.json({ ok: false, err: 'ไม่มีรอบจัดส่งวันนี้' });
  res.json({ ok: true, summary, roundIds: summary.roundIds });
});

// ─── PRESENCE ─────────────────────────────────────────────────────────────────
let presenceMap = {}; // { user: { roundId, lastSeen } }

app.post('/api/presence', (req, res) => {
  const { user, roundId } = req.body;
  if (!user) return res.json({ ok:false });
  presenceMap[user] = { roundId, lastSeen: Date.now() };
  res.json({ ok:true });
});

app.get('/api/presence', (_req, res) => {
  const now = Date.now();
  // only show users active in last 30s
  const users = Object.entries(presenceMap)
    .filter(([, v]) => now - v.lastSeen < 30000)
    .map(([user, v]) => {
      const r = getRound(v.roundId);
      return { user, roundId: v.roundId, roundName: r ? r.name : '' };
    });
  res.json({ ok:true, users });
});


// ─── ADD ROUND (manual, no PDF) ──────────────────────────────────────────────
app.post('/api/add-round', (req, res) => {
  const { name, user } = req.body;
  if (!name || !name.trim()) return res.json({ ok:false, err:'ต้องระบุชื่อรอบ' });
  const round = {
    id: genId(),
    name: name.trim(),
    uploadedAt: new Date().toISOString(),
    uploadedBy: user || '',
    items: [],
    scans: []
  };
  rounds.push(round);
  currentRoundId = round.id;
  scheduleSave();
  logAudit(user || 'system', 'add-round', { roundId: round.id, name: round.name });
  res.json({ ok:true, round });
});

// ─── DELETE ROUND ─────────────────────────────────────────────────────────────
app.post('/api/delete-round', (req, res) => {
  const { roundId } = req.body;
  if (!getRound(roundId)) return res.json({ ok:false, err:'ไม่พบรอบ' });
  const r = getRound(roundId);
  rounds = rounds.filter(r => r.id !== roundId);
  if (currentRoundId === roundId) currentRoundId = rounds.length ? rounds[rounds.length-1].id : null;
  scheduleSave();
  logAudit(req.body.user || 'system', 'delete-round', { roundId, name: r ? r.name : '' });
  res.json({ ok:true });
});

// ─── RENAME ROUND ─────────────────────────────────────────────────────────────
app.post('/api/rename-round', (req, res) => {
  const { roundId, name } = req.body;
  const r = getRound(roundId);
  if (!r) return res.json({ ok:false, err:'ไม่พบรอบ' });
  if (!name || !name.trim()) return res.json({ ok:false, err:'ต้องระบุชื่อ' });
  const oldName = r.name;
  r.name = name.trim();
  scheduleSave();
  logAudit(req.body.user || 'system', 'rename-round', { roundId, oldName, newName: r.name });
  res.json({ ok:true });
});

// ─── EXPORT: scan log for a round as JSON (client will convert to Excel) ──────
app.get('/api/export/:roundId', (req, res) => {
  const isAll = req.params.roundId === 'all';
  const fromDate = req.query.from;
  const toDate = req.query.to;

  let targetRounds = [];
  if (isAll) {
    targetRounds = rounds.filter(r => {
      const dt = new Date(r.uploadedAt);
      const ymd = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
      if (fromDate && ymd < fromDate) return false;
      if (toDate && ymd > toDate) return false;
      return true;
    });
    if (!targetRounds.length) return res.status(404).json({ ok:false, err:'ไม่พบรอบในช่วงวันที่เลือก' });
  } else {
    const r = getRound(req.params.roundId);
    if (!r) return res.status(404).json({ ok:false, err:'ไม่พบรอบ' });
    targetRounds = [r];
  }

  let allItems = [];
  let allScanLog = [];

  targetRounds.forEach(r => {
    const st = roundStats(r);
    r.items.forEach(it => {
      const scanned = st.scannedKeys.includes(it.tracking) || st.scannedKeys.includes(it.order);
      const scanEvent = r.scans.find(s => s.result==='ok' && (s.code===it.tracking||s.code===it.order));
      allItems.push({
        roundName: r.name,
        tracking: it.tracking,
        order: it.order,
        status: scanned ? 'ยิงแล้ว' : 'ยังไม่ยิง',
        scannedBy: scanEvent ? scanEvent.user : '',
        scannedAt: scanEvent ? scanEvent.time : ''
      });
    });
    r.scans.forEach(s => {
      allScanLog.push({
        roundName: r.name,
        code: s.code, user: s.user, result: s.result,
        time: s.time, date: s.time ? s.time.slice(0,10) : ''
      });
    });
  });

  res.json({
    ok: true,
    round: { 
      id: isAll ? 'all' : targetRounds[0].id, 
      name: isAll ? 'รวมรอบ' : targetRounds[0].name 
    },
    items: allItems,
    scanLog: allScanLog
  });
});

// ─── KPI by date range ────────────────────────────────────────────────────────
app.get('/api/kpi-range', (req, res) => {
  const { from, to } = req.query; // YYYY-MM-DD
  const result = {};
  EMPLOYEES.forEach(emp => {
    const daily = (kpi[emp] || {}).daily || {};
    let ok=0, dup=0, err=0;
    Object.entries(daily).forEach(([day, v]) => {
      if (from && day < from) return;
      if (to   && day > to)   return;
      ok  += v.ok  || 0;
      dup += v.dup || 0;
      err += v.err || 0;
    });
    result[emp] = { ok, dup, err };
  });
  res.json({ ok:true, kpi:result, employees:EMPLOYEES, from, to });
});

// ─── DELIVERY CONFIRMATION PRINT SYSTEM ─────────────────────────────────────

/**
 * detectCarrier(roundName, tracking)
 * Infers carrier from round name keywords + tracking prefix.
 * Rules confirmed by user:
 *   - ชื่อรอบขึ้นต้น "ส่งทันที" → SPX ส่งทันที (order-only)
 *   - ชื่อรอบขึ้นต้น "ด่วนคลัง" → SPX ด่วนคลัง (order-only)
 *   - ชื่อรอบขึ้นต้น "ด่วน" (แต่ไม่ใช่ด่วนคลัง) → SPX ด่วน (order-only)
 *   - TH2... → SPX Express
 *   - THT... → TikTok Shop
 *   - round name Flash/แฟลช → Flash Express
 *   - round name J&T/JT → J&T Express
 *   - round name Kerry/เคอรี่ → Kerry Express
 *   - fallback → อื่นๆ
 */
function detectCarrier(roundName, tracking) {
  const rn = (roundName || '').toLowerCase();
  const rnOrig = (roundName || '').trim();
  const tr = (tracking || '').toUpperCase();

  // SPX sub-types — check round name prefix FIRST (order matters: ด่วนคลัง before ด่วน)
  if (rnOrig.startsWith('ส่งทันที') || /ด่วนทันที/i.test(rn)) return 'SPX ส่งทันที';
  if (rnOrig.startsWith('ด่วนคลัง') || /ด่วนคลัง/i.test(rn)) return 'SPX ด่วนคลัง';
  if (rnOrig.startsWith('ด่วน') || /^ด่วน/i.test(rn))         return 'SPX ด่วน';

  // Round name keywords
  if (/flash.*bulky|bulky/i.test(rn))                        return 'Flash Express Bulky';
  if (/flash|แฟลช/i.test(rn))                                return 'Flash Express';
  if (/spx/i.test(rn))                                       return 'SPX Express';
  if (/j&t|jnt|j\+t|jt\b/i.test(rn))                         return 'J&T Express';
  if (/kerry|เคอรี่/i.test(rn))                               return 'Kerry Express';
  if (/tiktok|tktok|ติ๊กต็อก/i.test(rn))                     return 'TikTok Shop';

  // Tracking prefix fallback
  if (/^TH2/.test(tr))                                        return 'SPX Express';
  if (/^THT/.test(tr))                                        return 'TikTok Shop';

  return 'อื่นๆ';
}

/**
 * GET /api/delivery-confirm?rounds=id1,id2,id3&itemsPerPage=50
 * Returns merged + deduplicated items grouped by carrier for print system.
 */
app.get('/api/delivery-confirm', (req, res) => {
  const roundIds    = (req.query.rounds || '').split(',').map(s => s.trim()).filter(Boolean);
  const itemsPerPage = Math.max(10, Math.min(200, parseInt(req.query.itemsPerPage) || 50));
  const carrierFilter = (req.query.carriers || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!roundIds.length) return res.json({ ok: false, err: 'ไม่ได้เลือกรอบ' });

  const warnings   = [];
  const seenKeys   = new Set(); // for deduplication across rounds
  const byCarrier  = {};        // { carrierName: [enrichedItem, ...] }
  const foundRounds = [];

  for (const rid of roundIds) {
    const r = getRound(rid);
    if (!r) { warnings.push(`ไม่พบรอบ ID: ${rid}`); continue; }
    if (!r.items || r.items.length === 0) {
      warnings.push(`รอบ "${r.name}" ไม่มีรายการ`);
      foundRounds.push({ id: r.id, name: r.name, itemCount: 0 });
      continue;
    }
    foundRounds.push({ id: r.id, name: r.name, itemCount: r.items.length });

    for (const item of r.items) {
      // Exclude canceled / recalled items from delivery confirmation print (Function 10)
      if (item.recallState === 'RECALLED' || item.recallState === 'PENDING_RECALL') continue;

      // Dedup key: prefer tracking, fallback to order
      const dupKey = item.tracking || item.order || item.id;
      if (seenKeys.has(dupKey)) continue;
      seenKeys.add(dupKey);

      // Validation
      if (!item.tracking && !item.order) {
        warnings.push(`รอบ "${r.name}": พบรายการที่ไม่มีทั้ง tracking และ order`);
        continue;
      }

      const carrier = detectCarrier(r.name, item.tracking);
      if (!byCarrier[carrier]) byCarrier[carrier] = [];

      byCarrier[carrier].push({
        order:    item.order    || '—',
        tracking: item.tracking || '—',
        roundName: r.name,
        roundId:   r.id,
        hasTracking: !!item.tracking,
        hasOrder:    !!item.order
      });
    }
  }

  // Apply carrier filter (if provided, remove carriers not in the list)
  if (carrierFilter.length > 0) {
    for (const key of Object.keys(byCarrier)) {
      if (!carrierFilter.includes(key)) delete byCarrier[key];
    }
  }

  // Build stats
  const totalOrders = Object.values(byCarrier).reduce((s, arr) => s + arr.length, 0);
  const carrierStats = {};
  const pagesByCarrier = {};
  for (const [carrier, items] of Object.entries(byCarrier)) {
    carrierStats[carrier] = items.length;
    pagesByCarrier[carrier] = Math.ceil(items.length / itemsPerPage);
  }
  const totalPages = Object.values(pagesByCarrier).reduce((s, n) => s + n, 0);

  // Warn items missing tracking (SPX urgent rounds)
  const missingTracking = Object.values(byCarrier).flat().filter(i => !i.hasTracking).length;
  if (missingTracking > 0) {
    warnings.push(`${missingTracking} รายการไม่มีเลข Tracking (แสดงเฉพาะเลข Order)`);
  }

  res.json({
    ok: true,
    rounds: foundRounds,
    byCarrier,
    stats: {
      totalRounds: foundRounds.length,
      totalOrders,
      itemsPerPage,
      totalPages,
      carriers: carrierStats
    },
    warnings
  });
});

// ─── Health Check (สำหรับ Render / Railway / Fly.io / Vercel) ────────────────
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

if (!process.env.VERCEL) {
  app.listen(port, '0.0.0.0', () => {
    console.log('\n🚀 SPX Scanner ready!');
    console.log('   พนักงาน → http://localhost:' + port);
    console.log('   Admin   → http://localhost:' + port + '/admin\n');
  });
}

module.exports = app;
