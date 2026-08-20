"use client";

/**
 * NetSpec landing page — Astra Security visual language (ported from the design template).
 * Self-contained: the template CSS lives in a scoped <style> block (only mounted while
 * this page is shown), and the score-dial animations run in useEffect. CTA buttons call
 * onEnter to switch into the actual app.
 */

import { useEffect, useRef } from "react";

const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;700;900&family=Space+Grotesk:wght@500;600;700&display=swap');

.ns-land{
  --ink:#0F1318;--ink-2:#161C23;--ink-3:#1F262E;
  --paper:#F3F5EF;--card:#FFFFFF;
  --accent:#C5F23C;--accent-deep:#A6DC1B;--accent-soft:#EBF8C8;
  --violet:#6B5CF0;--violet-soft:#ECEAFB;
  --text:#10151B;--muted:#6E7882;--muted-2:#9AA3AD;
  --line:#E7E9E1;--line-d:#262D36;
  --amber:#E0982E;--amber-soft:#FBF1DE;--red:#E5604D;--red-soft:#FBE7E3;
  --radius:20px;--sh:0 1px 2px rgba(16,21,27,.05),0 18px 44px -22px rgba(16,21,27,.28);
  font-family:"Plus Jakarta Sans","Noto Sans TC",system-ui,sans-serif;background:var(--paper);
  color:var(--text);-webkit-font-smoothing:antialiased;letter-spacing:-.01em;line-height:1.5;
  min-height:100vh;overflow-y:auto;
}
.ns-land *{box-sizing:border-box;margin:0;padding:0}
.ns-land .num{font-family:"Space Grotesk","Plus Jakarta Sans",sans-serif;font-feature-settings:"tnum"}
.ns-land a{color:inherit;text-decoration:none}
.ns-land .wrap{max-width:1140px;margin:0 auto;padding:0 28px}

/* nav */
.ns-land nav.bar{position:sticky;top:0;z-index:30;background:rgba(15,19,24,.72);backdrop-filter:blur(12px);
  border-bottom:1px solid rgba(255,255,255,.07)}
.ns-land .bar-in{display:flex;align-items:center;gap:28px;height:66px}
.ns-land .logo{display:flex;align-items:center;gap:11px;color:#fff}
.ns-land .logo .mark{width:34px;height:34px;border-radius:10px;background:var(--accent);color:#0F1318;display:grid;
  place-items:center;font-weight:800;font-size:14px;font-family:"Space Grotesk",sans-serif;letter-spacing:-.04em;
  box-shadow:0 6px 18px -6px rgba(197,242,60,.6)}
.ns-land .logo b{font-size:17px;font-weight:800;letter-spacing:-.02em}
.ns-land .links{display:flex;gap:6px;margin-left:8px}
.ns-land .links a{color:#AEB6BF;font-size:14px;font-weight:600;padding:8px 13px;border-radius:9px;transition:.15s}
.ns-land .links a:hover{color:#fff;background:rgba(255,255,255,.06)}
.ns-land .bar-cta{margin-left:auto;display:flex;align-items:center;gap:14px}
.ns-land .bar-cta .signin{color:#C4CCD4;font-size:14px;font-weight:700;cursor:pointer}
.ns-land .bar-cta .signin:hover{color:#fff}
.ns-land .btn{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:14px;border:0;cursor:pointer;
  font-family:inherit;border-radius:11px;transition:.16s;white-space:nowrap}
.ns-land .btn svg{width:16px;height:16px}
.ns-land .btn.lime{background:var(--accent);color:#0F1318;padding:11px 18px;box-shadow:0 10px 24px -12px rgba(166,220,27,.7)}
.ns-land .btn.lime:hover{background:var(--accent-deep);transform:translateY(-1px)}
.ns-land .btn.ghost-d{background:rgba(255,255,255,.06);color:#fff;padding:11px 18px;border:1px solid rgba(255,255,255,.14)}
.ns-land .btn.ghost-d:hover{background:rgba(255,255,255,.12)}
.ns-land .btn.lg{padding:15px 26px;font-size:15px;border-radius:13px}

/* hero */
.ns-land .hero{background:var(--ink);color:#fff;position:relative;overflow:hidden}
.ns-land .hero svg.topo{position:absolute;inset:0;width:100%;height:100%;opacity:.5}
.ns-land .hero::before{content:"";position:absolute;width:680px;height:680px;left:-160px;top:-260px;border-radius:50%;
  background:radial-gradient(circle,rgba(197,242,60,.16),transparent 62%);filter:blur(8px)}
.ns-land .hero::after{content:"";position:absolute;width:520px;height:520px;right:-120px;bottom:-220px;border-radius:50%;
  background:radial-gradient(circle,rgba(107,92,240,.22),transparent 64%)}
.ns-land .hero-in{position:relative;z-index:2;display:grid;grid-template-columns:1.05fr .95fr;gap:48px;
  align-items:center;padding:78px 0 92px}
.ns-land .eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:12.5px;font-weight:700;color:var(--accent);
  background:rgba(197,242,60,.10);border:1px solid rgba(197,242,60,.25);padding:7px 14px;border-radius:999px;
  letter-spacing:.02em}
.ns-land .eyebrow .d{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent)}
.ns-land h1.hero-h{font-size:52px;line-height:1.08;font-weight:800;letter-spacing:-.035em;margin:22px 0 0}
.ns-land h1.hero-h .hl{color:var(--accent)}
.ns-land .hero-sub{font-size:17px;line-height:1.7;color:#B6BEC7;margin-top:20px;max-width:520px;font-weight:500}
.ns-land .hero-sub b{color:#EDF0F3;font-weight:700}
.ns-land .hero-cta{display:flex;gap:13px;margin-top:30px;flex-wrap:wrap}
.ns-land .hero-trust{display:flex;align-items:center;gap:10px;margin-top:34px;flex-wrap:wrap}
.ns-land .hero-trust .tt{font-size:12px;color:#828B95;font-weight:600;margin-right:2px}
.ns-land .ptag{font-family:"Space Grotesk",sans-serif;font-size:12px;font-weight:700;color:#C4CCD4;
  border:1px solid rgba(255,255,255,.13);padding:5px 11px;border-radius:8px}

/* hero demo card */
.ns-land .demo{background:#FBFCF8;border-radius:22px;box-shadow:0 40px 90px -40px rgba(0,0,0,.6);
  border:1px solid rgba(255,255,255,.5);overflow:hidden;color:var(--text)}
.ns-land .demo-bar{display:flex;align-items:center;gap:7px;padding:13px 16px;border-bottom:1px solid var(--line);background:#fff}
.ns-land .demo-bar .tl{width:10px;height:10px;border-radius:50%;background:#E2E5DC}
.ns-land .demo-bar .tl.g{background:var(--accent)}
.ns-land .demo-bar small{margin-left:8px;color:var(--muted-2);font-size:12px;font-weight:600}
.ns-land .demo-body{padding:18px}
.ns-land .prompt{display:flex;gap:10px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:13px 14px;
  font-size:13.5px;font-weight:500;color:#2B333C;line-height:1.5}
.ns-land .prompt .who{font-size:11px;font-weight:800;color:var(--violet);background:var(--violet-soft);padding:3px 8px;
  border-radius:6px;height:fit-content;white-space:nowrap}
.ns-land .flow{display:flex;align-items:center;gap:8px;justify-content:center;margin:13px 0;color:var(--muted);
  font-size:11.5px;font-weight:700}
.ns-land .flow .ln{height:1px;flex:1;background:linear-gradient(90deg,transparent,var(--line),transparent)}
.ns-land .flow .b{display:inline-flex;align-items:center;gap:6px;background:var(--accent-soft);color:var(--accent-deep);
  border:1px solid #DCEFA9;padding:4px 11px;border-radius:999px}
.ns-land .flow .b .sp{width:7px;height:7px;border-radius:50%;background:var(--accent-deep);animation:nsPulse 1.4s infinite}
@keyframes nsPulse{0%,100%{opacity:.4}50%{opacity:1}}
.ns-land .specout{background:#fff;border:1px solid var(--line);border-radius:14px;padding:15px 16px;display:flex;gap:14px;
  align-items:center}
.ns-land .specout .so-l{flex:1;min-width:0}
.ns-land .so-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ns-land .so-title b{font-size:15px;font-weight:800}
.ns-land .so-title .risk{font-size:10px;font-weight:800;color:#C4452F;background:var(--red-soft);border:1px solid #F4CFC8;
  padding:3px 8px;border-radius:999px;letter-spacing:.03em}
.ns-land .so-rows{margin-top:11px;display:flex;flex-direction:column;gap:7px}
.ns-land .so-rows .r{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--muted);font-weight:600}
.ns-land .so-rows .r .id{font-family:"Space Grotesk",sans-serif;font-size:10.5px;font-weight:700;color:var(--violet);
  background:var(--violet-soft);padding:2px 7px;border-radius:6px}
.ns-land .so-rows .r.done .id{color:var(--accent-deep);background:var(--accent-soft)}
.ns-land .dial{position:relative;width:96px;height:96px;flex:none}
.ns-land .dial svg{transform:rotate(-90deg)}
.ns-land .dial .v{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.ns-land .dial .v .n{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:30px;line-height:1}
.ns-land .dial .v .l{font-size:9.5px;font-weight:700;color:var(--muted-2);letter-spacing:.1em;margin-top:2px}

/* marquee */
.ns-land .marq{background:var(--ink-2);border-top:1px solid var(--line-d);border-bottom:1px solid var(--line-d);
  padding:18px 0;overflow:hidden;white-space:nowrap}
.ns-land .marq .track{display:inline-flex;gap:40px;animation:nsScroll 26s linear infinite;will-change:transform}
.ns-land .marq span{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:15px;color:#6B7580;letter-spacing:.02em}
.ns-land .marq span em{color:var(--accent);font-style:normal}
@keyframes nsScroll{to{transform:translateX(-50%)}}

/* section frame */
.ns-land section.s{padding:88px 0}
.ns-land .s-head{max-width:680px;margin-bottom:46px}
.ns-land .s-eyebrow{font-size:12.5px;font-weight:800;color:var(--accent-deep);letter-spacing:.1em;text-transform:uppercase;
  display:flex;align-items:center;gap:9px}
.ns-land .s-eyebrow::before{content:"";width:22px;height:2px;background:var(--accent-deep);border-radius:2px}
.ns-land .s-head h2{font-size:36px;font-weight:800;letter-spacing:-.03em;margin:16px 0 0;line-height:1.15}
.ns-land .s-head p{font-size:16px;color:var(--muted);margin-top:14px;font-weight:500;line-height:1.65}

/* how it works */
.ns-land .phases{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.ns-land .phase{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:26px;
  position:relative;overflow:hidden;transition:.2s}
.ns-land .phase:hover{transform:translateY(-3px);box-shadow:var(--sh)}
.ns-land .phase .pn{font-family:"Space Grotesk",sans-serif;font-size:13px;font-weight:700;color:var(--accent-deep);
  background:var(--accent-soft);width:fit-content;padding:5px 11px;border-radius:8px;letter-spacing:.04em}
.ns-land .phase h3{font-size:19px;font-weight:800;margin:16px 0 9px;letter-spacing:-.02em}
.ns-land .phase p{font-size:14px;color:var(--muted);font-weight:500;line-height:1.65}
.ns-land .phase .ar{position:absolute;right:20px;top:24px;font-family:"Space Grotesk",sans-serif;font-size:46px;
  font-weight:700;color:#EEF1E8;line-height:1}

/* features */
.ns-land .feat{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
.ns-land .fcard{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:28px;
  display:flex;gap:18px;transition:.2s}
.ns-land .fcard:hover{border-color:#D6E4A8;box-shadow:var(--sh)}
.ns-land .fcard .ic{width:46px;height:46px;border-radius:13px;flex:none;display:grid;place-items:center;
  background:var(--ink);color:var(--accent)}
.ns-land .fcard .ic svg{width:22px;height:22px}
.ns-land .fcard.violet .ic{background:var(--violet-soft);color:var(--violet)}
.ns-land .fcard h3{font-size:17px;font-weight:800;letter-spacing:-.02em}
.ns-land .fcard p{font-size:14px;color:var(--muted);margin-top:7px;font-weight:500;line-height:1.65}

/* examples */
.ns-land .ex-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.ns-land .exc{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:24px;transition:.2s;cursor:pointer}
.ns-land .exc:hover{transform:translateY(-3px);box-shadow:var(--sh);border-color:#D6E4A8}
.ns-land .exc-top{display:flex;align-items:center;justify-content:space-between}
.ns-land .exc .ico{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:var(--violet-soft);
  color:var(--violet)}
.ns-land .exc .ico svg{width:20px;height:20px}
.ns-land .ring{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;position:relative;flex:none}
.ns-land .ring::before{content:"";position:absolute;inset:0;border-radius:50%;
  background:conic-gradient(var(--accent-deep) calc(var(--p)*1%),transparent 0)}
.ns-land .ring::after{content:"";position:absolute;inset:3.5px;border-radius:50%;background:var(--card)}
.ns-land .ring i{position:relative;z-index:1;font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:14px;font-style:normal}
.ns-land .exc h3{font-size:18px;font-weight:800;margin:18px 0 6px;letter-spacing:-.02em}
.ns-land .exc p{font-size:13.5px;color:var(--muted);font-weight:500;line-height:1.6}
.ns-land .exc .ftr{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted-2);
  font-weight:600;display:flex;align-items:center;gap:7px}
.ns-land .exc .ftr .g{color:var(--accent-deep);font-weight:700}

/* scoring spotlight */
.ns-land .score-band{background:var(--card);border:1px solid var(--line);border-radius:28px;box-shadow:var(--sh);
  display:grid;grid-template-columns:300px 1fr;gap:48px;padding:48px;align-items:center}
.ns-land .bigdial{position:relative;width:240px;height:240px;margin:0 auto}
.ns-land .bigdial svg{transform:rotate(-90deg)}
.ns-land .bigdial .c{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.ns-land .bigdial .c .n{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:72px;line-height:1}
.ns-land .bigdial .c .l{font-size:12px;font-weight:700;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}
.ns-land .breakdown{display:flex;flex-direction:column;gap:18px}
.ns-land .bd-row .bd-h{display:flex;justify-content:space-between;font-size:14px;font-weight:700;margin-bottom:8px}
.ns-land .bd-row .bd-h .pct{font-family:"Space Grotesk",sans-serif;color:var(--accent-deep)}
.ns-land .bd-track{height:8px;border-radius:8px;background:#EEF1E8;overflow:hidden}
.ns-land .bd-track i{display:block;height:100%;border-radius:8px;background:linear-gradient(90deg,var(--accent),var(--accent-deep));
  width:0;transition:width 1.1s cubic-bezier(.2,.7,.2,1)}

/* stats */
.ns-land .stats{background:var(--ink);color:#fff;border-radius:28px;padding:52px;display:grid;
  grid-template-columns:repeat(4,1fr);gap:32px;position:relative;overflow:hidden}
.ns-land .stats::after{content:"";position:absolute;right:-80px;top:-80px;width:320px;height:320px;border-radius:50%;
  background:radial-gradient(circle,rgba(197,242,60,.14),transparent 65%)}
.ns-land .stat{position:relative;z-index:1}
.ns-land .stat .n{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:46px;letter-spacing:-.02em;color:var(--accent)}
.ns-land .stat .l{font-size:14px;color:#AEB6BF;font-weight:600;margin-top:6px}

/* final cta */
.ns-land .final{background:var(--ink);color:#fff;border-radius:28px;padding:62px;text-align:center;position:relative;
  overflow:hidden}
.ns-land .final::before{content:"";position:absolute;inset:0;background:radial-gradient(540px 240px at 50% -20%,
  rgba(197,242,60,.18),transparent 70%)}
.ns-land .final h2{position:relative;font-size:38px;font-weight:800;letter-spacing:-.03em;line-height:1.18}
.ns-land .final h2 .hl{color:var(--accent)}
.ns-land .final p{position:relative;color:#B6BEC7;font-size:16px;margin-top:14px;font-weight:500}
.ns-land .final .fc{position:relative;display:flex;gap:13px;justify-content:center;margin-top:28px;flex-wrap:wrap}

/* footer */
.ns-land footer{padding:54px 0 40px}
.ns-land .foot{display:flex;justify-content:space-between;align-items:flex-start;gap:30px;flex-wrap:wrap}
.ns-land .foot .logo{color:var(--text)}
.ns-land .foot .logo .mark{box-shadow:none}
.ns-land .foot .fdesc{font-size:13.5px;color:var(--muted);max-width:280px;margin-top:14px;font-weight:500;line-height:1.6}
.ns-land .fcols{display:flex;gap:56px;flex-wrap:wrap}
.ns-land .fcol h4{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2);margin-bottom:14px}
.ns-land .fcol a{display:block;font-size:14px;color:var(--muted);font-weight:600;padding:5px 0;transition:.15s}
.ns-land .fcol a:hover{color:var(--text)}
.ns-land .fbottom{margin-top:42px;padding-top:22px;border-top:1px solid var(--line);display:flex;justify-content:space-between;
  font-size:12.5px;color:var(--muted-2);font-weight:500;flex-wrap:wrap;gap:10px}

@media (max-width:920px){
  .ns-land .hero-in{grid-template-columns:1fr;gap:40px;padding:54px 0 64px}
  .ns-land h1.hero-h{font-size:38px}
  .ns-land .phases,.ns-land .feat,.ns-land .ex-grid{grid-template-columns:1fr}
  .ns-land .score-band{grid-template-columns:1fr;gap:32px;padding:32px;text-align:center}
  .ns-land .stats{grid-template-columns:repeat(2,1fr);gap:28px;padding:36px}
  .ns-land .links,.ns-land .bar-cta .signin{display:none}
  .ns-land section.s{padding:60px 0}
  .ns-land .s-head h2,.ns-land .final h2{font-size:28px}
}
@media (prefers-reduced-motion:reduce){.ns-land *{animation:none!important;transition:none!important}
  .ns-land .bd-track i{transition:none!important}}
`;

const BODY = `
<nav class="bar"><div class="wrap bar-in">
  <a class="logo"><span class="mark">NS</span><b>NetSpec</b></a>
  <div class="links">
    <a href="#ns-how">運作流程</a>
    <a href="#ns-features">功能</a>
    <a href="#ns-examples">範例</a>
    <a href="#ns-scoring">品質評分</a>
  </div>
  <div class="bar-cta">
    <a class="signin" data-enter>登入</a>
    <button class="btn lime" data-enter>開始生成
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
  </div>
</div></nav>

<header class="hero">
  <svg class="topo" viewBox="0 0 1200 560" preserveAspectRatio="xMidYMid slice" fill="none">
    <g stroke="#2A323B" stroke-width="1">
      <path d="M120 90 L320 200 L520 120 L760 240 L980 140 L1100 300"/>
      <path d="M120 90 L260 360 L520 120"/>
      <path d="M320 200 L460 430 L760 240"/>
      <path d="M760 240 L900 470 L980 140"/>
      <path d="M260 360 L460 430 L900 470"/>
    </g>
    <g fill="#3A434D">
      <circle cx="320" cy="200" r="4"/><circle cx="520" cy="120" r="4"/><circle cx="760" cy="240" r="4"/>
      <circle cx="260" cy="360" r="4"/><circle cx="460" cy="430" r="4"/><circle cx="900" cy="470" r="4"/>
      <circle cx="980" cy="140" r="4"/>
    </g>
    <g fill="#C5F23C"><circle cx="120" cy="90" r="5"/><circle cx="1100" cy="300" r="5"/></g>
  </svg>
  <div class="wrap hero-in">
    <div>
      <span class="eyebrow"><span class="d"></span>AI 驅動的網通規格平台</span>
      <h1 class="hero-h">一句話的需求，<br>生成<span class="hl">工程級</span>規格書。</h1>
      <p class="hero-sub">NetSpec 解析你的自然語言描述，自動產出涵蓋功能、非功能、邊界條件與風險的完整規格 — 並為<b>每一版打上品質分數</b>，讓迭代有依據。</p>
      <div class="hero-cta">
        <button class="btn lime lg" data-enter>免費開始生成
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
        <button class="btn ghost-d lg" data-enter>看範例規格</button>
      </div>
      <div class="hero-trust">
        <span class="tt">支援協定</span>
        <span class="ptag">BGP</span><span class="ptag">VLAN</span><span class="ptag">ACL</span>
        <span class="ptag">NAT</span><span class="ptag">OSPF</span><span class="ptag">HA</span>
      </div>
    </div>

    <div class="demo">
      <div class="demo-bar"><span class="tl g"></span><span class="tl"></span><span class="tl"></span>
        <small>netspec · 即時生成</small></div>
      <div class="demo-body">
        <div class="prompt"><span class="who">需求</span>公司想提供訪客專用的 WiFi，讓客戶能上網，但不能連到內部伺服器和員工電腦。</div>
        <div class="flow"><span class="ln"></span><span class="b"><span class="sp"></span>NetSpec 分析中</span><span class="ln"></span></div>
        <div class="specout">
          <div class="so-l">
            <div class="so-title"><b>訪客 WiFi 安全隔離</b><span class="risk">HIGH 風險</span></div>
            <div class="so-rows">
              <div class="r done"><span class="id">REQ-001</span>訪客 VLAN 隔離與雙棧防火牆</div>
              <div class="r done"><span class="id">REQ-002</span>NAT 狀態管理與洪泛防護</div>
              <div class="r"><span class="id">NFR-01</span>可用率 ≥ 99.99% / HA 故障轉移</div>
            </div>
          </div>
          <div class="dial">
            <svg width="96" height="96" viewBox="0 0 96 96">
              <circle cx="48" cy="48" r="40" stroke="#ECEFE6" stroke-width="9" fill="none"/>
              <circle id="ns-heroArc" cx="48" cy="48" r="40" stroke="#A6DC1B" stroke-width="9" fill="none"
                stroke-linecap="round" stroke-dasharray="251.2" stroke-dashoffset="251.2"/>
            </svg>
            <div class="v"><div class="n num" id="ns-heroNum">0</div><div class="l">品質分數</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</header>

<div class="marq"><div class="track">
  <span>VLAN 隔離 <em>·</em> Stateful Firewall <em>·</em> BGP 繞送 <em>·</em> ACL 規則 <em>·</em> NAT 狀態表 <em>·</em> SYN Cookie <em>·</em> DHCP 授權 <em>·</em> Active-Standby HA <em>·</em> IPv4/IPv6 雙棧 <em>·</em> Rate Limiting <em>·</em> OSPF 區域 <em>·</em> </span>
  <span>VLAN 隔離 <em>·</em> Stateful Firewall <em>·</em> BGP 繞送 <em>·</em> ACL 規則 <em>·</em> NAT 狀態表 <em>·</em> SYN Cookie <em>·</em> DHCP 授權 <em>·</em> Active-Standby HA <em>·</em> IPv4/IPv6 雙棧 <em>·</em> Rate Limiting <em>·</em> OSPF 區域 <em>·</em> </span>
</div></div>

<section class="s" id="ns-how"><div class="wrap">
  <div class="s-head">
    <div class="s-eyebrow">運作流程</div>
    <h2>三個階段，從一句話到可審閱的規格書。</h2>
    <p>NetSpec 把規格生成拆成清楚的三步，每一步你都看得見、改得動。</p>
  </div>
  <div class="phases">
    <div class="phase"><span class="ar num">01</span>
      <span class="pn">PHASE 1</span><h3>需求輸入</h3>
      <p>用自然語言描述需求，或直接從 Figma 解析畫面。系統即時估算規模並提示該補的細節。</p></div>
    <div class="phase"><span class="ar num">02</span>
      <span class="pn">PHASE 2</span><h3>分析</h3>
      <p>拆解需求、比對社群災情與最佳實務，標出中高風險邊界、依賴關係與不在範圍的項目。</p></div>
    <div class="phase"><span class="ar num">03</span>
      <span class="pn">PHASE 3</span><h3>規格輸出</h3>
      <p>生成 8 章節規格書 — 功能、非功能、邊界、驗證問題與引用來源，並打上品質分數。</p></div>
  </div>
</div></section>

<section class="s" id="ns-features" style="padding-top:0"><div class="wrap">
  <div class="s-head">
    <div class="s-eyebrow">核心功能</div>
    <h2>為網通團隊量身打造的規格引擎。</h2>
  </div>
  <div class="feat">
    <div class="fcard">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
      <div><h3>規格品質評分</h3><p>每一版規格自動評分（0–100），量化完整度與風險覆蓋。改了哪、進步多少，一目了然。</p></div>
    </div>
    <div class="fcard violet">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="8" r="3"/><path d="M4 20c0-3 2.5-5 5-5s5 2 5 5M14 20c0-2 1-3.5 3-4.2"/></svg></div>
      <div><h3>三種審閱視角</h3><p>同一份規格，一鍵切換 PM、架構師、QA 測試三種視圖，每個角色都只看到他在意的內容。</p></div>
    </div>
    <div class="fcard violet">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg></div>
      <div><h3>風險邊界內建</h3><p>自動標示中高風險邊界、不在範圍與依賴關係，把容易漏掉的安全缺口先攤在桌上。</p></div>
    </div>
    <div class="fcard">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></div>
      <div><h3>一鍵匯出與交付</h3><p>中／英切換、精簡檢視、列印與匯出 Markdown — 規格寫完直接進你現有的工作流程。</p></div>
    </div>
  </div>
</div></section>

<section class="s" id="ns-examples" style="padding-top:0"><div class="wrap">
  <div class="s-head">
    <div class="s-eyebrow">範例規格</div>
    <h2>常見的網通主題，幾分鐘就有底稿。</h2>
    <p>從這些起點出發，或描述你自己的需求 — 分數越高，代表規格越完整、風險覆蓋越足。</p>
  </div>
  <div class="ex-grid">
    <div class="exc" data-enter>
      <div class="exc-top">
        <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h6a3 3 0 013 3v6"/></svg></div>
        <div class="ring" style="--p:87"><i class="num">87</i></div>
      </div>
      <h3>BGP 路由</h3><p>跨自治系統繞送、路由策略與收斂行為設計。</p>
      <div class="ftr"><span class="g">8 章節</span>· 含風險邊界與驗證問題</div>
    </div>
    <div class="exc" data-enter>
      <div class="exc-top">
        <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/></svg></div>
        <div class="ring" style="--p:84"><i class="num">84</i></div>
      </div>
      <h3>防火牆規則</h3><p>存取控制、狀態化過濾與規則載入原子性保障。</p>
      <div class="ftr"><span class="g">8 章節</span>· 含風險邊界與驗證問題</div>
    </div>
    <div class="exc" data-enter>
      <div class="exc-top">
        <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="15" width="18" height="5" rx="1"/><path d="M8 9v6"/></svg></div>
        <div class="ring" style="--p:95"><i class="num">95</i></div>
      </div>
      <h3>VLAN 切割</h3><p>網段隔離、雙棧設計與 Guest Zone 邊界規劃。</p>
      <div class="ftr"><span class="g">8 章節</span>· 含風險邊界與驗證問題</div>
    </div>
  </div>
</div></section>

<section class="s" id="ns-scoring" style="padding-top:0"><div class="wrap">
  <div class="s-head">
    <div class="s-eyebrow">招牌功能 · 品質評分</div>
    <h2>每一份規格，都有一個分數。</h2>
    <p>NetSpec 用 0–100 分衡量規格的可交付程度。分數拆成四個面向，讓你知道下一步該補什麼。</p>
  </div>
  <div class="score-band" id="ns-scoreBand">
    <div class="bigdial">
      <svg width="240" height="240" viewBox="0 0 240 240">
        <circle cx="120" cy="120" r="100" stroke="#EEF1E8" stroke-width="18" fill="none"/>
        <circle id="ns-bigArc" cx="120" cy="120" r="100" stroke="#A6DC1B" stroke-width="18" fill="none"
          stroke-linecap="round" stroke-dasharray="628.3" stroke-dashoffset="628.3"/>
      </svg>
      <div class="c"><div class="n num" id="ns-bigNum">0</div><div class="l">品質分數</div></div>
    </div>
    <div class="breakdown">
      <div class="bd-row"><div class="bd-h"><span>完整度 · 章節是否齊備</span><span class="pct">88%</span></div>
        <div class="bd-track"><i data-w="88"></i></div></div>
      <div class="bd-row"><div class="bd-h"><span>風險覆蓋 · 邊界與例外</span><span class="pct">74%</span></div>
        <div class="bd-track"><i data-w="74"></i></div></div>
      <div class="bd-row"><div class="bd-h"><span>可驗證性 · 驗收標準明確</span><span class="pct">80%</span></div>
        <div class="bd-track"><i data-w="80"></i></div></div>
      <div class="bd-row"><div class="bd-h"><span>一致性 · 三視角不衝突</span><span class="pct">86%</span></div>
        <div class="bd-track"><i data-w="86"></i></div></div>
    </div>
  </div>
</div></section>

<section class="s" style="padding-top:0"><div class="wrap">
  <div class="stats">
    <div class="stat"><div class="n num">8</div><div class="l">章節結構 / 規格</div></div>
    <div class="stat"><div class="n num">3</div><div class="l">審閱視角（PM / 架構師 / QA）</div></div>
    <div class="stat"><div class="n num">100</div><div class="l">分制品質評分</div></div>
    <div class="stat"><div class="n num">分鐘級</div><div class="l">從需求到規格書</div></div>
  </div>
</div></section>

<section class="s" style="padding-top:0"><div class="wrap">
  <div class="final">
    <h2>把下一個網通需求，<span class="hl">寫成規格</span>。</h2>
    <p>描述一句話，剩下的交給 NetSpec。</p>
    <div class="fc">
      <button class="btn lime lg" data-enter>免費開始生成
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
      <button class="btn ghost-d lg" data-enter>預約導覽</button>
    </div>
  </div>
</div></section>

<footer><div class="wrap">
  <div class="foot">
    <div>
      <a class="logo"><span class="mark">NS</span><b>NetSpec</b></a>
      <p class="fdesc">把自然語言的網通需求，變成可評分、可審閱、可交付的工程規格書。</p>
    </div>
    <div class="fcols">
      <div class="fcol"><h4>產品</h4><a href="#ns-how">運作流程</a><a href="#ns-features">功能</a><a href="#ns-scoring">品質評分</a><a data-enter>Figma 分析</a></div>
      <div class="fcol"><h4>範例</h4><a href="#ns-examples">BGP 路由</a><a href="#ns-examples">防火牆</a><a href="#ns-examples">VLAN 切割</a></div>
      <div class="fcol"><h4>公司</h4><a>關於</a><a>文件</a><a>聯絡我們</a></div>
    </div>
  </div>
  <div class="fbottom">
    <span>© 2026 NetSpec · 網通規格生成平台</span>
    <span>隱私權政策 · 服務條款</span>
  </div>
</div></footer>
`;

export default function LandingPage({ onEnter }: { onEnter?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const C = 2 * Math.PI * 40, CB = 2 * Math.PI * 100;

    const animScore = (arcEl: any, numEl: any, target: number, circ: number, dur: number) => {
      if (!arcEl || !numEl) return;
      if (reduce) { arcEl.style.strokeDashoffset = String(circ * (1 - target / 100)); numEl.textContent = String(target); return; }
      let t0: number | null = null;
      const step = (ts: number) => {
        if (t0 === null) t0 = ts;
        const p = Math.min((ts - t0) / dur, 1);
        const e = 1 - Math.pow(1 - p, 3);
        arcEl.style.strokeDashoffset = String(circ * (1 - (target / 100) * e));
        numEl.textContent = String(Math.round(target * e));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    // hero dial
    const heroTimer = setTimeout(() => {
      animScore(root.querySelector("#ns-heroArc"), root.querySelector("#ns-heroNum"), 82, C, 1400);
    }, 350);

    // scoring band + bars on scroll-in
    const band = root.querySelector("#ns-scoreBand");
    let fired = false;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting && !fired) {
          fired = true;
          animScore(root.querySelector("#ns-bigArc"), root.querySelector("#ns-bigNum"), 82, CB, 1500);
          root.querySelectorAll<HTMLElement>(".bd-track i").forEach((i) => {
            i.style.width = (i.getAttribute("data-w") || "0") + "%";
          });
        }
      });
    }, { threshold: 0.4 });
    if (band) io.observe(band);

    // wire all CTAs (data-enter) to enter the app
    const enter = (e: Event) => { e.preventDefault(); onEnter?.(); };
    const ctas = Array.from(root.querySelectorAll<HTMLElement>("[data-enter]"));
    ctas.forEach((el) => el.addEventListener("click", enter));

    return () => {
      clearTimeout(heroTimer);
      io.disconnect();
      ctas.forEach((el) => el.removeEventListener("click", enter));
    };
  }, [onEnter]);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-enter]")) {
      e.preventDefault();
      onEnter?.();
    }
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      <div ref={ref} className="ns-land" dangerouslySetInnerHTML={{ __html: BODY }} onClick={handleClick} />
    </>
  );
}
