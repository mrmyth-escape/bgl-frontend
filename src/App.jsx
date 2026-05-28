import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import * as XLSX from "xlsx";

// ── SimplyBook 串接設定 ──────────────────────────────────
const SB_CONFIG = {
  companyLogin: "bglescape",
  apiEndpoint:  "https://user-api.simplybook.asia/",
  locations: { 1:"大忠店", 2:"謎先生" },
  backendUrl: "https://bgl-backend-new.vercel.app",
};

// ── GAS 後端（排班 + 打卡 + 員工）─────────────────────────
const GAS_URL = "https://script.google.com/macros/s/AKfycbwb319Bqz-_p-fDj_tIm62jaIRpMJ0mypwrOTGvyHUxR-WOhQxZ0ri8GS8uB2hFkfUzoQ/exec";

// In-flight request 去重 + sessionStorage cache（避免重複打 GAS）
const _gasInflight = new Map();
const GAS_CACHE_TTL = 30 * 1000; // 30 秒內視為新鮮

function _cacheKey(action, payload) {
  try { return "gas:" + action + ":" + JSON.stringify(payload || {}); }
  catch (e) { return "gas:" + action; }
}

function readGasCache(action, payload) {
  try {
    const raw = sessionStorage.getItem(_cacheKey(action, payload));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > 5 * 60 * 1000) return null;  // 5 分鐘內都可當 stale fallback
    return { data: obj.d, fresh: (Date.now() - obj.t) < GAS_CACHE_TTL };
  } catch (e) { return null; }
}

function writeGasCache(action, payload, data) {
  try { sessionStorage.setItem(_cacheKey(action, payload), JSON.stringify({ t: Date.now(), d: data })); }
  catch (e) {}
}

async function callGAS(action, payload = {}, opts = {}) {
  const key = _cacheKey(action, payload);

  // 同樣的請求 in-flight 就 dedup
  if (_gasInflight.has(key)) return _gasInflight.get(key);

  const p = (async () => {
    try {
      const res = await fetch(GAS_URL, {
        method: "POST",
        body: JSON.stringify({ action, payload }),
        redirect: "follow",
      });
      if (!res.ok) throw new Error("GAS HTTP " + res.status);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "GAS error");
      if (opts.cache !== false) writeGasCache(action, payload, json.data);
      return json.data;
    } finally {
      _gasInflight.delete(key);
    }
  })();
  _gasInflight.set(key, p);
  return p;
}

// stale-while-revalidate：立刻回 cache（若有），同時背景刷新
function callGAScached(action, payload = {}, onFresh) {
  const cached = readGasCache(action, payload);
  if (cached) {
    if (!cached.fresh) {
      // 背景 reload
      callGAS(action, payload).then(d => { if (onFresh) onFresh(d); }).catch(() => {});
    }
    return Promise.resolve(cached.data);
  }
  return callGAS(action, payload).then(d => { if (onFresh) onFresh(d); return d; });
}

// 場次狀態 UI 設定（icon / 顏色 / 文字）
const SHIFT_STATUS_UI = {
  skip:           { icon:'⏸',  label:'不計薪', color:'#7A786E' },
  upcoming:       { icon:'⏳', label:'未開始', color:'#7A786E' },
  warn_soon:      { icon:'⚠️', label:'即將開始，記得打卡', color:'#C07000' },
  warn_missing:   { icon:'⚠️', label:'場進行中，還沒打卡', color:'#C07000' },
  missed:         { icon:'❌', label:'未到 / 未打卡', color:'#C0292A' },
  covered_early:  { icon:'☑️', label:'已對應，等開場', color:'#2A5CC0' },
  in_progress:    { icon:'🟢', label:'進行中', color:'#1A7A4A' },
  done:           { icon:'✅', label:'已完成', color:'#1A7A4A' },
};

// 主題顏色（給行事曆色點用）
const THEME_COLOR = {
  '詭店':     '#D94040',
  '詭獄':     '#C07000',
  '詭獄加場': '#A08000',
  '詭廁':     '#007A80',
  '越獄者':   '#2E8B2E',
  '屎力全開': '#7B4FA6',
  '孤兒怨':   '#B04070',
  '桌遊':     '#9A8F7D',
  '外婆':     '#5B8A3A',
};
function themeColor(t) { return THEME_COLOR[t] || '#7A786E'; }

// 把 GAS 員工資料轉成前端 StaffData 格式
const STAFF_COLORS = ["#3B82F6","#EC4899","#10B981","#F59E0B","#8B5CF6","#06B6D4","#F97316","#84CC16","#A855F7","#14B8A6","#EAB308","#F43F5E","#6366F1","#22D3EE","#D946EF"];
function gasStaffToLocal(gasStaff, idx) {
  return {
    id: gasStaff.id,           // 字串：EMP001
    name: gasStaff.name,
    rate: gasStaff.rate || 200,
    color: STAFF_COLORS[idx % STAFF_COLORS.length],
    shift: "10:00",            // 預設，可日後從排班讀
    bonus: 0,
    deduct: 0,
    role: gasStaff.role,
    branch: gasStaff.branch,
    themes: gasStaff.themes,
  };
}

// ── 資料定義 ──────────────────────────────────────────────
const BRANCHES = ["大忠店", "謎先生"];

const ROOMS = [
  { id:"A", name:"孤兒怨",   branch:"大忠店", sbServiceId:2,  sbLocationId:1, color:"#B04070", bg:"#FCEEF3", emoji:"👻", duration:75  },
  { id:"B", name:"屎力全開", branch:"大忠店", sbServiceId:3,  sbLocationId:1, color:"#7B4FA6", bg:"#F5EFF9", emoji:"💩", duration:75  },
  { id:"C", name:"越獄者",   branch:"大忠店", sbServiceId:15, sbLocationId:1, color:"#2E8B2E", bg:"#EDF8ED", emoji:"🦸", duration:90  },
  { id:"D", name:"詭廁",     branch:"大忠店", sbServiceId:14, sbLocationId:1, color:"#007A80", bg:"#E8F8F9", emoji:"🚽", duration:60  },
  { id:"E", name:"詭獄",     branch:"謎先生", sbServiceId:11, sbLocationId:2, color:"#C07000", bg:"#FDF5E8", emoji:"⛓",  duration:90  },
  { id:"F", name:"詭獄加場", branch:"謎先生", sbServiceId:17, sbLocationId:2, color:"#A08000", bg:"#FDFAE8", emoji:"➕", duration:120 },
  { id:"G", name:"詭店",     branch:"謎先生", sbServiceId:16, sbLocationId:2, color:"#D94040", bg:"#FDF0F0", emoji:"🏚", duration:75  },
];

const SB_SERVICE_MAP = Object.fromEntries(ROOMS.map(r => [r.sbServiceId, r.id]));

const SLOTS = [
  "09:30","09:50","10:00","10:30","11:00","11:20","11:40",
  "12:00","12:10","12:30","13:00","13:10","13:20","13:30","13:50",
  "14:00","15:00","15:20","15:30","16:00","16:40","16:50",
  "17:00","17:10","17:20","18:00","18:20","18:30","18:40","18:50",
  "19:00","19:10","20:00","20:30","21:00",
];

const INIT_STAFF = [
  { id:1, name:"小明", rate:180, color:"#3B82F6", shift:"10:00", bonus:500,  deduct:0   },
  { id:2, name:"小美", rate:200, color:"#EC4899", shift:"10:00", bonus:0,    deduct:200 },
  { id:3, name:"阿偉", rate:170, color:"#10B981", shift:"09:00", bonus:300,  deduct:0   },
  { id:4, name:"小琳", rate:190, color:"#F59E0B", shift:"14:00", bonus:0,    deduct:0   },
  { id:5, name:"阿志", rate:175, color:"#8B5CF6", shift:"12:00", bonus:200,  deduct:0   },
];

const INIT_ACCOUNTS = {
  staff:  { pass:"staff123", role:"staff", staffId:1 },
  小美:   { pass:"mei123",   role:"staff", staffId:2 },
  阿偉:   { pass:"wei123",   role:"staff", staffId:3 },
  admin:  { pass:"admin999", role:"admin"              },
};

const WEEK_DAYS = ["一","二","三","四","五","六","日"];

function initSchedule() {
  const s = {};
  ROOMS.forEach(r => {
    s[r.id] = {};
    SLOTS.forEach(t => { s[r.id][t] = { booked:false, staffId:null, clientName:"", source:"none" }; });
  });
  const demo = [
    ["A","10:00",true,1,"王小華","simplybook"],
    ["A","14:00",true,3,"陳大明","simplybook"],
    ["B","11:00",true,2,"林美美","simplybook"],
    ["B","17:00",true,5,"張志遠","manual"],
    ["C","13:00",true,4,"黃小琳","simplybook"],
    ["D","10:30",true,1,"劉先生","simplybook"],
    ["E","15:00",true,3,"吳小姐","simplybook"],
    ["F","19:00",true,2,"趙大哥","simplybook"],
    ["G","20:00",true,5,"許小妹","simplybook"],
  ];
  demo.forEach(([r,t,b,sid,c,src]) => { s[r][t] = { booked:b, staffId:sid, clientName:c, source:src }; });
  return s;
}

const PUNCH_DEMO = [
  { id:"p1", staffId:1, name:"小明", type:"in",  timeStr:"09:52", time:new Date(Date.now()-3600000), anomaly:null },
  { id:"p2", staffId:2, name:"小美", type:"in",  timeStr:"10:07", time:new Date(Date.now()-3000000), anomaly:"遲到 7 分鐘" },
  { id:"p3", staffId:3, name:"阿偉", type:"in",  timeStr:"09:58", time:new Date(Date.now()-3200000), anomaly:null },
];

// ── 樣式系統 ─────────────────────────────────────────────
const C = {
  bg:      "#F7F6F2",
  surface: "#FFFFFF",
  border:  "#E4E2DC",
  text:    "#1C1B18",
  muted:   "#7A786E",
  hint:    "#B0ADA4",
  tabBg:   "#EDECEA",
  tabActive:"#FFFFFF",
  success: { bg:"#EDFBF4", text:"#1A7A4A" },
  warning: { bg:"#FEF8E7", text:"#8A6200" },
  danger:  { bg:"#FEF0F0", text:"#C0292A" },
  info:    { bg:"#EEF4FF", text:"#2A5CC0" },
};

const S = {
  app: {
    minHeight:"100vh", background:C.bg,
    fontFamily:"'Noto Sans TC', sans-serif",
    maxWidth:480, margin:"0 auto",
    color:C.text, paddingBottom:80,
  },
  card: {
    background:C.surface, border:`1px solid ${C.border}`,
    borderRadius:16, padding:"1rem 1.25rem", marginBottom:"1rem",
  },
  tabBar: {
    display:"flex", gap:3, background:C.tabBg,
    borderRadius:12, padding:3, marginBottom:"1.25rem",
  },
  tab: (active) => ({
    flex:1, padding:"8px 4px", border:"none",
    background: active ? C.tabActive : "transparent",
    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
    borderRadius:9, fontSize:12,
    color: active ? C.text : C.muted,
    cursor:"pointer", fontWeight: active ? 500 : 400,
    fontFamily:"'Noto Sans TC', sans-serif", transition:"all .15s",
  }),
  label: { fontSize:11, color:C.muted, letterSpacing:"0.05em", marginBottom:8, fontWeight:500, textTransform:"uppercase" },
  badge: (type) => {
    const map = {
      green: [C.success.bg, C.success.text],
      red:   [C.danger.bg,  C.danger.text],
      amber: [C.warning.bg, C.warning.text],
      gray:  ["#F0EFE9",    C.muted],
      blue:  [C.info.bg,    C.info.text],
    };
    const [bg,color] = map[type] || map.gray;
    return { display:"inline-block", padding:"2px 10px", borderRadius:99, fontSize:11, fontWeight:500, background:bg, color, whiteSpace:"nowrap" };
  },
  punchBtn: (variant, disabled) => ({
    width:"100%", padding:15, border:"none", borderRadius:12,
    fontSize:15, fontWeight:500, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily:"'Noto Sans TC', sans-serif",
    opacity: disabled ? 0.45 : 1,
    background: disabled ? "#D0CEC8" : (variant==="in" ? "#0F9B6A" : "#C0392B"),
    color: disabled ? "#8A8880" : "#FFFFFF",
    transition:"all .15s",
  }),
  ghostBtn: {
    background:"transparent", border:`1px solid ${C.border}`, borderRadius:8,
    padding:"6px 12px", fontSize:12, color:C.muted, cursor:"pointer",
    fontFamily:"'Noto Sans TC', sans-serif",
  },
  row: (last) => ({
    display:"flex", justifyContent:"space-between", alignItems:"center",
    padding:"10px 0",
    borderBottom: last ? "none" : `1px solid ${C.border}`,
  }),
  metric: {
    background:C.tabBg, borderRadius:12, padding:"12px 14px", flex:1,
  },
  inp: {
    width:"100%", padding:"9px 12px",
    border:`1px solid ${C.border}`, borderRadius:8,
    background:C.surface, color:C.text,
    fontSize:13, marginBottom:10, outline:"none",
    fontFamily:"'Noto Sans TC', sans-serif",
    boxSizing:"border-box",
  },
  modalOverlay: {
    position:"fixed", inset:0, background:"rgba(0,0,0,0.35)",
    display:"flex", alignItems:"flex-end", zIndex:100,
  },
  modalSheet: {
    background:C.surface, borderRadius:"20px 20px 0 0",
    padding:"1.5rem 1.25rem", width:"100%",
    maxWidth:480, margin:"0 auto",
    boxShadow:"0 -4px 24px rgba(0,0,0,0.1)",
    maxHeight:"85vh", overflowY:"auto",
  },
};

// ── 工具 ─────────────────────────────────────────────────
function fmtTime(d) {
  return d.toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
}
function fmtDate(d) {
  return d.toLocaleDateString("zh-TW",{month:"long",day:"numeric",weekday:"short"});
}
function getWeekDates(base) {
  const d = new Date(base);
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day===0 ? 6 : day-1));
  return Array.from({length:7}, (_,i) => {
    const x = new Date(mon);
    x.setDate(mon.getDate()+i);
    return x;
  });
}
function staffById(id, list) { return list.find(s=>s.id===id); }

function calcHours(staffId, logs) {
  let total = 0;
  const inLogs = logs.filter(l => l.staffId===staffId && l.type==="in");
  inLogs.forEach(inL => {
    const outL = logs.find(o => o.type==="out" && o.staffId===staffId && o.time > inL.time);
    if (outL) total += (outL.time - inL.time) / 3600000;
  });
  return Math.round(total * 10) / 10;
}

function getPresentStaff(logs) {
  const byStaff = {};
  logs.forEach(l => {
    if (!byStaff[l.staffId]) byStaff[l.staffId] = [];
    byStaff[l.staffId].push(l);
  });
  return Object.values(byStaff)
    .filter(entries => {
      const sorted = [...entries].sort((a,b)=>a.time-b.time);
      return sorted[sorted.length-1]?.type === "in";
    })
    .map(entries => entries.find(e=>e.type==="in"));
}

let _nextStaffId = INIT_STAFF.length + 1;
function nextStaffId() { return _nextStaffId++; }
let _nextPunchId = 100;
function nextPunchId() { return `p${_nextPunchId++}`; }

// ── Toast ─────────────────────────────────────────────────
function Toast({ msg, show }) {
  return (
    <div style={{
      position:"fixed", bottom:90, left:"50%", transform:"translateX(-50%)",
      background:C.text, color:C.surface, padding:"9px 20px",
      borderRadius:99, fontSize:12, whiteSpace:"nowrap",
      opacity: show ? 1 : 0, transition:"opacity .25s",
      pointerEvents:"none", zIndex:999,
      boxShadow:"0 2px 12px rgba(0,0,0,0.15)",
    }}>{msg}</div>
  );
}

// ── Avatar ────────────────────────────────────────────────
function Avatar({ name, color, size=36 }) {
  return (
    <div style={{
      width:size, height:size, borderRadius:"50%", flexShrink:0,
      background: color+"20", color,
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize: size > 30 ? 13 : 11, fontWeight:500,
    }}>{name[0]}</div>
  );
}

// ── 員工編輯 Modal ────────────────────────────────────────
const STAFF_ROLES = ['密室正職', '桌遊正職', '兼職NPC', '兼職場控', '兼職美術'];
const STAFF_BRANCHES = ['兩店通用', '大忠店', '謎先生'];
const STAFF_THEMES = ['詭店', '詭獄', '詭獄加場', '詭廁', '越獄者', '屎力全開', '孤兒怨', '桌遊'];

function StaffEditModal({ staff, isNew, onSave, onClose, liveMode }) {
  const [name,       setName]       = useState(staff?.name     || "");
  const [rate,       setRate]       = useState(String(staff?.rate  || 200));
  const [password,   setPassword]   = useState("");
  // demo 用
  const [shift,      setShift]      = useState(staff?.shift    || "10:00");
  const [color,      setColor]      = useState(staff?.color    || "#3B82F6");
  // liveMode 用
  const [role,       setRole]       = useState(staff?.role   || "兼職NPC");
  const [branch,     setBranch]     = useState(staff?.branch || "兩店通用");
  const [lineUserId, setLineUserId] = useState(staff?.lineUserId || "");
  const initThemes = useMemo(() => {
    if (!staff?.themes) return [];
    // 精確 split，避免「詭獄」誤匹配「詭獄加場」
    const list = String(staff.themes).split(/[、,，]/).map(s => s.trim()).filter(Boolean);
    return STAFF_THEMES.filter(t => list.includes(t));
  }, [staff]);
  const [themes,     setThemes]     = useState(initThemes);

  const toggleTheme = (t) => {
    setThemes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  };

  const canSave = isNew ? name.trim() : true;

  const handleSave = () => {
    if (liveMode) {
      onSave({
        name: name.trim(),
        rate: Number(rate) || 200,
        password,
        role,
        branch,
        themes: themes.join('、'),
        lineUserId: lineUserId.trim(),
      });
    } else {
      onSave({ name:name.trim(), rate:Number(rate)||180, shift, color, password });
    }
  };

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modalSheet} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:500 }}>{isNew ? "新增員工" : `編輯員工：${staff.name}`}</div>
            {!isNew && staff?.id && <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>{staff.id}</div>}
          </div>
          <button onClick={onClose} style={{ border:"none", background:C.tabBg, color:C.muted,
            fontSize:16, cursor:"pointer", width:30, height:30, borderRadius:"50%", lineHeight:1 }}>×</button>
        </div>

        {isNew && (
          <>
            <div style={S.label}>姓名</div>
            <input style={S.inp} value={name} onChange={e=>setName(e.target.value)} placeholder="輸入姓名"/>
            {liveMode && <div style={{ fontSize:10, color:C.hint, marginTop:-8, marginBottom:10 }}>員工ID 會自動分配（EMP016、EMP017…）</div>}
          </>
        )}

        {liveMode ? (
          <>
            <div style={S.label}>職位</div>
            <select style={{ ...S.inp, cursor:"pointer" }} value={role} onChange={e=>setRole(e.target.value)}>
              {STAFF_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            <div style={S.label}>所屬店</div>
            <select style={{ ...S.inp, cursor:"pointer" }} value={branch} onChange={e=>setBranch(e.target.value)}>
              {STAFF_BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
            </select>

            <div style={S.label}>可帶主題（複選）</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:14 }}>
              {STAFF_THEMES.map(t => {
                const on = themes.includes(t);
                return (
                  <button key={t} onClick={()=>toggleTheme(t)} style={{
                    padding:"6px 12px", borderRadius:99, fontSize:12, cursor:"pointer",
                    fontFamily:"'Noto Sans TC', sans-serif",
                    border: `1px solid ${on ? C.info.text+"66" : C.border}`,
                    background: on ? C.info.bg : "transparent",
                    color: on ? C.info.text : C.muted,
                    fontWeight: on ? 500 : 400,
                  }}>
                    {on && "✓ "}{t}
                  </button>
                );
              })}
            </div>

            <div style={S.label}>時薪（元/小時，場控/桌遊/打卡用）</div>
            <input style={S.inp} type="number" value={rate} onChange={e=>setRate(e.target.value)}/>

            <div style={S.label}>LINE userId（選填，給通知用）</div>
            <input style={S.inp} value={lineUserId} onChange={e=>setLineUserId(e.target.value)}
              placeholder="U1234... 或留空"/>

            <div style={S.label}>{isNew ? "登入密碼" : "重設密碼（留空則不改）"}</div>
            <input style={S.inp} type="password" value={password}
              onChange={e=>setPassword(e.target.value)}
              placeholder={isNew ? "留空則預設＝員工ID" : "留空則維持原密碼"}/>
            <div style={{ fontSize:10, color:C.hint, marginTop:-8, marginBottom:14, lineHeight:1.5 }}>
              ※ 若員工主檔沒有「密碼」欄，會自動以員工ID當預設密碼
            </div>
          </>
        ) : (
          <>
            <div style={S.label}>時薪（元）</div>
            <input style={S.inp} type="number" value={rate} onChange={e=>setRate(e.target.value)}/>

            <div style={S.label}>班次開始時間</div>
            <input style={S.inp} type="time" value={shift} onChange={e=>setShift(e.target.value)}/>

            <div style={S.label}>顯示顏色</div>
            <input style={{ ...S.inp, padding:4, height:42, cursor:"pointer" }} type="color"
              value={color} onChange={e=>setColor(e.target.value)}/>

            <div style={S.label}>{isNew ? "登入密碼" : "重設密碼（留空則不更改）"}</div>
            <input style={S.inp} type="password" value={password}
              onChange={e=>setPassword(e.target.value)}
              placeholder={isNew ? "設定初始密碼" : "輸入新密碼（可留空）"}/>
          </>
        )}

        <button
          style={{ width:"100%", padding:13, border:"none", borderRadius:10, fontSize:14,
            fontWeight:500, cursor: canSave ? "pointer" : "not-allowed",
            background: canSave ? "#2A5CC0" : "#D0CEC8", color:"#FFF",
            fontFamily:"'Noto Sans TC', sans-serif", opacity: canSave ? 1 : 0.6 }}
          disabled={!canSave}
          onClick={handleSave}>
          {isNew ? (liveMode ? "新增到 Sheets" : "建立員工帳號") : "儲存變更"}
        </button>
      </div>
    </div>
  );
}

// ── 員工新申請 Modal ──────────────────────────────────────
function StaffRequestModal({ type, staffData, myId, onClose, onSubmit }) {
  const today = new Date().toISOString().substring(0, 10);
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("10:00");
  const [note, setNote] = useState("");
  const [punchType, setPunchType] = useState("in");
  const [swapTarget, setSwapTarget] = useState("");
  const [leaveKind, setLeaveKind] = useState("事假");

  const titleMap = { leave: "🌴 申請請假", swap: "🔄 申請換班", punch_fix: "⏰ 申請補打卡" };
  const canSubmit = date && (type !== 'swap' || swapTarget);

  const handleSubmit = () => {
    const details = {};
    if (type === 'punch_fix') details.punchType = punchType;
    if (type === 'swap') details.swapWithEmpId = swapTarget;
    if (type === 'leave') details.leaveKind = leaveKind;
    onSubmit({ type, date, time: (type === 'punch_fix' ? time : ''), details, note });
  };

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modalSheet} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:15, fontWeight:500 }}>{titleMap[type]}</div>
          <button onClick={onClose} style={{ border:"none", background:C.tabBg, color:C.muted,
            fontSize:16, cursor:"pointer", width:30, height:30, borderRadius:"50%", lineHeight:1 }}>×</button>
        </div>

        <div style={S.label}>{type === 'leave' ? '請假日期' : type === 'swap' ? '想換掉的班 日期' : '補打卡日期'}</div>
        <input style={S.inp} type="date" value={date} onChange={e => setDate(e.target.value)} />

        {type === 'leave' && (
          <>
            <div style={S.label}>請假類別</div>
            <select style={{ ...S.inp, cursor:"pointer" }} value={leaveKind} onChange={e => setLeaveKind(e.target.value)}>
              {['事假','病假','特休','排休','其他'].map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </>
        )}

        {type === 'swap' && (
          <>
            <div style={S.label}>想跟誰換</div>
            <select style={{ ...S.inp, cursor:"pointer" }} value={swapTarget} onChange={e => setSwapTarget(e.target.value)}>
              <option value="">-- 選擇對方員工 --</option>
              {staffData.filter(s => s.id !== myId).map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
              ))}
            </select>
          </>
        )}

        {type === 'punch_fix' && (
          <>
            <div style={S.label}>補打卡時間</div>
            <input style={S.inp} type="time" value={time} onChange={e => setTime(e.target.value)} />
            <div style={S.label}>類別</div>
            <div style={{ display:"flex", gap:8, marginBottom:14 }}>
              {[['in','上班'],['out','下班']].map(([v,l]) => (
                <button key={v} onClick={() => setPunchType(v)} style={{
                  flex:1, padding:10, border:`1px solid ${punchType===v?'#2A5CC0':C.border}`,
                  borderRadius:8, background: punchType===v?'#EEF4FF':'transparent',
                  color: punchType===v?'#2A5CC0':C.muted, cursor:"pointer", fontWeight: punchType===v?500:400,
                  fontFamily:"'Noto Sans TC', sans-serif", fontSize:13 }}>
                  {l}
                </button>
              ))}
            </div>
          </>
        )}

        <div style={S.label}>備註（原因 / 補充）</div>
        <textarea style={{ ...S.inp, height:80, resize:"vertical", fontFamily:"'Noto Sans TC', sans-serif" }}
          value={note} onChange={e => setNote(e.target.value)}
          placeholder={type === 'leave' ? '例：家中有事' : type === 'swap' ? '例：當天有事，已徵得對方同意' : '例：當日忙忘了打卡'}/>

        <button onClick={handleSubmit} disabled={!canSubmit}
          style={{ width:"100%", padding:13, border:"none", borderRadius:10, fontSize:14,
            fontWeight:500, cursor: canSubmit ? "pointer" : "not-allowed",
            background: canSubmit ? "#2A5CC0" : "#D0CEC8", color:"#FFF",
            fontFamily:"'Noto Sans TC', sans-serif", opacity: canSubmit ? 1 : 0.6, marginTop:8 }}>
          送出申請
        </button>
      </div>
    </div>
  );
}

// ── 刪除確認 Dialog ───────────────────────────────────────
function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div style={{ ...S.modalOverlay, alignItems:"center", padding:"0 1.5rem" }} onClick={onCancel}>
      <div style={{ background:C.surface, borderRadius:16, padding:"1.5rem", width:"100%",
        maxWidth:340, boxShadow:"0 4px 24px rgba(0,0,0,0.15)" }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ fontSize:15, fontWeight:500, marginBottom:8 }}>確認刪除</div>
        <div style={{ fontSize:13, color:C.muted, marginBottom:20, lineHeight:1.6 }}>{message}</div>
        <div style={{ display:"flex", gap:10 }}>
          <button style={{ flex:1, padding:11, border:`1px solid ${C.border}`, borderRadius:10,
            background:"transparent", color:C.muted, fontSize:13, cursor:"pointer",
            fontFamily:"'Noto Sans TC', sans-serif" }} onClick={onCancel}>取消</button>
          <button style={{ flex:1, padding:11, border:"none", borderRadius:10,
            background:C.danger.text, color:"#FFF", fontSize:13, cursor:"pointer",
            fontFamily:"'Noto Sans TC', sans-serif", fontWeight:500 }} onClick={onConfirm}>確認刪除</button>
        </div>
      </div>
    </div>
  );
}

// ── 登入畫面 ──────────────────────────────────────────────
function LoginScreen({ onLogin, accounts, liveMode, gasError }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err,  setErr]  = useState(false);
  const [busy, setBusy] = useState(false);

  const showErr = (msg) => {
    setErr(msg || true);
    setTimeout(() => setErr(false), 2200);
  };

  const doLogin = async () => {
    if (busy) return;
    // admin 帳號：liveMode 時走 GAS verifyAdmin（與 GAS 後台同一組密碼）
    if ((user === 'admin' || user === '管理員') && liveMode) {
      setBusy(true);
      try {
        const res = await callGAS('verifyAdmin', { password: pass });
        if (res?.valid) {
          // 存進 sessionStorage 給 GasAdminEmbed SSO 用
          try { sessionStorage.setItem('bgl_admin_pwd', pass); } catch (e) {}
          onLogin({ role: 'admin' }, user);
        } else {
          showErr('管理者密碼錯誤');
        }
      } catch (e) {
        showErr('連線 GAS 失敗：' + e.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    // 一般帳號（員工或 demo 模式 admin）：用 client side accounts 比對
    const acc = accounts[user];
    if (!acc || acc.pass !== pass) {
      showErr('帳號或密碼錯誤');
      return;
    }
    onLogin(acc, user);
  };

  return (
    <div style={{ ...S.app, display:"flex", flexDirection:"column", justifyContent:"center", padding:"2rem 1.5rem" }}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet"/>
      <div style={{ textAlign:"center", marginBottom:"2.5rem" }}>
        <div style={{ fontSize:40, marginBottom:12 }}>🔐</div>
        <div style={{ fontSize:24, fontWeight:700, color:C.text }}>密室排班系統</div>
        <div style={{ fontSize:12, color:C.hint, marginTop:4 }}>Escape Room Scheduler</div>
        <div style={{ display:"inline-flex", alignItems:"center", gap:6, marginTop:10,
          padding:"4px 10px", borderRadius:99, fontSize:11,
          background: liveMode ? "#EDFBF4" : "#FEF8E7",
          color: liveMode ? "#1A7A4A" : "#8A6200" }}>
          <span style={{ width:6, height:6, borderRadius:"50%",
            background: liveMode ? "#0F9B6A" : "#C07000" }}/>
          {liveMode ? "已連線 GAS Sheets（真實員工資料）" : (gasError ? `Demo 模式（${gasError}）` : "Demo 模式（離線測試）")}
        </div>
      </div>
      <div style={S.card}>
        {err && (
          <div style={{ background:C.danger.bg, color:C.danger.text, fontSize:12, padding:"8px 12px", borderRadius:8, marginBottom:12, textAlign:"center" }}>
            {typeof err === 'string' ? err : '帳號或密碼錯誤'}
          </div>
        )}
        <div style={S.label}>帳號</div>
        <input style={S.inp} value={user} onChange={e=>setUser(e.target.value)}
          placeholder="請輸入帳號" onKeyDown={e=>e.key==="Enter"&&doLogin()} />
        <div style={S.label}>密碼</div>
        <input style={S.inp} type="password" value={pass} onChange={e=>setPass(e.target.value)}
          placeholder="請輸入密碼" onKeyDown={e=>e.key==="Enter"&&doLogin()} />
        <button
          style={{ width:"100%", padding:13, border:"none", borderRadius:10, fontSize:15, fontWeight:500,
            cursor: busy ? "wait" : "pointer", background: busy ? "#94a8d6" : "#2A5CC0", color:"#FFF",
            fontFamily:"'Noto Sans TC', sans-serif", marginTop:4 }}
          onClick={doLogin} disabled={busy}>
          {busy ? "登入中..." : "登入"}
        </button>
        <div style={{ fontSize:11, color:C.hint, textAlign:"center", marginTop:14, lineHeight:1.8 }}>
          {liveMode
            ? <>員工：<b>員工ID 或 姓名</b>（預設密碼＝員工ID）<br/>管理者：<b>admin</b> / GAS 後台密碼</>
            : <>員工：<b>staff</b> / staff123　　管理者：<b>admin</b> / admin999</>}
        </div>
      </div>
    </div>
  );
}

// ── 員工版 ────────────────────────────────────────────────
function StaffApp({ account, schedule, punchLogs, staffData, onPunch, onLogout, liveMode }) {
  const [tab,        setTab]        = useState("punch");
  const [punchState, setPunchState] = useState("out");
  const [clock,      setClock]      = useState(new Date());
  const [gpsOk,      setGpsOk]      = useState(false);
  const [toast,      setToast]      = useState({ show:false, msg:"" });
  const [todayStatus, setTodayStatus] = useState(null);  // 從 getTodayStatus 來
  const [gasSched,    setGasSched]    = useState([]);    // 指定月份排班（給「我的班表」行事曆用）
  const [loading,     setLoading]     = useState(false);
  const [myReqs,      setMyReqs]      = useState([]);
  const [newReq,      setNewReq]      = useState(null);    // 新申請 modal: null | { type }
  const todayObj = useMemo(() => new Date(), []);
  const [viewMonth,    setViewMonth]    = useState(() => {
    const t = new Date();
    return t.getFullYear() + '-' + String(t.getMonth()+1).padStart(2,'0');
  }); // YYYY-MM
  const [selectedDate, setSelectedDate] = useState(null); // YYYY-MM-DD，點開行事曆某天時設

  const me = staffData.find(s => s.id === account.staffId);

  // 載入 GAS 真實資料：今日狀態 + viewMonth 月份排班（stale-while-revalidate）
  const reloadGAS = useCallback(async () => {
    if (!liveMode || !account.staffId) return;
    const [y, m] = viewMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const monthStart = `${viewMonth}-01`;
    const monthEnd   = `${viewMonth}-${String(lastDay).padStart(2,'0')}`;

    // 立刻顯示 cache
    const cs = readGasCache('getTodayStatus', { empId: String(account.staffId) });
    const cm = readGasCache('getMySchedule', { empId: String(account.staffId), from: monthStart, to: monthEnd });
    if (cs) setTodayStatus(cs.data);
    if (cm) setGasSched(cm.data?.schedule || []);
    if (cs && cm && cs.fresh && cm.fresh) return;

    setLoading(true);
    try {
      const [status, sData] = await Promise.all([
        callGAS("getTodayStatus", { empId: String(account.staffId) }),
        callGAS("getMySchedule",  { empId: String(account.staffId), from: monthStart, to: monthEnd }),
      ]);
      setTodayStatus(status);
      setGasSched(sData?.schedule || []);
    } catch (e) {
      console.warn("載入 GAS 資料失敗:", e.message);
    } finally {
      setLoading(false);
    }
  }, [liveMode, account.staffId, viewMonth]);

  useEffect(() => { reloadGAS(); }, [reloadGAS]);

  // 把 gasSched 按日期分組（給行事曆用）
  const shiftsByDate = useMemo(() => {
    const map = {};
    gasSched.forEach(s => {
      const d = String(s['日期'] || '').substring(0,10);
      if (!d) return;
      if (!map[d]) map[d] = [];
      map[d].push({
        time: String(s['開場時間'] || '').substring(0,5),
        theme: s['主題'] || '',
        role: s['角色'] || '',
      });
    });
    Object.keys(map).forEach(d => {
      map[d].sort((a,b) => a.time.localeCompare(b.time));
    });
    return map;
  }, [gasSched]);

  // 每 60 秒自動重抓今日狀態（場次狀態會隨時間變）
  useEffect(() => {
    if (!liveMode) return;
    const id = setInterval(reloadGAS, 60000);
    return () => clearInterval(id);
  }, [liveMode, reloadGAS]);

  // 我的申請列表
  const reloadMyReqs = useCallback(async () => {
    if (!liveMode || !account.staffId) return;
    try {
      const data = await callGAS("getMyRequests", { empId: String(account.staffId) });
      setMyReqs(data?.requests || []);
    } catch (e) {}
  }, [liveMode, account.staffId]);
  useEffect(() => { if (tab === "request") reloadMyReqs(); }, [tab, reloadMyReqs]);

  // 提交申請
  const submitRequest = useCallback(async (req) => {
    try {
      await callGAS("submitStaffRequest", {
        empId: String(account.staffId),
        type: req.type,
        date: req.date,
        time: req.time || "",
        details: req.details || {},
        note: req.note || "",
      });
      setNewReq(null);
      showToast("已送出申請，等待 admin 審核");
      reloadMyReqs();
    } catch (e) {
      showToast("送出失敗：" + e.message);
    }
  }, [account.staffId, reloadMyReqs]);

  // 統一 myLogs：liveMode 用 todayStatus.punches，demo 用本地 punchLogs
  const myLogs = useMemo(() => {
    if (liveMode && todayStatus) {
      // 注意：todayStatus.punches 只有今日；要顯示今日打卡列表足夠
      return todayStatus.punches.map((p, i) => ({
        id: 'gas-' + i,
        staffId: account.staffId,
        name: me?.name || '',
        type: p.type === '上班' ? 'in' : 'out',
        timeStr: p.time,
        time: new Date(`${todayStatus.date}T${p.time}:00`),
        anomaly: null,
        color: me?.color || "#888",
      }));
    }
    return punchLogs.filter(l => l.staffId === account.staffId);
  }, [liveMode, todayStatus, punchLogs, account.staffId, me]);

  useEffect(() => {
    const tick = setInterval(() => setClock(new Date()), 1000);
    const gps  = setTimeout(() => setGpsOk(true), 1800);
    return () => { clearInterval(tick); clearTimeout(gps); };
  }, []);

  useEffect(() => {
    if (liveMode && todayStatus) {
      setPunchState(todayStatus.currentState === 'in' ? 'in' : 'out');
      return;
    }
    if (myLogs.length === 0) { setPunchState("out"); return; }
    const last = [...myLogs].sort((a,b)=>a.time-b.time).pop();
    setPunchState(last.type === "in" ? "in" : "out");
  }, [myLogs, liveMode, todayStatus]);

  function showToast(msg) {
    setToast({ show:true, msg });
    setTimeout(() => setToast(t=>({...t,show:false})), 2200);
  }

  function checkAnomaly(staff, timeStr) {
    if (!staff?.shift) return null;
    const [h,m] = timeStr.split(":").map(Number);
    const [sh,sm] = staff.shift.split(":").map(Number);
    const diff = h*60+m - (sh*60+sm);
    return diff > 5 ? `遲到 ${diff} 分鐘` : null;
  }

  const handlePunch = async () => {
    if (!gpsOk) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",hour12:false});
    const newType = punchState === "out" ? "in" : "out";
    const anomaly = newType === "in" && me ? checkAnomaly(me, timeStr) : null;
    await onPunch({ id:nextPunchId(), staffId:me.id, name:me.name, type:newType, timeStr, time:now, anomaly, color:me.color });
    showToast(newType === "in" ? `上班打卡成功 ${timeStr} ✓` : `下班打卡成功 ${timeStr} ✓`);
    // 打卡後重抓 GAS 確認寫進去了
    if (liveMode) setTimeout(reloadGAS, 800);
  };

  // 今日排班：liveMode 用 todayStatus.shifts（含 status/pay）
  const todayStr = clock.getFullYear() + '-' + String(clock.getMonth()+1).padStart(2,'0') + '-' + String(clock.getDate()).padStart(2,'0');
  const myShifts = useMemo(() => {
    if (liveMode) {
      return (todayStatus?.shifts || []).map(s => ({
        openTime: s.openTime,
        endTime: s.endTime,
        theme: s.theme,
        role: s.role,
        category: s.category,
        payType: s.payType,
        pay: s.pay,
        status: s.status,
        lateMin: s.lateMin,
      }));
    }
    const result = [];
    ROOMS.forEach(r => {
      SLOTS.forEach(t => {
        const cell = schedule[r.id]?.[t];
        if (cell?.staffId === account.staffId && cell.booked) {
          result.push({ room:r, time:t, client:cell.clientName });
        }
      });
    });
    return result;
  }, [liveMode, todayStatus, schedule, account.staffId]);

  // 本月全部排班（給「我的班表」tab 用）
  const myMonthShifts = useMemo(() => {
    if (!liveMode) return [];
    return gasSched
      .map(s => ({
        date: String(s['日期'] || '').substring(0,10),
        time: String(s['開場時間'] || '').substring(0,5),
        theme: s['主題'] || '',
        role: s['角色'] || '',
      }))
      .sort((a,b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  }, [liveMode, gasSched]);

  const salaryInfo = useMemo(() => {
    const workedH = calcHours(account.staffId, punchLogs);
    const hours = workedH > 0 ? workedH : 38.5;
    const base   = Math.round(hours * (me?.rate || 180));
    const bonus  = me?.bonus  || 0;
    const deduct = me?.deduct || 0;
    return { hours, base, bonus, deduct, total: base+bonus-deduct };
  }, [punchLogs, account.staffId, me]);

  const TABS = [
    { id:"punch",    label:"打卡" },
    { id:"schedule", label:"我的班表" },
    { id:"request",  label:"申請" },
    { id:"salary",   label:"薪資" },
  ];

  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet"/>
      <Toast msg={toast.msg} show={toast.show} />

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        padding:"1.25rem 1.25rem 0.5rem", borderBottom:`1px solid ${C.border}`, marginBottom:"0.75rem" }}>
        <div>
          <div style={{ fontSize:16, fontWeight:500 }}>Hi，{me?.name}</div>
          <div style={{ fontSize:11, color:C.muted }}>員工</div>
        </div>
        <Avatar name={me?.name || "?"} color={me?.color || "#888"} />
      </div>

      <div style={{ padding:"0 1.25rem" }}>
        <div style={S.tabBar}>
          {TABS.map(t => (
            <button key={t.id} style={S.tab(tab===t.id)} onClick={()=>setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {tab==="punch" && (
          <div>
            <div style={S.card}>
              <div style={{ fontSize:36, fontWeight:600, textAlign:"center", letterSpacing:3, color:C.text, marginBottom:4 }}>
                {fmtTime(clock)}
              </div>
              <div style={{ fontSize:12, color:C.muted, textAlign:"center", marginBottom:16 }}>
                {fmtDate(clock)}
              </div>

              {/* 目前打卡狀態徽章 */}
              {liveMode && todayStatus && (
                <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 12px",
                  background: todayStatus.currentState === 'in' ? C.success.bg : C.tabBg,
                  borderRadius:8, marginBottom:12, fontSize:13,
                  color: todayStatus.currentState === 'in' ? C.success.text : C.muted }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                    background: todayStatus.currentState === 'in' ? "#0F9B6A" : "#B0ADA4" }}/>
                  <span style={{ fontWeight:500 }}>
                    {todayStatus.currentState === 'in' ? '上班中' : todayStatus.currentState === 'out' ? '下班中' : '今日尚未打卡'}
                  </span>
                  {todayStatus.stateSince && (
                    <span style={{ marginLeft:'auto', fontSize:11 }}>從 {todayStatus.stateSince} 起</span>
                  )}
                </div>
              )}

              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 12px",
                background: gpsOk ? C.success.bg : C.warning.bg,
                borderRadius:8, marginBottom:14, fontSize:11,
                color: gpsOk ? C.success.text : C.warning.text }}>
                <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
                  background: gpsOk ? "#0F9B6A" : "#C07000" }}/>
                {gpsOk ? "GPS 已確認" : "GPS 定位中..."}
              </div>

              {/* 提醒：場次即將開始或進行中但未打卡 */}
              {liveMode && todayStatus?.nextUnpunchedShift && (
                <div style={{ padding:"10px 12px", marginBottom:14, borderRadius:8,
                  background:C.warning.bg, color:C.warning.text, fontSize:12, lineHeight:1.6 }}>
                  ⚠️ <b>{todayStatus.nextUnpunchedShift.openTime} {todayStatus.nextUnpunchedShift.theme}</b>
                  {' '}
                  {todayStatus.nextUnpunchedShift.minutesUntil < 0
                    ? `已開場 ${-todayStatus.nextUnpunchedShift.minutesUntil} 分鐘`
                    : `${todayStatus.nextUnpunchedShift.minutesUntil} 分鐘後開場`}
                  ，記得打上班卡！
                </div>
              )}

              <div style={S.label}>
                {liveMode ? `今日場次（${myShifts.length} 場）` : '今日排班'}
              </div>

              {liveMode ? (
                myShifts.length === 0 ? (
                  <div style={{ fontSize:13, color:C.hint, padding:"10px 0", textAlign:"center" }}>今日無排班</div>
                ) : (
                  <div style={{ marginBottom:14 }}>
                    {myShifts.map((s,i) => {
                      const cfg = SHIFT_STATUS_UI[s.status] || SHIFT_STATUS_UI.upcoming;
                      return (
                        <div key={i} style={{ display:"flex", alignItems:"center", padding:"8px 4px",
                          borderBottom: i===myShifts.length-1 ? 'none' : `1px solid ${C.border}` }}>
                          <span style={{ fontSize:16, marginRight:8 }}>{cfg.icon}</span>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:13, fontWeight:500 }}>
                              {s.openTime} {s.theme} <span style={{ color:C.muted, fontSize:11 }}>{s.role}</span>
                            </div>
                            <div style={{ fontSize:11, color:cfg.color }}>
                              {cfg.label}
                              {s.lateMin > 0 && <span style={{ marginLeft:6, color:C.warning.text }}>遲到 {s.lateMin} 分</span>}
                            </div>
                          </div>
                          <div style={{ textAlign:'right' }}>
                            <div style={{ fontSize:13, fontWeight:600, color: s.pay > 0 ? C.text : C.hint }}>
                              {s.pay > 0 ? `＄${s.pay}` : '—'}
                            </div>
                            <div style={{ fontSize:10, color:C.muted }}>
                              {s.payType === 'per_session' ? '場次制' : s.payType === 'hourly' ? '時薪制' : ''}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                      padding:"10px 4px", borderTop:`2px solid ${C.border}`, marginTop:4 }}>
                      <span style={{ fontSize:13, color:C.muted }}>本日累計</span>
                      <span style={{ fontSize:18, fontWeight:600 }}>＄{(todayStatus?.todayPaid || 0).toLocaleString()}</span>
                    </div>
                  </div>
                )
              ) : (
                <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:16 }}>
                  {myShifts.slice(0,4).map((s,i) => (
                    <span key={i} style={{ padding:"4px 10px", borderRadius:99, fontSize:12,
                      background:s.room.bg, color:s.room.color, fontWeight:500 }}>
                      {s.room.name} {s.time}
                    </span>
                  ))}
                  {myShifts.length===0 && <span style={{ fontSize:12, color:C.hint }}>今日無排班</span>}
                </div>
              )}

              <button style={S.punchBtn(punchState==="out"?"in":"out", !gpsOk)}
                onClick={handlePunch} disabled={!gpsOk}>
                {!gpsOk ? "等待 GPS 驗證..." : punchState==="out" ? "上班打卡" : "下班打卡"}
              </button>
            </div>

            {myLogs.length > 0 && (
              <div style={S.card}>
                <div style={S.label}>今日打卡紀錄</div>
                {[...myLogs].reverse().map((l,i) => (
                  <div key={i} style={S.row(i===myLogs.length-1)}>
                    <span style={{ fontSize:13, color:C.muted }}>{l.type==="in"?"上班":"下班"}打卡</span>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:13, fontWeight:500 }}>{l.timeStr}</div>
                      {l.anomaly && <div style={{ fontSize:11, color:C.warning.text }}>{l.anomaly}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab==="schedule" && liveMode && (
          <div style={S.card}>
            {/* 月份切換 */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
              <button onClick={() => {
                const [y, m] = viewMonth.split('-').map(Number);
                const prev = new Date(y, m-2, 1);
                setViewMonth(prev.getFullYear() + '-' + String(prev.getMonth()+1).padStart(2,'0'));
              }} style={{ border:`1px solid ${C.border}`, background:'transparent', borderRadius:8, padding:'4px 10px', cursor:'pointer', fontSize:13, color:C.text, fontFamily:"'Noto Sans TC', sans-serif" }}>◀</button>
              <div style={{ fontSize:15, fontWeight:600 }}>{viewMonth.substring(0,4)} 年 {parseInt(viewMonth.substring(5,7))} 月</div>
              <button onClick={() => {
                const [y, m] = viewMonth.split('-').map(Number);
                const next = new Date(y, m, 1);
                setViewMonth(next.getFullYear() + '-' + String(next.getMonth()+1).padStart(2,'0'));
              }} style={{ border:`1px solid ${C.border}`, background:'transparent', borderRadius:8, padding:'4px 10px', cursor:'pointer', fontSize:13, color:C.text, fontFamily:"'Noto Sans TC', sans-serif" }}>▶</button>
            </div>

            {/* 統計 + 圖例 */}
            <div style={{ fontSize:11, color:C.muted, marginBottom:10, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span>共 {myMonthShifts.length} 場</span>
              <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:'#5b8a3a' }}/>有班
              </span>
            </div>

            {/* 行事曆 grid */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:3 }}>
              {['日','一','二','三','四','五','六'].map((w,i) => (
                <div key={w} style={{ fontSize:11, textAlign:'center', color: i===0||i===6 ? '#b06a6a' : C.muted, padding:'4px 0', fontWeight:500 }}>{w}</div>
              ))}
              {(() => {
                const [yr, mo] = viewMonth.split('-').map(Number);
                const firstDay = new Date(yr, mo-1, 1).getDay(); // 0=Sun
                const lastDate = new Date(yr, mo, 0).getDate();
                const cells = [];
                // 空白前墊
                for (let i = 0; i < firstDay; i++) cells.push(<div key={'pad'+i} />);
                for (let d = 1; d <= lastDate; d++) {
                  const dateStr = `${viewMonth}-${String(d).padStart(2,'0')}`;
                  const dayShifts = shiftsByDate[dateStr] || [];
                  const dt = new Date(yr, mo-1, d);
                  const isToday = dateStr === todayStr;
                  const isPast = dateStr < todayStr;
                  const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
                  cells.push(
                    <button
                      key={dateStr}
                      onClick={() => dayShifts.length > 0 && setSelectedDate(dateStr)}
                      disabled={dayShifts.length === 0}
                      style={{
                        aspectRatio: '1 / 1',
                        minHeight: 50,
                        background: isToday ? '#FEF8E7' : C.surface,
                        border: isToday ? `2px solid #C07000` : `1px solid ${C.border}`,
                        borderRadius: 8,
                        padding: 4,
                        cursor: dayShifts.length > 0 ? 'pointer' : 'default',
                        opacity: isPast && !isToday ? 0.55 : 1,
                        display:'flex', flexDirection:'column', alignItems:'center', gap:2,
                        fontFamily:"'Noto Sans TC', sans-serif",
                      }}>
                      <div style={{ fontSize:13, fontWeight: isToday ? 700 : 500,
                        color: isWeekend ? '#b06a6a' : C.text }}>{d}</div>
                      {dayShifts.length > 0 && (
                        <div style={{ display:'flex', gap:2, flexWrap:'wrap', justifyContent:'center' }}>
                          {dayShifts.slice(0, 4).map((s, idx) => (
                            <span key={idx} style={{
                              width:6, height:6, borderRadius:'50%',
                              background: themeColor(s.theme)
                            }}/>
                          ))}
                          {dayShifts.length > 4 && (
                            <span style={{ fontSize:9, color:C.muted, lineHeight:1 }}>+{dayShifts.length-4}</span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                }
                return cells;
              })()}
            </div>

            <div style={{ fontSize:11, color:C.hint, marginTop:10, textAlign:'center' }}>
              點任意日期看當天場次詳情
            </div>
          </div>
        )}

        {tab==="schedule" && !liveMode && (
          <div style={S.card}>
            <div style={S.label}>本週我的班次</div>
            {myShifts.length === 0
              ? <div style={{ fontSize:13, color:C.hint, padding:"1.5rem 0", textAlign:"center" }}>本週暫無班次</div>
              : myShifts.map((s,i) => (
                  <div key={i} style={S.row(i===myShifts.length-1)}>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background:s.room.color, flexShrink:0 }}/>
                      <div>
                        <div style={{ fontSize:13, fontWeight:500 }}>{s.room.name}</div>
                        <div style={{ fontSize:11, color:C.muted }}>{s.time}{s.client ? ` · ${s.client}` : ""}</div>
                      </div>
                    </div>
                    <span style={S.badge("green")}>已排班</span>
                  </div>
                ))
            }
          </div>
        )}

        {/* 行事曆點某天的彈窗 — 顯示該日完整場次 */}
        {selectedDate && shiftsByDate[selectedDate] && (
          <div style={{ ...S.modalOverlay, alignItems:"center", padding:"0 1.25rem" }} onClick={() => setSelectedDate(null)}>
            <div style={{ background:C.surface, borderRadius:16, padding:"1.25rem", width:"100%",
              maxWidth:380, boxShadow:"0 4px 24px rgba(0,0,0,0.15)" }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:16, fontWeight:600 }}>
                    {selectedDate.substring(5,7)} 月 {parseInt(selectedDate.substring(8,10))} 日
                    <span style={{ fontSize:12, color:C.muted, marginLeft:6 }}>
                      (週{['日','一','二','三','四','五','六'][new Date(selectedDate).getDay()]})
                    </span>
                  </div>
                  <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
                    共 {shiftsByDate[selectedDate].length} 場
                    {selectedDate === todayStr && <span style={{ marginLeft:6, color:'#C07000', fontWeight:500 }}>今日</span>}
                  </div>
                </div>
                <button onClick={() => setSelectedDate(null)} style={{
                  border:'none', background:'transparent', fontSize:22, color:C.muted,
                  cursor:'pointer', padding:'0 4px', lineHeight:1 }}>×</button>
              </div>
              {shiftsByDate[selectedDate].map((s, i, arr) => (
                <div key={i} style={{
                  display:'flex', alignItems:'center', gap:10,
                  padding:'10px 0',
                  borderBottom: i === arr.length - 1 ? 'none' : `1px solid ${C.border}`
                }}>
                  <div style={{ width:10, height:10, borderRadius:'50%', background:themeColor(s.theme), flexShrink:0 }}/>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}>{s.theme} <span style={{ color:C.muted, fontSize:12 }}>{s.role}</span></div>
                    <div style={{ fontSize:12, color:C.muted }}>{s.time} 開場</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 新申請 modal */}
        {newReq && (
          <StaffRequestModal
            type={newReq.type}
            staffData={staffData}
            myId={account.staffId}
            onClose={() => setNewReq(null)}
            onSubmit={submitRequest}
          />
        )}

        {tab==="request" && liveMode && (
          <div>
            <div style={S.card}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={S.label}>新申請</div>
                <button onClick={reloadMyReqs} style={{ fontSize:11, padding:"3px 8px",
                  border:`1px solid ${C.border}`, borderRadius:6, background:"transparent",
                  color:C.muted, cursor:"pointer", fontFamily:"'Noto Sans TC', sans-serif" }}>↻</button>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                {[
                  { type:"leave",      icon:"🌴", label:"請假" },
                  { type:"swap",       icon:"🔄", label:"換班" },
                  { type:"punch_fix",  icon:"⏰", label:"補打卡" },
                ].map(t => (
                  <button key={t.type} onClick={() => setNewReq({ type: t.type })}
                    style={{ padding:"14px 6px", border:`1px solid ${C.border}`, borderRadius:10,
                      background:"#fff", cursor:"pointer", fontFamily:"'Noto Sans TC', sans-serif",
                      display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:22 }}>{t.icon}</span>
                    <span style={{ fontSize:13, fontWeight:500, color:C.text }}>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div style={S.card}>
              <div style={S.label}>我的申請紀錄（{myReqs.length}）</div>
              {myReqs.length === 0 ? (
                <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>還沒申請過</div>
              ) : myReqs.map((r, i, arr) => {
                const statusColor = r.status === '已批准' ? C.success.text
                  : r.status === '已拒絕' ? C.danger.text
                  : C.warning.text;
                const statusBg = r.status === '已批准' ? C.success.bg
                  : r.status === '已拒絕' ? C.danger.bg
                  : C.warning.bg;
                return (
                  <div key={r.requestId} style={{ padding:"10px 4px",
                    borderBottom: i===arr.length-1 ? 'none' : `1px solid ${C.border}` }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
                      <div style={{ fontSize:13, fontWeight:500 }}>
                        {r.type} · {r.date}{r.time ? ` ${r.time}` : ''}
                      </div>
                      <span style={{ fontSize:11, padding:"2px 8px", borderRadius:99,
                        background: statusBg, color: statusColor, fontWeight:500 }}>
                        {r.status}
                      </span>
                    </div>
                    {r.note && (
                      <div style={{ fontSize:11, color:C.muted, marginTop:3 }}>備註：{r.note}</div>
                    )}
                    {r.reviewNote && (
                      <div style={{ fontSize:11, color: statusColor, marginTop:3 }}>
                        審核：{r.reviewNote}
                      </div>
                    )}
                    <div style={{ fontSize:10, color:C.hint, marginTop:3 }}>
                      申請 {r.submittedAt}{r.reviewedAt ? ` · 審核 ${r.reviewedAt}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {tab==="request" && !liveMode && (
          <div style={S.card}>
            <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>
              demo 模式不支援申請功能
            </div>
          </div>
        )}

        {tab==="salary" && (
          liveMode ? (
            <div style={S.card}>
              <div style={{ textAlign:"center", padding:"1.5rem 0" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>📊</div>
                <div style={{ fontSize:14, fontWeight:500, marginBottom:6 }}>本月薪資</div>
                <div style={{ fontSize:12, color:C.muted, lineHeight:1.7 }}>
                  5 月仍用舊系統打卡資料算薪資。<br/>
                  6 月起本系統正式上線，可即時看本月薪資。
                </div>
                <div style={{ marginTop:14, padding:10, background:C.tabBg, borderRadius:8, fontSize:11, color:C.muted }}>
                  你的本月排班：{myMonthShifts.length} 場
                </div>
              </div>
            </div>
          ) : (
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:"1rem" }}>
              <div style={S.metric}>
                <div style={S.label}>本月工時</div>
                <div style={{ fontSize:22, fontWeight:600 }}>{salaryInfo.hours}h</div>
              </div>
              <div style={S.metric}>
                <div style={S.label}>預估薪資</div>
                <div style={{ fontSize:22, fontWeight:600 }}>${salaryInfo.total.toLocaleString()}</div>
              </div>
            </div>
            <div style={S.card}>
              <div style={S.label}>薪資明細</div>
              {[
                ["基本工時薪資", `$${salaryInfo.base.toLocaleString()}`, null],
                ["績效獎金",     `+$${salaryInfo.bonus}`,               salaryInfo.bonus>0?C.success.text:C.muted],
                ["扣款",         `-$${salaryInfo.deduct}`,              salaryInfo.deduct>0?C.danger.text:C.muted],
              ].map(([label,val,color],i) => (
                <div key={i} style={S.row(false)}>
                  <span style={{ fontSize:13, color:C.muted }}>{label}</span>
                  <span style={{ fontSize:13, fontWeight:500, color:color||C.text }}>{val}</span>
                </div>
              ))}
              <div style={{ ...S.row(true), borderTop:`1px solid ${C.border}`, paddingTop:12, marginTop:4 }}>
                <span style={{ fontSize:14, fontWeight:500 }}>本月合計</span>
                <span style={{ fontSize:18, fontWeight:600 }}>${salaryInfo.total.toLocaleString()}</span>
              </div>
            </div>
          </div>
          )
        )}

        {tab==="notif" && (
          <div style={S.card}>
            <div style={S.label}>最新通知</div>
            {[
              { title:"班表更新",  body:"4/19 週六新增詭店 15:00 班次", badge:"blue",  isNew:true },
              { title:"薪資入帳",  body:"3月薪資 $7,200 已入帳",        badge:"green"              },
              { title:"系統公告",  body:"五一連假排班請提前確認",        badge:"gray"               },
            ].map((n,i,arr) => (
              <div key={i} style={{ ...S.row(i===arr.length-1), alignItems:"flex-start" }}>
                <div style={{ flex:1, marginRight:10 }}>
                  <div style={{ fontSize:13, fontWeight:500 }}>{n.title}</div>
                  <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{n.body}</div>
                </div>
                <span style={S.badge(n.badge)}>{n.isNew?"新":"已讀"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button onClick={onLogout} style={{ display:"block", margin:"0.5rem 1.25rem 0",
        width:"calc(100% - 2.5rem)", padding:10, border:`1px solid ${C.border}`,
        borderRadius:10, background:"transparent", color:C.hint, fontSize:13,
        cursor:"pointer", fontFamily:"'Noto Sans TC', sans-serif" }}>
        登出
      </button>
    </div>
  );
}

// ── GAS 排班後台嵌入元件（全螢幕 iframe + SSO 自動登入）────
function GasAdminEmbed({ onClose }) {
  const iframeRef = useRef(null);
  // 從 sessionStorage 拿登入時用過的 GAS 密碼（admin 登入時已存）
  const ADMIN_PASS = (typeof window !== 'undefined' && window.sessionStorage)
    ? (sessionStorage.getItem('bgl_admin_pwd') || 'admin1234')
    : 'admin1234';

  // SSO：sandbox iframe 主動 postMessage 過來時，用 e.source 直接回（不靠層級關係）
  useEffect(() => {
    const handler = (e) => {
      try {
        if (!e.data) return;
        // sandbox 主動索取
        if (e.data.type === "bgl_adminReady_v2" && e.source) {
          e.source.postMessage({ type: "bgl_autoAdminLogin", pwd: ADMIN_PASS }, "*");
        }
        // 舊版相容
        if (e.data.type === "bgl_adminReady" && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage({ type: "bgl_autoAdminLogin", pwd: ADMIN_PASS }, "*");
        }
      } catch (err) {}
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [ADMIN_PASS]);

  // 不再帶 query string adminPass（GAS sandbox 收不到）；單純走 postMessage
  const iframeSrc = `${GAS_URL}?page=admin`;

  return (
    <div style={{ position:"fixed", inset:0, zIndex:100, background:"#fff", display:"flex", flexDirection:"column" }}>
      <div style={{ padding:"8px 14px", borderBottom:`1px solid ${C.border}`,
        display:"flex", justifyContent:"space-between", alignItems:"center",
        background:"#f7f3ec", flexShrink:0 }}>
        <span style={{ fontSize:13, fontWeight:500, color:C.text }}>📅 GAS 排班後台</span>
        <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${C.border}`,
          borderRadius:6, padding:"4px 10px", fontSize:12, cursor:"pointer",
          fontFamily:"'Noto Sans TC', sans-serif", color:C.text }}>
          ← 返回
        </button>
      </div>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        style={{ flex:1, border:"none", width:"100%" }}
        title="GAS 排班後台"
        onLoad={() => {
          [100, 500, 1500, 3000].forEach(delay => {
            setTimeout(() => {
              try {
                iframeRef.current?.contentWindow?.postMessage({ type:"bgl_autoAdminLogin", pwd:ADMIN_PASS }, "*");
              } catch (err) {}
            }, delay);
          });
        }}
      />
    </div>
  );
}

// ── 管理者版 ──────────────────────────────────────────────
function AdminApp({ schedule, setSchedule, punchLogs, setPunchLogs, accounts, setAccounts, onLogout, liveMode, staffData, setStaffData, reloadStaff }) {
  const [tab,            setTab]           = useState("overview");
  const [viewMode,       setViewMode]      = useState("timeline");
  const [adminOverview,  setAdminOverview] = useState(null);
  const [monthSalary,    setMonthSalary]   = useState(null);
  const [salaryLoading,  setSalaryLoading] = useState(false);
  const [bizReport,      setBizReport]     = useState(null);
  const [systemStatus,   setSystemStatus]  = useState(null);
  const [exportingMonth, setExportingMonth] = useState(null);
  const [pendingReqs,    setPendingReqs]   = useState([]);
  const [reviewBusy,     setReviewBusy]    = useState(null); // requestId 處理中

  // 匯出月度完整報表 (.xlsx, 5 個 sheet)
  const exportMonthReport = useCallback(async (month) => {
    if (!liveMode) return;
    setExportingMonth(month);
    try {
      const [sal, biz, md] = await Promise.all([
        callGAS('calculateMonthlySalary', { month }),
        callGAS('getMonthBusinessReport',  { month }).catch(() => null),
        callGAS('getMonthData',            { month }),
      ]);

      const wb = XLSX.utils.book_new();

      // === Sheet 1: 經營概況 ===
      const s1 = [
        ['密室經營報表', month, '', '', '產出時間', new Date().toLocaleString('zh-TW')],
        [],
        ['📊 經營指標', '金額（NT$）'],
      ];
      if (biz) {
        s1.push(['月毛收入',    biz.revenue]);
        s1.push(['月人事成本',  biz.labor]);
        s1.push(['月毛利',      biz.grossProfit]);
        s1.push(['人事佔比',    (biz.laborRatio * 100).toFixed(1) + '%']);
        s1.push([]);
        s1.push(['主題營收',    '金額']);
        if (biz.revenueByTheme) {
          Object.entries(biz.revenueByTheme).forEach(([t, v]) => s1.push([t, v]));
        }
        s1.push([]);
        s1.push(['資料來源',    biz.revenueSource || '']);
        s1.push(['營收天數',    biz.daysWithRevenue]);
      } else {
        s1.push(['（無營收資料）']);
      }
      s1.push([]);
      s1.push(['在職員工數', sal.perEmployee.length]);
      s1.push(['月薪資合計', sal.monthTotal]);
      const ws1 = XLSX.utils.aoa_to_sheet(s1);
      ws1['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 22 }];
      XLSX.utils.book_append_sheet(wb, ws1, '經營概況');

      // === Sheet 2: 月薪總表 ===
      const s2 = [
        ['員工ID', '姓名', '排班場次', '已對應', '遲到', '缺勤', '時數', '總薪'],
      ];
      sal.perEmployee.forEach(e => {
        s2.push([e.empId, e.name, e.totalShifts, e.totalCovered, e.totalLate, e.totalMissed, e.totalHours, e.totalPay]);
      });
      s2.push(['', '合計', '', '', '', '', '', sal.monthTotal]);
      const ws2 = XLSX.utils.aoa_to_sheet(s2);
      ws2['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws2, '月薪總表');

      // === Sheet 3: 薪資每日明細 ===
      const s3 = [
        ['員工ID', '姓名', '日期', '類別', '場次', '時數', '小計', '備註'],
      ];
      const empNameMap = {};
      sal.perEmployee.forEach(e => { empNameMap[e.empId] = e.name; });
      sal.perDay.forEach(d => {
        const name = empNameMap[d.empId] || '';
        Object.entries(d.byCat || {}).forEach(([cat, c]) => {
          if (c.sessions > 0 || c.pay > 0 || c.missed > 0) {
            s3.push([
              d.empId, name, d.date, cat,
              c.sessions || (c.covered + c.missed),
              c.hours || '', c.pay || 0,
              c.missed > 0 ? `${c.missed} 場未打卡` : ''
            ]);
          }
        });
        if (d.flags && d.flags.length > 0) {
          s3.push([d.empId, name, d.date, '⚠ 異常', '', '', '', d.flags.join('；')]);
        }
      });
      const ws3 = XLSX.utils.aoa_to_sheet(s3);
      ws3['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws3, '每日明細');

      // === Sheet 4: 排班表 ===
      const s4 = [
        ['日期', '開場時間', '主題', '角色', '員工ID', '員工姓名', '場費', '通知狀態'],
      ];
      (md.schedule || []).forEach(s => {
        s4.push([
          String(s['日期'] || '').substring(0, 10),
          String(s['開場時間'] || '').substring(0, 5),
          s['主題'] || '', s['角色'] || '',
          s['員工ID'] || '', s['員工姓名'] || '',
          s['場費'] || 0, s['通知狀態'] || '',
        ]);
      });
      const ws4 = XLSX.utils.aoa_to_sheet(s4);
      ws4['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws4, '排班表');

      // === Sheet 5: 預約清單 ===
      const s5 = [
        ['預約ID', '日期', '開場時間', '主題', '預約人數', '客戶聯絡', '來源', '備註'],
      ];
      (md.bookings || []).forEach(b => {
        s5.push([
          b['預約ID'] || '',
          String(b['日期'] || '').substring(0, 10),
          String(b['開場時間'] || '').substring(0, 5),
          b['主題'] || '', b['預約人數'] || 0,
          b['客戶聯絡'] || '', b['來源'] || '', b['備註'] || '',
        ]);
      });
      const ws5 = XLSX.utils.aoa_to_sheet(s5);
      ws5['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 28 }, { wch: 12 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws5, '預約清單');

      // === Sheet 6: 每日營收（如果有）===
      if (biz && biz.revenueAvailable) {
        const revData = await callGAS('getMonthRevenue', { month });
        const s6 = [
          ['日期', '星期', '平/假日', '毛收入', '密室加總', '折價加總', '紀念品加總', '詭獄', '詭店', '外婆'],
        ];
        (revData.daily || []).forEach(d => {
          s6.push([
            d.date, d.weekday, d.dayType,
            d.gross, d.indoor, d.discount, d.souvenir,
            d.byTheme['詭獄'] || 0, d.byTheme['詭店'] || 0, d.byTheme['外婆'] || 0,
          ]);
        });
        const ws6 = XLSX.utils.aoa_to_sheet(s6);
        ws6['!cols'] = Array(10).fill({ wch: 12 });
        XLSX.utils.book_append_sheet(wb, ws6, '每日營收');
      }

      XLSX.writeFile(wb, `密室經營報表_${month}.xlsx`);
    } catch (e) {
      alert('匯出失敗：' + e.message);
    } finally {
      setExportingMonth(null);
    }
  }, [liveMode]);

  // 系統狀態：切到設定 tab 時抓（stale-while-revalidate）
  const reloadSystemStatus = useCallback(async () => {
    if (!liveMode) return;
    const c = readGasCache('getSystemStatus', {});
    if (c) setSystemStatus(c.data);
    if (c && c.fresh) return;
    try {
      const data = await callGAS('getSystemStatus');
      setSystemStatus(data);
    } catch (e) { console.warn('getSystemStatus 失敗:', e.message); }
  }, [liveMode]);

  useEffect(() => {
    if (liveMode && tab === 'settings') reloadSystemStatus();
  }, [liveMode, tab, reloadSystemStatus]);

  // 從 GAS 抓真實 admin overview + pending requests，每分鐘 reload
  const reloadPendingReqs = useCallback(async () => {
    if (!liveMode) return;
    try {
      const data = await callGAS('getPendingRequests');
      setPendingReqs(data?.requests || []);
    } catch (e) {}
  }, [liveMode]);

  useEffect(() => {
    if (!liveMode) return;
    let cancel = false;
    // 立刻顯示 cache，背景靜默 reload
    callGAScached('getAdminOverview', {}, (fresh) => {
      if (!cancel) setAdminOverview(fresh);
    }).then(d => { if (!cancel) setAdminOverview(d); }).catch(() => {});
    reloadPendingReqs();
    const id = setInterval(() => {
      callGAS('getAdminOverview').then(d => { if (!cancel) setAdminOverview(d); }).catch(() => {});
      reloadPendingReqs();
    }, 60000);
    return () => { cancel = true; clearInterval(id); };
  }, [liveMode, reloadPendingReqs]);

  // 審核申請
  const handleReview = useCallback(async (requestId, action, note) => {
    setReviewBusy(requestId);
    try {
      const res = await callGAS('reviewRequest', { requestId, action, reviewer: 'admin', reviewNote: note || '' });
      showToast(`已${action === 'approve' ? '批准' : '拒絕'}${res?.actionTaken ? '（' + res.actionTaken + '）' : ''}`);
      await reloadPendingReqs();
    } catch (e) {
      showToast('審核失敗：' + e.message);
    } finally {
      setReviewBusy(null);
    }
  }, [reloadPendingReqs]);

  // v3.49 載入本月薪資 + 商業報表（只 call 一次 GAS，省半個 round-trip）
  const reloadMonthSalary = useCallback(async (targetMonth) => {
    if (!liveMode) return;
    const now = new Date();
    const month = targetMonth || (now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0'));

    // 立刻顯示 cache（若有）
    const cb = readGasCache('getMonthBusinessReport', { month });
    if (cb) {
      setBizReport(cb.data);
      if (cb.data?.monthSalary) setMonthSalary(cb.data.monthSalary);
      if (cb.fresh) return; // 新鮮就不打 API
    }

    if (!cb) setSalaryLoading(true);  // 沒 cache 才顯示 loading
    try {
      const biz = await callGAS('getMonthBusinessReport', { month });
      setBizReport(biz);
      if (biz?.monthSalary) setMonthSalary(biz.monthSalary);
    } catch (e) {
      console.warn('reloadMonthSalary 失敗:', e.message);
    } finally {
      setSalaryLoading(false);
    }
  }, [liveMode]);

  // v3.49 admin 登入後背景 prefetch 本月薪資（不阻塞 UI）
  useEffect(() => {
    if (!liveMode) return;
    // 延後 800ms 讓 admin overview 先載入
    const t = setTimeout(() => { reloadMonthSalary(); }, 800);
    return () => clearTimeout(t);
  }, [liveMode, reloadMonthSalary]);

  useEffect(() => {
    if (liveMode && tab === 'salary' && !monthSalary) reloadMonthSalary();
  }, [liveMode, tab, monthSalary, reloadMonthSalary]);
  const [selectedDate,   setSelectedDate]  = useState(new Date());
  const [selectedRoom,   setSelectedRoom]  = useState("A");
  const [selectedBranch, setSelectedBranch]= useState("大忠店");
  const [modal,          setModal]         = useState(null);
  // staffData/setStaffData 改從 props 來（main App 統一管理 + liveMode 接 GAS）
  const [toast,          setToast]         = useState({ show:false, msg:"" });
  const [sbLogin,        setSbLogin]       = useState(SB_CONFIG.companyLogin);
  const [sbKey,          setSbKey]         = useState("");
  const [sbStatus,       setSbStatus]      = useState(null); // null|"loading"|"ok"|"error"
  const [syncStatus,     setSyncStatus]    = useState(null); // null|"loading"|"ok"|"error"
  const [editStaff,      setEditStaff]     = useState(null); // { staff, isNew }
  const [deleteStaffId,  setDeleteStaffId] = useState(null);
  const [confirmedIds,   setConfirmedIds]  = useState(new Set());

  const weekDates = getWeekDates(selectedDate);

  function showToast(msg) {
    setToast({ show:true, msg });
    setTimeout(() => setToast(t=>({...t,show:false})), 2200);
  }

  function updateCell(roomId, time, data) {
    setSchedule(prev => ({
      ...prev,
      [roomId]: { ...prev[roomId], [time]: { ...prev[roomId][time], ...data } }
    }));
    setModal(null);
    showToast("已儲存");
  }

  // SimplyBook 測試連線
  async function testSimplyBookConn() {
    setSbStatus("loading");
    try {
      const r = await fetch(SB_CONFIG.backendUrl + "/api/health", { signal: AbortSignal.timeout(8000) });
      setSbStatus(r.ok ? "ok" : "error");
    } catch {
      setSbStatus("error");
    }
  }

  // 立即同步今日預約：liveMode 直接呼叫 GAS 的 _v3SyncSimplyBookBookings
  async function syncTodayBookings() {
    setSyncStatus("loading");
    if (liveMode) {
      try {
        await callGAS("_v3RunSyncNow");
        // 立刻重抓 overview
        try {
          const data = await callGAS("getAdminOverview");
          setAdminOverview(data);
        } catch (_) {}
        showToast("已觸發 GAS 同步，預約已更新");
        setSyncStatus("ok");
        setTimeout(() => setSyncStatus(null), 2000);
      } catch (e) {
        setSyncStatus("error");
        showToast("同步失敗：" + e.message);
        setTimeout(() => setSyncStatus(null), 3000);
      }
      return;
    }
    // demo 模式：原本走 bgl-backend-new 的 fallback
    try {
      const r = await fetch(`${SB_CONFIG.backendUrl}/api/bookings`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const bookings = Array.isArray(data) ? data : (data.bookings || []);
      if (bookings.length > 0) {
        setSchedule(prev => {
          const next = { ...prev };
          bookings.forEach(b => {
            const roomId = SB_SERVICE_MAP[b.service_id];
            const time   = b.start_time?.slice(0,5);
            if (roomId && time && next[roomId]?.[time] !== undefined) {
              next[roomId] = {
                ...next[roomId],
                [time]: { booked:true, staffId:null, clientName:b.client_name||"", source:"simplybook" }
              };
            }
          });
          return next;
        });
        showToast(`同步完成，共 ${bookings.length} 筆預約`);
      } else {
        showToast("同步完成，今日無預約");
      }
      setSyncStatus("ok");
    } catch {
      setSyncStatus("error");
      showToast("同步失敗，請檢查後端連線");
    }
  }

  // 儲存員工編輯
  async function handleSaveStaff({ name, rate, shift, color, password, role, branch, themes, lineUserId }) {
    if (liveMode) {
      try {
        if (editStaff.isNew) {
          const res = await callGAS('addStaff', {
            name, rate, password,
            role: role || '兼職NPC',
            branch: branch || '兩店通用',
            themes: themes || '',
            lineUserId: lineUserId || ''
          });
          showToast(`已新增員工 ${name}（${res.empId}）寫入 Sheets`);
        } else {
          const updates = { rate };
          if (password) updates.password = password;
          if (role) updates.role = role;
          if (branch) updates.branch = branch;
          if (themes !== undefined) updates.themes = themes;
          if (lineUserId !== undefined) updates.lineUserId = lineUserId;
          await callGAS('updateStaff', { empId: editStaff.staff.id, updates });
          showToast(`已更新 ${editStaff.staff.name}`);
        }
        await reloadStaff();   // 抓最新資料
      } catch (e) {
        showToast(`儲存失敗：${e.message}`);
      }
    } else {
      // demo 模式：原本邏輯
      if (editStaff.isNew) {
        const newId = nextStaffId();
        setStaffData(prev => [...prev, { id:newId, name, rate, color, shift, bonus:0, deduct:0 }]);
        setAccounts(prev => ({ ...prev, [name]: { pass:password, role:"staff", staffId:newId } }));
        showToast(`已建立員工帳號：${name}`);
      } else {
        const s = editStaff.staff;
        setStaffData(prev => prev.map(x => x.id===s.id ? { ...x, rate, shift, color } : x));
        if (password) {
          setAccounts(prev => {
            const next = { ...prev };
            Object.keys(next).forEach(k => {
              if (next[k].staffId === s.id) next[k] = { ...next[k], pass:password };
            });
            return next;
          });
        }
        showToast(`已更新 ${s.name}`);
      }
    }
    setEditStaff(null);
  }

  // 刪除員工
  async function handleDeleteStaff() {
    const id = deleteStaffId;
    const s = staffData.find(x => x.id === id);
    if (liveMode) {
      try {
        await callGAS('deleteStaff', { empId: id });
        showToast(`${s?.name} 已標記為「離職」（Sheets 保留歷史資料）`);
        await reloadStaff();
      } catch (e) {
        showToast(`刪除失敗：${e.message}`);
      }
    } else {
      setStaffData(prev => prev.filter(x => x.id !== id));
      setAccounts(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(k => { if (next[k].staffId === id) delete next[k]; });
        return next;
      });
      showToast(`已刪除員工：${s?.name}`);
    }
    setDeleteStaffId(null);
  }

  // 確認異常打卡
  function confirmAnomaly(punchId) {
    setConfirmedIds(prev => new Set([...prev, punchId]));
  }

  const branchRooms   = useMemo(() => ROOMS.filter(r => r.branch === selectedBranch), [selectedBranch]);
  const bookedSlots   = useMemo(() => {
    const result = {};
    SLOTS.forEach(t => {
      const rooms = branchRooms.filter(r => schedule[r.id]?.[t]?.booked);
      if (rooms.length > 0) result[t] = rooms;
    });
    return result;
  }, [schedule, branchRooms]);

  const presentStaff  = useMemo(() => getPresentStaff(punchLogs), [punchLogs]);
  const anomalies     = useMemo(() => punchLogs.filter(l=>l.anomaly), [punchLogs]);
  const pendingCount  = useMemo(() => anomalies.filter(l=>!confirmedIds.has(l.id)).length, [anomalies, confirmedIds]);

  const totalBookings = useMemo(() =>
    Object.values(schedule).reduce((a,rm)=>a+Object.values(rm).filter(c=>c.booked).length,0),
    [schedule]
  );

  const salaryRows = useMemo(() => {
    return staffData.map(s => {
      const worked = calcHours(s.id, punchLogs);
      const hours  = worked > 0 ? worked : 40;
      const base   = Math.round(hours * s.rate);
      const net    = base + s.bonus - s.deduct;
      return { ...s, hours, base, net };
    });
  }, [staffData, punchLogs]);

  const TABS = [
    { id:"overview",  label:"總覽"  },
    { id:"schedule",  label:"排班"  },
    { id:"clock",     label:"打卡"  },
    { id:"salary",    label:"薪資"  },
    { id:"settings",  label:"設定"  },
  ];

  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet"/>
      <Toast msg={toast.msg} show={toast.show} />

      {modal && (
        <CellModal
          cell={schedule[modal.roomId]?.[modal.time]}
          room={ROOMS.find(r=>r.id===modal.roomId)}
          time={modal.time}
          staffList={staffData}
          onSave={(data)=>updateCell(modal.roomId, modal.time, data)}
          onClose={()=>setModal(null)}
        />
      )}

      {editStaff && (
        <StaffEditModal
          staff={editStaff.staff}
          isNew={editStaff.isNew}
          onSave={handleSaveStaff}
          onClose={()=>setEditStaff(null)}
          liveMode={liveMode}
        />
      )}

      {deleteStaffId && (
        <ConfirmDialog
          message={liveMode
            ? `將員工「${staffData.find(s=>s.id===deleteStaffId)?.name}」標記為「離職」？資料會保留在 Sheets 員工主檔（薪資/排班歷史不會消失），未來可重新啟用。`
            : `確定要刪除員工「${staffData.find(s=>s.id===deleteStaffId)?.name}」？此操作無法復原，相關登入帳號也會一併移除。`}
          onConfirm={handleDeleteStaff}
          onCancel={()=>setDeleteStaffId(null)}
        />
      )}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        padding:"1.25rem 1.25rem 0.5rem", borderBottom:`1px solid ${C.border}`, marginBottom:"0.75rem" }}>
        <div>
          <div style={{ fontSize:16, fontWeight:500 }}>管理後台</div>
          <div style={{ fontSize:11, color:C.muted }}>Admin</div>
        </div>
        <div style={{ width:36, height:36, borderRadius:"50%", background:"#FEF8E7", color:"#8A6200",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:500 }}>管</div>
      </div>

      <div style={{ padding:"0 1.25rem" }}>
        <div style={S.tabBar}>
          {TABS.map(t => (
            <button key={t.id} style={S.tab(tab===t.id)} onClick={()=>setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {/* ── 總覽 ── */}
        {tab==="overview" && (
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:"1rem" }}>
              {(() => {
                const todayAtt = liveMode && adminOverview ? adminOverview.todayAttendance : presentStaff.length;
                const anomalyCnt = liveMode && adminOverview ? adminOverview.anomalyCount : anomalies.length;
                const shiftCnt = liveMode && adminOverview ? adminOverview.todayShiftCount : totalBookings;
                const monthSalary = liveMode && adminOverview
                  ? `＄${(adminOverview.monthSalary/1000).toFixed(1)}k`
                  : "$34.2k";
                return [
                  ["今日出勤", `${todayAtt} 人`, null],
                  ["異常打卡", `${anomalyCnt} 件`, anomalyCnt > 0 ? C.danger.text : null],
                  ["今日場次", `${shiftCnt} 場`, null],
                  ["本月薪資", monthSalary, null],
                ];
              })().map(([label,val,color]) => (
                <div key={label} style={S.metric}>
                  <div style={S.label}>{label}</div>
                  <div style={{ fontSize:22, fontWeight:600, color:color||C.text }}>{val}</div>
                </div>
              ))}
            </div>

            {/* 快捷：立即同步 */}
            <button
              onClick={syncTodayBookings}
              disabled={syncStatus==="loading"}
              style={{ ...S.ghostBtn, width:"100%", padding:"10px 0", textAlign:"center",
                marginBottom:"1rem", color: C.info.text, borderColor: C.info.text+"44",
                background: C.info.bg, opacity: syncStatus==="loading" ? 0.6 : 1 }}>
              {syncStatus==="loading" ? "同步中..." : "⟳  立即同步今日預約"}
            </button>

            {/* liveMode：直接顯示 GAS 真實員工狀態 */}
            {liveMode && adminOverview ? (
              <>
                {/* 📥 待審申請（最重要，放最上面） */}
                {pendingReqs.length > 0 && (
                  <div style={{ ...S.card, border:`2px solid ${C.warning.text}66`, background:'#FFFAEC' }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8 }}>
                      <div style={{ fontSize:14, fontWeight:600, color:C.warning.text }}>
                        📥 待審申請（{pendingReqs.length}）
                      </div>
                    </div>
                    {pendingReqs.map((r, i, arr) => (
                      <div key={r.requestId} style={{ padding:"10px 4px",
                        borderBottom: i===arr.length-1 ? 'none' : `1px solid ${C.border}` }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:3 }}>
                          <div style={{ fontSize:13, fontWeight:500 }}>
                            {r.name} <span style={{ fontSize:10, color:C.muted }}>{r.empId}</span>
                            {' · '}{r.type}
                          </div>
                          <span style={{ fontSize:10, color:C.muted }}>{r.submittedAt.substring(5,16)}</span>
                        </div>
                        <div style={{ fontSize:12, color:C.text, marginTop:2 }}>
                          {r.date}{r.time ? ` ${r.time}` : ''}
                          {r.details?.punchType && <span style={{ marginLeft:6 }}>({r.details.punchType === 'in' ? '上班' : '下班'})</span>}
                          {r.details?.leaveKind && <span style={{ marginLeft:6 }}>({r.details.leaveKind})</span>}
                          {r.details?.swapWithEmpId && <span style={{ marginLeft:6 }}>(換給 {r.details.swapWithEmpId})</span>}
                        </div>
                        {r.note && (
                          <div style={{ fontSize:11, color:C.muted, marginTop:3 }}>備註：{r.note}</div>
                        )}
                        <div style={{ display:"flex", gap:6, marginTop:8 }}>
                          <button onClick={() => handleReview(r.requestId, 'approve', '')}
                            disabled={reviewBusy === r.requestId}
                            style={{ flex:1, padding:"7px 0", fontSize:12, fontWeight:500,
                              border:"none", borderRadius:8, background:C.success.text, color:"#FFF",
                              cursor: reviewBusy === r.requestId ? "wait" : "pointer",
                              fontFamily:"'Noto Sans TC', sans-serif" }}>
                            ✓ 批准
                          </button>
                          <button onClick={() => {
                            const reason = window.prompt('拒絕原因（可留空）') ?? null;
                            if (reason !== null) handleReview(r.requestId, 'reject', reason);
                          }} disabled={reviewBusy === r.requestId}
                            style={{ flex:1, padding:"7px 0", fontSize:12, fontWeight:500,
                              border:`1px solid ${C.danger.text}66`, borderRadius:8,
                              background:"transparent", color:C.danger.text,
                              cursor: reviewBusy === r.requestId ? "wait" : "pointer",
                              fontFamily:"'Noto Sans TC', sans-serif" }}>
                            ✗ 拒絕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* 📊 本月場次概況 + 員工排行 */}
                {adminOverview.monthlyStats && (
                  <div style={S.card}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
                      <div style={S.label}>📊 本月場次概況 ({adminOverview.monthlyStats.month})</div>
                      <div style={{ fontSize:10, color:C.hint }}>{adminOverview.monthlyStats.empCount} 位員工有班</div>
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
                      <div style={{ background:"#EEF4FF", borderRadius:8, padding:"10px 12px" }}>
                        <div style={{ fontSize:11, color:"#2A5CC0" }}>月總預約場次</div>
                        <div style={{ fontSize:22, fontWeight:700, color:"#2A5CC0" }}>
                          {adminOverview.monthlyStats.totalBookings}
                          <span style={{ fontSize:12, fontWeight:400, marginLeft:4 }}>場</span>
                        </div>
                      </div>
                      <div style={{ background:"#EDFBF4", borderRadius:8, padding:"10px 12px" }}>
                        <div style={{ fontSize:11, color:"#1A7A4A" }}>月總已排班</div>
                        <div style={{ fontSize:22, fontWeight:700, color:"#1A7A4A" }}>
                          {adminOverview.monthlyStats.totalScheduled}
                          <span style={{ fontSize:12, fontWeight:400, marginLeft:4 }}>人次</span>
                        </div>
                      </div>
                    </div>

                    <div style={{ fontSize:11, color:C.muted, marginBottom:6, fontWeight:500 }}>員工本月場次排行</div>
                    {adminOverview.monthlyStats.empRanking.map((e,i,arr) => {
                      const cap = e.isFulltime ? 60 : 50;
                      const overrun = e.shifts > cap;
                      const ratio = Math.min(1, e.shifts / cap);
                      const medals = ['🥇','🥈','🥉'];
                      return (
                        <div key={e.empId} style={{ padding:"5px 0",
                          borderBottom: i===arr.length-1 ? 'none' : `1px solid ${C.border}` }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                              <span style={{ fontSize:11, color:C.muted, minWidth:20 }}>
                                {i < 3 ? medals[i] : `#${i+1}`}
                              </span>
                              <span style={{ fontSize:12, fontWeight:500 }}>{e.name}</span>
                              <span style={{ fontSize:10, color:C.muted }}>{e.role}</span>
                            </div>
                            <span style={{ fontSize:13, fontWeight:600, color: overrun ? C.danger.text : C.text }}>
                              {e.shifts} 場
                              {overrun && <span style={{ fontSize:10, marginLeft:4 }}>⚠</span>}
                            </span>
                          </div>
                          {/* 進度條（相對軟上限） */}
                          <div style={{ height:3, background:'#f0ede4', borderRadius:2, overflow:'hidden' }}>
                            <div style={{ width: `${ratio*100}%`, height:'100%',
                              background: overrun ? C.danger.text : ratio > 0.8 ? '#C07000' : '#5b8a3a' }}/>
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ fontSize:10, color:C.hint, marginTop:8, textAlign:"center" }}>
                      軟上限：正職 60 場 / 兼職 50 場
                    </div>
                  </div>
                )}

                <div style={S.card}>
                  <div style={S.label}>目前在場員工（{adminOverview.presentStaff.length}）</div>
                  {adminOverview.presentStaff.length === 0
                    ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>目前無人在場</div>
                    : adminOverview.presentStaff.map((s,i,arr) => (
                        <div key={s.empId} style={S.row(i===arr.length-1)}>
                          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                            <Avatar name={s.name||"?"} color="#5b8a3a" size={34}/>
                            <div>
                              <div style={{ fontSize:13, fontWeight:500 }}>{s.name} <span style={{ color:C.muted, fontSize:10 }}>{s.empId}</span></div>
                              <div style={{ fontSize:11, color:C.muted }}>上班 {s.firstIn} · 今日 {s.todayShiftCount} 場</div>
                            </div>
                          </div>
                          <span style={S.badge(s.lateMin>0?"amber":"green")}>
                            {s.lateMin>0 ? `遲到 ${s.lateMin} 分` : "在場"}
                          </span>
                        </div>
                      ))
                  }
                </div>

                {adminOverview.finishedStaff.length > 0 && (
                  <div style={S.card}>
                    <div style={S.label}>今日已下班（{adminOverview.finishedStaff.length}）</div>
                    {adminOverview.finishedStaff.map((s,i,arr) => (
                      <div key={s.empId} style={S.row(i===arr.length-1)}>
                        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                          <Avatar name={s.name||"?"} color="#9a8f7d" size={34}/>
                          <div>
                            <div style={{ fontSize:13, fontWeight:500 }}>{s.name} <span style={{ color:C.muted, fontSize:10 }}>{s.empId}</span></div>
                            <div style={{ fontSize:11, color:C.muted }}>{s.firstIn} 上班 → {s.lastActionTime} 下班</div>
                          </div>
                        </div>
                        <span style={S.badge("gray")}>已下班</span>
                      </div>
                    ))}
                  </div>
                )}

                {adminOverview.noShowList && adminOverview.noShowList.length > 0 && (
                  <div style={S.card}>
                    <div style={{ ...S.label, color: C.danger.text }}>⚠️ 排班但未打卡（{adminOverview.noShowList.length}）</div>
                    {adminOverview.noShowList.map((s,i,arr) => (
                      <div key={s.empId} style={S.row(i===arr.length-1)}>
                        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                          <Avatar name={s.name||"?"} color={C.danger.text} size={34}/>
                          <div>
                            <div style={{ fontSize:13, fontWeight:500 }}>{s.name} <span style={{ color:C.muted, fontSize:10 }}>{s.empId}</span></div>
                            <div style={{ fontSize:11, color:C.muted }}>首場 {s.firstShiftTime} · 今日 {s.todayShiftCount} 場</div>
                          </div>
                        </div>
                        <span style={S.badge("amber")}>未到</span>
                      </div>
                    ))}
                  </div>
                )}

                <div style={S.card}>
                  <div style={S.label}>今日預約（{adminOverview.todayBookings.length}）</div>
                  {adminOverview.todayBookings.length === 0
                    ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>今日無預約</div>
                    : adminOverview.todayBookings.map((b,i,arr) => (
                        <div key={b.bookingId||i} style={S.row(i===arr.length-1)}>
                          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                            <div style={{ width:8, height:8, borderRadius:'50%', background:themeColor(b.theme), flexShrink:0 }}/>
                            <div>
                              <div style={{ fontSize:13, fontWeight:500 }}>{b.time} {b.theme}</div>
                              <div style={{ fontSize:11, color:C.muted }}>
                                {b.contact || '—'}{b.headcount ? ` · ${b.headcount}人` : ''}
                                {b.source==='simplybook' && <span style={{ color:'#2A5CC0', marginLeft:6 }}>SB</span>}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                  }
                </div>
              </>
            ) : (
              // demo 模式 fallback
              <div style={S.card}>
                <div style={S.label}>目前在場員工</div>
                {presentStaff.length === 0
                  ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>目前無人在場</div>
                  : presentStaff.map((l,i) => {
                      const sf = staffById(l.staffId, staffData);
                      return (
                        <div key={i} style={S.row(i===presentStaff.length-1)}>
                          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                            <Avatar name={l.name} color={sf?.color||"#888"} size={34}/>
                            <div>
                              <div style={{ fontSize:13, fontWeight:500 }}>{l.name}</div>
                              <div style={{ fontSize:11, color:C.muted }}>上班 {l.timeStr}</div>
                            </div>
                          </div>
                          <span style={S.badge(l.anomaly?"amber":"green")}>{l.anomaly||"在場"}</span>
                        </div>
                      );
                    })
                }
              </div>
            )}
          </div>
        )}

        {/* ── 排班 ── */}
        {tab==="schedule" && (
          <GasAdminEmbed onClose={() => setTab("overview")} />
        )}

        {/* ── 打卡管理 ── */}
        {tab==="clock" && (liveMode && adminOverview ? (
          <div>
            <div style={S.card}>
              <div style={S.label}>今日打卡明細（{adminOverview.todayPunches.length} 筆）</div>
              {adminOverview.todayPunches.length === 0
                ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>今日尚無打卡紀錄</div>
                : adminOverview.todayPunches.slice().reverse().map((p,i,arr) => (
                    <div key={i} style={{ ...S.row(i===arr.length-1), gap:8 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:13, fontWeight:500 }}>
                          {p.name} <span style={{ fontSize:10, color:C.muted }}>{p.empId}</span>
                        </div>
                        <div style={{ fontSize:11, color:C.muted }}>
                          {p.type==='in' ? '上班打卡' : '下班打卡'} {p.time}
                        </div>
                        {p.lateMin > 0 && (
                          <div style={{ fontSize:11, color:C.warning.text, marginTop:2 }}>
                            遲到 {p.lateMin} 分鐘（首場 {p.againstShift}）
                          </div>
                        )}
                      </div>
                      <span style={S.badge(
                        p.lateMin > 0 ? "amber" :
                        p.type === "in" ? "green" : "gray"
                      )}>
                        {p.lateMin > 0 ? `遲到 ${p.lateMin}m` : (p.type==='in' ? '上班' : '下班')}
                      </span>
                    </div>
                  ))
              }
            </div>
            <div style={S.card}>
              <div style={S.label}>今日異常摘要</div>
              {[
                ["遲到",      adminOverview.lateCount, "件"],
                ["未到",      adminOverview.noShowCount, "人"],
                ["異常合計",  adminOverview.anomalyCount, "件"],
              ].map(([k,v,unit],i,arr) => (
                <div key={k} style={{ ...S.row(i===arr.length-1), fontSize:13 }}>
                  <span style={{ color:C.muted }}>{k}</span>
                  <span style={{ fontWeight:500, color: v>0 ? C.danger.text : C.text }}>
                    {v} {unit}
                  </span>
                </div>
              ))}
            </div>
            {adminOverview.noShowList && adminOverview.noShowList.length > 0 && (
              <div style={S.card}>
                <div style={{ ...S.label, color:C.danger.text }}>⚠️ 未到員工</div>
                {adminOverview.noShowList.map((s,i,arr) => (
                  <div key={s.empId} style={S.row(i===arr.length-1)}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:500 }}>{s.name} <span style={{ fontSize:10, color:C.muted }}>{s.empId}</span></div>
                      <div style={{ fontSize:11, color:C.muted }}>首場 {s.firstShiftTime} · 今日 {s.todayShiftCount} 場</div>
                    </div>
                    <span style={S.badge("amber")}>未打卡</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          // demo 模式 fallback
          <div>
            <div style={S.card}>
              <div style={S.label}>今日打卡紀錄</div>
              {punchLogs.length === 0
                ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>尚無打卡紀錄</div>
                : [...punchLogs].reverse().map((l,i,arr) => {
                    const isConfirmed = confirmedIds.has(l.id);
                    return (
                      <div key={l.id||i} style={{ ...S.row(i===arr.length-1), gap:8 }}>
                        <div style={{ flex:1, opacity: isConfirmed ? 0.45 : 1 }}>
                          <div style={{ fontSize:13, fontWeight:500 }}>{l.name}</div>
                          <div style={{ fontSize:11, color:C.muted }}>{l.type==="in"?"上班":"下班"} {l.timeStr}</div>
                          {l.anomaly && (
                            <div style={{ fontSize:11, color: isConfirmed ? C.hint : C.warning.text, marginTop:2 }}>
                              {l.anomaly}{isConfirmed ? " · 已確認" : ""}
                            </div>
                          )}
                        </div>
                        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                          {l.anomaly && !isConfirmed && (
                            <button
                              onClick={() => confirmAnomaly(l.id)}
                              style={{ padding:"4px 10px", borderRadius:8, border:`1px solid ${C.warning.text}44`,
                                background:C.warning.bg, color:C.warning.text, fontSize:11,
                                cursor:"pointer", fontFamily:"'Noto Sans TC', sans-serif", fontWeight:500,
                                whiteSpace:"nowrap" }}>
                              確認
                            </button>
                          )}
                          <span style={S.badge(
                            isConfirmed ? "gray" :
                            l.anomaly ? "amber" :
                            l.type==="in" ? "green" : "gray"
                          )}>
                            {isConfirmed ? "已確認" : l.anomaly || (l.type==="in"?"正常":"下班")}
                          </span>
                        </div>
                      </div>
                    );
                  })
              }
            </div>
          </div>
        ))}

        {/* ── 薪資 ── */}
        {tab==="salary" && (liveMode ? (
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem", gap:8, flexWrap:"wrap" }}>
              <div style={{ fontSize:14, fontWeight:600 }}>
                {monthSalary?.month || (new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0'))} 薪資
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={reloadMonthSalary} disabled={salaryLoading}
                  style={{ fontSize:11, padding:"5px 10px", border:`1px solid ${C.border}`,
                    borderRadius:6, background:"transparent", color:C.muted,
                    cursor: salaryLoading ? "wait" : "pointer", fontFamily:"'Noto Sans TC', sans-serif" }}>
                  {salaryLoading ? "計算中..." : "↻ 重算"}
                </button>
                <button
                  onClick={() => exportMonthReport(monthSalary?.month || (new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0')))}
                  disabled={!!exportingMonth || !monthSalary}
                  style={{ fontSize:11, padding:"5px 12px", border:"none",
                    borderRadius:6, background: exportingMonth ? "#94a8d6" : "#2A5CC0", color:"#FFF",
                    cursor: exportingMonth ? "wait" : "pointer", fontFamily:"'Noto Sans TC', sans-serif",
                    fontWeight:500 }}>
                  {exportingMonth ? "匯出中..." : "📥 匯出 Excel"}
                </button>
              </div>
            </div>

            <div style={{ display:"flex", gap:6, marginBottom:"0.75rem", overflowX:"auto", paddingBottom:4 }}>
              {(() => {
                const cur = new Date();
                const months = [];
                for (let i = 0; i < 6; i++) {
                  const d = new Date(cur.getFullYear(), cur.getMonth() - i, 1);
                  months.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
                }
                return months.map(m => (
                  <button key={m} onClick={() => reloadMonthSalary(m)} style={{
                    flexShrink:0, padding:"5px 10px", borderRadius:8, fontSize:11,
                    border: `1px solid ${monthSalary?.month === m ? "#2A5CC0" : C.border}`,
                    background: monthSalary?.month === m ? "#EEF4FF" : "transparent",
                    color: monthSalary?.month === m ? "#2A5CC0" : C.muted,
                    cursor: "pointer", fontFamily:"'Noto Sans TC', sans-serif",
                    fontWeight: monthSalary?.month === m ? 500 : 400,
                  }}>
                    {m}
                  </button>
                ));
              })()}
            </div>

            {!monthSalary && !salaryLoading && (
              <div style={{ ...S.card, textAlign:"center", color:C.hint, fontSize:13 }}>
                點「↻ 重算」載入本月薪資
              </div>
            )}

            {salaryLoading && (
              <div style={{ ...S.card, textAlign:"center", color:C.muted, fontSize:13 }}>
                計算中...
              </div>
            )}

            {monthSalary && (
              <>
                {/* 經營概況：月營收 + 人事 + 毛利 (謎先生) */}
                {bizReport && bizReport.revenueAvailable && (
                  <div style={{ ...S.card, marginBottom:"0.75rem" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
                      <span style={{ fontSize:13, fontWeight:500 }}>📈 本月經營概況 (謎先生)</span>
                      <span style={{ fontSize:10, color:C.hint }}>{bizReport.daysWithRevenue} 天有營收</span>
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
                      <div style={{ textAlign:"center", padding:"10px 4px", background:"#EDFBF4", borderRadius:8 }}>
                        <div style={{ fontSize:10, color:"#1A7A4A", marginBottom:3 }}>毛收入</div>
                        <div style={{ fontSize:15, fontWeight:700, color:"#1A7A4A" }}>
                          ＄{(bizReport.revenue/1000).toFixed(0)}k
                        </div>
                      </div>
                      <div style={{ textAlign:"center", padding:"10px 4px", background:"#FEF0F0", borderRadius:8 }}>
                        <div style={{ fontSize:10, color:"#C0292A", marginBottom:3 }}>人事</div>
                        <div style={{ fontSize:15, fontWeight:700, color:"#C0292A" }}>
                          ＄{(bizReport.labor/1000).toFixed(1)}k
                        </div>
                      </div>
                      <div style={{ textAlign:"center", padding:"10px 4px",
                        background: bizReport.grossProfit > 0 ? "#EEF4FF" : "#FEF8E7", borderRadius:8 }}>
                        <div style={{ fontSize:10, color: bizReport.grossProfit > 0 ? "#2A5CC0" : "#C07000", marginBottom:3 }}>毛利</div>
                        <div style={{ fontSize:15, fontWeight:700, color: bizReport.grossProfit > 0 ? "#2A5CC0" : "#C07000" }}>
                          ＄{(bizReport.grossProfit/1000).toFixed(0)}k
                        </div>
                      </div>
                    </div>
                    {bizReport.revenue > 0 && (
                      <div style={{ fontSize:11, color:C.muted, textAlign:"center", marginBottom:6 }}>
                        人事佔比 {(bizReport.laborRatio*100).toFixed(1)}%
                        {bizReport.laborRatio > 0.4 && <span style={{ color:C.danger.text, marginLeft:6 }}>⚠ 偏高</span>}
                      </div>
                    )}
                    {bizReport.revenueByTheme && (
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6, justifyContent:"center", marginTop:8 }}>
                        {Object.entries(bizReport.revenueByTheme)
                          .filter(([, v]) => v > 0)
                          .sort(([, a], [, b]) => b - a)
                          .map(([theme, val]) => (
                            <span key={theme} style={{ fontSize:10, padding:"3px 8px", borderRadius:6,
                              background: '#f5f3ee', color: themeColor(theme), fontWeight:500 }}>
                              {theme} ＄{(val/1000).toFixed(0)}k
                            </span>
                          ))
                        }
                      </div>
                    )}
                  </div>
                )}

                {bizReport && !bizReport.revenueAvailable && (
                  <div style={{ ...S.card, marginBottom:"0.75rem", background:C.tabBg }}>
                    <div style={{ fontSize:11, color:C.muted, textAlign:"center" }}>
                      📊 本月營收資料尚未填寫 ({bizReport.revenueError || '請員工每日記錄'})
                    </div>
                  </div>
                )}

                <div style={{ ...S.card, background:C.info.bg, marginBottom:"0.75rem" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ color:C.info.text, fontSize:13 }}>本月應付薪資合計</span>
                    <span style={{ fontWeight:700, fontSize:20, color:C.info.text }}>
                      ＄{(monthSalary.monthTotal || 0).toLocaleString()}
                    </span>
                  </div>
                </div>

                <div style={{ ...S.card, marginBottom:"0.75rem" }}>
                  <div style={S.label}>員工薪資（{monthSalary.perEmployee.length}）</div>
                  {monthSalary.perEmployee.length === 0
                    ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>本月無打卡資料</div>
                    : monthSalary.perEmployee.map((e,i,arr) => {
                        const cats = Object.entries(e.byCat || {})
                          .filter(([, v]) => v.pay > 0 || v.sessions > 0 || v.missed > 0)
                          .sort(([, a], [, b]) => b.pay - a.pay);
                        return (
                          <div key={e.empId} style={{ padding:"10px 4px",
                            borderBottom: i===arr.length-1 ? 'none' : `1px solid ${C.border}` }}>
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
                              <div>
                                <span style={{ fontSize:14, fontWeight:500 }}>{e.name}</span>
                                <span style={{ fontSize:10, color:C.muted, marginLeft:6 }}>{e.empId}</span>
                              </div>
                              <span style={{ fontSize:15, fontWeight:700, color:e.totalPay>0 ? C.text : C.hint }}>
                                ＄{e.totalPay.toLocaleString()}
                              </span>
                            </div>
                            <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>
                              {e.totalShifts}排 · 到 {e.totalCovered}
                              {e.totalLate>0 && <span style={{ color:C.warning.text }}> · 遲到 {e.totalLate}</span>}
                              {e.totalMissed>0 && <span style={{ color:C.danger.text }}> · 缺 {e.totalMissed}</span>}
                            </div>
                            {cats.length > 0 && (
                              <div style={{ marginTop:6, display:"flex", flexWrap:"wrap", gap:4 }}>
                                {cats.map(([cat, v]) => (
                                  <span key={cat} style={{ fontSize:10, padding:"2px 6px", borderRadius:6,
                                    background: v.pay > 0 ? '#eef4ff' : '#f5f3ee',
                                    color: v.pay > 0 ? '#2A5CC0' : C.muted }}>
                                    {cat}: {v.sessions > 0 ? `${v.sessions}場` : v.missed > 0 ? `缺${v.missed}` : `${v.hours.toFixed(1)}h`} ＄{Math.round(v.pay)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                  }
                </div>

                <div style={{ fontSize:10, color:C.hint, textAlign:"center" }}>
                  資料來源：GAS 打卡紀錄 + 排班結果分頁<br/>
                  {monthSalary.notes}
                </div>
              </>
            )}
          </div>
        ) : (
          // demo 模式 fallback
          <div>
            <div style={{ ...S.card, marginBottom:"0.75rem" }}>
              <div style={S.label}>月薪資總表（範例）</div>
              {salaryRows.map((s,i) => (
                <div key={s.id} style={S.row(i===salaryRows.length-1)}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:500, color:s.color }}>{s.name}</div>
                    <div style={{ fontSize:10, color:C.muted }}>{s.hours}h × ${s.rate}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:13, fontWeight:500 }}>${s.net.toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ ...S.card, background:C.tabBg }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:14 }}>
                <span style={{ color:C.muted }}>本月薪資總計</span>
                <span style={{ fontWeight:600 }}>${salaryRows.reduce((a,s)=>a+s.net,0).toLocaleString()}</span>
              </div>
            </div>
          </div>
        ))}

        {/* ── 設定 ── */}
        {tab==="settings" && (
          <div>
            {/* 系統狀態 */}
            {liveMode && (
              <div style={S.card}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                  <div style={S.label}>系統狀態</div>
                  <button onClick={reloadSystemStatus} style={{ fontSize:11, padding:"3px 8px",
                    border:`1px solid ${C.border}`, borderRadius:6, background:"transparent",
                    color:C.muted, cursor:"pointer", fontFamily:"'Noto Sans TC', sans-serif" }}>↻</button>
                </div>
                {!systemStatus
                  ? <div style={{ fontSize:12, color:C.hint, padding:"0.5rem 0" }}>載入中...</div>
                  : (
                    <div style={{ fontSize:12 }}>
                      {/* SimplyBook */}
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>SimplyBook 同步</span>
                        <span style={{ color: systemStatus.simplybook.autoSyncTrigger ? C.success.text : C.danger.text, fontWeight:500 }}>
                          {systemStatus.simplybook.autoSyncTrigger ? "✓ 每 15 分鐘自動跑" : "✗ trigger 沒在跑"}
                        </span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>　最新預約寫入</span>
                        <span style={{ color:C.text, fontFamily:"monospace", fontSize:11 }}>{systemStatus.simplybook.latestBookingTime || "—"}</span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>　預約總筆數</span>
                        <span style={{ color:C.text, fontWeight:500 }}>{systemStatus.sheets.bookingsCount} 筆</span>
                      </div>

                      {/* Calendar */}
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>行事曆可班同步</span>
                        <span style={{ color: systemStatus.calendar.syncTrigger ? C.success.text : C.danger.text, fontWeight:500 }}>
                          {systemStatus.calendar.syncTrigger ? "✓ 每日 06:00 跑" : "✗"}
                        </span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>　可班時段筆數</span>
                        <span style={{ color:C.text, fontWeight:500 }}>{systemStatus.sheets.availCount} 列</span>
                      </div>

                      {/* LINE */}
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>LINE Channel Token</span>
                        <span style={{ color: systemStatus.line.tokenConfigured ? C.success.text : C.warning.text, fontWeight:500 }}>
                          {systemStatus.line.tokenConfigured ? "✓ 已填" : "⏳ 待設定"}
                        </span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>　Owner LINE ID</span>
                        <span style={{ color: systemStatus.line.ownerConfigured ? C.success.text : C.warning.text, fontWeight:500 }}>
                          {systemStatus.line.ownerConfigured ? "✓" : "⏳"}
                        </span>
                      </div>

                      {/* Sheets 概況 */}
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>排班筆數</span>
                        <span style={{ color:C.text, fontWeight:500 }}>{systemStatus.sheets.scheduleCount} 筆</span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>打卡記錄筆數</span>
                        <span style={{ color:C.text, fontWeight:500 }}>{systemStatus.sheets.punchRecordsCount} 筆</span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
                        <span style={{ color:C.muted }}>在職 / 總員工</span>
                        <span style={{ color:C.text, fontWeight:500 }}>{systemStatus.sheets.employeesActive} / {systemStatus.sheets.employeesTotal}</span>
                      </div>

                      <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0" }}>
                        <span style={{ color:C.muted }}>觸發器</span>
                        <span style={{ color:C.text, fontWeight:500 }}>{systemStatus.triggerCount} 個</span>
                      </div>
                      <div style={{ fontSize:10, color:C.hint, paddingLeft:8, lineHeight:1.6 }}>
                        {systemStatus.triggers.map(t => t.fn).join('、')}
                      </div>
                    </div>
                  )
                }
              </div>
            )}

            {/* 員工帳號管理 — 真正接 GAS */}
            <div style={S.card}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <div style={S.label}>員工帳號管理（{staffData.length}）</div>
                {liveMode && <span style={{ fontSize:10, color:C.success.text, padding:"2px 6px", background:C.success.bg, borderRadius:4 }}>同步 Sheets</span>}
              </div>
              {staffData.map((s,i) => (
                <div key={s.id} style={S.row(i===staffData.length-1)}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <Avatar name={s.name} color={s.color} size={28}/>
                    <div>
                      <div style={{ fontSize:13, fontWeight:500 }}>{s.name} <span style={{ fontSize:10, color:C.muted, marginLeft:4 }}>{s.id}</span></div>
                      <div style={{ fontSize:10, color:C.hint }}>
                        {s.role || ''} {s.branch ? '· '+s.branch : ''} · ＄{s.rate}/h
                      </div>
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:6 }}>
                    <button
                      style={{ ...S.ghostBtn, padding:"5px 10px", color:C.info.text, borderColor:C.info.text+"44", background:C.info.bg }}
                      onClick={()=>setEditStaff({ staff:s, isNew:false })}>
                      編輯
                    </button>
                    <button
                      style={{ ...S.ghostBtn, padding:"5px 10px", color:C.danger.text, borderColor:C.danger.text+"44", background:C.danger.bg }}
                      onClick={()=>setDeleteStaffId(s.id)}>
                      {liveMode ? '離職' : '刪除'}
                    </button>
                  </div>
                </div>
              ))}
              <button
                style={{ ...S.ghostBtn, width:"100%", padding:10, marginTop:10, textAlign:"center" }}
                onClick={()=>setEditStaff({ staff:null, isNew:true })}>
                + 新增員工{liveMode ? '（寫入 Sheets）' : ''}
              </button>
              {liveMode && (
                <div style={{ fontSize:10, color:C.hint, textAlign:"center", marginTop:8, lineHeight:1.5 }}>
                  改動會即時寫入 Sheets「員工主檔」<br/>
                  「離職」員工資料保留（薪資/排班歷史用）
                </div>
              )}
            </div>

            {/* 進階：直連 Sheets */}
            <div style={S.card}>
              <div style={S.label}>進階</div>
              <a href="https://docs.google.com/spreadsheets/d/1LJqq4oMjuFc3zkXnqk9MALWcc246umBjtGjIBUZE55Y"
                target="_blank" rel="noreferrer"
                style={{ display:"block", textAlign:"center", padding:10, borderRadius:8,
                  border:`1px solid ${C.border}`, color:C.muted, textDecoration:"none", fontSize:12,
                  fontFamily:"'Noto Sans TC', sans-serif" }}>
                🔗 開啟 Sheets 資料庫
              </a>
            </div>
          </div>
        )}
      </div>

      <button onClick={onLogout} style={{ display:"block", margin:"0.5rem 1.25rem 0",
        width:"calc(100% - 2.5rem)", padding:10, border:`1px solid ${C.border}`,
        borderRadius:10, background:"transparent", color:C.hint, fontSize:13,
        cursor:"pointer", fontFamily:"'Noto Sans TC', sans-serif" }}>
        登出
      </button>
    </div>
  );
}

// ── 編輯 Modal（排班格）────────────────────────────────────
function CellModal({ cell, room, time, staffList, onSave, onClose }) {
  const [booked,     setBooked]     = useState(cell?.booked     || false);
  const [clientName, setClientName] = useState(cell?.clientName || "");
  const [staffId,    setStaffId]    = useState(cell?.staffId    || null);

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modalSheet} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:500, color:room.color }}>{room.name}</div>
            <div style={{ fontSize:12, color:C.muted }}>{time}</div>
          </div>
          <button onClick={onClose} style={{ border:"none", background:C.tabBg, color:C.muted,
            fontSize:16, cursor:"pointer", width:30, height:30, borderRadius:"50%", lineHeight:1 }}>×</button>
        </div>

        <div style={{ display:"flex", gap:8, marginBottom:14 }}>
          {[true, false].map(v => (
            <button key={String(v)} onClick={()=>setBooked(v)} style={{
              flex:1, padding:"9px 0", border:"1px solid",
              borderRadius:9, cursor:"pointer",
              borderColor: booked===v ? room.color : C.border,
              background:  booked===v ? room.bg    : C.surface,
              color:       booked===v ? room.color : C.muted,
              fontFamily:"'Noto Sans TC', sans-serif", fontSize:13, fontWeight: booked===v ? 500 : 400,
            }}>{v ? "已預約" : "空閒"}</button>
          ))}
        </div>

        {booked && (
          <>
            <div style={S.label}>客人名稱</div>
            <input style={{ ...S.inp, marginBottom:12 }} value={clientName}
              onChange={e=>setClientName(e.target.value)} placeholder="輸入客人名稱"/>
            <div style={S.label}>指派員工</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:16 }}>
              {staffList.map(s => (
                <button key={s.id} onClick={()=>setStaffId(staffId===s.id ? null : s.id)} style={{
                  padding:"5px 12px", borderRadius:8, border:"1px solid",
                  borderColor: staffId===s.id ? s.color : C.border,
                  background:  staffId===s.id ? s.color+"18" : C.surface,
                  color:       staffId===s.id ? s.color : C.muted,
                  fontSize:12, cursor:"pointer",
                  fontFamily:"'Noto Sans TC', sans-serif", fontWeight: staffId===s.id ? 500 : 400,
                }}>{s.name}</button>
              ))}
            </div>
          </>
        )}

        <button style={{ width:"100%", padding:13, border:"none", borderRadius:10, fontSize:14,
          fontWeight:500, cursor:"pointer", background:room.color, color:"#FFF",
          fontFamily:"'Noto Sans TC', sans-serif" }}
          onClick={()=>onSave({ booked, clientName, staffId })}>
          儲存
        </button>
      </div>
    </div>
  );
}

// ── 主 App ────────────────────────────────────────────────
export default function App() {
  const [user,      setUser]      = useState(null);
  const [schedule,  setSchedule]  = useState(initSchedule);
  const [punchLogs, setPunchLogs] = useState(PUNCH_DEMO);
  const [accounts,  setAccounts]  = useState(() => ({...INIT_ACCOUNTS}));
  const [staffData, setStaffData] = useState(INIT_STAFF.map(s=>({...s})));
  const [liveMode,  setLiveMode]  = useState(false); // true = GAS Sheets 連線中
  const [gasError,  setGasError]  = useState(null);

  // 從 GAS 載入真實員工 + 帳號（可被呼叫 reload）
  const reloadStaffFromGAS = useCallback(async () => {
    try {
      const data = await callGAS("getStaffPublic");
      const list = (data?.staff || []).filter(s => s.id);
      if (list.length === 0) throw new Error("GAS 沒回員工");
      const realStaff = list.map(gasStaffToLocal);
      const realAccounts = {
        admin: { pass: "admin999", role: "admin" }, // admin 仍走 GAS verifyAdmin（這裡的 pass 只是 demo fallback）
      };
      list.forEach(s => {
        realAccounts[s.id]   = { pass: s.id, role: "staff", staffId: s.id }; // 預設密碼 = ID
        realAccounts[s.name] = { pass: s.id, role: "staff", staffId: s.id };
      });
      setStaffData(realStaff);
      setAccounts(realAccounts);
      setLiveMode(true);
      setGasError(null);
      return realStaff;
    } catch (e) {
      setGasError(e.message);
      throw e;
    }
  }, []);

  // 啟動時跑一次
  useEffect(() => {
    reloadStaffFromGAS().catch(() => {});
  }, [reloadStaffFromGAS]);

  const handleLogin  = useCallback((acc, username) => setUser({ ...acc, username }), []);
  const handleLogout = useCallback(() => setUser(null), []);

  // 打卡：同時更新本地 UI 與 GAS Sheets（liveMode 時）
  const handlePunch = useCallback(async (entry) => {
    setPunchLogs(prev => [...prev, entry]);
    if (!liveMode) return;
    try {
      await callGAS("punchClock", {
        empId: String(entry.staffId),
        type: entry.type,
        note: entry.anomaly || "",
        source: "Vercel",
      });
    } catch (e) {
      console.warn("GAS punchClock 失敗（本地仍記錄）:", e.message);
    }
  }, [liveMode]);

  if (!user) return <LoginScreen onLogin={handleLogin} accounts={accounts} liveMode={liveMode} gasError={gasError}/>;

  if (user.role === "staff") {
    return (
      <StaffApp
        account={user}
        schedule={schedule}
        punchLogs={punchLogs}
        staffData={staffData}
        onPunch={handlePunch}
        onLogout={handleLogout}
        liveMode={liveMode}
      />
    );
  }

  return (
    <AdminApp
      schedule={schedule}
      setSchedule={setSchedule}
      punchLogs={punchLogs}
      setPunchLogs={setPunchLogs}
      accounts={accounts}
      setAccounts={setAccounts}
      onLogout={handleLogout}
      liveMode={liveMode}
      staffData={staffData}
      setStaffData={setStaffData}
      reloadStaff={reloadStaffFromGAS}
    />
  );
}
