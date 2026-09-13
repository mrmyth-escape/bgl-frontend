#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""台股三大法人資金流向 每日自動掃描。

流程：
  1. 抓 證交所(上市 TWSE) + 櫃買(上櫃 TPEx) 當日「三大法人買賣超」全市場明細
  2. 往前多抓幾個交易日，算出「連續買超 / 連續賣超」天數
  3. 整理成排行榜（外資 / 投信 / 雙買）
  4. 丟給 Claude 做資金流向分析（可選，需 ANTHROPIC_API_KEY）
  5. 寄一封 HTML mail 給自己（可選，需 SMTP 設定）

用法：
  python scan.py --selftest          # 只測資料源，印出欄位結構，不寄信、不呼叫 AI
  python scan.py --dry-run           # 完整跑，報告印在畫面上，不寄信
  python scan.py                     # 完整跑並寄信
  python scan.py --date 20260911     # 指定日期（YYYYMMDD）

環境變數：
  SMTP_HOST（預設 smtp.gmail.com）SMTP_PORT（預設 465）SMTP_USER SMTP_PASS MAIL_TO MAIL_FROM
  ANTHROPIC_API_KEY   有設才會做 AI 分析
  ANTHROPIC_MODEL     預設 claude-opus-5

資料來源：臺灣證券交易所、證券櫃檯買賣中心公開資料。本程式僅整理公開資訊，不構成投資建議。
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
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
SHARES_PER_LOT = 1000
DISCLAIMER = "資料來源：臺灣證券交易所 / 證券櫃檯買賣中心公開資料。本報告為程式自動整理，僅供參考，不構成任何投資建議。"


# --------------------------------------------------------------------------
# 基礎工具
# --------------------------------------------------------------------------
def log(msg: str) -> None:
    ts = dt.datetime.now(TPE_TZ).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


def http_get_json(url: str, referer: str | None = None, retries: int = 3, timeout: int = 30) -> Any:
    """抓 JSON。失敗會重試（交易所常有瞬斷 / 流量限制）。"""
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/javascript, text/plain, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            text = raw.decode("utf-8-sig", errors="replace").strip()
            if not text:
                raise ValueError("空回應")
            return json.loads(text)
        except Exception as exc:  # noqa: BLE001 - 交易所什麼錯都可能吐
            last_err = exc
            if attempt < retries:
                time.sleep(2 * attempt)
    raise RuntimeError(f"抓取失敗 {url} -> {last_err}")


def to_num(value: Any) -> float:
    """把 '1,234' / '-1,234' / '--' / '' 轉成數字。"""
    if value is None:
        return 0.0
    text = str(value).strip().replace(",", "").replace(" ", "").replace("　", "")
    text = text.replace("+", "")
    if text in ("", "-", "--", "---", "N/A"):
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def taipei_today() -> dt.date:
    return dt.datetime.now(TPE_TZ).date()


def lots(shares: float) -> float:
    return shares / SHARES_PER_LOT


def fmt_lots(shares: float) -> str:
    return f"{lots(shares):,.0f}"


# --------------------------------------------------------------------------
# 欄位對應（用「欄位名稱」找欄位，不寫死索引，交易所加欄位也不會壞）
# --------------------------------------------------------------------------
def _base_name(field: str) -> str:
    """去掉括號註記，例如『外陸資買賣超股數(不含外資自營商)』-> 『外陸資買賣超股數』。"""
    return str(field).split("(")[0].split("（")[0].strip()


def map_twse_columns(fields: list[str]) -> dict[str, int]:
    """回傳 {角色: 欄位索引}。找不到的角色不會出現在 dict 裡。"""
    idx: dict[str, int] = {}
    for i, raw in enumerate(fields):
        name = str(raw).strip()
        base = _base_name(name)
        if "證券代號" in base or base in ("代號", "股票代號"):
            idx.setdefault("code", i)
        elif "證券名稱" in base or base in ("名稱", "股票名稱"):
            idx.setdefault("name", i)
        elif base.endswith("買賣超股數") or base.endswith("買賣超"):
            if "三大法人" in base:
                idx.setdefault("total", i)
            elif "投信" in base:
                idx.setdefault("trust", i)
            elif "自營商" in base:
                # 自營商有三欄：合計 / 自行買賣 / 避險。合計那欄沒有括號註記。
                if "外資" in base:
                    idx.setdefault("foreign_dealer", i)
                elif name == base:
                    idx.setdefault("dealer", i)
                else:
                    idx.setdefault("dealer_any", i)
            elif "外陸資" in base or "外資" in base:
                idx.setdefault("foreign", i)
    if "dealer" not in idx and "dealer_any" in idx:
        idx["dealer"] = idx["dealer_any"]
    return idx


def rows_from_table(fields: list[str], data: list[list[Any]], market: str) -> list[dict[str, Any]]:
    idx = map_twse_columns([str(f) for f in fields])
    missing = [k for k in ("code", "name", "foreign", "trust") if k not in idx]
    if missing:
        raise ValueError(f"欄位對應失敗，缺少 {missing}；實際欄位={fields}")

    out: list[dict[str, Any]] = []
    for row in data:
        if not row or len(row) <= max(idx.values()):
            continue
        code = str(row[idx["code"]]).strip()
        name = str(row[idx["name"]]).strip()
        if not code or not name:
            continue
        # 只留一般股票代號（4 碼數字），過濾 ETF/權證/特別股等雜訊
        if not (len(code) == 4 and code.isdigit()):
            continue
        foreign = to_num(row[idx["foreign"]])
        if "foreign_dealer" in idx:
            foreign += to_num(row[idx["foreign_dealer"]])
        trust = to_num(row[idx["trust"]])
        dealer = to_num(row[idx["dealer"]]) if "dealer" in idx else 0.0
        total = to_num(row[idx["total"]]) if "total" in idx else foreign + trust + dealer
        out.append(
            {
                "code": code,
                "name": name,
                "market": market,
                "foreign": foreign,
                "trust": trust,
                "dealer": dealer,
                "total": total,
            }
        )
    return out


# --------------------------------------------------------------------------
# 上市（TWSE）
# --------------------------------------------------------------------------
def fetch_twse(day: dt.date, verbose: bool = False) -> list[dict[str, Any]] | None:
    """回傳當日上市三大法人買賣超；該日非交易日回 None。"""
    url = (
        "https://www.twse.com.tw/rwd/zh/fund/T86"
        f"?date={day:%Y%m%d}&selectType=ALL&response=json"
    )
    payload = http_get_json(url, referer="https://www.twse.com.tw/zh/trading/foreign/t86.html")
    stat = str(payload.get("stat", ""))
    if stat.upper() != "OK":
        if verbose:
            log(f"  TWSE {day:%Y-%m-%d} stat={stat}（非交易日或尚未公布）")
        return None
    fields = payload.get("fields") or []
    data = payload.get("data") or []
    if verbose:
        log(f"  TWSE 欄位({len(fields)})：{fields}")
        log(f"  TWSE 資料筆數：{len(data)}")
    rows = rows_from_table(fields, data, "上市")
    if verbose and rows:
        log(f"  TWSE 解析後 {len(rows)} 檔，範例：{rows[0]}")
    return rows


# --------------------------------------------------------------------------
# 上櫃（TPEx）— 端點這幾年改過版，依序嘗試，哪個通用哪個
# --------------------------------------------------------------------------
def _tpex_tables(payload: Any) -> list[tuple[list[str], list[list[Any]]]]:
    """從 TPEx 各種回傳格式中挖出 (fields, data) 組。"""
    found: list[tuple[list[str], list[list[Any]]]] = []
    if isinstance(payload, dict):
        tables = payload.get("tables")
        if isinstance(tables, list):
            for tbl in tables:
                if isinstance(tbl, dict) and tbl.get("fields") and tbl.get("data"):
                    found.append(([str(f) for f in tbl["fields"]], tbl["data"]))
        if not found and payload.get("fields") and payload.get("data"):
            found.append(([str(f) for f in payload["fields"]], payload["data"]))
        if not found and isinstance(payload.get("aaData"), list) and payload.get("fields"):
            found.append(([str(f) for f in payload["fields"]], payload["aaData"]))
    return found


def fetch_tpex(day: dt.date, verbose: bool = False) -> list[dict[str, Any]] | None:
    candidates = [
        "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade"
        f"?type=Daily&sect=EW&date={day:%Y/%m/%d}&id=&response=json",
        "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade"
        f"?type=Daily&sect=EW&date={day:%Y%m%d}&id=&response=json",
    ]
    for url in candidates:
        try:
            payload = http_get_json(url, referer="https://www.tpex.org.tw/zh-tw/mainboard/trading/major-institutional/daily.html")
        except Exception as exc:  # noqa: BLE001
            if verbose:
                log(f"  TPEx 端點失敗：{url} -> {exc}")
            continue
        tables = _tpex_tables(payload)
        if verbose:
            keys = list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__
            log(f"  TPEx 回應 keys={keys}，解析到 {len(tables)} 張表：{url}")
            for fields, data in tables:
                log(f"    欄位({len(fields)})：{fields}")
                log(f"    筆數：{len(data)}；首列：{data[0] if data else None}")
        for fields, data in tables:
            if not data:
                continue
            try:
                rows = rows_from_table(fields, data, "上櫃")
            except ValueError as exc:
                if verbose:
                    log(f"    這張表不是要的：{exc}")
                continue
            if rows:
                if verbose:
                    log(f"  TPEx 解析後 {len(rows)} 檔，範例：{rows[0]}")
                return rows
    return None


# --------------------------------------------------------------------------
# 交易日與歷史
# --------------------------------------------------------------------------
def collect_days(target: dt.date | None, days: int, verbose: bool = False) -> list[tuple[dt.date, list[dict[str, Any]]]]:
    """從 target（預設今天）往回找，收集 days 個有資料的交易日，新到舊。"""
    cursor = target or taipei_today()
    collected: list[tuple[dt.date, list[dict[str, Any]]]] = []
    probes = 0
    while len(collected) < days and probes < days + 20:
        probes += 1
        if cursor.weekday() >= 5:  # 週末直接跳過，省請求
            cursor -= dt.timedelta(days=1)
            continue
        try:
            listed = fetch_twse(cursor, verbose=verbose and not collected)
        except Exception as exc:  # noqa: BLE001
            log(f"  {cursor:%Y-%m-%d} 上市資料抓取失敗：{exc}")
            listed = None
        if listed:
            rows = list(listed)
            otc = None
            try:
                otc = fetch_tpex(cursor, verbose=verbose and len(collected) == 0)
            except Exception as exc:  # noqa: BLE001
                log(f"  {cursor:%Y-%m-%d} 上櫃資料抓取失敗：{exc}")
            if otc:
                rows.extend(otc)
            else:
                log(f"  {cursor:%Y-%m-%d} 僅取得上市資料（上櫃缺）")
            collected.append((cursor, rows))
            log(f"  {cursor:%Y-%m-%d} 取得 {len(rows)} 檔（上市 {len(listed)} / 上櫃 {len(otc) if otc else 0}）")
        cursor -= dt.timedelta(days=1)
        time.sleep(1.2)  # 交易所有流量限制，放慢一點
    return collected


def streaks(history: list[tuple[dt.date, list[dict[str, Any]]]], key: str) -> dict[str, int]:
    """算連續同方向天數，正數=連買，負數=連賣。history 需由新到舊。"""
    by_day = [{r["code"]: r for r in rows} for _, rows in history]
    if not by_day:
        return {}
    result: dict[str, int] = {}
    for code, row in by_day[0].items():
        value = row[key]
        if value == 0:
            continue
        sign = 1 if value > 0 else -1
        count = 1
        for day_map in by_day[1:]:
            other = day_map.get(code)
            if not other or other[key] == 0:
                break
            if (1 if other[key] > 0 else -1) != sign:
                break
            count += 1
        result[code] = count * sign
    return result


# --------------------------------------------------------------------------
# 報告
# --------------------------------------------------------------------------
def top_rows(rows: list[dict[str, Any]], key: str, n: int, buy: bool) -> list[dict[str, Any]]:
    picked = [r for r in rows if (r[key] > 0 if buy else r[key] < 0)]
    picked.sort(key=lambda r: r[key], reverse=buy)
    return picked[:n]


def build_report(
    day: dt.date,
    rows: list[dict[str, Any]],
    history: list[tuple[dt.date, list[dict[str, Any]]]],
    top_n: int,
) -> dict[str, Any]:
    foreign_streak = streaks(history, "foreign")
    trust_streak = streaks(history, "trust")

    for row in rows:
        row["foreign_streak"] = foreign_streak.get(row["code"], 0)
        row["trust_streak"] = trust_streak.get(row["code"], 0)

    both_buy = [r for r in rows if r["foreign"] > 0 and r["trust"] > 0]
    both_buy.sort(key=lambda r: r["foreign"] + r["trust"], reverse=True)
    both_sell = [r for r in rows if r["foreign"] < 0 and r["trust"] < 0]
    both_sell.sort(key=lambda r: r["foreign"] + r["trust"])

    long_foreign = [r for r in rows if r["foreign_streak"] >= 3]
    long_foreign.sort(key=lambda r: (-r["foreign_streak"], -r["foreign"]))
    long_trust = [r for r in rows if r["trust_streak"] >= 3]
    long_trust.sort(key=lambda r: (-r["trust_streak"], -r["trust"]))

    return {
        "day": day,
        "days_used": [d for d, _ in history],
        "universe": len(rows),
        "totals": {
            "foreign": sum(r["foreign"] for r in rows),
            "trust": sum(r["trust"] for r in rows),
            "dealer": sum(r["dealer"] for r in rows),
        },
        "foreign_buy": top_rows(rows, "foreign", top_n, True),
        "foreign_sell": top_rows(rows, "foreign", top_n, False),
        "trust_buy": top_rows(rows, "trust", top_n, True),
        "trust_sell": top_rows(rows, "trust", top_n, False),
        "both_buy": both_buy[:top_n],
        "both_sell": both_sell[:top_n],
        "long_foreign": long_foreign[:top_n],
        "long_trust": long_trust[:top_n],
    }


def _line(row: dict[str, Any], key: str) -> str:
    streak_key = "foreign_streak" if key == "foreign" else "trust_streak"
    streak = row.get(streak_key, 0)
    tag = ""
    if streak >= 2:
        tag = f"（連買{streak}日）"
    elif streak <= -2:
        tag = f"（連賣{abs(streak)}日）"
    return f"{row['code']} {row['name']}[{row['market']}] {fmt_lots(row[key])} 張{tag}"


def report_to_text(rep: dict[str, Any]) -> str:
    out: list[str] = []
    out.append(f"# 台股三大法人資金流向 {rep['day']:%Y-%m-%d}")
    out.append(f"納入標的：{rep['universe']} 檔（上市+上櫃，僅四碼普通股）")
    t = rep["totals"]
    out.append(
        "全市場合計（張）："
        f"外資 {lots(t['foreign']):,.0f}、投信 {lots(t['trust']):,.0f}、自營商 {lots(t['dealer']):,.0f}"
    )
    out.append(f"連續天數統計採用交易日：{', '.join(f'{d:%m/%d}' for d in rep['days_used'])}")

    sections = [
        ("外資買超前 %d 名" % len(rep["foreign_buy"]), rep["foreign_buy"], "foreign"),
        ("外資賣超前 %d 名" % len(rep["foreign_sell"]), rep["foreign_sell"], "foreign"),
        ("投信買超前 %d 名" % len(rep["trust_buy"]), rep["trust_buy"], "trust"),
        ("投信賣超前 %d 名" % len(rep["trust_sell"]), rep["trust_sell"], "trust"),
        ("外資+投信同步買超", rep["both_buy"], "foreign"),
        ("外資+投信同步賣超", rep["both_sell"], "foreign"),
        ("外資連買 3 日以上", rep["long_foreign"], "foreign"),
        ("投信連買 3 日以上", rep["long_trust"], "trust"),
    ]
    for title, items, key in sections:
        out.append("")
        out.append(f"## {title}")
        if not items:
            out.append("（無）")
            continue
        for row in items:
            out.append("- " + _line(row, key))
    return "\n".join(out)


def _table_html(items: list[dict[str, Any]], key: str) -> str:
    if not items:
        return '<p style="color:#888;margin:4px 0 16px">（無）</p>'
    head = (
        '<tr style="background:#f2f4f7">'
        '<th align="left">代號</th><th align="left">名稱</th><th align="left">市場</th>'
        '<th align="right">買賣超(張)</th><th align="right">連續</th></tr>'
    )
    body = []
    streak_key = "foreign_streak" if key == "foreign" else "trust_streak"
    for row in items:
        value = row[key]
        color = "#c0392b" if value > 0 else "#1e7e34"
        streak = row.get(streak_key, 0)
        streak_txt = "-"
        if streak >= 2:
            streak_txt = f"連買{streak}"
        elif streak <= -2:
            streak_txt = f"連賣{abs(streak)}"
        body.append(
            f'<tr><td>{row["code"]}</td><td>{row["name"]}</td><td>{row["market"]}</td>'
            f'<td align="right" style="color:{color}">{fmt_lots(value)}</td>'
            f'<td align="right">{streak_txt}</td></tr>'
        )
    return (
        '<table cellpadding="6" cellspacing="0" border="0" '
        'style="border-collapse:collapse;width:100%;font-size:14px;margin:4px 0 18px">'
        + head
        + "".join(body)
        + "</table>"
    )


def report_to_html(rep: dict[str, Any], ai_text: str | None) -> str:
    t = rep["totals"]
    parts = [
        '<div style="font-family:-apple-system,\'Segoe UI\',\'Microsoft JhengHei\',sans-serif;'
        'max-width:760px;margin:0 auto;color:#222">',
        f'<h2 style="margin:0 0 4px">台股三大法人資金流向　{rep["day"]:%Y-%m-%d}</h2>',
        f'<p style="color:#666;margin:0 0 14px;font-size:13px">納入 {rep["universe"]} 檔（上市+上櫃普通股）｜'
        f'全市場合計：外資 {lots(t["foreign"]):,.0f} 張、投信 {lots(t["trust"]):,.0f} 張、'
        f'自營商 {lots(t["dealer"]):,.0f} 張</p>',
    ]
    if ai_text:
        safe = ai_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
        parts.append(
            '<div style="background:#f7f9fc;border-left:4px solid #3b6ea5;padding:12px 14px;'
            'margin:0 0 20px;font-size:14px;line-height:1.7">'
            '<b>AI 資金流向解讀</b><br>' + safe + "</div>"
        )
    for title, items, key in [
        ("外資買超排行", rep["foreign_buy"], "foreign"),
        ("外資賣超排行", rep["foreign_sell"], "foreign"),
        ("投信買超排行", rep["trust_buy"], "trust"),
        ("投信賣超排行", rep["trust_sell"], "trust"),
        ("外資＋投信同步買超", rep["both_buy"], "foreign"),
        ("外資＋投信同步賣超", rep["both_sell"], "foreign"),
        ("外資連買 3 日以上", rep["long_foreign"], "foreign"),
        ("投信連買 3 日以上", rep["long_trust"], "trust"),
    ]:
        parts.append(f'<h3 style="margin:18px 0 2px;font-size:15px">{title}</h3>')
        parts.append(_table_html(items, key))
    parts.append(
        f'<p style="color:#888;font-size:12px;line-height:1.6;margin-top:24px">'
        f'連續天數採用交易日：{", ".join(f"{d:%m/%d}" for d in rep["days_used"])}<br>{DISCLAIMER}</p>'
    )
    parts.append("</div>")
    return "".join(parts)


# --------------------------------------------------------------------------
# AI 分析
# --------------------------------------------------------------------------
SYSTEM_PROMPT = """你是一位台股資金流向分析助理。使用者會給你當日三大法人買賣超的整理結果。

請用繁體中文寫一段 250-400 字的解讀，結構為：
1. 今日法人動向總結（外資與投信方向是否一致）
2. 值得留意的族群或個股（從資料中找共同點，例如同產業多檔同步被買超）
3. 連續買超名單透露的訊息
4. 一句風險提醒

嚴格規則：
- 只能使用使用者提供的數據，絕對不可以捏造任何數字、股價、新聞或未提供的個股。
- 不確定的事情就說資料不足，不要臆測。
- 不要給出買賣建議或目標價，結尾不需要加免責聲明（系統會另外附上）。"""


def ai_comment(digest: str) -> str | None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log("未設定 ANTHROPIC_API_KEY，略過 AI 分析")
        return None
    try:
        import anthropic  # type: ignore
    except ImportError:
        log("未安裝 anthropic 套件（pip install anthropic），略過 AI 分析")
        return None
    model = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5")
    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=model,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": digest}],
        )
        if getattr(resp, "stop_reason", None) == "refusal":
            log("AI 拒絕回應，略過分析段落")
            return None
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
        return text or None
    except Exception as exc:  # noqa: BLE001 - AI 掛掉不該讓整封信寄不出去
        log(f"AI 分析失敗（不影響報告）：{exc}")
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
        log("SMTP_USER / SMTP_PASS / MAIL_TO 未設定齊全，略過寄信")
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


def subject_line(rep: dict[str, Any]) -> str:
    names = "、".join(r["name"] for r in rep["foreign_buy"][:3]) or "無"
    return f"【法人資金流】{rep['day']:%m/%d} 外資買超前三：{names}"


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def run_selftest(target: dt.date | None) -> int:
    day = target or taipei_today()
    log("=== 自我測試：確認資料源與欄位結構 ===")
    ok_twse = False
    probe = day
    for _ in range(12):
        if probe.weekday() < 5:
            log(f"--- 測試 TWSE {probe:%Y-%m-%d} ---")
            try:
                rows = fetch_twse(probe, verbose=True)
            except Exception as exc:  # noqa: BLE001
                log(f"TWSE 失敗：{exc}")
                rows = None
            if rows:
                ok_twse = True
                break
        probe -= dt.timedelta(days=1)
        time.sleep(1.2)

    log(f"--- 測試 TPEx {probe:%Y-%m-%d} ---")
    try:
        otc = fetch_tpex(probe, verbose=True)
    except Exception as exc:  # noqa: BLE001
        log(f"TPEx 失敗：{exc}")
        otc = None

    log("=== 結果 ===")
    log(f"上市(TWSE)：{'OK' if ok_twse else '失敗'}")
    log(f"上櫃(TPEx)：{'OK' if otc else '失敗（報告會只含上市）'}")
    return 0 if ok_twse else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="台股三大法人資金流向每日掃描")
    parser.add_argument("--date", help="指定日期 YYYYMMDD（預設今天往回找最近交易日）")
    parser.add_argument("--days", type=int, default=6, help="連續天數統計要往回取幾個交易日（預設 6）")
    parser.add_argument("--top", type=int, default=15, help="每個排行取前幾名（預設 15）")
    parser.add_argument("--dry-run", action="store_true", help="不寄信，只把報告印出來")
    parser.add_argument("--no-ai", action="store_true", help="跳過 AI 分析")
    parser.add_argument("--selftest", action="store_true", help="只測資料源與欄位結構")
    parser.add_argument("--out", help="另存報告的資料夾")
    args = parser.parse_args(argv)

    target: dt.date | None = None
    if args.date:
        target = dt.datetime.strptime(args.date, "%Y%m%d").date()

    if args.selftest:
        return run_selftest(target)

    log("開始抓取三大法人買賣超…")
    history = collect_days(target, max(1, args.days))
    if not history:
        log("找不到任何交易日資料（可能是連假，或交易所尚未公布）")
        return 1

    day, rows = history[0]
    rep = build_report(day, rows, history, args.top)
    text = report_to_text(rep)

    ai_text = None if args.no_ai else ai_comment(text)
    html = report_to_html(rep, ai_text)
    subject = subject_line(rep)

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, f"{day:%Y%m%d}.md"), "w", encoding="utf-8") as fh:
            fh.write(text + ("\n\n## AI 分析\n" + ai_text if ai_text else "") + "\n\n" + DISCLAIMER + "\n")
        with open(os.path.join(args.out, f"{day:%Y%m%d}.html"), "w", encoding="utf-8") as fh:
            fh.write(html)
        log(f"報告已存到 {args.out}")

    if args.dry_run:
        print(subject)
        print()
        print(text)
        if ai_text:
            print("\n## AI 分析\n" + ai_text)
        print("\n" + DISCLAIMER)
        return 0

    send_mail(subject, html, text + ("\n\n【AI 分析】\n" + ai_text if ai_text else "") + "\n\n" + DISCLAIMER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
