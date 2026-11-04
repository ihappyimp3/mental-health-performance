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

test("지표 순서 바꾸기", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const mk = async (name) => (await (await call(env, "/api/plans", { method: "POST", body: { year: 2026, doc: "youth", name, target: 10 }, cookie })).json()).id;
  const [a, b, c] = [await mk("가"), await mk("나"), await mk("다")];
  const names = async () => (await (await call(env, "/api/data?year=2026", { cookie })).json()).plans.map((p) => p.name);
  assert.deepEqual(await names(), ["가", "나", "다"]);
  assert.equal((await call(env, "/api/plans/reorder", { method: "POST", body: { year: 2026, doc: "youth", ids: [c, a, b] }, cookie })).status, 200);
  assert.deepEqual(await names(), ["다", "가", "나"]);
  // 삭제 뒤 새로 추가해도 맨 뒤에 붙는다
  await call(env, "/api/plans/" + a, { method: "DELETE", cookie });
  await mk("라");
  assert.deepEqual(await names(), ["다", "나", "라"]);
  // 다른 계획서 지표는 건드리지 않는다
  assert.equal((await call(env, "/api/plans/reorder", { method: "POST", body: { year: 2026, doc: "main", ids: [b] }, cookie })).status, 200);
  assert.deepEqual(await names(), ["다", "나", "라"]);
  assert.equal((await call(env, "/api/plans/reorder", { method: "POST", body: { year: 2026, doc: "zzz", ids: [b] }, cookie })).status, 400);
});

test("다른 연도로 지표 복사: 같은 계획서도 가능, 실적은 복사하지 않음", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const id = (await (await call(env, "/api/plans", { method: "POST", body: { year: 2026, doc: "child", name: "아동 상담", calc: "산출식", target: 40, unit: "건" }, cookie })).json()).id;
  await call(env, "/api/records", { method: "POST", body: { planIds: [id], date: "2026-05-01", value: 9 }, cookie });

  const copy = (b) => call(env, "/api/plans/copy", { method: "POST", body: b, cookie }).then((r) => r.json());
  const r1 = await copy({ ids: [id], doc: "child", year: 2027, withRecords: true });
  assert.equal(r1.added, 1); assert.equal(r1.records, 0);
  const d27 = await (await call(env, "/api/data?year=2027", { cookie })).json();
  assert.equal(d27.plans.length, 1); assert.equal(d27.plans[0].calc, "산출식"); assert.equal(d27.plans[0].target, 40);
  assert.equal(d27.records.length, 0);
  // 같은 연도·같은 계획서로 다시 복사하면 건너뜀, 이미 있는 연도로 다시 복사해도 건너뜀
  assert.deepEqual((await copy({ ids: [id], doc: "child", year: 2027 })).skipped, ["아동 상담"]);
  assert.deepEqual((await copy({ ids: [id], doc: "child", year: 2026 })).skipped, ["아동 상담"]);
  // 연도를 안 보내면 원래 연도 유지(기존 동작)
  assert.equal((await copy({ ids: [id], doc: "youth", withRecords: true })).records, 1);
  // 2026 원본은 그대로
  assert.equal((await (await call(env, "/api/data?year=2026", { cookie })).json()).plans.length, 2);
});

test("선택한 지표 삭제·한꺼번에 수정", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const mk = async (doc, name) => (await (await call(env, "/api/plans", { method: "POST", body: { year: 2026, doc, name, target: 10, unit: "명", owner: "갑" }, cookie })).json()).id;
  const [a, b, c] = [await mk("main", "A"), await mk("main", "B"), await mk("health", "C")];
  await call(env, "/api/records", { method: "POST", body: { planIds: [a, c], date: "2026-02-02", value: 5 }, cookie });
  const post = (path, body) => call(env, path, { method: "POST", body, cookie });

  assert.equal((await post("/api/plans/update", { ids: [a, b], patch: {} })).status, 400);
  assert.equal((await post("/api/plans/update", { ids: [a, b], patch: { target: -1 } })).status, 400);
  const u = await (await post("/api/plans/update", { ids: [a, b], patch: { target: 80, unit: "건", calc: "산출식" } })).json();
  assert.equal(u.count, 2);
  let data = await (await call(env, "/api/data?year=2026", { cookie })).json();
  const byName = Object.fromEntries(data.plans.map((p) => [p.name, p]));
  assert.equal(byName.A.target, 80); assert.equal(byName.B.unit, "건"); assert.equal(byName.A.owner, "갑"); // 안 보낸 항목은 유지
  assert.equal(byName.C.target, 10);                                                                          // 선택 안 한 지표는 그대로

  const d = await (await post("/api/plans/delete", { ids: [a, c] })).json();
  assert.equal(d.count, 2);
  data = await (await call(env, "/api/data?year=2026", { cookie })).json();
  assert.deepEqual(data.plans.map((p) => p.name), ["B"]);
  assert.equal(data.records.length, 0); // 실적도 함께 삭제
  assert.equal((await post("/api/plans/delete", { ids: [] })).status, 400);
});

test("연도 전체 복사: 계획서 유지, 순서 유지, 실적 제외, 중복 건너뜀", async () => {
  const env = { DB: makeD1(), ASSETS, APP_PASSCODE: PASS };
  const cookie = await session(env);
  const mk = async (doc, name) => (await (await call(env, "/api/plans", { method: "POST", body: { year: 2026, doc, name, calc: name + "산출", target: 7, unit: "건" }, cookie })).json()).id;
  const a = await mk("main", "첫째"), b = await mk("main", "둘째"), c = await mk("health", "셋째");
  await call(env, "/api/records", { method: "POST", body: { planIds: [a], date: "2026-01-05", value: 3 }, cookie });
  const copy = (body) => call(env, "/api/plans/copy", { method: "POST", body, cookie }).then((r) => r.json());
  const r = await copy({ ids: [a, b, c], keepDoc: true, year: 2027, withRecords: false });
  assert.equal(r.added, 3);
  const d = await (await call(env, "/api/data?year=2027", { cookie })).json();
  assert.deepEqual(d.plans.map((p) => p.doc + ":" + p.name), ["health:셋째", "main:첫째", "main:둘째"]);
  assert.equal(d.plans.find((p) => p.name === "첫째").calc, "첫째산출");
  assert.equal(d.records.length, 0);
  assert.deepEqual((await copy({ ids: [a, b, c], keepDoc: true, year: 2027 })).skipped.sort(), ["둘째", "셋째", "첫째"]);
  assert.equal((await call(env, "/api/plans/copy", { method: "POST", body: { ids: [a], year: 2027 }, cookie })).status, 400);
});
