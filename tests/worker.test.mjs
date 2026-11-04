// Worker 동작 검증: Node 내장 SQLite로 D1을 흉내 내어 로그인·API·복사 로직을 확인합니다.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../worker/index.js";

function makeD1() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    first: async () => sql.prepare(q).get(...args) ?? null,
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (list) => { sql.exec("BEGIN"); try { for (const s of list) await s.run(); sql.exec("COMMIT"); } catch (e) { sql.exec("ROLLBACK"); throw e; } },
  };
}

const ASSETS = { fetch: async () => new Response("asset", { status: 200 }) };
const PASS = "test-passcode-1234";
const ORIGIN = "https://mh.example.workers.dev";
const call = (env, path, { method = "GET", body, cookie } = {}) =>
  worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { Origin: ORIGIN } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

async function session(env) {
  const r = await call(env, "/api/login", { method: "POST", body: { passcode: PASS } });
  assert.equal(r.status, 200);
  return r.headers.get("Set-Cookie").split(";")[0];
}

test("비밀번호가 설정되지 않으면 화면과 API 모두 열리지 않는다", async () => {
  const env = { DB: makeD1(), ASSETS };
  assert.equal((await call(env, "/")).status, 503);
  assert.equal((await call(env, "/api/data?year=2026")).status, 503);
  assert.equal((await call({ ...env, APP_PASSCODE: "short" }, "/")).status, 503);
});

test("로그인 없이는 데이터를 줄 수 없고, 잘못된 비밀번호는 거부된다", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  assert.equal((await call(env, "/api/data?year=2026")).status, 401);
  const page = await call(env, "/");
  assert.match(await page.text(), /로그인/);
  assert.equal((await call(env, "/api/login", { method: "POST", body: { passcode: "wrong-wrong" } })).status, 401);
  assert.equal((await call(env, "/api/data?year=2026", { cookie: "mh_s=9999999999999.forged" })).status, 401);
});

test("보안 헤더와 쿠키 속성", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const r = await call(env, "/api/login", { method: "POST", body: { passcode: PASS } });
  const c = r.headers.get("Set-Cookie");
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/);
  assert.match(r.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("다른 사이트에서 온 쓰기 요청은 거부된다", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const r = await worker.fetch(new Request(ORIGIN + "/api/plans", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: cookie }, body: JSON.stringify({}) }), env);
  assert.equal(r.status, 403);
});

test("지표 추가·중복 방지·실적 입력·집계·삭제", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const add = (b) => call(env, "/api/plans", { method: "POST", body: b, cookie });
  const a = await add({ year: 2026, doc: "main", name: "우울증 선별검사", calc: "검사 인원", target: 100, unit: "명" });
  assert.equal(a.status, 201);
  const { id } = await a.json();
  assert.equal((await add({ year: 2026, doc: "main", name: "우울증  선별검사", target: 1 })).status, 409);
  assert.equal((await add({ year: 2026, doc: "bogus", name: "x", target: 1 })).status, 400);

  const rec = (b) => call(env, "/api/records", { method: "POST", body: b, cookie });
  assert.equal((await rec({ planIds: [id], date: "2026-03-05", value: 25, note: "경로당", author: "홍길동" })).status, 201);
  assert.equal((await rec({ planIds: [id], date: "2025-03-05", value: 1 })).status, 400); // 연도 불일치
  assert.equal((await rec({ planIds: [id], date: "2026-03-05", value: -1 })).status, 400);
  assert.equal((await rec({ planIds: [id], date: "2026/03/05", value: 1 })).status, 400);

  const data = await (await call(env, "/api/data?year=2026", { cookie })).json();
  assert.equal(data.plans.length, 1);
  assert.equal(data.plans[0].calc, "검사 인원");
  assert.equal(data.records[0].value, 25);
  assert.equal(data.records[0].author, "홍길동");

  assert.equal((await call(env, "/api/plans/" + id, { method: "PUT", body: { doc: "main", name: "우울증 선별검사", target: 120, unit: "명" }, cookie })).status, 200);
  assert.equal((await call(env, "/api/records/" + data.records[0].id, { method: "DELETE", cookie })).status, 200);
  assert.equal((await call(env, "/api/plans/" + id, { method: "DELETE", cookie })).status, 200);
  assert.equal((await (await call(env, "/api/data?year=2026", { cookie })).json()).plans.length, 0);
});

test("다른 계획서로 복사: 실적 포함, 중복은 건너뜀, 동시 기록", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const mk = async (doc, name) => (await (await call(env, "/api/plans", { method: "POST", body: { year: 2026, doc, name, target: 50, unit: "건" }, cookie })).json()).id;
  const a = await mk("main", "상담 연계"), b = await mk("main", "교육 실시"), dup = await mk("health", "교육 실시");
  await call(env, "/api/records", { method: "POST", body: { planIds: [a], date: "2026-02-01", value: 7 }, cookie });

  const r = await (await call(env, "/api/plans/copy", { method: "POST", body: { ids: [a, b], doc: "health", withRecords: true }, cookie })).json();
  assert.equal(r.added, 1); assert.equal(r.records, 1); assert.deepEqual(r.skipped, ["교육 실시"]);

  const data = await (await call(env, "/api/data?year=2026", { cookie })).json();
  const copied = data.plans.find((p) => p.doc === "health" && p.name === "상담 연계");
  assert.ok(copied); assert.equal(copied.copiedFrom, a);
  assert.equal(data.records.filter((x) => x.planId === copied.id).length, 1);

  // 같은 이름 지표에 한 번에 기록
  const multi = await call(env, "/api/records", { method: "POST", body: { planIds: [b, dup], date: "2026-04-01", value: 3 }, cookie });
  assert.equal((await multi.json()).count, 2);
  assert.equal((await call(env, "/api/plans/copy", { method: "POST", body: { ids: [], doc: "health" }, cookie })).status, 400);
});
