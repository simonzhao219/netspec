"""Demo 生成腳本 v2 — 輪詢方式，不依賴 SSE 串流"""
import urllib.request, urllib.error, json, time, sys

BASE = "http://localhost:8000/api"

DEMOS = [
    {
        "name": "VLAN 管理功能",
        "requirement": (
            "需要在企業核心交換器上實作完整的 VLAN 管理功能，"
            "支援 VLAN 的新增、編輯與刪除（ID 範圍 1-4094），"
            "支援 trunk 與 access port 模式切換，"
            "需考慮與 STP 802.1D/802.1w 配置的相容性，"
            "設備為 Broadcom SONiC 4.x。"
        ),
    },
    {
        "name": "BGP 路由備援機制",
        "requirement": (
            "設計 BGP 雙線路由備援機制，主線故障時需在 500ms 內切換，"
            "支援 AS-PATH 過濾與 route-map 策略，避免路由抖動，"
            "符合 RFC 4271，運行於 FRRouting 9.x on Ubuntu 22.04。"
        ),
    },
]

def post(path, data=None):
    body = json.dumps(data).encode() if data else b""
    req = urllib.request.Request(
        BASE + path, data=body,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read())

def run_demo(demo):
    name = demo["name"]
    req  = demo["requirement"]
    print(f"\n{'='*55}\n🚀 {name}\n{'='*55}", flush=True)

    # Create session
    code, s = post("/sessions")
    sid = s["session_id"]
    print(f"   Session: {sid[:8]}...", flush=True)

    # Start pipeline
    code, r = post(f"/sessions/{sid}/start", {"requirement": req})
    if code != 200:
        print(f"   ❌ Start failed: {code}", flush=True)
        return False
    print("   ✅ Pipeline 啟動", flush=True)

    # Poll session status
    prev_step = 0
    socratic_handled = False
    plan_handled = False
    timeout = time.time() + 600  # 10 min max

    while time.time() < timeout:
        time.sleep(3)
        try:
            sess = get(f"/sessions/{sid}")
        except Exception as e:
            print(f"   ⚠ Poll error: {e}", flush=True)
            continue

        status = sess.get("status", "")
        itype  = sess.get("interrupt_type")

        # Step progress from iterations
        iters = sess.get("iterations", [])
        if iters and not status == "complete":
            sys.stdout.write(".")
            sys.stdout.flush()

        if itype == "socratic" and not socratic_handled:
            print(f"\n   ⏭ Socratic → 自動跳過", flush=True)
            post(f"/sessions/{sid}/resume", {"answers": {"__skip__": True}})
            socratic_handled = True

        elif itype == "plan_confirm" and not plan_handled:
            idata = sess.get("interrupt_data", {})
            plan  = idata.get("plan", []) if idata else []
            print(f"\n   📋 搜尋計畫 {len(plan)} 組 → 自動確認", flush=True)
            for q in plan[:3]:
                print(f"      [{q.get('source','?').upper()}] {q.get('keyword','')}", flush=True)
            post(f"/sessions/{sid}/resume", {"confirmed": True})
            plan_handled = True

        elif status == "complete":
            result = sess.get("result", {})
            score  = result.get("validation_score", 0)
            fname  = result.get("spec_sections", {}).get("feature_name", name)
            print(f"\n   🎉 完成！{fname}  品質：{score}/100", flush=True)
            return True

        elif status == "error":
            err = sess.get("error", "unknown")
            print(f"\n   ❌ Error: {err[:80]}", flush=True)
            return False

    print("\n   ⏰ Timeout", flush=True)
    return False


if __name__ == "__main__":
    print("NetSpec Demo 生成器 v2（輪詢模式）", flush=True)
    ok = 0
    for i, demo in enumerate(DEMOS, 1):
        print(f"\n[{i}/{len(DEMOS)}] {demo['name']}", flush=True)
        if run_demo(demo):
            ok += 1
        if i < len(DEMOS):
            print("\n   ⏳ 等待 3 秒...", flush=True)
            time.sleep(3)

    print(f"\n{'='*55}")
    print(f"完成！成功 {ok}/{len(DEMOS)} 筆")
    print("請到 http://localhost:3000 左側欄「歷史記錄」載入")
    print("="*55, flush=True)
