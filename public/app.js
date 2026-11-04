(function(){
"use strict";
const DOCS=[
  {key:"main",name:"주요업무계획"},{key:"district",name:"구정성과"},{key:"dept",name:"부서별 성과관리"},
  {key:"budget",name:"예산의 성과지표"},{key:"audit",name:"행정사무감사"},{key:"health",name:"지역보건의료계획"},
  {key:"center",name:"센터 계획서"},{key:"child",name:"아동정책계획"},{key:"youth",name:"청년정책계획"},{key:"rights",name:"인권계획"}
];
const DOCMAP=Object.fromEntries(DOCS.map(d=>[d.key,d]));
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
let year = today.getFullYear();
let curDoc = "all";
let selPlan = null, logMonth = "all", editingPlan = null;
const picked = new Set();
let copyMsg = "";
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
      plans=d.plans; records=d.records; knownYears=d.years||[];
      loaded=true; lastSync=new Date(); $("#banner").hidden=true;
      render();
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
window.addEventListener("hashchange", ()=>{ readHash(); render(); });
readHash();

/* ---------- 연도 ---------- */
function fillYears(){
  const ys = new Set([2025,2026,2027,2028,2029,2030, ...knownYears, year]);
  $("#yearSel").innerHTML = [...ys].sort().map(y=>`<option value="${y}"${y===year?" selected":""}>${y}년</option>`).join("");
}
$("#yearSel").addEventListener("change", e => { year=+e.target.value; selPlan=null; picked.clear(); logMonth="all"; $("#fDate").value=""; plans=[]; records=[]; loaded=false; render(); load(); });

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
      if(!dps.length) return `<a class="doccard empty-card" href="#${t.key}"><div class="top"><h3>${esc(t.name)}</h3></div><div class="meta">등록된 지표 없음 · 눌러서 추가</div></a>`;
      const st={done:0,ok:0,warn:0,bad:0,none:0}; const lag=[]; let sum=0;
      dps.forEach(p=>{ const r=rateOf(p,totals); sum+=Math.min(r,100); const [c]=status(r,el,!!last[p.id]); st[c]++; if(c==="bad") lag.push(p.name); });
      const n=dps.length, keys=["done","ok","warn","bad","none"], labels={done:"달성",ok:"순항",warn:"주의",bad:"부진",none:"시작 전"};
      const bar=keys.map(k=>st[k]?`<span class="s-${k}" style="width:${st[k]/n*100}%"></span>`:"").join("");
      const label=keys.filter(k=>st[k]).map(k=>labels[k]+" "+st[k]).join(" · ");
      return `<a class="doccard" href="#${t.key}"><div class="top"><h3>${esc(t.name)}</h3><span class="meta">지표 ${n}</span></div>
        <div class="rate">${pct(sum/n)}</div>
        <div class="stack" role="img" aria-label="${esc(label)}">${bar}</div>
        <div class="meta">${esc(label)}</div>
        ${lag.length?`<div class="lag" title="${esc(lag.join(", "))}">부진: ${esc(lag.slice(0,2).join(", "))}${lag.length>2?` 외 ${lag.length-2}`:""}</div>`:""}</a>`;
    }).join("");
    $("#docGrid").innerHTML=`<div class="docgrid">${cards}</div>`;
  }

  $("#tablePanel").hidden = isAll; $("#heatPanel").hidden = isAll;
  if(!isAll){
    $("#tableTitle").textContent = `${docName(curDoc)} 지표별 진도`;
    const tw=$("#planTableWrap");
    if(!ps.length){
      tw.innerHTML=`<div class="empty"><strong>${year}년 ${esc(docName(curDoc))} 지표가 아직 없습니다.</strong><span>계획서에 있는 성과지표와 연간 목표를 등록하면 날짜별 실적을 입력할 수 있어요.</span><button class="primary" type="button" data-act="openPlans">지표 추가</button></div>`;
    } else {
      const allPicked = ps.every(p=>picked.has(p.id));
      tw.innerHTML=`<table><thead><tr><th class="pk"><input type="checkbox" class="pick" id="pickAll" data-pickall aria-label="이 계획서 지표 모두 선택"${allPicked?" checked":""}></th><th>지표명</th><th class="r">연간 목표</th><th class="r">최근 실적</th><th>달성률</th><th class="r"></th><th>상태</th></tr></thead><tbody>${
        ps.map((p,i)=>{ const r=rates[i], [cls,lab]=status(r,el,!!last[p.id]);
          return `<tr class="row${selPlan===p.id?" sel":""}" data-plan="${esc(p.id)}" tabindex="0" title="이 지표의 실적만 보기">
            <td class="pk"><input type="checkbox" class="pick" id="pick-${esc(p.id)}" data-pick="${esc(p.id)}" aria-label="${esc(p.name)} 선택"${picked.has(p.id)?" checked":""}></td>
            <td><div class="pname">${esc(p.name)}</div>${p.calc?`<div class="pcat">산출내역: ${esc(p.calc)}</div>`:""}</td>
            <td class="r num">${fmt(p.target||0)} <span class="muted">${esc(p.unit||"")}</span></td>
            <td class="r num">${last[p.id]?`${fmt(totals[p.id]||0)} <span class="muted">${esc(p.unit||"")}</span><div class="pcat">${last[p.id].slice(5).replace("-","/")} 입력</div>`:`<span class="muted">–</span>`}</td>
            <td><div class="prog" role="img" aria-label="달성률 ${pct(r)}, 경과율 ${pct(el)}"><div class="fill" style="width:${Math.min(r,100)}%"></div><div class="mark" style="left:calc(${Math.min(el,100)}% - 1px)"></div></div></td>
            <td class="r num">${p.target>0?pct(r):"목표 없음"}</td>
            <td><span class="pill ${cls}">${lab}</span></td></tr>`; }).join("")
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
$("#fDoc").addEventListener("change", ()=>fillPlanSelect());
$("#fPlan").addEventListener("change", updateUnit);
$("#logMonth").addEventListener("change", e=>{ logMonth=e.target.value; render(); });
$("#fAuthor").value = store.get("mh_author") || "";
$("#fAuthor").addEventListener("change", e=>store.set("mh_author", e.target.value.trim()));

function renderLog(rs, all){
  const pmap=Object.fromEntries(all.map(p=>[p.id,p]));
  let list=rs.filter(r=>pmap[r.planId]);
  if(selPlan) list=list.filter(r=>r.planId===selPlan);
  if(logMonth!=="all") list=list.filter(r=>+r.date.slice(5,7)===+logMonth);
  list.sort((a,b)=>b.date.localeCompare(a.date)||(b.createdAt||"").localeCompare(a.createdAt||""));
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
  if(act==="paste"){ doPaste(actEl.closest(".copybar")); return; }
  if(act==="unpick"){ picked.clear(); copyMsg=""; render(); return; }
  if(act==="openPlans"){ openPlans(); return; }
  if(act==="clearSel"){ selPlan=null; render(); return; }
  const row=e.target.closest("tr.row");
  if(row){ selPlan=selPlan===row.dataset.plan?null:row.dataset.plan; render(); return; }
  const del=e.target.closest("[data-del]");
  if(del) confirmThen(del, async()=>{ try{ await api("DELETE","/api/records/"+encodeURIComponent(del.dataset.del)); await load(); }catch(err){ flash("삭제하지 못했습니다: "+err.message,true); } });
  const pdel=e.target.closest("[data-pdel]");
  if(pdel){
    const id=pdel.dataset.pdel, n=records.filter(r=>r.planId===id).length;
    confirmThen(pdel, async()=>{
      try{ await api("DELETE","/api/plans/"+encodeURIComponent(id)); if(selPlan===id) selPlan=null; picked.delete(id); await load(); }
      catch(err){ $("#pMsg").className="msg err"; $("#pMsg").textContent="삭제하지 못했습니다: "+err.message; }
    }, n?`실적 ${n}건도 삭제`:"삭제 확인");
  }
  const pedit=e.target.closest("[data-pedit]");
  if(pedit) startEditPlan(pedit.dataset.pedit);
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
$("#pDoc").innerHTML = DOCS.map(d=>`<option value="${d.key}">${esc(d.name)}</option>`).join("");
function openPlans(){ resetPlanForm(); renderPlanList(); dlg.showModal(); $("#pName").focus(); }
$("#managePlans").addEventListener("click", openPlans);
dlg.addEventListener("click", e=>{ if(e.target.matches("[data-close]")||e.target===dlg) dlg.close(); });
function renderPlanList(){
  const all=allYearPlans(), w=$("#planListWrap");
  const groups = curDoc==="all" ? DOCS.map(d=>d.key) : [curDoc];
  let html="", n=0;
  groups.forEach(k=>{
    const ps=all.filter(p=>docOf(p)===k); if(!ps.length) return; n+=ps.length;
    if(curDoc==="all") html+=`<li class="grp">${esc(docName(k))}</li>`;
    html+=ps.map(p=>`<li><div class="lft"><input type="checkbox" class="pick" id="dpick-${esc(p.id)}" data-pick="${esc(p.id)}" aria-label="${esc(p.name)} 선택"${picked.has(p.id)?" checked":""}><div><div class="pname">${esc(p.name)}</div><div class="pcat">목표 ${fmt(p.target||0)}${esc(p.unit||"")}${p.owner?` · 담당 ${esc(p.owner)}`:""}</div>${p.calc?`<div class="pcat">산출내역: ${esc(p.calc)}</div>`:""}</div></div><div style="display:flex;gap:2px;flex-shrink:0"><button class="ghost" type="button" data-pedit="${esc(p.id)}">수정</button><button class="ghost danger" type="button" data-pdel="${esc(p.id)}">삭제</button></div></li>`).join("");
  });
  const scope = curDoc==="all" ? `${year}년 전체 지표` : `${year}년 ${docName(curDoc)} 지표`;
  w.innerHTML = n ? `<div class="eyebrow">${esc(scope)} (${n})</div><div class="hint">지표를 체크하면 다른 계획서에 붙여넣을 수 있습니다.</div><ul class="planlist">${html}</ul>` : `<div class="hint">${esc(scope)}가 아직 없습니다.</div>`;
  renderCopyBars();
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
    resetPlanForm(); $("#pDoc").value=data.doc; m.className="msg ok"; m.textContent=t; $("#pName").focus();
  }catch(err){ m.className="msg err"; m.textContent="저장하지 못했습니다: "+err.message; }
  finally{ btn.disabled=false; }
});

/* ---------- 지표 복사 → 다른 계획서에 붙여넣기 ---------- */
function renderCopyBars(){
  const valid=new Set(allYearPlans().map(p=>p.id));
  [...picked].forEach(id=>{ if(!valid.has(id)) picked.delete(id); });
  const srcDocs=new Set([...picked].map(id=>docOf(plans.find(p=>p.id===id))));
  const targets=DOCS.filter(d=>!(srcDocs.size===1 && srcDocs.has(d.key)));
  document.querySelectorAll(".copybar").forEach((bar,i)=>{
    if(!picked.size && !copyMsg){ bar.hidden=true; bar.innerHTML=""; return; }
    bar.hidden=false;
    const prevSel=bar.querySelector("select")?.value, prevRec=bar.querySelector("input[type=checkbox]")?.checked;
    bar.innerHTML = picked.size ? `<span class="cnt">${picked.size}개 지표 선택</span>
      <label for="cbDoc${i}">붙여넣을 계획서</label>
      <select id="cbDoc${i}" class="cbDoc">${targets.map(d=>`<option value="${d.key}">${esc(d.name)}</option>`).join("")}</select>
      <label><input type="checkbox" id="cbRec${i}" class="cbRec"${prevRec?" checked":""}> 기존 실적도 복사</label>
      <button class="primary" type="button" data-act="paste">붙여넣기</button>
      <button class="ghost" type="button" data-act="unpick">선택 해제</button>
      <div class="msg ok">${esc(copyMsg)}</div>` : `<div class="msg ok">${esc(copyMsg)}</div><button class="ghost" type="button" data-act="unpick">닫기</button>`;
    if(prevSel && targets.some(d=>d.key===prevSel)) bar.querySelector("select").value=prevSel;
  });
}
async function doPaste(bar){
  const target=bar.querySelector(".cbDoc").value, withRecords=bar.querySelector(".cbRec").checked;
  bar.querySelector('[data-act="paste"]').disabled=true;
  try{
    const r=await api("POST","/api/plans/copy",{ids:[...picked],doc:target,withRecords});
    copyMsg=`${docName(target)}에 ${r.added}개 붙여넣었습니다${r.records?` (실적 ${r.records}건 포함)`:""}.${r.skipped.length?` 이미 있는 지표 ${r.skipped.length}개는 건너뜀: ${r.skipped.join(", ")}`:""} 목표치가 다르면 해당 탭에서 수정하세요.`;
    picked.clear();
    await load();
  }catch(err){ copyMsg="붙여넣지 못했습니다: "+err.message; render(); }
}

/* ---------- 시작 ---------- */
render();
load();
})();
