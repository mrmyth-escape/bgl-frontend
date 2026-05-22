import { useState, useEffect, useCallback, useMemo, Fragment } from "react";

// ── SimplyBook 串接設定 ──────────────────────────────────
const SB_CONFIG = {
  companyLogin: "bglescape",
  apiEndpoint:  "https://user-api.simplybook.asia/",
  locations: { 1:"大忠店", 2:"謎先生" },
  backendUrl: "https://bgl-backend-new.vercel.app",
};

// ── GAS 後端（排班 + 打卡 + 員工）─────────────────────────
const GAS_URL = "https://script.google.com/macros/s/AKfycbwb319Bqz-_p-fDj_tIm62jaIRpMJ0mypwrOTGvyHUxR-WOhQxZ0ri8GS8uB2hFkfUzoQ/exec";
async function callGAS(action, payload = {}) {
  const res = await fetch(GAS_URL, {
    method: "POST",
    body: JSON.stringify({ action, payload }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error("GAS HTTP " + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "GAS error");
  return json.data;
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
function StaffEditModal({ staff, isNew, onSave, onClose }) {
  const [name,     setName]     = useState(staff?.name     || "");
  const [rate,     setRate]     = useState(String(staff?.rate  || 180));
  const [shift,    setShift]    = useState(staff?.shift    || "10:00");
  const [color,    setColor]    = useState(staff?.color    || "#3B82F6");
  const [password, setPassword] = useState("");

  const canSave = isNew ? name.trim() && password.trim() : true;

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={S.modalSheet} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:15, fontWeight:500 }}>{isNew ? "新增員工" : `編輯員工：${staff.name}`}</div>
          <button onClick={onClose} style={{ border:"none", background:C.tabBg, color:C.muted,
            fontSize:16, cursor:"pointer", width:30, height:30, borderRadius:"50%", lineHeight:1 }}>×</button>
        </div>

        {isNew && (
          <>
            <div style={S.label}>姓名（同時作為登入帳號）</div>
            <input style={S.inp} value={name} onChange={e=>setName(e.target.value)} placeholder="輸入姓名"/>
          </>
        )}

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

        <button
          style={{ width:"100%", padding:13, border:"none", borderRadius:10, fontSize:14,
            fontWeight:500, cursor: canSave ? "pointer" : "not-allowed",
            background: canSave ? "#2A5CC0" : "#D0CEC8", color:"#FFF",
            fontFamily:"'Noto Sans TC', sans-serif", opacity: canSave ? 1 : 0.6 }}
          disabled={!canSave}
          onClick={() => onSave({ name:name.trim(), rate:Number(rate)||180, shift, color, password })}>
          {isNew ? "建立員工帳號" : "儲存變更"}
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

  const doLogin = () => {
    const acc = accounts[user];
    if (!acc || acc.pass !== pass) {
      setErr(true);
      setTimeout(() => setErr(false), 2000);
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
            帳號或密碼錯誤
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
            cursor:"pointer", background:"#2A5CC0", color:"#FFF",
            fontFamily:"'Noto Sans TC', sans-serif", marginTop:4 }}
          onClick={doLogin}>登入</button>
        <div style={{ fontSize:11, color:C.hint, textAlign:"center", marginTop:14, lineHeight:1.8 }}>
          測試帳號<br/>
          員工：<b>staff</b> / staff123　　管理者：<b>admin</b> / admin999
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
  const [gasSched,    setGasSched]    = useState([]);    // 本月排班（給「我的班表」用）
  const [loading,     setLoading]     = useState(false);

  const me = staffData.find(s => s.id === account.staffId);

  // 載入 GAS 真實資料：今日狀態 + 本月排班
  const reloadGAS = useCallback(async () => {
    if (!liveMode || !account.staffId) return;
    setLoading(true);
    try {
      const today = new Date();
      const monthStart = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-01';
      const monthEnd   = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-31';
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
  }, [liveMode, account.staffId]);

  useEffect(() => { reloadGAS(); }, [reloadGAS]);

  // 每 60 秒自動重抓今日狀態（場次狀態會隨時間變）
  useEffect(() => {
    if (!liveMode) return;
    const id = setInterval(reloadGAS, 60000);
    return () => clearInterval(id);
  }, [liveMode, reloadGAS]);

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
    { id:"salary",   label:"薪資" },
    { id:"notif",    label:"通知" },
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

        {tab==="schedule" && (
          <div style={S.card}>
            <div style={S.label}>{liveMode ? `本月排班（共 ${myMonthShifts.length} 場）` : "本週我的班次"}</div>
            {liveMode ? (
              myMonthShifts.length === 0
                ? <div style={{ fontSize:13, color:C.hint, padding:"1.5rem 0", textAlign:"center" }}>本月無排班</div>
                : myMonthShifts.map((s,i) => {
                  const isToday = s.date === todayStr;
                  const isPast = s.date < todayStr;
                  return (
                    <div key={i} style={S.row(i===myMonthShifts.length-1)}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ width:50, fontSize:12, color:C.muted, textAlign:"left" }}>
                          {s.date.substring(5)}
                        </div>
                        <div>
                          <div style={{ fontSize:13, fontWeight:500 }}>{s.theme}</div>
                          <div style={{ fontSize:11, color:C.muted }}>{s.time} · {s.role}</div>
                        </div>
                      </div>
                      <span style={S.badge(isToday ? "blue" : isPast ? "gray" : "green")}>
                        {isToday ? "今日" : isPast ? "已過" : "未來"}
                      </span>
                    </div>
                  );
                })
            ) : (
              myShifts.length === 0
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
            )}
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

// ── 管理者版 ──────────────────────────────────────────────
function AdminApp({ schedule, setSchedule, punchLogs, setPunchLogs, accounts, setAccounts, onLogout }) {
  const [tab,            setTab]           = useState("overview");
  const [viewMode,       setViewMode]      = useState("timeline");
  const [selectedDate,   setSelectedDate]  = useState(new Date());
  const [selectedRoom,   setSelectedRoom]  = useState("A");
  const [selectedBranch, setSelectedBranch]= useState("大忠店");
  const [modal,          setModal]         = useState(null);
  const [staffData,      setStaffData]     = useState(INIT_STAFF.map(s=>({...s})));
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

  // 立即同步今日預約
  async function syncTodayBookings() {
    setSyncStatus("loading");
    try {
      const r = await fetch(`${SB_CONFIG.backendUrl}/api/bookings`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      // 將後端回傳的預約寫入 schedule
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
  function handleSaveStaff({ name, rate, shift, color, password }) {
    if (editStaff.isNew) {
      const newId = nextStaffId();
      setStaffData(prev => [...prev, { id:newId, name, rate, color, shift, bonus:0, deduct:0 }]);
      setAccounts(prev => ({ ...prev, [name]: { pass:password, role:"staff", staffId:newId } }));
      showToast(`已建立員工帳號：${name}`);
    } else {
      const s = editStaff.staff;
      setStaffData(prev => prev.map(x => x.id===s.id ? { ...x, rate, shift, color } : x));
      if (password) {
        // 找到此員工對應的帳號並更新密碼
        setAccounts(prev => {
          const next = { ...prev };
          Object.keys(next).forEach(k => {
            if (next[k].staffId === s.id) next[k] = { ...next[k], pass:password };
          });
          return next;
        });
        showToast(`已更新 ${s.name} 的資料和密碼`);
      } else {
        showToast(`已更新 ${s.name} 的資料`);
      }
    }
    setEditStaff(null);
  }

  // 刪除員工
  function handleDeleteStaff() {
    const id = deleteStaffId;
    const s = staffData.find(x => x.id === id);
    setStaffData(prev => prev.filter(x => x.id !== id));
    setAccounts(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(k => { if (next[k].staffId === id) delete next[k]; });
      return next;
    });
    setDeleteStaffId(null);
    showToast(`已刪除員工：${s?.name}`);
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
        />
      )}

      {deleteStaffId && (
        <ConfirmDialog
          message={`確定要刪除員工「${staffData.find(s=>s.id===deleteStaffId)?.name}」？此操作無法復原，相關登入帳號也會一併移除。`}
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
              {[
                ["今日出勤", `${presentStaff.length} 人`, null],
                ["異常打卡", `${anomalies.length} 件`,    anomalies.length>0?C.danger.text:null],
                ["今日場次", `${totalBookings} 場`,       null],
                ["本月薪資", "$34.2k",                    null],
              ].map(([label,val,color]) => (
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
          </div>
        )}

        {/* ── 排班 ── */}
        {tab==="schedule" && (
          <div>
            <div style={{ display:"flex", gap:6, marginBottom:"0.75rem" }}>
              {BRANCHES.map(b => (
                <button key={b} onClick={()=>{ setSelectedBranch(b); setSelectedRoom(ROOMS.find(r=>r.branch===b)?.id||"A"); }} style={{
                  flex:1, padding:"8px 0", border:"1px solid",
                  borderRadius:10, fontSize:13, fontWeight:500, cursor:"pointer",
                  fontFamily:"'Noto Sans TC', sans-serif",
                  borderColor: selectedBranch===b ? "#2A5CC0" : C.border,
                  background:  selectedBranch===b ? "#EEF4FF" : C.surface,
                  color:       selectedBranch===b ? "#2A5CC0" : C.muted,
                }}>{b}</button>
              ))}
            </div>

            <div style={{ display:"flex", gap:4, overflowX:"auto", marginBottom:"0.75rem", paddingBottom:4 }}>
              {weekDates.map((d,i) => {
                const sel = d.toDateString()===selectedDate.toDateString();
                const isToday = d.toDateString()===new Date().toDateString();
                return (
                  <button key={i} onClick={()=>setSelectedDate(d)} style={{
                    flexShrink:0, padding:"6px 10px", border:"1px solid",
                    borderRadius:10, minWidth:44, textAlign:"center",
                    borderColor: sel ? "#2A5CC0" : C.border,
                    background:  sel ? "#EEF4FF" : C.surface,
                    color:       sel ? "#2A5CC0" : isToday ? C.text : C.muted,
                    fontSize:12, cursor:"pointer",
                    fontFamily:"'Noto Sans TC', sans-serif", fontWeight: sel ? 500 : 400,
                  }}>
                    <div>{WEEK_DAYS[i]}</div>
                    <div style={{ fontWeight:600 }}>{d.getDate()}</div>
                    {isToday && <div style={{ width:4, height:4, borderRadius:"50%", background:"#2A5CC0", margin:"2px auto 0" }}/>}
                  </button>
                );
              })}
            </div>

            <div style={{ display:"flex", gap:4, marginBottom:"0.75rem" }}>
              {[["timeline","時間軸"],["heatmap","熱圖"],["single","單場"]].map(([v,l]) => (
                <button key={v} style={{ ...S.tab(viewMode===v), flex:"none", padding:"6px 14px", fontSize:12 }}
                  onClick={()=>setViewMode(v)}>{l}</button>
              ))}
            </div>

            {viewMode==="timeline" && (
              <div style={S.card}>
                {Object.keys(bookedSlots).length === 0
                  ? <div style={{ fontSize:13, color:C.hint, textAlign:"center", padding:"2rem 0" }}>今日無預約</div>
                  : Object.entries(bookedSlots).map(([time,rooms]) => (
                    <div key={time} style={{ marginBottom:14 }}>
                      <div style={{ fontSize:11, color:C.muted, marginBottom:6, fontWeight:600 }}>{time}</div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                        {rooms.map(r => {
                          const cell = schedule[r.id][time];
                          const sf   = staffById(cell.staffId, staffData);
                          return (
                            <button key={r.id} onClick={()=>setModal({roomId:r.id,time})} style={{
                              padding:"6px 10px", borderRadius:10, border:`1px solid ${r.color}30`,
                              background:r.bg, cursor:"pointer", textAlign:"left",
                              fontFamily:"'Noto Sans TC', sans-serif",
                            }}>
                              <div style={{ fontSize:12, color:r.color, fontWeight:500 }}>{r.name}</div>
                              <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>
                                {cell.clientName || "—"}
                                {cell.source==="simplybook" && <span style={{ color:"#2A5CC0", marginLeft:4 }}>SB</span>}
                                {sf && <span style={{ marginLeft:4 }}>
                                  <span style={{ display:"inline-block", width:5, height:5, borderRadius:"50%",
                                    background:sf.color, marginRight:2, verticalAlign:"middle" }}/>
                                  {sf.name}
                                </span>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                }
                <button onClick={()=>setModal({roomId:"A",time:"10:00"})}
                  style={{ ...S.ghostBtn, width:"100%", padding:"8px 0", marginTop:4, textAlign:"center", color:C.muted }}>
                  + 新增排班
                </button>
              </div>
            )}

            {viewMode==="heatmap" && (
              <div style={{ ...S.card, overflowX:"auto" }}>
                <div style={{
                  display:"grid",
                  gridTemplateColumns:`50px repeat(${branchRooms.length},1fr)`,
                  gap:2, minWidth:280,
                }}>
                  <div/>
                  {branchRooms.map(r => (
                    <div key={r.id} style={{ fontSize:10, color:r.color, textAlign:"center", fontWeight:600, paddingBottom:6 }}>
                      {r.name.slice(0,2)}
                    </div>
                  ))}
                  {SLOTS.map(t => (
                    <Fragment key={t}>
                      <div style={{ fontSize:10, color:C.muted, display:"flex", alignItems:"center", paddingRight:4 }}>{t}</div>
                      {branchRooms.map(r => {
                        const cell = schedule[r.id]?.[t];
                        return (
                          <button key={r.id} onClick={()=>setModal({roomId:r.id,time:t})} style={{
                            height:16, border:"none", borderRadius:3, cursor:"pointer",
                            background: cell?.booked ? r.color+"CC" : C.tabBg,
                            transition:"opacity .1s",
                          }}/>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>
            )}

            {viewMode==="single" && (
              <div>
                <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:"0.75rem" }}>
                  {branchRooms.map(r => (
                    <button key={r.id} onClick={()=>setSelectedRoom(r.id)} style={{
                      padding:"5px 10px", borderRadius:8, border:"1px solid",
                      borderColor: selectedRoom===r.id ? r.color : C.border,
                      background:  selectedRoom===r.id ? r.bg : C.surface,
                      color:       selectedRoom===r.id ? r.color : C.muted,
                      fontSize:12, cursor:"pointer",
                      fontFamily:"'Noto Sans TC', sans-serif",
                    }}>{r.name}</button>
                  ))}
                </div>
                <div style={S.card}>
                  {SLOTS.map((t,i) => {
                    const cell = schedule[selectedRoom]?.[t];
                    const room = ROOMS.find(r=>r.id===selectedRoom);
                    const sf   = staffById(cell?.staffId, staffData);
                    return (
                      <div key={t} onClick={()=>setModal({roomId:selectedRoom,time:t})}
                        style={{ ...S.row(i===SLOTS.length-1), cursor:"pointer" }}>
                        <span style={{ fontSize:12, color: cell?.booked ? C.text : C.hint }}>{t}</span>
                        {cell?.booked
                          ? <div style={{ textAlign:"right" }}>
                              <div style={{ fontSize:12, color:room.color, fontWeight:500 }}>{cell.clientName||"已預約"}</div>
                              <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>
                                {sf && <><span style={{ display:"inline-block", width:5, height:5, borderRadius:"50%",
                                  background:sf.color, marginRight:3, verticalAlign:"middle" }}/>{sf.name}</>}
                                {cell.source==="simplybook" && <span style={{ color:"#2A5CC0", marginLeft:4 }}>SB</span>}
                              </div>
                            </div>
                          : <span style={{ fontSize:10, color:C.hint }}>空閒</span>
                        }
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 打卡管理 ── */}
        {tab==="clock" && (
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
            <div style={S.card}>
              <div style={S.label}>今日異常摘要</div>
              {[
                ["遲到",   anomalies.filter(l=>l.anomaly?.includes("遲到")).length],
                ["早退",   anomalies.filter(l=>l.anomaly?.includes("早退")).length],
                ["缺勤",   0],
                ["待確認", pendingCount],
              ].map(([k,v],i,arr) => (
                <div key={k} style={{ ...S.row(i===arr.length-1), fontSize:13 }}>
                  <span style={{ color:C.muted }}>{k}</span>
                  <span style={{ fontWeight:500,
                    color: k==="待確認" && v>0 ? C.info.text : v>0 ? C.danger.text : C.text }}>
                    {v} {k==="待確認" ? "筆" : "件"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 薪資 ── */}
        {tab==="salary" && (
          <div>
            <div style={{ ...S.card, marginBottom:"0.75rem" }}>
              <div style={S.label}>月薪資總表</div>
              {salaryRows.map((s,i) => (
                <div key={s.id} style={S.row(i===salaryRows.length-1)}>
                  <div>
                    <div style={{ fontSize:13, fontWeight:500, color:s.color }}>{s.name}</div>
                    <div style={{ fontSize:10, color:C.muted }}>{s.hours}h × ${s.rate}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:13, fontWeight:500 }}>${s.net.toLocaleString()}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6, justifyContent:"flex-end", marginTop:4 }}>
                      <button onClick={()=>setStaffData(prev=>prev.map((x,j)=>j===i?{...x,deduct:x.deduct+100}:x))}
                        style={{ width:24,height:24,borderRadius:"50%",border:`1px solid ${C.border}`,
                          background:"transparent",color:C.muted,cursor:"pointer",fontSize:15,lineHeight:1 }}>−</button>
                      <span style={{ fontSize:11, minWidth:46, textAlign:"center",
                        color: s.bonus-s.deduct>=0 ? C.success.text : C.danger.text }}>
                        {s.bonus-s.deduct>=0?"+":""}{s.bonus-s.deduct}
                      </span>
                      <button onClick={()=>setStaffData(prev=>prev.map((x,j)=>j===i?{...x,bonus:x.bonus+100}:x))}
                        style={{ width:24,height:24,borderRadius:"50%",border:`1px solid ${C.border}`,
                          background:"transparent",color:C.muted,cursor:"pointer",fontSize:15,lineHeight:1 }}>+</button>
                    </div>
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
        )}

        {/* ── 設定 ── */}
        {tab==="settings" && (
          <div>
            {/* SimplyBook 串接 */}
            <div style={S.card}>
              <div style={S.label}>SimplyBook 串接</div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:6 }}>Company Login（網址前綴）</div>
              <input style={S.inp} value={sbLogin} onChange={e=>setSbLogin(e.target.value)} placeholder="bglescape"/>
              <div style={{ fontSize:11, color:C.muted, marginBottom:6 }}>API Key</div>
              <input style={S.inp} type="password" value={sbKey} onChange={e=>setSbKey(e.target.value)} placeholder="貼上 API Key"/>

              {/* 連線狀態 */}
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 12px",
                background: sbStatus==="ok" ? C.success.bg : sbStatus==="error" ? C.danger.bg : "#FEF8E7",
                borderRadius:8, marginBottom:12, fontSize:12,
                color: sbStatus==="ok" ? C.success.text : sbStatus==="error" ? C.danger.text : C.warning.text }}>
                <div style={{ width:7,height:7,borderRadius:"50%", flexShrink:0,
                  background: sbStatus==="ok" ? "#0F9B6A" : sbStatus==="error" ? C.danger.text : "#C07000" }}/>
                {sbStatus==="ok"      ? "後端連線正常 ✓" :
                 sbStatus==="error"   ? "連線失敗，請確認後端服務" :
                 sbStatus==="loading" ? "測試中..." :
                 sbLogin&&sbKey       ? "設定完成，點下方按鈕測試連線" : "尚未填入 SimplyBook 資訊"}
              </div>

              <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                <button
                  onClick={testSimplyBookConn}
                  disabled={sbStatus==="loading"}
                  style={{ flex:1, ...S.ghostBtn, padding:10, textAlign:"center",
                    opacity: sbStatus==="loading" ? 0.6 : 1 }}>
                  {sbStatus==="loading" ? "測試中..." : "測試 SimplyBook 連線"}
                </button>
                <button
                  onClick={syncTodayBookings}
                  disabled={syncStatus==="loading"}
                  style={{ flex:1, ...S.ghostBtn, padding:10, textAlign:"center",
                    color:C.info.text, borderColor:C.info.text+"44", background:C.info.bg,
                    opacity: syncStatus==="loading" ? 0.6 : 1 }}>
                  {syncStatus==="loading" ? "同步中..." : "立即同步今日預約"}
                </button>
              </div>

              <div style={{ fontSize:11, color:C.muted, marginBottom:8 }}>Webhook URL（填入 SimplyBook 後台）</div>
              <div style={{ background:C.tabBg, borderRadius:8, padding:"9px 12px", fontSize:11,
                color:C.text, fontFamily:"monospace", marginBottom:12, wordBreak:"break-all" }}>
                {SB_CONFIG.backendUrl}/api/webhook
              </div>
              <button style={{ ...S.ghostBtn, width:"100%", padding:10, textAlign:"center" }}
                onClick={()=>showToast("設定已儲存")}>儲存設定</button>
            </div>

            {/* 員工帳號管理 */}
            <div style={S.card}>
              <div style={S.label}>員工帳號管理</div>
              {staffData.map((s,i) => (
                <div key={s.id} style={S.row(i===staffData.length-1)}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <Avatar name={s.name} color={s.color} size={28}/>
                    <div>
                      <div style={{ fontSize:13 }}>{s.name}</div>
                      <div style={{ fontSize:10, color:C.hint }}>${s.rate}/h · {s.shift} 起班</div>
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
                      刪除
                    </button>
                  </div>
                </div>
              ))}
              <button
                style={{ ...S.ghostBtn, width:"100%", padding:10, marginTop:10, textAlign:"center" }}
                onClick={()=>setEditStaff({ staff:null, isNew:true })}>
                + 新增員工帳號
              </button>
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

  // 啟動時從 GAS 載入真實員工 + 帳號（預設密碼＝員工ID）
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const data = await callGAS("getStaffPublic");
        if (cancel) return;
        const list = (data?.staff || []).filter(s => s.id);
        if (list.length === 0) throw new Error("GAS 沒回員工");
        const realStaff = list.map(gasStaffToLocal);
        const realAccounts = {
          admin: { pass: "admin999", role: "admin" }, // admin 帳號仍走本地
        };
        list.forEach(s => {
          realAccounts[s.id]   = { pass: s.id, role: "staff", staffId: s.id }; // 預設密碼 = ID
          realAccounts[s.name] = { pass: s.id, role: "staff", staffId: s.id }; // 也可用姓名登入
        });
        setStaffData(realStaff);
        setAccounts(realAccounts);
        setLiveMode(true);
        setGasError(null);
      } catch (e) {
        setGasError(e.message);
        // 留在 demo 模式
      }
    })();
    return () => { cancel = true; };
  }, []);

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
    />
  );
}
