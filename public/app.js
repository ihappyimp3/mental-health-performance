(function(){
"use strict";
// 계획서 목록은 서버(DB)에서 받는다. 처음 화면용 기본값만 둔다.
let DOCS=[
  {key:"main",name:"주요업무계획"},{key:"district",name:"구정성과"},{key:"dept",name:"부서별 성과관리"},
  {key:"budget",name:"예산의 성과지표"},{key:"audit",name:"행정사무감사"},{key:"health",name:"지역보건의료계획"},
  {key:"center",name:"센터 계획서"},{key:"child",name:"아동정책계획"},{key:"youth",name:"청년정책계획"},{key:"rights",name:"인권계획"}
];
let DOCMAP=Object.fromEntries(DOCS.map(d=>[d.key,d]));
function setDocs(list){ DOCS=list.map(d=>({key:d.key,name:d.name})); DOCMAP=Object.fromEntries(DOCS.map(d=>[d.key,d])); }
const docName = k => DOCMAP[k]?.name || "미분류";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => (Math.round(n*10)/10).toLocaleString("ko-KR");
const pct = n => (Math.round(n*10)/10).toFixed(1) + "%";
const pad = n => String(n).padStart(2,"0");
const norm = s => String(s||"").replace(/\s+/g,"").toLowerCase();
const today = new Date();
const todayStr = today.getFullYear()+"-"+pad(today.getMonth()+1)+"-"+pad(today.getDate());
const store = { get:k=>{ try{ return localStorage.getItem(k); }catch(_){ return null; } }, set:(k,v)=>{ try{ localStorage.setItem(k,v); }catch(_){} } };

let plans=[], records=[], knownYears=[];
let year = (()=>{ const y=+(store.get("mh_year")||0); return y>=2025&&y<=2030 ? y : today.getFullYear(); })();
let curDoc = "all";
let selPlan = null, logMonth = "all", editingPlan = null;
let logSort = ["dateDesc","dateAsc","name"].includes(store.get("mh_logsort")) ? store.get("mh_logsort") : "dateDesc";
const picked = new Set();
let copyMsg = "", pasteYear = null, pasteDoc = null, closeAfterEdit = false;
let loaded = false, lastSync = null;

/* ---------- 서버 통신 ---------- */
async function api(method, path, body){
  const res = await fetch(path, { method, headers: body?{"Content-Type":"application/json"}:{}, body: body?JSON.stringify(body):undefined, credentials:"same-origin" });
  if(res.status===401){ location.reload(); throw new Error("로그인이 필요합니다."); }
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || `요청이 실패했습니다 (${res.status})`);
  return data;
}
let loading=null;
async function load(){
  if(loading) return loading;
  const y=year;
  loading=(async()=>{
    try{
      const d=await api("GET","/api/data?year="+y);
      if(y!==year) return;
      if(d.docs&&d.docs.length) setDocs(d.docs);
      const first=!loaded;
      plans=d.plans; records=d.records; knownYears=d.years||[];
      if(first) readHash(); // 새로 만든 계획서 주소(#키)로 들어온 경우를 위해, 계획서 목록을 받은 뒤 다시 읽는다
      loaded=true; lastSync=new Date(); $("#banner").hidden=true;
      render();
      loadEvents();
    }catch(err){ flash("데이터를 불러오지 못했습니다: "+err.message,true); }
    finally{ loading=null; }
  })();
  return loading;
}
// 다른 팀원이 입력한 내용을 30초마다 반영
setInterval(()=>{ if(document.visibilityState==="visible") load(); }, 30000);
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible") load(); });

/* ---------- 탭 (주소 #main 등으로 바로 열 수 있음) ---------- */
function readHash(){ const h=location.hash.replace("#",""); curDoc = DOCMAP[h] ? h : "all"; selPlan=null; }
window.addEventListener("hashchange", ()=>{ readHash(); render(); loadEvents(); });
readHash();

/* ---------- 연도 ---------- */
function fillYears(){
  const ys = new Set([2025,2026,2027,2028,2029,2030, ...knownYears, year]);
  $("#yearSel").innerHTML = [...ys].sort().map(y=>`<option value="${y}"${y===year?" selected":""}>${y}년</option>`).join("");
}
$("#yearSel").addEventListener("change", e => { year=+e.target.value; store.set("mh_year", String(year)); pasteYear=null; selPlan=null; picked.clear(); logMonth="all"; $("#fDate").value=""; plans=[]; records=[]; loaded=false; calY=year; calSel=null; events=[]; render(); load(); });

function elapsedRate(y){
  const ty=today.getFullYear();
  if(y<ty) return 100; if(y>ty) return 0;
  const start=new Date(y,0,1), end=new Date(y+1,0,1);
  return (today-start)/(end-start)*100;
}
function status(rate, el, hasRec){
  if(rate>=100) return ["done","달성"];
  if(!hasRec && el<5) return ["none","시작 전"];
  if(rate>=el) return ["ok","순항"];
  if(rate>=el*0.8) return ["warn","주의"];
  return ["bad","부진"];
}
const docOf = p => DOCMAP[p?.doc] ? p.doc : "unassigned";

/* ---------- 데이터 묶음 ---------- */
function allYearPlans(){ return plans.filter(p=>p.year===year).sort((a,b)=>(a.order??0)-(b.order??0) || String(a.name).localeCompare(b.name,"ko")); }
function scopedPlans(){ const ps=allYearPlans(); return curDoc==="all"?ps:ps.filter(p=>docOf(p)===curDoc); }
function yearRecords(){ const pre=year+"-"; return records.filter(r=>typeof r.date==="string" && r.date.startsWith(pre)); }
function stats(){
  // 입력값은 누적 실적이므로 합산하지 않고, 날짜가 가장 늦은(같은 날이면 나중에 입력한) 값을 최근 실적으로 쓴다.
  const totals={}, last={}, lastKey={}, monthly={}, monthKey={};
  yearRecords().forEach(r=>{
    const k=r.date+"|"+(r.createdAt||""), v=+r.value||0;
    if(!(r.planId in lastKey) || k>lastKey[r.planId]){ lastKey[r.planId]=k; totals[r.planId]=v; last[r.planId]=r.date; }
    const m=+r.date.slice(5,7), mk=r.planId+"|"+m;
    if(!(mk in monthKey) || k>monthKey[mk]){ monthKey[mk]=k; (monthly[r.planId]=monthly[r.planId]||{})[m]=v; }
  });
  return {totals,last,monthly};
}
const rateOf = (p,totals) => p.target>0 ? (totals[p.id]||0)/p.target*100 : 0;

/* ---------- 렌더 ---------- */
function render(){
  const el=elapsedRate(year), {totals,last,monthly}=stats();
  const all=allYearPlans(), ps=scopedPlans(), rsAll=yearRecords();
  const pIds=new Set(ps.map(p=>p.id));
  const rs=rsAll.filter(r=>pIds.has(r.planId));
  const isAll = curDoc==="all";

  $("#yearTitle").textContent=year;
  $("#docTitle").textContent = isAll ? "전체 현황" : docName(curDoc);
  document.title = (isAll?"":docName(curDoc)+" · ")+"정신건강사업 실적판";
  fillYears();

  const counts={}; all.forEach(p=>{ const k=docOf(p); counts[k]=(counts[k]||0)+1; });
  const tabList=[{key:"all",name:"전체 현황"},...DOCS];
  $("#tabs").innerHTML = tabList.map(t=>`<a href="#${t.key==="all"?"":t.key}" class="${curDoc===t.key?"on":""}"${curDoc===t.key?' aria-current="page"':""}>${esc(t.name)}${t.key!=="all"?`<span class="cnt">${counts[t.key]||0}</span>`:""}</a>`).join("");

  const rates=ps.map(p=>rateOf(p,totals));
  $("#sRate").textContent = ps.length ? pct(rates.reduce((a,b)=>a+Math.min(b,100),0)/ps.length) : "–";
  $("#sRateD").textContent = isAll ? "전체 지표 달성률 평균 (100% 상한)" : `${docName(curDoc)} 지표 평균`;
  $("#sElapsed").textContent = pct(el);
  $("#sElapsedD").textContent = year===today.getFullYear() ? `${today.getMonth()+1}월 ${today.getDate()}일 기준` : (year<today.getFullYear()?"종료된 연도":"아직 시작 전");
  $("#sOnTrack").textContent = ps.length ? `${rates.filter(r=>r>=el||r>=100).length} / ${ps.length}` : "–";
  const curM = year===today.getFullYear()? today.getMonth()+1 : null;
  $("#sMonth").textContent = curM ? fmt(rs.filter(r=>+r.date.slice(5,7)===curM).length)+"건" : "–";
  $("#sMonthD").textContent = curM ? `${curM}월 실적 기록 건수` : "올해에만 표시됩니다";
  $("#asof").textContent = loaded ? `지표 ${all.length}개 · 실적 ${fmt(rsAll.length)}건` : "불러오는 중…";
  $("#sync").textContent = lastSync ? `· ${pad(lastSync.getHours())}:${pad(lastSync.getMinutes())} 갱신 (30초마다 자동)` : "";

  $("#overviewPanel").hidden = !isAll;
  if(isAll){
    const cards = DOCS.map(t=>{
      const dps=all.filter(p=>docOf(p)===t.key);
      const mv=`<span class="docmv"><button class="ghost" type="button" data-docmove="-1" data-key="${esc(t.key)}" aria-label="${esc(t.name)} 앞으로">◀</button><button class="ghost" type="button" data-docmove="1" data-key="${esc(t.key)}" aria-label="${esc(t.name)} 뒤로">▶</button></span>`;
      const edit=mv+`<button class="ghost docedit" type="button" data-docedit="${esc(t.key)}" aria-label="${esc(t.name)} 이름 수정">이름 수정</button>`;
      if(!dps.length) return `<div class="docwrap" draggable="true" data-doc="${esc(t.key)}" title="끌어서 순서 바꾸기"><a class="doccard empty-card" href="#${t.key}"><div class="top"><h3>${esc(t.name)}</h3></div><div class="meta">등록된 지표 없음 · 눌러서 추가</div></a>${edit}</div>`;
      const st={done:0,ok:0,warn:0,bad:0,none:0}; const lag=[]; let sum=0;
      dps.forEach(p=>{ const r=rateOf(p,totals); sum+=Math.min(r,100); const [c]=status(r,el,!!last[p.id]); st[c]++; if(c==="bad") lag.push(p.name); });
      const n=dps.length, keys=["done","ok","warn","bad","none"], labels={done:"달성",ok:"순항",warn:"주의",bad:"부진",none:"시작 전"};
      const bar=keys.map(k=>st[k]?`<span class="s-${k}" style="width:${st[k]/n*100}%"></span>`:"").join("");
      const label=keys.filter(k=>st[k]).map(k=>labels[k]+" "+st[k]).join(" · ");
      return `<div class="docwrap" draggable="true" data-doc="${esc(t.key)}" title="끌어서 순서 바꾸기"><a class="doccard" href="#${t.key}"><div class="top"><h3>${esc(t.name)}</h3><span class="meta">지표 ${n}</span></div>
        <div class="rate">${pct(sum/n)}</div>
        <div class="stack" role="img" aria-label="${esc(label)}">${bar}</div>
        <div class="meta">${esc(label)}</div>
        ${lag.length?`<div class="lag" title="${esc(lag.join(", "))}">부진: ${esc(lag.slice(0,2).join(", "))}${lag.length>2?` 외 ${lag.length-2}`:""}</div>`:""}</a>${edit}</div>`;
    }).join("");
    $("#docGrid").innerHTML=`<div class="docgrid">${cards}</div>`;
  }

  $("#tablePanel").hidden = isAll; $("#heatPanel").hidden = isAll;
  $("#calPanel").hidden = !isAll; $("#logPanel").hidden = isAll;
  if(isAll) renderCal();
  if(!isAll){
    $("#tableTitle").textContent = `${docName(curDoc)} 지표별 진도`;
    const tw=$("#planTableWrap");
    if(!ps.length){
      tw.innerHTML=`<div class="empty"><strong>${year}년 ${esc(docName(curDoc))} 지표가 아직 없습니다.</strong><span>계획서에 있는 성과지표와 연간 목표를 등록하면 날짜별 실적을 입력할 수 있어요.</span><button class="primary" type="button" data-act="openPlans">지표 추가</button></div>`;
    } else {
      const allPicked = ps.every(p=>picked.has(p.id));
      tw.innerHTML=`<table><thead><tr><th class="dh" aria-label="순서"></th><th class="pk"><input type="checkbox" class="pick" id="pickAll" data-pickall aria-label="이 계획서 지표 모두 선택"${allPicked?" checked":""}></th><th>지표명</th><th class="r">연간 목표</th><th class="r">최근 실적</th><th>달성률</th><th class="r"></th><th>상태</th><th class="act"></th></tr></thead><tbody>${
        ps.map((p,i)=>{ const r=rates[i], [cls,lab]=status(r,el,!!last[p.id]);
          return `<tr class="row${selPlan===p.id?" sel":""}" data-plan="${esc(p.id)}" tabindex="0" title="이 지표의 실적만 보기">
            <td class="dh" draggable="true" title="끌어서 순서 바꾸기" aria-hidden="true">⠿</td>
            <td class="pk"><input type="checkbox" class="pick" id="pick-${esc(p.id)}" data-pick="${esc(p.id)}" aria-label="${esc(p.name)} 선택"${picked.has(p.id)?" checked":""}></td>
            <td><div class="pname">${esc(p.name)}</div>${p.calc?`<div class="pcat">산출내역: ${esc(p.calc)}</div>`:""}</td>
            <td class="r num">${fmt(p.target||0)} <span class="muted">${esc(p.unit||"")}</span></td>
            <td class="r num">${last[p.id]?`${fmt(totals[p.id]||0)} <span class="muted">${esc(p.unit||"")}</span><div class="pcat">${last[p.id].slice(5).replace("-","/")} 입력</div>`:`<span class="muted">–</span>`}</td>
            <td><div class="prog" role="img" aria-label="달성률 ${pct(r)}, 경과율 ${pct(el)}"><div class="fill" style="width:${Math.min(r,100)}%"></div><div class="mark" style="left:calc(${Math.min(el,100)}% - 1px)"></div></div></td>
            <td class="r num">${p.target>0?pct(r):"목표 없음"}</td>
            <td><span class="pill ${cls}">${lab}</span></td>
            <td class="act"><button class="ghost" type="button" data-pedit="${esc(p.id)}" aria-label="${esc(p.name)} 수정">수정</button><button class="ghost danger" type="button" data-pdel="${esc(p.id)}" aria-label="${esc(p.name)} 삭제">삭제</button></td></tr>`; }).join("")
      }</tbody></table>`;
    }
    const hw=$("#heatWrap");
    if(!ps.length){ hw.innerHTML=`<div class="empty">지표를 등록하면 월별 실적이 여기에 표시됩니다.</div>`; }
    else{
      let h=`<table class="heat"><thead><tr><th>지표</th>`;
      for(let m=1;m<=12;m++) h+=`<th class="${curM===m?"now":""}">${m}월</th>`;
      h+=`</tr></thead><tbody>`;
      ps.forEach(p=>{
        h+=`<tr><td><span class="pname">${esc(p.name)}</span></td>`;
        for(let m=1;m<=12;m++){
          const v=(monthly[p.id]||{})[m]||0;
          const a=v===0?0:p.target>0?Math.min(1,.15+.85*v/p.target):.5;
          h+=`<td class="c" style="background:rgba(var(--heat),${a.toFixed(2)});${a>.6?"color:var(--bg);font-weight:600":""}" title="${esc(p.name)} ${m}월: ${fmt(v)}${esc(p.unit||"")}">${v?fmt(v):""}</td>`;
        }
        h+=`</tr>`;
      });
      hw.innerHTML=h+`</tbody></table>`;
    }
  }

  fillDocSelect();
  renderForm(all);
  const lm=$("#logMonth");
  lm.innerHTML=`<option value="all">전체 월</option>`+Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}월</option>`).join("");
  lm.value=logMonth;
  renderLog(rs, all);
  renderPlanList();
}

/* ---------- 입력 폼 ---------- */
function renderForm(all){
  const fd=$("#fDoc"), prevDoc=fd.value;
  const docsWith=DOCS.filter(d=>all.some(p=>docOf(p)===d.key));
  fd.innerHTML = docsWith.length ? docsWith.map(d=>`<option value="${d.key}">${esc(d.name)}</option>`).join("") : `<option value="">먼저 지표를 등록하세요</option>`;
  if(curDoc!=="all" && docsWith.some(d=>d.key===curDoc)) fd.value=curDoc;
  else if(docsWith.some(d=>d.key===prevDoc)) fd.value=prevDoc;
  fillPlanSelect(all);
  if(!$("#fDate").value) $("#fDate").value = year===today.getFullYear()? todayStr : `${year}-01-01`;
}
function fillPlanSelect(all=allYearPlans()){
  const fp=$("#fPlan"), prev=fp.value, d=$("#fDoc").value;
  const opts=all.filter(p=>docOf(p)===d);
  fp.innerHTML = opts.length ? opts.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("") : `<option value="">지표 없음</option>`;
  if(selPlan && opts.some(p=>p.id===selPlan)) fp.value=selPlan; else if(opts.some(p=>p.id===prev)) fp.value=prev;
  $("#fSubmit").disabled = !opts.length;
  updateUnit();
}
function siblings(p){ return p ? allYearPlans().filter(x=>x.id!==p.id && norm(x.name)===norm(p.name)) : []; }
function updateUnit(){
  const p=plans.find(x=>x.id===$("#fPlan").value);
  $("#fUnit").textContent = p&&p.unit ? `(${p.unit})` : "";
  const sib=siblings(p);
  $("#linkWrap").hidden = !sib.length;
  if(sib.length) $("#linkText").textContent = `같은 지표가 ${sib.map(x=>docName(docOf(x))).join(", ")}에도 있습니다. 같은 실적을 함께 기록`;
}
$("#fDoc").addEventListener("change", ()=>{ $("#fLink").checked=false; fillPlanSelect(); });
$("#fPlan").addEventListener("change", ()=>{ $("#fLink").checked=false; updateUnit(); });
$("#logMonth").addEventListener("change", e=>{ logMonth=e.target.value; render(); });
$("#logSort").value=logSort;
$("#logSort").addEventListener("change", e=>{ logSort=e.target.value; store.set("mh_logsort", logSort); render(); });
$("#fAuthor").value = store.get("mh_author") || "";
$("#fAuthor").addEventListener("change", e=>store.set("mh_author", e.target.value.trim()));

function renderLog(rs, all){
  const pmap=Object.fromEntries(all.map(p=>[p.id,p]));
  let list=rs.filter(r=>pmap[r.planId]);
  if(selPlan) list=list.filter(r=>r.planId===selPlan);
  if(logMonth!=="all") list=list.filter(r=>+r.date.slice(5,7)===+logMonth);
  const byNew=(a,b)=>b.date.localeCompare(a.date)||(b.createdAt||"").localeCompare(a.createdAt||"");
  if(logSort==="dateAsc") list.sort((a,b)=>-byNew(a,b));
  else if(logSort==="name") list.sort((a,b)=>String(pmap[a.planId].name).localeCompare(String(pmap[b.planId].name),"ko")||byNew(a,b));
  else list.sort(byNew);
  $("#logFilter").innerHTML = selPlan&&pmap[selPlan] ? `<span class="filterchip">${esc(pmap[selPlan].name)}<button type="button" data-act="clearSel" aria-label="지표 필터 해제">×</button></span>` : "";
  const w=$("#logWrap");
  if(!list.length){ w.innerHTML=`<div class="empty">${rs.length?"이 조건에 맞는 실적이 없습니다.":"아직 입력된 실적이 없습니다. 왼쪽에서 날짜와 실적을 입력하면 여기에 쌓입니다."}</div>`; return; }
  const isAll=curDoc==="all";
  w.innerHTML=`<ul class="log">${list.slice(0,200).map(r=>{
    const p=pmap[r.planId];
    return `<li><span class="dt">${esc(r.date)}</span>
      <div class="what"><div class="t">${isAll?`<span class="tag">${esc(docName(docOf(p)))}</span>`:""}${esc(p.name)}</div>${r.note?`<div class="n">${esc(r.note)}</div>`:""}${r.author?`<div class="n">입력: ${esc(r.author)}</div>`:""}</div>
      <div><div class="val">${fmt(+r.value||0)} <span class="muted">${esc(p.unit||"")}</span></div>
      <div class="acts"><button class="ghost danger" type="button" data-del="${esc(r.id)}">삭제</button></div></div></li>`;}).join("")}</ul>${list.length>200?`<div class="hint">최근 200건만 표시합니다. 월을 선택해 좁혀 보세요.</div>`:""}`;
}

/* ---------- 일정 캘린더 (전체 현황) ---------- */
let events=[], calY=year, calM=today.getMonth()+1, calSel=null, calKey="";
const WD=["일","월","화","수","목","금","토"];
const dstr=(y,m,d)=>y+"-"+pad(m)+"-"+pad(d);
function calRange(){
  const first=new Date(calY,calM-1,1), start=new Date(calY,calM-1,1-first.getDay());
  const last=new Date(calY,calM,0), end=new Date(calY,calM-1,last.getDate()+(6-last.getDay()));
  const f=d=>dstr(d.getFullYear(),d.getMonth()+1,d.getDate());
  return {start,end,from:f(start),to:f(end)};
}
async function loadEvents(){
  if(curDoc!=="all") return;
  const {from,to}=calRange(), key=from+"~"+to;
  try{
    const d=await api("GET",`/api/events?from=${from}&to=${to}`);
    if(key!==calRange().from+"~"+calRange().to) return;
    events=d.events||[]; calKey=key; renderCal();
  }catch(err){ flash("일정을 불러오지 못했습니다: "+err.message,true); }
}
const evTime=e=>e.start?(e.end?`${e.start}~${e.end}`:e.start):"";
function renderCal(){
  const {start,end}=calRange();
  $("#calTitle").textContent=`${calY}년 ${calM}월`;
  const by={}; events.forEach(e=>(by[e.date]=by[e.date]||[]).push(e));
  let cells=WD.map(w=>`<div class="wd">${w}</div>`).join("");
  for(let d=new Date(start); d<=end; d=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)){
    const ds=dstr(d.getFullYear(),d.getMonth()+1,d.getDate()), list=by[ds]||[];
    cells+=`<button type="button" class="day${d.getMonth()+1!==calM?" out":""}${ds===todayStr?" today":""}${ds===calSel?" sel":""}" data-day="${ds}" aria-label="${ds} 일정 ${list.length}건"><span class="dn">${d.getDate()}</span>${list.slice(0,2).map(e=>`<span class="ev" title="${esc(e.name)}">${esc(e.name)}</span>`).join("")}${list.length>2?`<span class="more">+${list.length-2}건</span>`:""}</button>`;
  }
  $("#calGrid").innerHTML=`<div class="calgrid">${cells}</div>`;
  const inMonth=events.filter(e=>+e.date.slice(5,7)===calM && +e.date.slice(0,4)===calY);
  const shown=calSel?events.filter(e=>e.date===calSel):inMonth;
  const head=calSel?`<span>${esc(calSel)} 일정 ${shown.length}건</span><button type="button" class="ghost" data-cal="all">${calM}월 전체 보기</button>`:`<span>${calM}월 일정 ${shown.length}건</span>`;
  $("#calList").innerHTML=`<div class="calhead">${head}</div>`+(shown.length?`<ul class="evlist">${shown.map(e=>{
    const meta=[evTime(e),e.place,e.target&&`대상 ${e.target}`,e.headcount!=null&&`${e.headcount}명`,e.owner&&`담당 ${e.owner}`].filter(Boolean).map(esc).join(" · ");
    return `<li><div><div class="t">${calSel?"":`<span class="tag">${esc(e.date.slice(5))}</span>`}${esc(e.name)}</div>${meta?`<div class="m">${meta}</div>`:""}${e.content?`<div class="m">${esc(e.content)}</div>`:""}</div><div class="acts"><button class="ghost" type="button" data-evedit="${esc(e.id)}">수정</button><button class="ghost danger" type="button" data-evdel="${esc(e.id)}">삭제</button></div></li>`;}).join("")}</ul>`:`<div class="empty">${calSel?"이 날짜에 등록된 일정이 없습니다.":"이 달에 등록된 일정이 없습니다."} 「일정 추가」로 등록하세요.</div>`);
}
function calGo(y,m){ calY=y; calM=m; calSel=null; events=[]; renderCal(); loadEvents(); }
const evDlg=$("#evDlg"); let editingEv=null;
evDlg.addEventListener("click", e=>{ if(e.target.matches("[data-close]")||e.target===evDlg) evDlg.close(); });
function openEvDlg(id){
  const ev=id&&events.find(x=>x.id===id); editingEv=ev?ev.id:null;
  $("#evForm").reset(); $("#eMsg").textContent="";
  $("#evDlgTitle").textContent=ev?"일정 수정":"일정 추가"; $("#eSubmit").textContent=ev?"수정 저장":"추가";
  $("#eName").value=ev?ev.name:""; $("#eDate").value=ev?ev.date:(calSel||(calY===today.getFullYear()&&calM===today.getMonth()+1?todayStr:dstr(calY,calM,1)));
  $("#eStart").value=ev?ev.start:""; $("#eEnd").value=ev?ev.end:""; $("#ePlace").value=ev?ev.place:"";
  $("#eTarget").value=ev?ev.target:""; $("#eCount").value=ev&&ev.headcount!=null?ev.headcount:""; $("#eContent").value=ev?ev.content:"";
  $("#eOwner").value=ev?ev.owner:(store.get("mh_author")||"");
  evDlg.showModal(); $("#eName").focus();
}
$("#evForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const m=$("#eMsg"), btn=$("#eSubmit"); btn.disabled=true;
  const body={name:$("#eName").value.trim(),date:$("#eDate").value,start:$("#eStart").value,end:$("#eEnd").value,place:$("#ePlace").value.trim(),target:$("#eTarget").value.trim(),headcount:$("#eCount").value,content:$("#eContent").value.trim(),owner:$("#eOwner").value.trim()};
  try{
    if(editingEv) await api("PUT","/api/events/"+encodeURIComponent(editingEv),body); else await api("POST","/api/events",body);
    evDlg.close();
    const [y,mo]=body.date.split("-").map(Number); calY=y; calM=mo; calSel=body.date; // 저장한 날짜로 이동
    events=[]; renderCal(); await loadEvents();
  }catch(err){ m.className="msg err"; m.textContent="저장하지 못했습니다: "+err.message; }
  finally{ btn.disabled=false; }
});
document.addEventListener("click", e=>{
  const c=e.target.closest("[data-cal]");
  if(c){
    const a=c.dataset.cal;
    if(a==="prev") calGo(calM===1?calY-1:calY, calM===1?12:calM-1);
    else if(a==="next") calGo(calM===12?calY+1:calY, calM===12?1:calM+1);
    else if(a==="today") { calSel=todayStr; calGo(today.getFullYear(),today.getMonth()+1); calSel=todayStr; renderCal(); }
    else if(a==="all"){ calSel=null; renderCal(); }
    else if(a==="add") openEvDlg(null);
    return;
  }
  const d=e.target.closest("[data-day]");
  if(d){ calSel=calSel===d.dataset.day?null:d.dataset.day; const [y,m]=d.dataset.day.split("-").map(Number); if(m!==calM||y!==calY){ calY=y; calM=m; events=[]; renderCal(); loadEvents(); } else renderCal(); return; }
  const ed=e.target.closest("[data-evedit]"); if(ed){ openEvDlg(ed.dataset.evedit); return; }
  const dl=e.target.closest("[data-evdel]");
  if(dl) confirmThen(dl, async()=>{ try{ await api("DELETE","/api/events/"+encodeURIComponent(dl.dataset.evdel)); await loadEvents(); }catch(err){ flash("삭제하지 못했습니다: "+err.message,true); } });
});

/* ---------- 클릭 처리 ---------- */
document.addEventListener("click", e=>{
  const pk=e.target.closest("[data-pick]");
  if(pk){ pk.checked?picked.add(pk.dataset.pick):picked.delete(pk.dataset.pick); copyMsg=""; render(); return; }
  if(e.target.closest("[data-pickall]")){
    const on=e.target.checked;
    scopedPlans().forEach(p=>on?picked.add(p.id):picked.delete(p.id)); copyMsg=""; render(); return;
  }
  if(e.target.closest("td.pk")) return;
  const actEl=e.target.closest("[data-act]"), act=actEl?.dataset.act;
  if(act==="up"||act==="down"){ movePlans([...picked], act==="up"?-1:1); return; }
  if(act==="top"||act==="bottom"){ placePlans([...picked], act); return; }
  if(act==="goto"){ gotoPlans(actEl.closest(".copybar")); return; }
  if(act==="editsel"){ editSelected(); return; }
  if(act==="delsel"){
    const n=picked.size, rn=records.filter(r=>picked.has(r.planId)).length;
    confirmThen(actEl, deleteSelected, `${n}개${rn?` · 실적 ${rn}건`:""} 삭제 확인`); return;
  }
  if(act==="paste"){ doPaste(actEl.closest(".copybar")); return; }
  if(act==="unpick"){ picked.clear(); copyMsg=""; render(); return; }
  if(act==="openPlans"){ openPlans(); return; }
  if(act==="adddoc"){ openDocDlg(null); return; }
  if(act==="editdoc"){ openDocDlg(curDoc); return; }
  if(act==="clearSel"){ selPlan=null; render(); return; }
  const row=e.target.closest("tr.row");
  if(row && !e.target.closest("button,a,input,select,label")){ selPlan=selPlan===row.dataset.plan?null:row.dataset.plan; render(); return; }
  const del=e.target.closest("[data-del]");
  if(del) confirmThen(del, async()=>{ try{ await api("DELETE","/api/records/"+encodeURIComponent(del.dataset.del)); await load(); }catch(err){ flash("삭제하지 못했습니다: "+err.message,true); } });
  const pdel=e.target.closest("[data-pdel]");
  if(pdel){
    const id=pdel.dataset.pdel, n=records.filter(r=>r.planId===id).length;
    confirmThen(pdel, async()=>{
      try{ await api("DELETE","/api/plans/"+encodeURIComponent(id)); if(selPlan===id) selPlan=null; picked.delete(id); await load(); }
      catch(err){ $("#pMsg").className="msg err"; $("#pMsg").textContent="삭제하지 못했습니다: "+err.message; flash("삭제하지 못했습니다: "+err.message,true); }
    }, n?`실적 ${n}건도 삭제`:"삭제 확인");
  }
  const de=e.target.closest("[data-docedit]");
  if(de){ openDocDlg(de.dataset.docedit); return; }
  const mv=e.target.closest("[data-pmove]");
  if(mv){ const [id,d]=mv.dataset.pmove.split(":"); movePlans([id],+d, mv.dataset.pmove); return; }
  const pedit=e.target.closest("[data-pedit]");
  if(pedit){
    if(!dlg.open){ resetPlanForm(); renderPlanList(); dlg.showModal(); closeAfterEdit=true; }
    startEditPlan(pedit.dataset.pedit);
  }
});
document.addEventListener("keydown", e=>{ if((e.key==="Enter"||e.key===" ")&&e.target.matches("tr.row")){ e.preventDefault(); e.target.click(); } });
function confirmThen(btn, fn, label="삭제 확인"){
  if(btn.dataset.armed){ fn(); return; }
  const orig=btn.textContent; btn.dataset.armed="1"; btn.textContent=label;
  setTimeout(()=>{ if(btn.isConnected){ delete btn.dataset.armed; btn.textContent=orig; } },3000);
}
function flash(t,err){ const b=$("#banner"); b.hidden=false; b.className="banner"+(err?" err":""); b.textContent=t; }
$("#logout").addEventListener("click", async()=>{ try{ await fetch("/api/logout",{method:"POST"}); }catch(_){} location.reload(); });

/* ---------- 실적 저장 ---------- */
$("#entryForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const msg=$("#fMsg"), fail=t=>{ msg.className="msg err"; msg.textContent=t; };
  const planId=$("#fPlan").value, date=$("#fDate").value, value=parseFloat($("#fValue").value), note=$("#fNote").value.trim(), author=$("#fAuthor").value.trim();
  if(!planId) return fail("지표를 먼저 선택하세요.");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("실시 날짜를 입력하세요.");
  if(!(value>=0)) return fail("실적은 0 이상의 숫자로 입력하세요.");
  const p=plans.find(x=>x.id===planId);
  if(p && +date.slice(0,4)!==p.year) return fail(`이 지표는 ${p.year}년 계획입니다. ${p.year}년 날짜로 입력하세요.`);
  const targets=[p, ...(!$("#linkWrap").hidden && $("#fLink").checked ? siblings(p) : [])];
  store.set("mh_author", author);
  $("#fSubmit").disabled=true;
  try{
    await api("POST","/api/records",{planIds:targets.map(t=>t.id),date,value,note,author});
    msg.className="msg ok";
    msg.textContent=`${date} · ${p.name} ${fmt(value)}${p.unit||""} 저장했습니다.${targets.length>1?` (계획서 ${targets.length}곳에 반영)`:""}`;
    $("#fValue").value=""; $("#fNote").value="";
    await load();
  }catch(err){ fail("저장하지 못했습니다: "+err.message); }
  finally{ $("#fSubmit").disabled=false; }
});

/* ---------- 지표 관리 ---------- */
const dlg=$("#planDlg");
function fillDocSelect(){
  const sel=$("#pDoc"), html=DOCS.map(d=>`<option value="${d.key}">${esc(d.name)}</option>`).join("");
  if(sel.dataset.sig===html) return;
  const cur=sel.value; sel.innerHTML=html; sel.dataset.sig=html;
  if(DOCMAP[cur]) sel.value=cur;
}
fillDocSelect();
function openPlans(){ resetPlanForm(); renderPlanList(); dlg.showModal(); $("#pName").focus(); }
$("#managePlans").addEventListener("click", openPlans);
dlg.addEventListener("click", e=>{ if(e.target.matches("[data-close]")||e.target===dlg) dlg.close(); });
dlg.addEventListener("close", ()=>{ closeAfterEdit=false; });
/* 연도 복사: 보고 있는 연도의 지표를 다른 연도로 한꺼번에 복사 */
let ycYearSel=null;
function renderYearCopy(){
  const all=allYearPlans(), scoped=scopedPlans();
  const ys=[...new Set([2025,2026,2027,2028,2029,2030,...knownYears])].filter(y=>y!==year).sort();
  if(ycYearSel===null || !ys.includes(ycYearSel)) ycYearSel = ys.includes(year+1) ? year+1 : ys[0];
  $("#ycYear").innerHTML=ys.map(y=>`<option value="${y}"${y===ycYearSel?" selected":""}>${y}년</option>`).join("");
  const opts=[`<option value="all">${year}년 전체 계획서 (${all.length}개)</option>`];
  if(curDoc!=="all") opts.push(`<option value="cur">${esc(docName(curDoc))}만 (${scoped.length}개)</option>`);
  const prev=$("#ycScope").value;
  $("#ycScope").innerHTML=opts.join(""); if(prev==="cur"&&curDoc!=="all") $("#ycScope").value="cur";
  $("#ycHint").textContent=`지금 보고 있는 ${year}년 지표를 다른 연도로 복사합니다. 계획서·산출내역·목표·단위·담당이 그대로 복사되고 순서도 유지됩니다. 날짜별 실적은 복사하지 않고, 이미 있는 지표는 건너뜁니다.`;
  $("#ycBtn").disabled=!all.length;
}
$("#ycYear").addEventListener("change", e=>{ ycYearSel=+e.target.value; });
$("#yearCopyForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const m=$("#ycMsg"), ty=+$("#ycYear").value, list=$("#ycScope").value==="cur"?scopedPlans():allYearPlans();
  if(!list.length){ m.className="msg err"; m.textContent="복사할 지표가 없습니다."; return; }
  const btn=$("#ycBtn"); btn.disabled=true; m.className="msg"; m.textContent="복사하는 중…";
  try{
    const r=await api("POST","/api/plans/copy",{ids:list.map(p=>p.id),keepDoc:true,year:ty,withRecords:false});
    m.className="msg ok";
    m.textContent=`${year}년 → ${ty}년: ${r.added}개 복사했습니다.${r.skipped.length?` 이미 있는 ${r.skipped.length}개는 건너뜀.`:""} 위쪽 연도를 ${ty}년으로 바꾸면 볼 수 있습니다.`;
    await load();
  }catch(err){ m.className="msg err"; m.textContent="복사하지 못했습니다: "+err.message; }
  finally{ btn.disabled=false; }
});
function renderPlanList(){
  const all=allYearPlans(), w=$("#planListWrap");
  const groups = curDoc==="all" ? DOCS.map(d=>d.key) : [curDoc];
  let html="", n=0;
  groups.forEach(k=>{
    const ps=all.filter(p=>docOf(p)===k); if(!ps.length) return; n+=ps.length;
    if(curDoc==="all") html+=`<li class="grp">${esc(docName(k))}</li>`;
    html+=ps.map((p,i)=>`<li><div class="lft"><input type="checkbox" class="pick" id="dpick-${esc(p.id)}" data-pick="${esc(p.id)}" aria-label="${esc(p.name)} 선택"${picked.has(p.id)?" checked":""}><div><div class="pname">${esc(p.name)}</div><div class="pcat">목표 ${fmt(p.target||0)}${esc(p.unit||"")}${p.owner?` · 담당 ${esc(p.owner)}`:""}</div>${p.calc?`<div class="pcat">산출내역: ${esc(p.calc)}</div>`:""}</div></div><div style="display:flex;gap:2px;flex-shrink:0"><button class="ghost mv" type="button" data-pmove="${esc(p.id)}:-1" aria-label="${esc(p.name)} 위로 이동" title="위로"${i===0?" disabled":""}>▲</button><button class="ghost mv" type="button" data-pmove="${esc(p.id)}:1" aria-label="${esc(p.name)} 아래로 이동" title="아래로"${i===ps.length-1?" disabled":""}>▼</button><button class="ghost" type="button" data-pedit="${esc(p.id)}">수정</button><button class="ghost danger" type="button" data-pdel="${esc(p.id)}">삭제</button></div></li>`).join("");
  });
  const scope = curDoc==="all" ? `${year}년 전체 지표` : `${year}년 ${docName(curDoc)} 지표`;
  w.innerHTML = n ? `<div class="eyebrow">${esc(scope)} (${n})</div><div class="hint">▲▼로 순서를 바꾸고, 체크하면 다른 계획서에 붙여넣을 수 있습니다.</div><ul class="planlist">${html}</ul>` : `<div class="hint">${esc(scope)}가 아직 없습니다.</div>`;
  renderCopyBars();
  renderYearCopy();
}
function resetPlanForm(){
  editingPlan=null; $("#planForm").reset();
  $("#pDoc").value = DOCMAP[curDoc] ? curDoc : DOCS[0].key;
  $("#planFormTitle").textContent=`새 지표 추가 (${year}년)`; $("#pSubmit").textContent="지표 추가"; $("#pCancel").hidden=true; $("#pMsg").textContent="";
}
function startEditPlan(id){
  const p=plans.find(x=>x.id===id); if(!p) return;
  editingPlan=id; $("#pDoc").value=DOCMAP[p.doc]?p.doc:DOCS[0].key; $("#pName").value=p.name||""; $("#pCat").value=p.calc||""; $("#pOwner").value=p.owner||""; $("#pTarget").value=p.target??0; $("#pUnit").value=p.unit||"";
  $("#planFormTitle").textContent="지표 수정"; $("#pSubmit").textContent="수정 저장"; $("#pCancel").hidden=false; $("#pName").focus();
}
$("#pCancel").addEventListener("click", resetPlanForm);
$("#planForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const m=$("#pMsg");
  const data={doc:$("#pDoc").value, name:$("#pName").value.trim(), calc:$("#pCat").value.trim(), owner:$("#pOwner").value.trim(), target:parseFloat($("#pTarget").value)||0, unit:$("#pUnit").value.trim()};
  if(!data.name){ m.className="msg err"; m.textContent="지표명을 입력하세요."; return; }
  const btn=$("#pSubmit"); btn.disabled=true;
  try{
    if(editingPlan) await api("PUT","/api/plans/"+encodeURIComponent(editingPlan), data);
    else await api("POST","/api/plans", {...data, year});
    const t = editingPlan?"수정했습니다.":`${docName(data.doc)}에 '${data.name}' 추가했습니다.`;
    await load();
    if(editingPlan && closeAfterEdit){ dlg.close(); copyMsg="지표를 수정했습니다."; render(); return; }
    resetPlanForm(); $("#pDoc").value=data.doc; m.className="msg ok"; m.textContent=t; $("#pName").focus();
  }catch(err){ m.className="msg err"; m.textContent="저장하지 못했습니다: "+err.message; }
  finally{ btn.disabled=false; }
});

/* ---------- 지표 복사 → 다른 계획서에 붙여넣기 ---------- */
function renderCopyBars(){
  const valid=new Set(allYearPlans().map(p=>p.id));
  [...picked].forEach(id=>{ if(!valid.has(id)) picked.delete(id); });
  const srcDocs=new Set([...picked].map(id=>docOf(plans.find(p=>p.id===id))));
  const ty = pasteYear ?? year;
  const targets=DOCS.filter(d=>!(ty===year && srcDocs.size===1 && srcDocs.has(d.key))); // 같은 연도에서는 원래 계획서를 뺀다
  const yearOpts=[...new Set([2025,2026,2027,2028,2029,2030,...knownYears,year])].sort();
  if(!targets.some(d=>d.key===pasteDoc)) pasteDoc=targets[0]?.key||null;
  document.querySelectorAll(".copybar").forEach((bar,i)=>{
    if(!picked.size && !copyMsg){ bar.hidden=true; bar.innerHTML=""; return; }
    bar.hidden=false;
    const prevRec=bar.querySelector(".cbRec")?.checked, prevPos=bar.querySelector(".mvPos")?.value||"";
    bar.innerHTML = picked.size ? `<span class="cnt">${picked.size}개 지표 선택</span>
      <label for="cbYear${i}">붙여넣을 연도</label>
      <select id="cbYear${i}" class="cbYear">${yearOpts.map(y=>`<option value="${y}"${y===ty?" selected":""}>${y}년</option>`).join("")}</select>
      <label for="cbDoc${i}">계획서</label>
      <select id="cbDoc${i}" class="cbDoc">${targets.map(d=>`<option value="${d.key}"${d.key===pasteDoc?" selected":""}>${esc(d.name)}</option>`).join("")}</select>
      <label title="${ty!==year?"다른 연도로는 실적을 복사하지 않습니다":""}"><input type="checkbox" id="cbRec${i}" class="cbRec"${prevRec&&ty===year?" checked":""}${ty!==year?" disabled":""}> 기존 실적도 복사${ty!==year?" (같은 연도만)":""}</label>
      <button class="primary" type="button" data-act="paste">붙여넣기</button>
      <span class="grp" role="group" aria-label="순서 이동">
        <button type="button" data-act="top" title="맨 위로">⤒ 맨 위</button>
        <button type="button" data-act="up" title="한 칸 위로">▲ 위로</button>
        <button type="button" data-act="down" title="한 칸 아래로">▼ 아래로</button>
        <button type="button" data-act="bottom" title="맨 아래로">⤓ 맨 아래</button>
        <input type="number" class="mvPos" id="mvPos${i}" min="1" inputmode="numeric" placeholder="번호" aria-label="이동할 번호" value="${esc(prevPos)}"><button type="button" data-act="goto" title="입력한 번호 위치로 이동">번째로 이동</button>
      </span>
      <span class="grp" role="group" aria-label="수정과 삭제">
        <button type="button" data-act="editsel" title="${picked.size===1?"선택한 지표 수정":"선택한 지표를 한꺼번에 수정"}">${picked.size===1?"수정":"한꺼번에 수정"}</button>
        <button type="button" class="danger" data-act="delsel" title="선택한 지표와 그 실적을 삭제">선택 삭제</button>
      </span>
      <button class="ghost" type="button" data-act="unpick">선택 해제</button>
      <div class="msg ok">${esc(copyMsg)}</div>` : `<div class="msg ok">${esc(copyMsg)}</div><button class="ghost" type="button" data-act="unpick">닫기</button>`;
  });
}
async function doPaste(bar){
  const target=bar.querySelector(".cbDoc").value, ty=+bar.querySelector(".cbYear").value, withRecords=bar.querySelector(".cbRec").checked && ty===year;
  bar.querySelector('[data-act="paste"]').disabled=true;
  try{
    const r=await api("POST","/api/plans/copy",{ids:[...picked],doc:target,year:ty,withRecords});
    copyMsg=`${ty}년 ${docName(target)}에 ${r.added}개 붙여넣었습니다${r.records?` (실적 ${r.records}건 포함)`:""}.${r.skipped.length?` 이미 있는 지표 ${r.skipped.length}개는 건너뜀: ${r.skipped.join(", ")}`:""} 목표치가 다르면 해당 탭에서 수정하세요.${ty!==year&&r.added?` 위쪽 연도를 ${ty}년으로 바꾸면 볼 수 있습니다.`:""}`;
    picked.clear();
    await load();
  }catch(err){ copyMsg="붙여넣지 못했습니다: "+err.message; render(); }
}

/* ---------- 지표 순서 이동 ---------- */
let moveChain=Promise.resolve();
const docList = doc => allYearPlans().filter(p=>docOf(p)===doc).map(p=>p.id);
function groupByDoc(ids){
  const sel=new Set(ids), by={};
  allYearPlans().filter(p=>sel.has(p.id)).forEach(p=>{ (by[docOf(p)]=by[docOf(p)]||[]).push(p.id); });
  return by;
}
// jobs: [{doc, ids:[새 순서 전체]}] — 화면에 먼저 반영하고 서버에는 순서대로 저장한다.
function commitOrder(jobs, focusKey){
  jobs=jobs.filter(j=>DOCMAP[j.doc] && j.ids.some((x,i)=>x!==docList(j.doc)[i]));
  if(!jobs.length) return;
  jobs.forEach(j=>j.ids.forEach((id,i)=>{ const p=plans.find(x=>x.id===id); if(p) p.order=i; }));
  render();
  if(focusKey){ const b=document.querySelector(`[data-pmove="${CSS.escape(focusKey)}"]`); if(b&&!b.disabled) b.focus(); }
  moveChain=moveChain.then(async()=>{
    try{ for(const j of jobs) await api("POST","/api/plans/reorder",{year,doc:j.doc,ids:j.ids}); }
    catch(err){ flash("순서를 저장하지 못했습니다: "+err.message,true); }
    await load();
  });
}
// 한 칸씩 위(-1)/아래(+1)
function movePlans(ids, dir, focusKey){
  const by=groupByDoc(ids), jobs=[];
  Object.keys(by).forEach(doc=>{
    const chosen=new Set(by[doc]), arr=docList(doc);
    if(dir<0){ for(let i=1;i<arr.length;i++) if(chosen.has(arr[i]) && !chosen.has(arr[i-1])) [arr[i-1],arr[i]]=[arr[i],arr[i-1]]; }
    else { for(let i=arr.length-2;i>=0;i--) if(chosen.has(arr[i]) && !chosen.has(arr[i+1])) [arr[i+1],arr[i]]=[arr[i],arr[i+1]]; }
    jobs.push({doc,ids:arr});
  });
  commitOrder(jobs, focusKey);
}
// 선택한 지표를 맨 위/맨 아래/n번째(1부터)로. 선택한 것끼리의 순서는 유지한다.
function placePlans(ids, where, n){
  const by=groupByDoc(ids), jobs=[];
  Object.keys(by).forEach(doc=>{
    const chosen=new Set(by[doc]), list=docList(doc);
    const mine=list.filter(id=>chosen.has(id)), rest=list.filter(id=>!chosen.has(id));
    const at = where==="top" ? 0 : where==="bottom" ? rest.length : Math.min(Math.max((n|0)-1,0), rest.length);
    jobs.push({doc, ids:[...rest.slice(0,at), ...mine, ...rest.slice(at)]});
  });
  commitOrder(jobs);
}
function gotoPlans(bar){
  const n=parseInt(bar.querySelector(".mvPos").value,10);
  if(!(n>=1)){ flash("이동할 번호를 1 이상의 숫자로 입력하세요.",true); return; }
  $("#banner").hidden=true; placePlans([...picked],"index",n);
}
document.addEventListener("keydown", e=>{
  if(e.key==="Enter" && e.target.matches(".mvPos")){ e.preventDefault(); gotoPlans(e.target.closest(".copybar")); }
});

/* ---------- 계획서 추가·이름 수정 ---------- */
const docDlg=$("#docDlg"); let editingDoc=null;
docDlg.addEventListener("click", e=>{ if(e.target.matches("[data-close]")||e.target===docDlg) docDlg.close(); });
function openDocDlg(key){
  editingDoc = key && DOCMAP[key] ? key : null;
  $("#docForm").reset(); $("#dMsg").textContent="";
  $("#docDlgTitle").textContent = editingDoc ? "계획서 이름 수정" : "계획서 추가";
  $("#docDlgHint").textContent = editingDoc ? "이름을 바꿔도 이 계획서의 지표와 실적은 그대로 유지됩니다." : "새 계획서는 모든 연도에서 쓸 수 있고, 만든 뒤 지표를 추가하면 됩니다.";
  $("#dSubmit").textContent = editingDoc ? "저장" : "추가";
  if(editingDoc) $("#dName").value=DOCMAP[editingDoc].name;
  docDlg.showModal(); $("#dName").focus(); $("#dName").select();
}
$("#docForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const m=$("#dMsg"), name=$("#dName").value.trim();
  if(!name){ m.className="msg err"; m.textContent="계획서 이름을 입력하세요."; return; }
  const btn=$("#dSubmit"); btn.disabled=true;
  try{
    if(editingDoc){ await api("PUT","/api/docs/"+encodeURIComponent(editingDoc),{name}); await load(); docDlg.close(); copyMsg=""; render(); }
    else{
      const r=await api("POST","/api/docs",{name}); await load(); docDlg.close();
      location.hash=r.key; // 새 계획서 탭으로 이동
    }
  }catch(err){ m.className="msg err"; m.textContent="저장하지 못했습니다: "+err.message; }
  finally{ btn.disabled=false; }
});

/* ---------- 선택한 지표 수정·삭제 ---------- */
const bulkDlg=$("#bulkDlg");
bulkDlg.addEventListener("click", e=>{ if(e.target.matches("[data-close]")||e.target===bulkDlg) bulkDlg.close(); });
function editSelected(){
  const ids=[...picked]; if(!ids.length) return;
  if(ids.length===1){
    if(!dlg.open){ resetPlanForm(); renderPlanList(); dlg.showModal(); closeAfterEdit=true; }
    startEditPlan(ids[0]); return;
  }
  $("#bulkTitle").textContent=`지표 ${ids.length}개 한꺼번에 수정`;
  $("#bulkForm").reset(); $("#bMsg").textContent=""; bulkDlg.showModal(); $("#bTarget").focus();
}
$("#bulkForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const m=$("#bMsg"), patch={}, t=$("#bTarget").value.trim();
  if(t!==""){ const n=parseFloat(t); if(!(n>=0)){ m.className="msg err"; m.textContent="연간 목표는 0 이상의 숫자로 입력하세요."; return; } patch.target=n; }
  [["bUnit","unit"],["bOwner","owner"],["bCalc","calc"]].forEach(([id,k])=>{ const v=$("#"+id).value.trim(); if(v!=="") patch[k]=v; });
  if(!Object.keys(patch).length){ m.className="msg err"; m.textContent="바꿀 항목을 하나 이상 입력하세요."; return; }
  const btn=$("#bSubmit"); btn.disabled=true;
  try{
    const r=await api("POST","/api/plans/update",{ids:[...picked],patch});
    bulkDlg.close(); copyMsg=`${r.count}개 지표를 수정했습니다.`; await load(); render();
  }catch(err){ m.className="msg err"; m.textContent="수정하지 못했습니다: "+err.message; }
  finally{ btn.disabled=false; }
});
async function deleteSelected(){
  const ids=[...picked]; if(!ids.length) return;
  try{
    const r=await api("POST","/api/plans/delete",{ids});
    if(selPlan && ids.includes(selPlan)) selPlan=null;
    picked.clear(); copyMsg=`${r.count}개 지표를 삭제했습니다.`; await load(); render();
  }catch(err){ flash("삭제하지 못했습니다: "+err.message,true); }
}

/* 계획서 카드 끌어서 순서 바꾸기 (현황·탭 순서 공통) */
let dragDoc=null;
const clearDocDrop=()=>document.querySelectorAll(".docwrap.drop-before,.docwrap.drop-after,.docwrap.dragging").forEach(el=>el.classList.remove("drop-before","drop-after","dragging"));
async function commitDocOrder(keys){
  const prev=DOCS.slice();
  setDocs(keys.map(k=>DOCMAP[k]).filter(Boolean)); render();
  try{ await api("POST","/api/docs/reorder",{keys}); }
  catch(err){ setDocs(prev); render(); flash("순서를 바꾸지 못했습니다: "+err.message,true); }
}
function moveDoc(key,dir){
  const keys=DOCS.map(d=>d.key), i=keys.indexOf(key), j=i+dir;
  if(i<0||j<0||j>=keys.length) return;
  keys.splice(j,0,keys.splice(i,1)[0]); commitDocOrder(keys);
}
document.addEventListener("click", e=>{
  const b=e.target.closest("[data-docmove]"); if(!b) return;
  moveDoc(b.dataset.key,+b.dataset.docmove);
});
document.addEventListener("dragstart", e=>{
  const w=e.target.closest?.(".docwrap"); if(!w||dragIds) return;
  dragDoc=w.dataset.doc; w.classList.add("dragging");
  e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain", dragDoc);
});
document.addEventListener("dragover", e=>{
  if(!dragDoc) return;
  const w=e.target.closest?.(".docwrap"); if(!w||w.dataset.doc===dragDoc) return;
  e.preventDefault(); e.dataTransfer.dropEffect="move";
  const r=w.getBoundingClientRect(), after=e.clientX>r.left+r.width/2;
  document.querySelectorAll(".docwrap.drop-before,.docwrap.drop-after").forEach(el=>el.classList.remove("drop-before","drop-after"));
  w.classList.add(after?"drop-after":"drop-before");
});
document.addEventListener("drop", e=>{
  if(!dragDoc) return;
  const w=e.target.closest?.(".docwrap"); if(!w||w.dataset.doc===dragDoc) return;
  e.preventDefault();
  const r=w.getBoundingClientRect(), after=e.clientX>r.left+r.width/2, from=dragDoc;
  clearDocDrop(); dragDoc=null;
  const rest=DOCS.map(d=>d.key).filter(k=>k!==from), at=rest.indexOf(w.dataset.doc)+(after?1:0);
  commitDocOrder([...rest.slice(0,at),from,...rest.slice(at)]);
});
document.addEventListener("dragend", ()=>{ clearDocDrop(); dragDoc=null; });

/* 끌어서 놓기 (표의 ⠿ 손잡이) */
let dragIds=null;
const clearDrop=()=>document.querySelectorAll(".drop-before,.drop-after").forEach(el=>el.classList.remove("drop-before","drop-after"));
document.addEventListener("dragstart", e=>{
  const h=e.target.closest?.("td.dh"); if(!h){ return; }
  const tr=h.closest("tr.row"), id=tr.dataset.plan;
  dragIds = picked.has(id) ? [...picked] : [id];
  e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain", id);
  try{ e.dataTransfer.setDragImage(tr, 16, 16); }catch(_){}
});
document.addEventListener("dragover", e=>{
  if(!dragIds) return;
  const tr=e.target.closest?.("tr.row"); if(!tr) return;
  e.preventDefault(); e.dataTransfer.dropEffect="move";
  const r=tr.getBoundingClientRect(), after=e.clientY>r.top+r.height/2;
  clearDrop(); tr.classList.add(after?"drop-after":"drop-before");
});
document.addEventListener("drop", e=>{
  if(!dragIds) return;
  const tr=e.target.closest?.("tr.row"); if(!tr) return;
  e.preventDefault();
  const r=tr.getBoundingClientRect(), after=e.clientY>r.top+r.height/2, targetId=tr.dataset.plan;
  const target=plans.find(p=>p.id===targetId), doc=docOf(target);
  const chosen=new Set(dragIds.filter(id=>docOf(plans.find(p=>p.id===id))===doc && id!==targetId));
  const list=docList(doc), mine=list.filter(id=>chosen.has(id));
  if(!mine.length){ clearDrop(); dragIds=null; return; }
  const rest=list.filter(id=>!chosen.has(id)), at=rest.indexOf(targetId)+(after?1:0);
  clearDrop(); dragIds=null;
  commitOrder([{doc, ids:[...rest.slice(0,at), ...mine, ...rest.slice(at)]}]);
});
document.addEventListener("dragend", ()=>{ clearDrop(); dragIds=null; });

document.addEventListener("change", e=>{
  if(e.target.matches(".cbYear")){ pasteYear=+e.target.value; copyMsg=""; renderCopyBars(); }
  else if(e.target.matches(".cbDoc")){ pasteDoc=e.target.value; renderCopyBars(); }
});

/* ---------- 시작 ---------- */
render();
load();
})();
