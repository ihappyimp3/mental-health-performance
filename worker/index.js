// 정신건강사업 실적판 — Cloudflare Worker
// - 팀 비밀번호(APP_PASSCODE, Worker 비밀값)로 로그인해야 화면과 데이터에 접근할 수 있습니다.
// - 비밀번호가 설정되지 않았으면 아무것도 보여주지 않습니다(fail closed).
// - 데이터는 Cloudflare D1(binding: DB)에 저장합니다.

const DOC_KEYS = ["main", "district", "dept", "budget", "audit", "health", "center", "child", "youth", "rights"];
const COOKIE = "mh_s";
const SESSION_DAYS = 14;

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};

export default {
  async fetch(request, env) {
    try {
      return withHeaders(await route(request, env));
    } catch (err) {
      console.error(err);
      return withHeaders(json({ error: "서버 오류가 발생했습니다." }, 500));
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 로그인 화면용 파일만 로그인 없이 제공 (데이터 없음)
  if ((path === "/login.css" || path === "/login.js") && request.method === "GET") return env.ASSETS.fetch(request);

  if (!env.APP_PASSCODE || env.APP_PASSCODE.length < 8) {
    return html(setupPage(), 503);
  }

  if (path === "/api/login" && request.method === "POST") return login(request, env);
  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  const authed = await verifySession(request, env);
  if (!authed) {
    if (path.startsWith("/api/")) return json({ error: "로그인이 필요합니다." }, 401);
    return html(loginPage(), 200);
  }

  if (path.startsWith("/api/")) {
    if (request.method !== "GET" && !sameOrigin(request, url)) return json({ error: "허용되지 않은 요청입니다." }, 403);
    return api(request, env, url);
  }
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  return out;
}

/* ---------------- 인증 ---------------- */
async function login(request, env) {
  if (!sameOrigin(request, new URL(request.url))) return json({ error: "허용되지 않은 요청입니다." }, 403);
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const ok = await safeEqual(String(body.passcode || ""), env.APP_PASSCODE);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // 무차별 대입 속도 늦추기
    return json({ error: "비밀번호가 맞지 않습니다." }, 401);
  }
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = await hmac(env.APP_PASSCODE, String(exp));
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

async function verifySession(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > Date.now())) return false;
  return safeEqual(m[2], await hmac(env.APP_PASSCODE, String(exp)));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("mh-session:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin";
}

/* ---------------- API ---------------- */
async function api(request, env, url) {
  const db = env.DB;
  const m = request.method;
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

  // GET /api/data?year=2026
  if (parts[0] === "data" && m === "GET") {
    const year = toYear(url.searchParams.get("year"));
    if (!year) return json({ error: "연도가 올바르지 않습니다." }, 400);
    const [plans, records, years] = await Promise.all([
      db.prepare("SELECT * FROM plans WHERE year = ? ORDER BY doc, ord, name").bind(year).all(),
      db.prepare("SELECT r.* FROM records r JOIN plans p ON p.id = r.plan_id WHERE p.year = ? ORDER BY r.date DESC, r.created_at DESC").bind(year).all(),
      db.prepare("SELECT DISTINCT year FROM plans").all(),
    ]);
    return json({ plans: plans.results.map(planOut), records: records.results.map(recOut), years: years.results.map((r) => r.year) });
  }

  // POST /api/plans
  if (parts[0] === "plans" && parts.length === 1 && m === "POST") {
    const b = await body(request);
    const p = cleanPlan(b);
    if (p.error) return json({ error: p.error }, 400);
    const year = toYear(b.year);
    if (!year) return json({ error: "연도가 올바르지 않습니다." }, 400);
    const dup = await db.prepare("SELECT id FROM plans WHERE year=? AND doc=? AND lower(replace(name,' ',''))=lower(replace(?,' ',''))").bind(year, p.doc, p.name).first();
    if (dup) return json({ error: "이 계획서에 같은 이름의 지표가 이미 있습니다." }, 409);
    const ord = (await db.prepare("SELECT COALESCE(MAX(ord),-1)+1 AS n FROM plans WHERE year=? AND doc=?").bind(year, p.doc).first()).n;
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO plans (id,year,doc,name,calc,owner,target,unit,ord,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, year, p.doc, p.name, p.calc, p.owner, p.target, p.unit, ord, now()).run();
    return json({ id }, 201);
  }

  // PUT / DELETE /api/plans/:id
  if (parts[0] === "plans" && parts.length === 2 && parts[1] !== "copy") {
    const id = parts[1];
    if (m === "PUT") {
      const p = cleanPlan(await body(request));
      if (p.error) return json({ error: p.error }, 400);
      const r = await db.prepare("UPDATE plans SET doc=?, name=?, calc=?, owner=?, target=?, unit=? WHERE id=?")
        .bind(p.doc, p.name, p.calc, p.owner, p.target, p.unit, id).run();
      return r.meta.changes ? json({ ok: true }) : json({ error: "지표를 찾을 수 없습니다." }, 404);
    }
    if (m === "DELETE") {
      await db.batch([db.prepare("DELETE FROM records WHERE plan_id=?").bind(id), db.prepare("DELETE FROM plans WHERE id=?").bind(id)]);
      return json({ ok: true });
    }
  }

  // POST /api/plans/delete  { ids:[] } — 선택한 지표와 그 실적을 함께 삭제
  if (parts[0] === "plans" && parts[1] === "delete" && m === "POST") {
    const ids = cleanIds((await body(request)).ids);
    if (!ids.length) return json({ error: "삭제할 지표를 선택하세요." }, 400);
    let count = 0;
    for (const chunk of chunks(ids, 40)) {
      const ph = chunk.map(() => "?").join(",");
      count += (await db.prepare(`SELECT COUNT(*) AS n FROM plans WHERE id IN (${ph})`).bind(...chunk).first()).n;
      await db.batch([db.prepare(`DELETE FROM records WHERE plan_id IN (${ph})`).bind(...chunk), db.prepare(`DELETE FROM plans WHERE id IN (${ph})`).bind(...chunk)]);
    }
    return json({ ok: true, count });
  }

  // POST /api/plans/update  { ids:[], patch:{ target?, unit?, owner?, calc? } } — 보낸 항목만 바꿈
  if (parts[0] === "plans" && parts[1] === "update" && m === "POST") {
    const b = await body(request), pt = b.patch || {}, ids = cleanIds(b.ids), sets = [], vals = [];
    if (pt.target !== undefined) {
      const t = Number(pt.target);
      if (!Number.isFinite(t) || t < 0) return json({ error: "연간 목표는 0 이상의 숫자여야 합니다." }, 400);
      sets.push("target=?"); vals.push(t);
    }
    if (pt.unit !== undefined) { sets.push("unit=?"); vals.push(str(pt.unit, 10)); }
    if (pt.owner !== undefined) { sets.push("owner=?"); vals.push(str(pt.owner, 30)); }
    if (pt.calc !== undefined) { sets.push("calc=?"); vals.push(str(pt.calc, 300)); }
    if (!ids.length || !sets.length) return json({ error: "수정할 지표와 항목을 선택하세요." }, 400);
    let count = 0;
    for (const chunk of chunks(ids, 40)) {
      const r = await db.prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...vals, ...chunk).run();
      count += r.meta.changes;
    }
    return json({ ok: true, count });
  }

  // POST /api/plans/reorder  { year, doc, ids:[앞에서부터 새 순서] }
  if (parts[0] === "plans" && parts[1] === "reorder" && m === "POST") {
    const b = await body(request);
    const year = toYear(b.year), doc = String(b.doc || "");
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500).map(String) : [];
    if (!year || !DOC_KEYS.includes(doc) || !ids.length) return json({ error: "순서를 바꿀 수 없습니다." }, 400);
    await db.batch(ids.map((id, i) => db.prepare("UPDATE plans SET ord=? WHERE id=? AND year=? AND doc=?").bind(i, id, year, doc)));
    return json({ ok: true });
  }

  // POST /api/plans/copy  { ids:[], doc | keepDoc, year?, withRecords }  (keepDoc: 각 지표를 원래 계획서 그대로 복사)
  if (parts[0] === "plans" && parts[1] === "copy" && m === "POST") {
    const b = await body(request);
    const keep = !!b.keepDoc, target = String(b.doc || "");
    if (!keep && !DOC_KEYS.includes(target)) return json({ error: "붙여넣을 계획서가 올바르지 않습니다." }, 400);
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500).map(String) : [];
    if (!ids.length) return json({ error: "복사할 지표를 선택하세요." }, 400);
    let added = 0, records = 0; const skipped = [];
    for (const id of ids) {
      const src = await db.prepare("SELECT * FROM plans WHERE id=?").bind(id).first();
      if (!src) continue;
      const year = toYear(b.year) || src.year; // 붙여넣을 연도(없으면 원래 연도)
      const doc = keep ? src.doc : target;
      const dup = await db.prepare("SELECT id FROM plans WHERE year=? AND doc=? AND lower(replace(name,' ',''))=lower(replace(?,' ',''))").bind(year, doc, src.name).first();
      if (dup) { skipped.push(src.name); continue; }
      const ord = (await db.prepare("SELECT COALESCE(MAX(ord),-1)+1 AS n FROM plans WHERE year=? AND doc=?").bind(year, doc).first()).n;
      const nid = crypto.randomUUID();
      const stmts = [db.prepare("INSERT INTO plans (id,year,doc,name,calc,owner,target,unit,ord,copied_from,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(nid, year, doc, src.name, src.calc, src.owner, src.target, src.unit, ord, src.id, now())];
      if (b.withRecords && year === src.year) { // 다른 연도로는 실적(날짜)을 복사하지 않는다
        const rs = await db.prepare("SELECT * FROM records WHERE plan_id=?").bind(src.id).all();
        for (const r of rs.results) {
          stmts.push(db.prepare("INSERT INTO records (id,plan_id,date,value,note,author,created_at) VALUES (?,?,?,?,?,?,?)")
            .bind(crypto.randomUUID(), nid, r.date, r.value, r.note, r.author, r.created_at));
          records++;
        }
      }
      await db.batch(stmts);
      added++;
    }
    return json({ added, records, skipped });
  }

  // POST /api/records  { planIds:[], date, value, note, author }
  if (parts[0] === "records" && parts.length === 1 && m === "POST") {
    const b = await body(request);
    const ids = (Array.isArray(b.planIds) ? b.planIds : [b.planId]).filter(Boolean).slice(0, 20).map(String);
    const date = String(b.date || "");
    const value = Number(b.value);
    if (!ids.length) return json({ error: "지표를 선택하세요." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "날짜 형식이 올바르지 않습니다." }, 400);
    if (!Number.isFinite(value) || value < 0) return json({ error: "실적은 0 이상의 숫자여야 합니다." }, 400);
    const note = str(b.note, 300), author = str(b.author, 30), ts = now();
    const plans = await db.prepare(`SELECT id, year FROM plans WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    if (plans.results.length !== ids.length) return json({ error: "지표를 찾을 수 없습니다." }, 404);
    if (plans.results.some((p) => String(p.year) !== date.slice(0, 4))) return json({ error: "지표의 연도와 실시 날짜의 연도가 다릅니다." }, 400);
    await db.batch(ids.map((pid) => db.prepare("INSERT INTO records (id,plan_id,date,value,note,author,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), pid, date, value, note, author, ts)));
    return json({ ok: true, count: ids.length }, 201);
  }

  // DELETE /api/records/:id
  if (parts[0] === "records" && parts.length === 2 && m === "DELETE") {
    await db.prepare("DELETE FROM records WHERE id=?").bind(parts[1]).run();
    return json({ ok: true });
  }

  return json({ error: "찾을 수 없는 주소입니다." }, 404);
}

/* ---------------- helpers ---------------- */
function cleanPlan(b) {
  const doc = String(b.doc || "");
  if (!DOC_KEYS.includes(doc)) return { error: "계획서를 선택하세요." };
  const name = str(b.name, 80);
  if (!name) return { error: "지표명을 입력하세요." };
  const target = Number(b.target);
  if (!Number.isFinite(target) || target < 0) return { error: "연간 목표는 0 이상의 숫자여야 합니다." };
  return { doc, name, calc: str(b.calc, 300), owner: str(b.owner, 30), target, unit: str(b.unit, 10) };
}
const planOut = (p) => ({ id: p.id, year: p.year, doc: p.doc, name: p.name, calc: p.calc, owner: p.owner, target: p.target, unit: p.unit, order: p.ord, copiedFrom: p.copied_from });
const recOut = (r) => ({ id: r.id, planId: r.plan_id, date: r.date, value: r.value, note: r.note, author: r.author, createdAt: r.created_at });
const cleanIds = (v) => (Array.isArray(v) ? [...new Set(v.slice(0, 500).map(String))] : []);
function chunks(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const now = () => new Date().toISOString();
function toYear(v) { const y = Number(v); return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : null; }
async function body(request) { try { return await request.json(); } catch { return {}; } }

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } });
}
function html(markup, status = 200) {
  return new Response(markup, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

const shell = (title, inner) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title><link rel="stylesheet" href="/login.css"></head><body>${inner}</body></html>`;

function loginPage() {
  return shell("정신건강사업 실적판", `<main class="box">
  <div class="eyebrow">울산동구보건소 정신건강사업 계획 및 실적</div>
  <h1>실적판 로그인</h1>
  <p>팀에서 공유받은 비밀번호를 입력하세요.</p>
  <form id="f" autocomplete="off">
    <label for="pw">팀 비밀번호</label>
    <input id="pw" type="password" required autofocus autocomplete="current-password">
    <button type="submit">들어가기</button>
    <div id="m" class="msg" role="status"></div>
  </form>
  <script src="/login.js"></script>
</main>`);
}

function setupPage() {
  return shell("설정 필요", `<main class="box"><h1>설정이 끝나지 않았습니다</h1><p>Cloudflare 대시보드에서 이 Worker의 비밀값 <code>APP_PASSCODE</code>(8자 이상)를 등록하면 실적판이 열립니다. 비밀번호 없이는 화면과 데이터를 보여주지 않습니다.</p></main>`);
}
