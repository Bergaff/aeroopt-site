#!/usr/bin/env python3
"""
generate_license.py — Генератор записей лицензий для AeroOpt.

Использование:
    python generate_license.py --key AERO-XXXX-XXXX-XXXX \
        --product "AeroOpt Pro" \
        --expires 2027-12-31 \
        --max-hwids 2 \
        --features basic,optimization,rans

Выводит JSON-запись для вставки в licenses.json на GitHub.

Файл licenses.json размещается в корне репозитория aeroopt-site
и автоматически становится доступен через GitHub Pages.
"""

import argparse
import hashlib
import hmac
import json
import sys

# ============================================================
# ТОТ ЖЕ КЛЮЧ, ЧТО ОБФУСЦИРОВАН В license_checker.py
# ============================================================
# Если меняете ключ здесь — ОБЯЗАТЕЛЬНО обновите hex-строку
# в license_checker.py → _decode_hmac_key().
#
# Текущий ключ (47 байт):
HMAC_KEY = b"AeroOpt2026_License_HMAC_SecretKey_Verification"
# ============================================================


def compute_signature(key: str, product: str, expires: str,
                      max_hwids: int, hwids: list, features: list) -> str:
    """Вычисляет HMAC-SHA256 подпись для записи лицензии.

    Формат сообщения: KEY|PRODUCT|EXPIRES|MAX_HWIDS|HWIDS_SORTED|FEATURES_SORTED
    """
    msg = "|".join([
        key,
        product,
        expires,
        str(max_hwids),
        ",".join(sorted(hwids)),
        ",".join(sorted(features)),
    ])
    return hmac.new(HMAC_KEY, msg.encode("utf-8"), hashlib.sha256).hexdigest()


def generate_entry(key: str, product: str, expires: str,
                   max_hwids: int, features: list,
                   hwids: list = None) -> dict:
    """Генерирует запись лицензии с HMAC-подписью."""
    if hwids is None:
        hwids = []

    sig = compute_signature(key, product, expires, max_hwids, hwids, features)

    return {
        key: {
            "product": product,
            "expires": expires,
            "max_hwids": max_hwids,
            "hwids": hwids,
            "features": features,
            "signature": sig,
        }
    }


def main():
    parser = argparse.ArgumentParser(
        description="Генератор лицензий AeroOpt для GitHub Pages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Примеры:
  # Новая лицензия
  python generate_license.py \\
    --key AERO-PROD-2026-ABCD \\
    --product "AeroOpt Pro" \\
    --expires 2027-12-31 \\
    --features basic,optimization,rans

  # Привязать к конкретной машине (HWID из лога приложения)
  python generate_license.py \\
    --key AERO-PROD-2026-ABCD \\
    --expires 2027-12-31 \\
    --hwids "abc123def456"

  # Добавить HWID к существующей лицензии
  python generate_license.py \\
    --key AERO-PROD-2026-ABCD \\
    --expires 2027-12-31 \\
    --hwids "abc123,def456"
        """,
    )
    parser.add_argument(
        "--key", required=True,
        help="Лицензионный ключ (напр. AERO-XXXX-XXXX-XXXX)",
    )
    parser.add_argument(
        "--product", default="AeroOpt Pro",
        help="Название продукта (по умолчанию: AeroOpt Pro)",
    )
    parser.add_argument(
        "--expires", required=True,
        help="Дата окончания в формате YYYY-MM-DD",
    )
    parser.add_argument(
        "--max-hwids", type=int, default=2,
        help="Максимальное количество привязок к машинам (по умолчанию: 2)",
    )
    parser.add_argument(
        "--features", default="basic,optimization,rans",
        help="Фичи через запятую (по умолчанию: basic,optimization,rans)",
    )
    parser.add_argument(
        "--hwids", default="",
        help="HWID через запятую (пусто = любой; первый активировавший займёт)",
    )

    args = parser.parse_args()

    features = [f.strip() for f in args.features.split(",") if f.strip()]
    hwids = (
        [h.strip() for h in args.hwids.split(",") if h.strip()]
        if args.hwids else []
    )

    entry = generate_entry(
        key=args.key.upper(),
        product=args.product,
        expires=args.expires,
        max_hwids=args.max_hwids,
        features=features,
        hwids=hwids,
    )

    print("\n" + "=" * 60)
    print("  ЗАПИСЬ ЛИЦЕНЗИИ (вставьте в licenses.json)")
    print("=" * 60)
    print(json.dumps(entry, indent=2, ensure_ascii=False))

    print("\n" + "=" * 60)
    print("  ПОЛНЫЙ licenses.json (если это первая лицензия)")
    print("=" * 60)
    full = {
        "version": 1,
        "updated": "2026-08-27",
        "licenses": entry,
    }
    print(json.dumps(full, indent=2, ensure_ascii=False))

    print("\n" + "=" * 60)
    print("  ИНСТРУКЦИЯ")
    print("=" * 60)
    print("""
1. Скопируйте запись выше в файл licenses.json в репозитории
   Bergaff/aeroopt-site (в корень, рядом с index.html).

2. Если licenses.json уже есть — добавьте запись внутрь объекта
   "licenses": { ... }.

3. Закоммитьте и запушьте:
   git add licenses.json
   git commit -m "Add license: {key}"
   git push

4. GitHub Pages обновится автоматически (обычно 1-2 минуты).

5. Проверьте доступность:
   curl https://bergaff.github.io/aeroopt-site/licenses.json
""".format(key=args.key.upper()))


if __name__ == "__main__":
    main()
