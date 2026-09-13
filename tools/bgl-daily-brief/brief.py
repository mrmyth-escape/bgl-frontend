#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""密室每日戰情簡報。

每天自動做四件事：
  1. 從 SimplyBook 後端抓訂位（今天 / 明天 / 上週同一天）
  2. 從 GAS 抓今日排班與打卡狀態
  3. 比對「有場沒人 / 有人沒場」，算各主題場次與週對比
  4. 丟給 Claude 寫幾句重點，然後寄一封 mail 給老闆

用法：
  python brief.py --selftest   # 探測 API 結構（只印欄位名與筆數，不印客戶資料）
  python brief.py --dry-run    # 完整跑，報告印在畫面，不寄信
  python brief.py              # 完整跑並寄信
  python brief.py --date 2026-09-14

環境變數：
  SMTP_HOST（預設 smtp.gmail.com）SMTP_PORT（預設 465）SMTP_USER SMTP_PASS MAIL_TO MAIL_FROM
  ANTHROPIC_API_KEY   有設才會做 AI 摘要
  ANTHROPIC_MODEL     預設 claude-opus-5
  BGL_BACKEND_URL / BGL_GAS_URL   要換端點時才需要設

隱私：報告與 log 一律只輸出彙總數字與時段，不含客戶姓名、電話、Email。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import smtplib
import sys
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate
from typing import Any

TPE_TZ = dt.timezone(dt.timedelta(hours=8))
UA = "bgl-daily-brief/1.0 (+internal tool)"

BACKEND_URL = os.environ.get("BGL_BACKEND_URL", "https://bgl-backend-new.vercel.app").rstrip("/")
GAS_URL = os.environ.get(
    "BGL_GAS_URL",
    "https://script.google.com/macros/s/AKfycbwb319Bqz-_p-fDj_tIm62jaIRpMJ0mypwrOTGvyHUxR-WOhQxZ0ri8GS8uB2hFkfUzoQ/exec",
)

# 與 src/App.jsx 的 ROOMS 一致
ROOMS = [
    {"id": "A", "name": "孤兒怨", "branch": "大忠店", "service_id": 2, "location_id": 1, "emoji": "👻", "duration": 75},
    {"id": "B", "name": "屎力全開", "branch": "大忠店", "service_id": 3, "location_id": 1, "emoji": "💩", "duration": 75},
    {"id": "C", "name": "越獄者", "branch": "大忠店", "service_id": 15, "location_id": 1, "emoji": "🦸", "duration": 90},
    {"id": "D", "name": "詭廁", "branch": "大忠店", "service_id": 14, "location_id": 1, "emoji": "🚽", "duration": 60},
    {"id": "E", "name": "詭獄", "branch": "謎先生", "service_id": 11, "location_id": 2, "emoji": "⛓", "duration": 90},
    {"id": "F", "name": "詭獄加場", "branch": "謎先生", "service_id": 17, "location_id": 2, "emoji": "➕", "duration": 120},
    {"id": "G", "name": "詭店", "branch": "謎先生", "service_id": 16, "location_id": 2, "emoji": "🏚", "duration": 75},
]
ROOM_BY_SERVICE = {r["service_id"]: r for r in ROOMS}
BRANCHES = ["大忠店", "謎先生"]
WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]

# 探測模式下可以安全印出的欄位（其餘只印型別，不印值）
SAFE_KEYS = {
    "id", "service_id", "serviceid", "provider_id", "location_id", "unit_id",
    "start_date", "end_date", "start_time", "end_time", "date", "time",
    "status", "is_confirm", "count", "qty", "duration", "code", "ok", "error",
}
DISCLAIMER = "資料來源：SimplyBook 訂位系統與排班表。本信由程式自動產生。"


# --------------------------------------------------------------------------
# 基礎工具
# --------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[{dt.datetime.now(TPE_TZ):%H:%M:%S}] {msg}", file=sys.stderr, flush=True)


def taipei_today() -> dt.date:
    return dt.datetime.now(TPE_TZ).date()


def _error_detail(exc: Exception) -> str:
    """把伺服器回的錯誤內容濃縮成一行，方便判斷是誰壞了。"""
    if not isinstance(exc, urllib.error.HTTPError):
        return str(exc)
    try:
        body = exc.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return str(exc)
    flat = " ".join(body.replace("<", " <").split())
    return f"{exc} ｜ 回應內容：{flat[:300]}"


def http_json(
    url: str,
    payload: Any = None,
    retries: int = 3,
    timeout: int = 25,
    json_content_type: bool = False,
) -> Any:
    """GET（payload=None）或 POST。失敗會重試。

    預設 POST 不加 Content-Type，與前端 callGAS() 的送法一致
    （Apps Script 對 application/json 的處理和瀏覽器預設的 text/plain 不同）。
    """
    headers = {
        # Apps Script / Cloudflare 類的服務會擋掉看起來像機器人的 UA
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
    }
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        if json_content_type:
            headers["Content-Type"] = "application/json"
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            text = raw.decode("utf-8-sig", errors="replace").strip()
            if not text:
                raise ValueError("空回應")
            return json.loads(text)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < retries:
                time.sleep(1.5 * attempt)
    raise RuntimeError(f"請求失敗 {url} -> {_error_detail(last_err) if last_err else '未知錯誤'}")


def shape(value: Any, depth: int = 0) -> Any:
    """描述資料結構但不洩漏內容：只有白名單欄位會印出實際值。"""
    if depth > 3:
        return "…"
    if isinstance(value, dict):
        out = {}
        for key, val in list(value.items())[:40]:
            if str(key).lower() in SAFE_KEYS and not isinstance(val, (dict, list)):
                out[key] = val
            else:
                out[key] = shape(val, depth + 1) if isinstance(val, (dict, list)) else f"<{type(val).__name__}>"
        return out
    if isinstance(value, list):
        return [f"list[{len(value)}]", shape(value[0], depth + 1)] if value else "list[0]"
    return f"<{type(value).__name__}>"


# --------------------------------------------------------------------------
# 資料來源
# --------------------------------------------------------------------------
def _as_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("bookings", "data", "result", "items"):
            inner = payload.get(key)
            if isinstance(inner, list):
                return [x for x in inner if isinstance(x, dict)]
    return []


def fetch_bookings(day: dt.date, verbose: bool = False) -> tuple[list[dict[str, Any]], str]:
    """抓某一天的訂位。回傳 (訂位清單, 用到的網址)。

    後端是否吃日期參數不確定，所以依序試幾種寫法，再用日期欄位過濾一次。
    """
    candidates = [
        f"{BACKEND_URL}/api/bookings?date={day:%Y-%m-%d}",
        f"{BACKEND_URL}/api/bookings?from={day:%Y-%m-%d}&to={day:%Y-%m-%d}",
        f"{BACKEND_URL}/api/bookings",
    ]
    last_err: Exception | None = None
    for url in candidates:
        try:
            payload = http_json(url)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if verbose:
                log(f"  {url} 失敗：{exc}")
            continue
        rows = _as_list(payload)
        if verbose:
            log(f"  {url} -> {len(rows)} 筆")
        if rows:
            filtered = [r for r in rows if booking_date(r) == day]
            # 端點若不吃日期參數，全部資料裡挑得出當天的就用過濾結果
            return (filtered if filtered else ([] if _has_date_field(rows) else rows)), url
    if last_err:
        log(f"  訂位資料抓取失敗：{last_err}")
    return [], ""


def _has_date_field(rows: list[dict[str, Any]]) -> bool:
    return any(booking_date(r) is not None for r in rows)


def booking_date(row: dict[str, Any]) -> dt.date | None:
    for key in ("start_date", "date", "start_datetime", "startDate", "day"):
        raw = row.get(key)
        if not raw:
            continue
        text = str(raw).strip().replace("/", "-")[:10]
        try:
            return dt.date.fromisoformat(text)
        except ValueError:
            continue
    return None


def booking_time(row: dict[str, Any]) -> str:
    for key in ("start_time", "time", "startTime"):
        raw = row.get(key)
        if raw:
            return str(raw)[:5]
    raw = row.get("start_datetime") or row.get("start")
    if raw and " " in str(raw):
        return str(raw).split(" ", 1)[1][:5]
    return ""


def booking_room(row: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("service_id", "serviceId", "event_id", "service"):
        raw = row.get(key)
        if raw is None:
            continue
        try:
            return ROOM_BY_SERVICE.get(int(raw))
        except (TypeError, ValueError):
            continue
    return None


def is_cancelled(row: dict[str, Any]) -> bool:
    """只在明確標示取消時才排除，避免把正常訂位誤判掉。"""
    for key in ("status", "state"):
        if "cancel" in str(row.get(key, "")).lower():
            return True
    for key in ("is_cancelled", "cancelled", "canceled"):
        value = row.get(key)
        if value is True or str(value).strip() in ("1", "true", "True"):
            return True
    return False


def fetch_gas(action: str, payload: dict[str, Any] | None = None) -> Any:
    data = http_json(GAS_URL, {"action": action, "payload": payload or {}})
    if isinstance(data, dict):
        if data.get("ok") is False:
            raise RuntimeError(data.get("error") or "GAS 回報失敗")
        return data.get("data", data)
    return data


# --------------------------------------------------------------------------
# 彙總
# --------------------------------------------------------------------------
def summarize_day(day: dt.date, rows: list[dict[str, Any]]) -> dict[str, Any]:
    per_room: dict[str, dict[str, Any]] = {
        r["id"]: {"room": r, "times": [], "count": 0} for r in ROOMS
    }
    unknown = 0
    for row in rows:
        if is_cancelled(row):
            continue
        room = booking_room(row)
        if not room:
            unknown += 1
            continue
        slot = per_room[room["id"]]
        slot["count"] += 1
        t = booking_time(row)
        if t:
            slot["times"].append(t)
    for slot in per_room.values():
        slot["times"] = sorted(set(slot["times"]))
    return {
        "day": day,
        "total": sum(s["count"] for s in per_room.values()),
        "unknown_service": unknown,
        "per_room": per_room,
        "per_branch": {
            b: sum(s["count"] for s in per_room.values() if s["room"]["branch"] == b) for b in BRANCHES
        },
    }


def staffing_gaps(today: dict[str, Any], shifts: list[dict[str, Any]]) -> dict[str, Any]:
    """比對今日場次與今日排班，找出有場沒人 / 有人沒場。"""
    booked_rooms = {rid for rid, s in today["per_room"].items() if s["count"] > 0}
    booked_names = {today["per_room"][rid]["room"]["name"] for rid in booked_rooms}

    staffed_themes: set[str] = set()
    staff_count = 0
    for shift in shifts or []:
        if not isinstance(shift, dict):
            continue
        staff_count += 1
        theme = shift.get("theme") or shift.get("themes") or shift.get("room")
        if isinstance(theme, str):
            staffed_themes.update(t.strip() for t in theme.replace("、", ",").split(",") if t.strip())
        elif isinstance(theme, list):
            staffed_themes.update(str(t).strip() for t in theme)

    return {
        "staff_count": staff_count,
        "rooms_without_staff": sorted(booked_names - staffed_themes) if staffed_themes else [],
        "staff_without_rooms": sorted(staffed_themes - booked_names) if staffed_themes else [],
        "have_shift_data": bool(shifts),
        "have_theme_data": bool(staffed_themes),
    }


def build_brief(
    today: dict[str, Any],
    tomorrow: dict[str, Any],
    last_week: dict[str, Any] | None,
    staffing: dict[str, Any],
) -> dict[str, Any]:
    delta = None
    if last_week:
        delta = today["total"] - last_week["total"]
    quiet_rooms = [
        s["room"]["name"] for s in tomorrow["per_room"].values() if s["count"] == 0
    ]
    return {
        "today": today,
        "tomorrow": tomorrow,
        "last_week": last_week,
        "delta": delta,
        "quiet_rooms_tomorrow": quiet_rooms,
        "staffing": staffing,
    }


# --------------------------------------------------------------------------
# 輸出
# --------------------------------------------------------------------------
def day_label(day: dt.date) -> str:
    return f"{day:%m/%d}（{WEEKDAYS[day.weekday()]}）"


def brief_to_text(brief: dict[str, Any]) -> str:
    today, tomorrow = brief["today"], brief["tomorrow"]
    out: list[str] = [f"# 密室每日戰情 {day_label(today['day'])}"]

    line = f"今日總場次：{today['total']} 場"
    if brief["delta"] is not None:
        lw = brief["last_week"]
        sign = "＋" if brief["delta"] >= 0 else "－"
        line += f"（上週{day_label(lw['day'])} {lw['total']} 場，{sign}{abs(brief['delta'])}）"
    out.append(line)
    out.append("各店：" + "、".join(f"{b} {n} 場" for b, n in today["per_branch"].items()))

    out.append("")
    out.append("## 今日各主題")
    for slot in today["per_room"].values():
        room = slot["room"]
        times = "、".join(slot["times"]) if slot["times"] else "—"
        out.append(f"- {room['emoji']} {room['name']}（{room['branch']}）{slot['count']} 場：{times}")

    out.append("")
    out.append(f"## 明日 {day_label(tomorrow['day'])}：{tomorrow['total']} 場")
    for slot in tomorrow["per_room"].values():
        room = slot["room"]
        times = "、".join(slot["times"]) if slot["times"] else "—"
        out.append(f"- {room['emoji']} {room['name']} {slot['count']} 場：{times}")
    if brief["quiet_rooms_tomorrow"]:
        out.append(f"⚠️ 明天還完全沒有訂位的主題：{'、'.join(brief['quiet_rooms_tomorrow'])}")

    staffing = brief["staffing"]
    out.append("")
    out.append("## 人力對應")
    if not staffing["have_shift_data"]:
        out.append("（today 沒有排班資料，略過比對）")
    else:
        out.append(f"今日排班 {staffing['staff_count']} 人次")
        if not staffing["have_theme_data"]:
            out.append("（排班資料沒有主題欄位，無法比對有場沒人）")
        else:
            if staffing["rooms_without_staff"]:
                out.append(f"⚠️ 有場但排班沒對應主題：{'、'.join(staffing['rooms_without_staff'])}")
            else:
                out.append("✅ 今日有訂位的主題都有人對應")
            if staffing["staff_without_rooms"]:
                out.append(f"ℹ️ 有排班但今天沒場的主題：{'、'.join(staffing['staff_without_rooms'])}")
    return "\n".join(out)


def _rows_html(summary: dict[str, Any]) -> str:
    body = []
    for slot in summary["per_room"].values():
        room = slot["room"]
        times = "、".join(slot["times"]) if slot["times"] else "—"
        weight = "700" if slot["count"] else "400"
        color = "#222" if slot["count"] else "#999"
        body.append(
            f'<tr><td style="color:{color}">{room["emoji"]} {room["name"]}</td>'
            f'<td style="color:#777">{room["branch"]}</td>'
            f'<td align="right" style="font-weight:{weight};color:{color}">{slot["count"]}</td>'
            f'<td style="color:#555;font-size:13px">{times}</td></tr>'
        )
    return (
        '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;margin:4px 0 18px">'
        '<tr style="background:#f2f4f7"><th align="left">主題</th><th align="left">店</th>'
        '<th align="right">場次</th><th align="left">時段</th></tr>' + "".join(body) + "</table>"
    )


def brief_to_html(brief: dict[str, Any], ai_text: str | None) -> str:
    today, tomorrow = brief["today"], brief["tomorrow"]
    head = f"今日 {today['total']} 場"
    if brief["delta"] is not None:
        sign = "＋" if brief["delta"] >= 0 else "－"
        head += f"（較上週同日 {sign}{abs(brief['delta'])} 場）"

    parts = [
        '<div style="font-family:-apple-system,\'Segoe UI\',\'Microsoft JhengHei\',sans-serif;max-width:720px;margin:0 auto;color:#222">',
        f'<h2 style="margin:0 0 4px">密室每日戰情　{day_label(today["day"])}</h2>',
        f'<p style="color:#666;margin:0 0 16px;font-size:13px">{head}｜'
        + "、".join(f"{b} {n} 場" for b, n in today["per_branch"].items())
        + "</p>",
    ]
    if ai_text:
        safe = ai_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
        parts.append(
            '<div style="background:#f7f9fc;border-left:4px solid #3b6ea5;padding:12px 14px;margin:0 0 20px;'
            'font-size:14px;line-height:1.7"><b>今日重點</b><br>' + safe + "</div>"
        )
    parts.append('<h3 style="margin:16px 0 2px;font-size:15px">今日各主題</h3>')
    parts.append(_rows_html(today))
    parts.append(f'<h3 style="margin:16px 0 2px;font-size:15px">明日 {day_label(tomorrow["day"])}</h3>')
    parts.append(_rows_html(tomorrow))
    if brief["quiet_rooms_tomorrow"]:
        parts.append(
            '<p style="background:#FFF6E5;border-left:4px solid #C07000;padding:10px 12px;font-size:14px">'
            f'⚠️ 明天還完全沒訂位：{"、".join(brief["quiet_rooms_tomorrow"])}</p>'
        )

    staffing = brief["staffing"]
    parts.append('<h3 style="margin:16px 0 2px;font-size:15px">人力對應</h3>')
    if not staffing["have_shift_data"]:
        parts.append('<p style="color:#999;font-size:14px">今天沒有排班資料，略過比對。</p>')
    else:
        bits = [f'今日排班 {staffing["staff_count"]} 人次']
        if staffing["have_theme_data"]:
            if staffing["rooms_without_staff"]:
                bits.append(f'⚠️ 有場但排班沒對應主題：{"、".join(staffing["rooms_without_staff"])}')
            else:
                bits.append("✅ 今日有訂位的主題都有人對應")
            if staffing["staff_without_rooms"]:
                bits.append(f'ℹ️ 有排班但今天沒場：{"、".join(staffing["staff_without_rooms"])}')
        else:
            bits.append("（排班資料沒有主題欄位，無法比對）")
        parts.append('<p style="font-size:14px;line-height:1.8">' + "<br>".join(bits) + "</p>")

    parts.append(f'<p style="color:#888;font-size:12px;margin-top:24px">{DISCLAIMER}</p></div>')
    return "".join(parts)


# --------------------------------------------------------------------------
# AI 摘要
# --------------------------------------------------------------------------
SYSTEM_PROMPT = """你是一位密室逃脫店的營運助理。使用者每天早上會給你當天與隔天的訂位彙總。

請用繁體中文寫 3-5 句話，內容包含：
1. 今天的營運重點（哪間店哪個主題最忙、和上週同日比是增是減）
2. 最值得立刻處理的一件事（例如明天某主題完全沒訂位、某主題有場但排班沒人）
3. 一個具體可執行的小建議（例如針對明天空著的時段做限時優惠）

嚴格規則：
- 只能使用使用者提供的數字，不可以捏造任何訂位數、營收、客人資訊或未提供的主題。
- 資料不足就說資料不足，不要臆測。
- 講重點，不要客套話，不要條列超過 5 點。"""


def ai_comment(digest: str) -> str | None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log("未設定 ANTHROPIC_API_KEY，略過 AI 摘要")
        return None
    try:
        import anthropic  # type: ignore
    except ImportError:
        log("未安裝 anthropic 套件，略過 AI 摘要")
        return None
    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=os.environ.get("ANTHROPIC_MODEL", "claude-opus-5"),
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": digest}],
        )
        if getattr(resp, "stop_reason", None) == "refusal":
            return None
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
        return text or None
    except Exception as exc:  # noqa: BLE001
        log(f"AI 摘要失敗（不影響報告）：{exc}")
        return None


# --------------------------------------------------------------------------
# 寄信
# --------------------------------------------------------------------------
def send_mail(subject: str, html: str, text: str) -> bool:
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASS", "")
    to_addr = os.environ.get("MAIL_TO", "") or user
    from_addr = os.environ.get("MAIL_FROM", "") or user
    if not (user and password and to_addr):
        log("SMTP 設定不完整，略過寄信")
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=60) as server:
            server.login(user, password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=60) as server:
            server.starttls()
            server.login(user, password)
            server.send_message(msg)
    log(f"已寄出：{to_addr}")
    return True


# --------------------------------------------------------------------------
# 探測模式
# --------------------------------------------------------------------------
def run_selftest(day: dt.date) -> int:
    log("=== 探測資料源（只印結構，不印客戶資料）===")
    ok_any = False

    log(f"--- 後端 {BACKEND_URL} ---")
    try:
        health = http_json(f"{BACKEND_URL}/api/health", retries=1)
        log(f"  /api/health -> {shape(health)}")
    except Exception as exc:  # noqa: BLE001
        log(f"  /api/health 失敗：{exc}")

    for url in (
        f"{BACKEND_URL}/api/bookings",
        f"{BACKEND_URL}/api/bookings?date={day:%Y-%m-%d}",
        f"{BACKEND_URL}/api/bookings?from={day:%Y-%m-%d}&to={day + dt.timedelta(days=1):%Y-%m-%d}",
    ):
        try:
            payload = http_json(url, retries=1)
        except Exception as exc:  # noqa: BLE001
            log(f"  {url} 失敗：{exc}")
            continue
        rows = _as_list(payload)
        ok_any = ok_any or bool(rows)
        log(f"  {url}")
        log(f"    外層結構：{shape(payload) if not isinstance(payload, list) else f'list[{len(payload)}]'}")
        log(f"    筆數：{len(rows)}")
        if rows:
            log(f"    欄位：{sorted(rows[0].keys())}")
            log(f"    首筆結構：{shape(rows[0])}")
            dates = sorted({str(booking_date(r)) for r in rows})
            log(f"    出現的日期：{dates[:10]}{'…' if len(dates) > 10 else ''}")
            svc = sorted({str(r.get('service_id') or r.get('serviceId') or '?') for r in rows})
            log(f"    service_id：{svc}")

    try:
        root = http_json(f"{BACKEND_URL}/", retries=1)
        log(f"  / -> {shape(root)}")
    except Exception as exc:  # noqa: BLE001
        log(f"  / 失敗：{exc}")

    log("--- GAS ---")
    # 先確認這個網址從伺服器端到底能不能通（瀏覽器可以不代表 CI 可以）
    for label, kwargs in (
        ("GET（不帶內容）", {"payload": None}),
        ("POST 不帶 Content-Type（與前端相同）", {"payload": {"action": "getStaffPublic", "payload": {}}}),
        ("POST 帶 application/json", {"payload": {"action": "getStaffPublic", "payload": {}}, "json_content_type": True}),
    ):
        try:
            data = http_json(GAS_URL, retries=1, **kwargs)
            log(f"  {label} -> {shape(data)}")
            ok_any = True
        except Exception as exc:  # noqa: BLE001
            log(f"  {label} 失敗：{exc}")

    for action in ("getTodayStatus", "getAdminOverview", "getStaffPublic"):
        try:
            data = fetch_gas(action)
            log(f"  {action} -> {shape(data)}")
            ok_any = True
        except Exception as exc:  # noqa: BLE001
            log(f"  {action} 失敗：{exc}")

    log("=== 結果 ===")
    log(f"至少一個資料源可用：{'是' if ok_any else '否'}")
    return 0 if ok_any else 1


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="密室每日戰情簡報")
    parser.add_argument("--date", help="指定日期 YYYY-MM-DD（預設今天）")
    parser.add_argument("--dry-run", action="store_true", help="不寄信，只印報告")
    parser.add_argument("--no-ai", action="store_true", help="跳過 AI 摘要")
    parser.add_argument("--selftest", action="store_true", help="只探測 API 結構")
    parser.add_argument("--out", help="另存報告的資料夾")
    args = parser.parse_args(argv)

    day = dt.date.fromisoformat(args.date) if args.date else taipei_today()

    if args.selftest:
        return run_selftest(day)

    log(f"抓取 {day} 的訂位…")
    today_rows, used = fetch_bookings(day, verbose=True)
    log(f"  今日 {len(today_rows)} 筆（{used or '無可用端點'}）")
    tomorrow = day + dt.timedelta(days=1)
    tomorrow_rows, _ = fetch_bookings(tomorrow)
    log(f"  明日 {len(tomorrow_rows)} 筆")
    last_week_day = day - dt.timedelta(days=7)
    last_week_rows, _ = fetch_bookings(last_week_day)
    log(f"  上週同日 {len(last_week_rows)} 筆")

    shifts: list[dict[str, Any]] = []
    try:
        status = fetch_gas("getTodayStatus")
        if isinstance(status, dict):
            for key in ("shifts", "schedule", "today", "list"):
                if isinstance(status.get(key), list):
                    shifts = [x for x in status[key] if isinstance(x, dict)]
                    break
        elif isinstance(status, list):
            shifts = [x for x in status if isinstance(x, dict)]
        log(f"  今日排班 {len(shifts)} 筆")
    except Exception as exc:  # noqa: BLE001
        log(f"  排班資料抓取失敗（不影響其他段落）：{exc}")

    today_sum = summarize_day(day, today_rows)
    tomorrow_sum = summarize_day(tomorrow, tomorrow_rows)
    last_week_sum = summarize_day(last_week_day, last_week_rows) if last_week_rows else None
    brief = build_brief(today_sum, tomorrow_sum, last_week_sum, staffing_gaps(today_sum, shifts))

    text = brief_to_text(brief)
    ai_text = None if args.no_ai else ai_comment(text)
    html = brief_to_html(brief, ai_text)
    subject = f"【密室戰情】{day_label(day)} 今日 {today_sum['total']} 場／明日 {tomorrow_sum['total']} 場"

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, f"{day:%Y%m%d}.html"), "w", encoding="utf-8") as fh:
            fh.write(html)
        log(f"報告已存到 {args.out}")

    if args.dry_run:
        print(subject)
        print()
        print(text)
        if ai_text:
            print("\n## AI 重點\n" + ai_text)
        return 0

    send_mail(subject, html, text + ("\n\n【今日重點】\n" + ai_text if ai_text else "") + "\n\n" + DISCLAIMER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
