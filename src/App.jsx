import { useState, useEffect, useCallback, useMemo, Fragment } from "react";

// ── SimplyBook 串接設定 ──────────────────────────────────
const SB_CONFIG = {
  companyLogin: "bglescape",
  apiEndpoint:  "https://user-api.simplybook.asia/",
  locations: { 1:"大忠店", 2:"謎先生" },
  backendUrl: "https://bgl-backend-new.vercel.app",
};

// ── 資料定義 ──────────────────────────────────────────────
const BRANCHES = ["大忠店", "謎先生"];

const ROOMS = [
  // 大忠店（location_id: 1）
  { id:"A", name:"孤兒怨",   branch:"大忠店", sbServiceId:2,  sbLocationId:1, color:"#B04070", bg:"#FCEEF3", emoji:"👻", duration:75  },
  { id:"B", name:"屎力全開", branch:"大忠店", sbServiceId:3,  sbLocationId:1, color:"#7B4FA6", bg:"#F5EFF9", emoji:"💩", duration:75  },
  { id:"C", name:"越獄者",   branch:"大忠店", sbServiceId:15, sbLocationId:1, color:"#2E8B2E", bg:"#EDF8ED", emoji:"🦸", duration:90  },
  { id:"D", name:"詭廁",     branch:"大忠店", sbServiceId:14, sbLocationId:1, color:"#007A80", bg:"#E8F8F9", emoji:"🚽", duration:60  },
  // 謎先生（location_id: 2）
  { id:"E", name:"詭獄",     branch:"謎先生", sbServiceId:11, sbLocationId:2, color:"#C07000", bg:"#FDF5E8", emoji:"⛓",  duration:90  },
  { id:"F", name:"詭獄加場", branch:"謎先生", sbServiceId:17, sbLocationId:2, color:"#A08000", bg:"#FDFAE8", emoji:"➕", duration:120 },
  { id:"G", name:"詭店",     branch:"謎先生", sbServiceId:16, sbLocationId:2, color:"#D94040", bg:"#FDF0F0", emoji:"🏚", duration:75  },
];

// Service ID → Room ID 快速查表（Webhook 解析用）
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

const ACCOUNTS = {
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
    ["A","10:00",true,1,"王小華","simplybook"],  // 孤兒怨
    ["A","14:00",true,3,"陳大明","simplybook"],  // 孤兒怨
    ["B","11:00",true,2,"林美美","simplybook"],  // 屎力全開
    ["B","17:00",true,5,"張志遠","manual"],       // 屎力全開
    ["C","13:00",true,4,"黃小琳","simplybook"],  // 越獄者
    ["D","10:30",true,1,"劉先生","simplybook"],  // 詭廁
    ["E","15:00",true,3,"吳小姐","simplybook"],  // 詭獄
    ["F","19:00",true,2,"趙大哥","simplybook"],  // 詭獄加場
    ["G","20:00",true,5,"許小妹","simplybook"],  // 詭店
  ];
  demo.forEach(([r,t,b,sid,c,src]) => { s[r][t] = { booked:b, staffId:sid, clientName:c, source:src }; });
  return s;
}

const PUNCH_DEMO = [
  { staffId:1, name:"小明", type:"in",  timeStr:"09:52", time:new Date(Date.now()-3600000), anomaly:null },
  { staffId:2, name:"小美", type:"in",  timeStr:"10:07", time:new Date(Date.now()-3000000), anomaly:"遲到 7 分鐘" },
  { staffId:3, name:"阿偉", type:"in",  timeStr:"09:58", time:new Date(Date.now()-3200000), anomaly:null },
];

// ── 樣式系統（淺色）─────────────────────────────────────
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
      green:  [C.success.bg, C.success.text],
      red:    [C.danger.bg,  C.danger.text],
      amber:  [C.warning.bg, C.warning.text],
      gray:   ["#F0EFE9",    C.muted],
      blue:   [C.info.bg,    C.info.text],
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

// 從打卡紀錄計算已下班員工的工時（小時）
function calcHours(staffId, logs) {
  let total = 0;
  const inLogs = logs.filter(l => l.staffId===staffId && l.type==="in");
  inLogs.forEach(inL => {
    const outL = logs.find(o => o.type==="out" && o.staffId===staffId && o.time > inL.time);
    if (outL) total += (outL.time - inL.time) / 3600000;
  });
  return Math.round(total * 10) / 10;
}

// 取得目前在場員工（最後一筆是 in 且沒有對應 out）
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

// ── 登入畫面 ──────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err,  setErr]  = useState(false);

  const doLogin = () => {
    const acc = ACCOUNTS[user];
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
function StaffApp({ account, schedule, punchLogs, onPunch, onLogout }) {
  const [tab,        setTab]        = useState("punch");
  const [punchState, setPunchState] = useState("out");  // "in" | "out"
  const [clock,      setClock]      = useState(new Date());
  const [gpsOk,      setGpsOk]      = useState(false);
  const [toast,      setToast]      = useState({ show:false, msg:"" });

  const me = INIT_STAFF.find(s => s.id === account.staffId);
  const myLogs = punchLogs.filter(l => l.staffId === account.staffId);

  // FIX #4: useEffect with cleanup
  useEffect(() => {
    const tick = setInterval(() => setClock(new Date()), 1000);
    const gps  = setTimeout(() => setGpsOk(true), 1800);
    return () => { clearInterval(tick); clearTimeout(gps); };
  }, []);

  // Sync punchState with logs (if admin also punches this staff)
  useEffect(() => {
    if (myLogs.length === 0) { setPunchState("out"); return; }
    const last = [...myLogs].sort((a,b)=>a.time-b.time).pop();
    setPunchState(last.type === "in" ? "in" : "out");
  }, [punchLogs]);

  function showToast(msg) {
    setToast({ show:true, msg });
    setTimeout(() => setToast(t=>({...t,show:false})), 2200);
  }

  function checkAnomaly(staff, timeStr) {
    const [h,m] = timeStr.split(":").map(Number);
    const [sh,sm] = staff.shift.split(":").map(Number);
    const diff = h*60+m - (sh*60+sm);
    return diff > 5 ? `遲到 ${diff} 分鐘` : null;
  }

  const handlePunch = () => {
    if (!gpsOk) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",hour12:false});
    const newType = punchState === "out" ? "in" : "out";
    const anomaly = newType === "in" && me ? checkAnomaly(me, timeStr) : null;
    onPunch({ staffId:me.id, name:me.name, type:newType, timeStr, time:now, anomaly, color:me.color });
    // FIX #1: show toast
    showToast(newType === "in" ? `上班打卡成功 ${timeStr} ✓` : `下班打卡成功 ${timeStr} ✓`);
  };

  const myShifts = useMemo(() => {
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
  }, [schedule, account.staffId]);

  // FIX #7: calculate hours from punch logs
  const salaryInfo = useMemo(() => {
    const workedH = calcHours(account.staffId, punchLogs);
    // Use estimated 38.5h if no completed shifts yet (demo)
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

      {/* Header */}
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

        {/* 打卡 */}
        {tab==="punch" && (
          <div>
            <div style={S.card}>
              <div style={{ fontSize:36, fontWeight:600, textAlign:"center", letterSpacing:3, color:C.text, marginBottom:4 }}>
                {fmtTime(clock)}
              </div>
              <div style={{ fontSize:12, color:C.muted, textAlign:"center", marginBottom:16 }}>
                {fmtDate(clock)}
              </div>
              {/* GPS 狀態 */}
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px",
                background: gpsOk ? C.success.bg : C.warning.bg,
                borderRadius:8, marginBottom:14, fontSize:12,
                color: gpsOk ? C.success.text : C.warning.text }}>
                <div style={{ width:7, height:7, borderRadius:"50%", flexShrink:0,
                  background: gpsOk ? "#0F9B6A" : "#C07000" }}/>
                {gpsOk ? "GPS 已確認：台中市門市 (43m)" : "GPS 定位確認中..."}
              </div>
              {/* 今日排班 */}
              <div style={S.label}>今日排班</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:16 }}>
                {myShifts.slice(0,4).map((s,i) => (
                  <span key={i} style={{ padding:"4px 10px", borderRadius:99, fontSize:12,
                    background:s.room.bg, color:s.room.color, fontWeight:500 }}>
                    {s.room.name} {s.time}
                  </span>
                ))}
                {myShifts.length===0 && <span style={{ fontSize:12, color:C.hint }}>今日無排班</span>}
              </div>
              {/* FIX #5: disabled 樣式 */}
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

        {/* 班表 */}
        {tab==="schedule" && (
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

        {/* 薪資 */}
        {tab==="salary" && (
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
        )}

        {/* 通知 */}
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
function AdminApp({ schedule, setSchedule, punchLogs, onLogout }) {
  const [tab,          setTab]         = useState("overview");
  const [viewMode,     setViewMode]    = useState("timeline");
  const [selectedDate, setSelectedDate]= useState(new Date());
  const [selectedRoom, setSelectedRoom]= useState("A");
  const [selectedBranch, setSelectedBranch] = useState("大忠店");
  const [modal,        setModal]       = useState(null);
  const [staffData,    setStaffData]   = useState(INIT_STAFF.map(s=>({...s})));
  const [toast,        setToast]       = useState({ show:false, msg:"" });
  const [sbLogin,      setSbLogin]     = useState(SB_CONFIG.companyLogin);
  const [sbKey,        setSbKey]       = useState("");

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

  const branchRooms = useMemo(() => ROOMS.filter(r => r.branch === selectedBranch), [selectedBranch]);

  const bookedSlots = useMemo(() => {
    const result = {};
    SLOTS.forEach(t => {
      const rooms = branchRooms.filter(r => schedule[r.id]?.[t]?.booked);
      if (rooms.length > 0) result[t] = rooms;
    });
    return result;
  }, [schedule, branchRooms]);

  // FIX #2 & #6: 正確從 punchLogs 計算在場員工
  const presentStaff = useMemo(() => getPresentStaff(punchLogs), [punchLogs]);
  const anomalies    = useMemo(() => punchLogs.filter(l=>l.anomaly), [punchLogs]);

  const totalBookings = useMemo(() =>
    Object.values(schedule).reduce((a,rm)=>a+Object.values(rm).filter(c=>c.booked).length,0),
    [schedule]
  );

  // FIX #7: 從打卡紀錄計算薪資
  const salaryRows = useMemo(() => {
    return staffData.map(s => {
      const worked = calcHours(s.id, punchLogs);
      const hours  = worked > 0 ? worked : 40; // fallback for demo
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

      {/* Modal */}
      {modal && (
        <CellModal
          cell={schedule[modal.roomId]?.[modal.time]}
          room={ROOMS.find(r=>r.id===modal.roomId)}
          time={modal.time}
          staffList={INIT_STAFF}
          onSave={(data)=>updateCell(modal.roomId, modal.time, data)}
          onClose={()=>setModal(null)}
        />
      )}

      {/* Header */}
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

            {/* FIX #2: 使用 punchLogs 而非 PUNCH_DEMO */}
            <div style={S.card}>
              <div style={S.label}>目前在場員工</div>
              {presentStaff.length === 0
                ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>目前無人在場</div>
                : presentStaff.map((l,i) => {
                    const sf = staffById(l.staffId, INIT_STAFF);
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
            {/* 分店切換 */}
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

            {/* 日期列 */}
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

            {/* 視圖切換 */}
            <div style={{ display:"flex", gap:4, marginBottom:"0.75rem" }}>
              {[["timeline","時間軸"],["heatmap","熱圖"],["single","單場"]].map(([v,l]) => (
                <button key={v} style={{ ...S.tab(viewMode===v), flex:"none", padding:"6px 14px", fontSize:12 }}
                  onClick={()=>setViewMode(v)}>{l}</button>
              ))}
            </div>

            {/* 時間軸視圖 */}
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
                          const sf   = staffById(cell.staffId, INIT_STAFF);
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

            {/* 熱圖視圖 — FIX #3: 使用 Fragment with key */}
            {viewMode==="heatmap" && (
              <div style={{ ...S.card, overflowX:"auto" }}>
                <div style={{
                  display:"grid",
                  gridTemplateColumns:`50px repeat(${branchRooms.length},1fr)`,
                  gap:2, minWidth:280,
                }}>
                  {/* 標頭 */}
                  <div/>
                  {branchRooms.map(r => (
                    <div key={r.id} style={{ fontSize:10, color:r.color, textAlign:"center", fontWeight:600, paddingBottom:6 }}>
                      {r.name.slice(0,2)}
                    </div>
                  ))}
                  {/* 資料列 — FIX #3: Fragment with key */}
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

            {/* 單場視圖 */}
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
                    const sf   = staffById(cell?.staffId, INIT_STAFF);
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

        {/* ── 打卡管理 — FIX #2: 使用 punchLogs prop ── */}
        {tab==="clock" && (
          <div>
            <div style={S.card}>
              <div style={S.label}>今日打卡紀錄</div>
              {punchLogs.length === 0
                ? <div style={{ fontSize:13, color:C.hint, padding:"1rem 0", textAlign:"center" }}>尚無打卡紀錄</div>
                : [...punchLogs].reverse().map((l,i,arr) => (
                  <div key={i} style={S.row(i===arr.length-1)}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:500 }}>{l.name}</div>
                      <div style={{ fontSize:11, color:C.muted }}>{l.type==="in"?"上班":"下班"} {l.timeStr}</div>
                    </div>
                    <span style={S.badge(l.anomaly?"amber": l.type==="in"?"green":"gray")}>
                      {l.anomaly || (l.type==="in"?"正常":"下班")}
                    </span>
                  </div>
                ))
              }
            </div>
            <div style={S.card}>
              <div style={S.label}>今日異常摘要</div>
              {[
                ["遲到", anomalies.filter(l=>l.anomaly?.includes("遲到")).length],
                ["早退", anomalies.filter(l=>l.anomaly?.includes("早退")).length],
                ["缺勤", 0],
              ].map(([k,v],i,arr) => (
                <div key={k} style={{ ...S.row(i===arr.length-1), fontSize:13 }}>
                  <span style={{ color:C.muted }}>{k}</span>
                  <span style={{ fontWeight:500, color: v>0 ? C.danger.text : C.text }}>{v} 件</span>
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
            <div style={S.card}>
              <div style={S.label}>SimplyBook 串接</div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:6 }}>Company Login（網址前綴）</div>
              <input style={S.inp} value={sbLogin} onChange={e=>setSbLogin(e.target.value)} placeholder="bglescape"/>
              <div style={{ fontSize:11, color:C.muted, marginBottom:6 }}>API Key</div>
              <input style={S.inp} type="password" value={sbKey} onChange={e=>setSbKey(e.target.value)} placeholder="貼上 API Key"/>
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 12px",
                background: sbLogin&&sbKey ? C.success.bg : "#FEF8E7",
                borderRadius:8, marginBottom:12, fontSize:12,
                color: sbLogin&&sbKey ? C.success.text : C.warning.text }}>
                <div style={{ width:7,height:7,borderRadius:"50%", flexShrink:0,
                  background: sbLogin&&sbKey ? "#0F9B6A" : "#C07000" }}/>
                {sbLogin&&sbKey ? "設定完成，可測試連線" : "尚未填入 SimplyBook 資訊"}
              </div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:8 }}>Webhook URL（填入 SimplyBook 後台）</div>
              <div style={{ background:C.tabBg, borderRadius:8, padding:"9px 12px", fontSize:11,
                color:C.text, fontFamily:"monospace", marginBottom:12, wordBreak:"break-all" }}>
                https://your-backend.com/api/webhook
              </div>
              <button style={{ ...S.ghostBtn, width:"100%", padding:10, textAlign:"center" }}
                onClick={()=>showToast("設定已儲存")}>儲存設定</button>
            </div>
            <div style={S.card}>
              <div style={S.label}>員工帳號管理</div>
              {INIT_STAFF.map((s,i) => (
                <div key={s.id} style={S.row(i===INIT_STAFF.length-1)}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <Avatar name={s.name} color={s.color} size={28}/>
                    <span style={{ fontSize:13 }}>{s.name}</span>
                  </div>
                  <button style={S.ghostBtn} onClick={()=>showToast(`已重設 ${s.name} 的密碼`)}>重設密碼</button>
                </div>
              ))}
              <button style={{ ...S.ghostBtn, width:"100%", padding:10, marginTop:10, textAlign:"center" }}>
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

// ── 編輯 Modal ────────────────────────────────────────────
function CellModal({ cell, room, time, staffList, onSave, onClose }) {
  const [booked,     setBooked]     = useState(cell?.booked     || false);
  const [clientName, setClientName] = useState(cell?.clientName || "");
  const [staffId,    setStaffId]    = useState(cell?.staffId    || null);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.35)", display:"flex",
      alignItems:"flex-end", zIndex:100 }} onClick={onClose}>
      <div style={{ background:C.surface, borderRadius:"20px 20px 0 0", padding:"1.5rem 1.25rem",
        width:"100%", maxWidth:480, margin:"0 auto", boxShadow:"0 -4px 24px rgba(0,0,0,0.1)" }}
        onClick={e=>e.stopPropagation()}>

        {/* Modal 頂部 */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:500, color:room.color }}>{room.name}</div>
            <div style={{ fontSize:12, color:C.muted }}>{time}</div>
          </div>
          <button onClick={onClose} style={{ border:"none", background:C.tabBg, color:C.muted,
            fontSize:16, cursor:"pointer", width:30, height:30, borderRadius:"50%", lineHeight:1 }}>×</button>
        </div>

        {/* 預約狀態切換 */}
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
  const [user,       setUser]      = useState(null);
  const [schedule,   setSchedule]  = useState(initSchedule);
  const [punchLogs,  setPunchLogs] = useState(PUNCH_DEMO);

  const handleLogin  = useCallback((acc, username) => setUser({ ...acc, username }), []);
  const handleLogout = useCallback(() => setUser(null), []);
  const handlePunch  = useCallback((entry) => setPunchLogs(prev => [...prev, entry]), []);

  if (!user) return <LoginScreen onLogin={handleLogin}/>;

  if (user.role === "staff") {
    return (
      <StaffApp
        account={user}
        schedule={schedule}
        punchLogs={punchLogs}
        onPunch={handlePunch}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <AdminApp
      schedule={schedule}
      setSchedule={setSchedule}
      punchLogs={punchLogs}
      onLogout={handleLogout}
    />
  );
}
