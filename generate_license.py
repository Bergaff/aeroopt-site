#!/usr/bin/env python3
"""
generate_license.py — выдача лицензий AeroOpt через сервер лицензий
(Cloudflare Worker + D1). Используйте ВМЕСТО старой схемы с licenses.json:
ключи генерируются на сервере и сразу попадают в базу — в Git ничего
не коммитится.

Настройка окружения (один раз):
    set LICENSE_SERVER=https://aeroopt-license-server.tgmg.workers.dev
        (Windows cmd)  или
    $env:LICENSE_SERVER="https://aeroopt-license-server.tgmg.workers.dev"
        (PowerShell)   или
    export LICENSE_SERVER=https://aeroopt-license-server.tgmg.workers.dev
        (Linux/macOS)

    set ADMIN_TOKEN=<тот же токен, что wrangler secret put ADMIN_TOKEN>

Использование:
    python generate_license.py --email buyer@example.com --product pro
    python generate_license.py --email student@mit.edu --product edu --note "МФТИ"
    python generate_license.py --email t@t.com --product trial
    python generate_license.py list                      # список ключей
    python generate_license.py revoke AERO-XXXX-... --reason "возврат"

Продукты: personal (2 машины), pro (3 машины), edu (1 машина), trial (14 дней).
Сервер сам генерирует ключ формата AERO-XXXX-XXXX-XXXX-XXXX, считает срок,
сохраняет в D1 и (если настроен Resend) отправляет ключ на email.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def server_base() -> str:
    return (os.environ.get("LICENSE_SERVER", "").strip()
            or "https://aeroopt-license-server.tgmg.workers.dev").rstrip("/")


def admin_token() -> str:
    t = os.environ.get("ADMIN_TOKEN", "").strip()
    if not t:
        sys.exit("❌ Задайте ADMIN_TOKEN (wrangler secret put ADMIN_TOKEN):\n"
                 '   set ADMIN_TOKEN=ваш_токен   (Windows cmd)\n'
                 '   $env:ADMIN_TOKEN="..."      (PowerShell)')
    return t


def api(method: str, path: str, body: dict | None = None) -> dict:
    url = server_base() + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Content-Type": "application/json",
        "X-Admin-Token": admin_token(),
        "User-Agent": "AeroOpt-admin-cli/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
            sys.exit(f"❌ HTTP {e.code}: {payload.get('message') or payload.get('code')}")
        except Exception:
            sys.exit(f"❌ HTTP {e.code}")
    except Exception as e:
        sys.exit(f"❌ Сервер недоступен ({url}): {e}")


def cmd_issue(args):
    body = {"email": args.email, "product": args.product}
    if args.max_machines:
        body["max_machines"] = args.max_machines
    if args.expires_days is not None:
        body["expires_in_days"] = args.expires_days
    if args.note:
        body["note"] = args.note
    r = api("POST", "/v1/admin/issue", body)
    print("\n" + "=" * 60)
    print("  ✅ КЛЮЧ ВЫДАН И ЗАПИСАН В БАЗУ D1")
    print("=" * 60)
    print(f"  License key : {r['license_key']}")
    print(f"  Email       : {r['email']}")
    print(f"  Продукт     : {r['product']}")
    print(f"  Машин       : {r['max_machines']}")
    print(f"  Действует до: {r['expires_at'] or 'бессрочно'}")
    print(f"  Email клиенту: {r.get('email_status', '?')}")
    if r.get("note"):
        print(f"  Примечание  : {r['note']}")
    print("=" * 60)
    print("  Ключ уже активен — пользователь может вводить его в приложении.")
    print("  В Git коммитить ничего не нужно.\n")


def cmd_list(_args):
    r = api("GET", "/v1/admin/list?limit=200")
    rows = r.get("licenses", [])
    print(f"\nВсего ключей: {len(rows)}\n")
    print(f"{'KEY':<26} {'PRODUCT':<9} {'MACH':<5} {'СТАТУС':<9} EMAIL")
    print("-" * 80)
    for l in rows:
        status = "REVOKED" if l.get("revoked_at") else (
            "EXPIRED" if l.get("expires_at") and l["expires_at"] <
            __import__("time").time() else "ACTIVE")
        print(f"{l['license_key']:<26} {l.get('product',''):<9} "
              f"{l.get('active_machines',0)}/{l.get('max_machines',0):<3} "
              f"{status:<9} {l.get('email','')}")


def cmd_revoke(args):
    r = api("POST", "/v1/admin/revoke",
            {"license_key": args.key, "reason": args.reason})
    print(f"✅ Отозван: {args.key} ({r.get('revoked_at')})")


def cmd_inspect(args):
    from urllib.parse import quote
    r = api("GET", f"/v1/admin/inspect?license_key={quote(args.key)}")
    print(json.dumps(r, indent=2, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser(description="AeroOpt license admin CLI (Cloudflare API)")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("issue", help="выдать новый ключ")
    pi.add_argument("--email", required=True)
    pi.add_argument("--product", default="personal",
                    choices=["personal", "pro", "edu", "trial"])
    pi.add_argument("--max-machines", type=int, default=0)
    pi.add_argument("--expires-days", type=int, default=None,
                    help="срок действия в днях (по умолчанию по продукту)")
    pi.add_argument("--note", default="")
    pi.set_defaults(func=cmd_issue)

    pl = sub.add_parser("list", help="список ключей")
    pl.set_defaults(func=cmd_list)

    pr = sub.add_parser("revoke", help="отозвать ключ")
    pr.add_argument("key")
    pr.add_argument("--reason", default="")
    pr.set_defaults(func=cmd_revoke)

    pin = sub.add_parser("inspect", help="детали по ключу")
    pin.add_argument("key")
    pin.set_defaults(func=cmd_inspect)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
