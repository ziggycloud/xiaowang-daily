const app = document.querySelector('#app');
const dialog = document.querySelector('#editor-dialog');
const toastEl = document.querySelector('#toast');
let state = {today: new Date().toLocaleDateString('sv-SE'), tasks: [], plans: [], milestones: [], prerequisites: [], insights: []};
let selectedDay = state.today;
let selectedPlan = null;
let selectedInsight = state.today;
let dashboardRange = 30;
const collapsedTasks = new Set();
let journalTimer;
let journalQuery = '';
let toastTimer;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = d => d ? new Date(`${d}T12:00:00`).toLocaleDateString('zh-CN', {year:'numeric',month:'long',day:'numeric',weekday:'long'}) : '';
const shortDate = d => d ? new Date(`${d}T12:00:00`).toLocaleDateString('zh-CN', {month:'short',day:'numeric'}) : '未设置日期';
const dayShift = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate()+n); return x.toLocaleDateString('sv-SE'); };
const horizonLabel = {long:'长期方向',medium:'阶段目标',short:'近期行动'};
const statusLabel = {active:'进行中',paused:'已暂停',done:'已完成'};
const route = () => ['/','/today','/plans','/insights','/dashboard'].includes(location.pathname) ? location.pathname : '/';
const byId = (arr,id) => arr.find(x => x.id === Number(id));
const localStampDay = stamp => stamp ? new Date(stamp).toLocaleDateString('sv-SE') : '';
const activeTasks = () => state.tasks.filter(t => !t.completed_at);
const doneTasks = () => state.tasks.filter(t => !!t.completed_at);
const isDailyTask = t => ['english_vocab','english_listening'].includes(t.recurrence_key);

async function request(path, method='GET', data) {
  const r = await fetch(path, {method, headers: data === undefined ? {} : {'Content-Type':'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  let body;
  try { body = await r.json(); } catch { throw new Error('服务暂时不可用'); }
  if (!r.ok) throw new Error(body.error || '操作失败');
  return body;
}
async function refresh(redraw=true) {
  state = await request(`/api/bootstrap?day=${encodeURIComponent(selectedDay)}`);
  if (!selectedPlan && state.plans.length) selectedPlan = state.plans[0].id;
  if (selectedPlan && !byId(state.plans,selectedPlan)) selectedPlan = state.plans[0]?.id || null;
  if (redraw) render();
}
async function change(collection, method, id, data, message) {
  try {
    const result = await request(`/api/${collection}${id ? `/${id}` : ''}`, method, data);
    await refresh();
    if (message) toast(message);
    return result;
  } catch(e) { toast(e.message, true); return false; }
}
function toast(message, error=false) {
  toastEl.textContent = message;
  toastEl.style.background = error ? '#a64e4e' : '';
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
async function go(path) {
  if (location.pathname !== path) history.pushState({},'',path);
  try { await refresh(false); } catch(e) { toast(e.message,true); }
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}
function render() {
  const r = route();
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active',a.getAttribute('href')===r));
  app.innerHTML = r === '/' ? home() : r === '/today' ? todayPage() : r === '/plans' ? plansPage() : r === '/insights' ? insightsPage() : dashboardPage();
  document.title = `${r==='/'?'首页':{'/today':'今日','/plans':'规划','/insights':'每日记录','/dashboard':'回顾'}[r]} · 小汪的日常`;
}
function head(kicker,title,subtitle,actions='') { return `<div class="page-head"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`; }

function home() {
  const todays = state.tasks.filter(t => !t.parent_task_id && t.planned_date && t.planned_date<=state.today && !t.completed_at);
  const next = state.milestones.filter(m=>!m.completed_at && m.target_date).sort((a,b)=>a.target_date.localeCompare(b.target_date))[0];
  const journal = state.insights.find(i=>i.entry_date===state.today);
  const recentDone = state.tasks.filter(t=>t.completed_at && localStampDay(t.completed_at)>=dayShift(state.today,-6)).length;
  return `<section class="home-hero"><div><div class="eyebrow">${esc(dateLabel(state.today))}</div><h1>小汪你好，<br>今天我们要做些什么呢？</h1><p>把想做的事写下来，把走过的路留下来。<br>从今天的一小步开始。</p></div><div class="hero-note"><strong>今天，先做重要的事。</strong>你有 ${todays.length} 件待办。给计划留一点余地，也给自己留一点空间。</div></section>
    <section class="home-grid" aria-label="四个功能入口">
      <a class="home-card" href="/today" data-link><span class="num">01 / 今天</span><span class="arrow">↗</span><h2>今天，先做哪件事？</h2><p>${todays.length ? `还有 ${todays.filter(t=>t.category==='work').length} 件工作、${todays.filter(t=>t.category==='life').length} 件生活、${todays.filter(t=>t.category==='learning').length} 件个人学习待办` : '从写下第一件事开始'}</p></a>
      <a class="home-card" href="/plans" data-link><span class="num">02 / 规划</span><span class="arrow">↗</span><h2>未来几年，想抵达哪里？</h2><p>${next ? `下一个里程碑：${esc(next.title)} · ${shortDate(next.target_date)}` : '给想去的地方写下一个明确的方向'}</p></a>
      <a class="home-card" href="/insights" data-link><span class="num">03 / 记录</span><span class="arrow">↗</span><h2>今天，有什么值得记下？</h2><p>${journal?.success_body ? `成功日记：${esc(journal.success_body.slice(0,32))}` : journal?.body ? esc(journal.body.slice(0,42)) : '记下一件做成的事，或一点新的心得'}</p></a>
      <a class="home-card" href="/dashboard" data-link><span class="num">04 / 回顾</span><span class="arrow">↗</span><h2>回头看看，走了多远？</h2><p>最近 7 天完成了 ${recentDone} 件事</p></a>
    </section>`;
}

function childTasks(id) {
  return state.tasks.filter(t=>t.parent_task_id===id).sort((a,b)=>a.id-b.id);
}
function descendantTasks(id) {
  const found=[];
  const visit=parentId=>{for(const child of childTasks(parentId)){found.push(child);visit(child.id);}};
  visit(id);
  return found;
}
function deadlineBadge(t) {
  if(!t.deadline_date)return '';
  const expired=!t.completed_at && t.deadline_date<state.today;
  const today=!t.completed_at && t.deadline_date===state.today;
  return `<span class="deadline-tag ${expired?'expired':today?'today':''}">${expired?'DDL 已逾期 · ':today?'今日 DDL · ':'DDL · '}${shortDate(t.deadline_date)}</span>`;
}
function taskRow(t) {
  const plan = t.plan_id ? byId(state.plans,t.plan_id) : null;
  const children=childTasks(t.id), descendants=children.length?descendantTasks(t.id):[];
  const complete=descendants.filter(x=>x.completed_at).length;
  const collapsed=collapsedTasks.has(t.id);
  const resource=t.recurrence_key==='english_vocab'?['https://web.shanbay.com/web/main','打开扇贝']:t.recurrence_key==='english_listening'?['https://www.shanbay.com/listen/books/all/','扇贝听力']:null;
  return `<li class="task-node"><div class="task-row ${t.completed_at?'done':''}">${children.length?`<button class="branch-toggle" type="button" data-action="toggle-branch-open" data-id="${t.id}" aria-expanded="${!collapsed}" aria-label="${collapsed?'展开':'收起'} ${esc(t.title)} 的分支">${collapsed?'▸':'▾'}</button>`:'<span class="branch-spacer" aria-hidden="true"></span>'}<input class="check" type="checkbox" data-action="toggle-tasks" data-id="${t.id}" ${t.completed_at?'checked':''} aria-label="${t.completed_at?'取消完成':'完成'} ${esc(t.title)}"><div class="task-main"><div class="task-title">${esc(t.title)}</div><div class="task-meta">${t.due_time?`<span>${esc(t.due_time)}</span>`:''}${deadlineBadge(t)}${t.priority?`<span class="priority">${t.priority===2?'重要':'优先'}</span>`:''}${plan&&!t.parent_task_id?`<span>关联：${esc(plan.title)}</span>`:''}${isDailyTask(t)?'<span class="daily-tag">每日任务</span>':''}${descendants.length?`<span class="branch-progress">分支 ${complete}/${descendants.length}</span>`:''}${resource?`<a class="task-resource" href="${resource[0]}" target="_blank" rel="noopener noreferrer">${resource[1]} ↗</a>`:''}${!isDailyTask(t)&&t.planned_date&&t.planned_date<selectedDay&&!t.completed_at&&!t.parent_task_id?`<span class="carry-tag">原定 ${shortDate(t.planned_date)}</span>`:''}</div></div><div class="row-actions">${!t.recurrence_key?`<button type="button" data-action="new-branch" data-id="${t.id}" aria-label="为 ${esc(t.title)} 添加分支">＋ 分支</button>`:''}<button type="button" data-action="edit-task" data-id="${t.id}" aria-label="编辑 ${esc(t.title)}">编辑</button></div></div>${children.length&&!collapsed?`<ul class="task-branches">${children.map(taskRow).join('')}</ul>`:''}</li>`;
}
function todayPage() {
  const roots=state.tasks.filter(t=>!t.parent_task_id);
  const dateTasks = roots.filter(t=>t.planned_date===selectedDay);
  const carried = roots.filter(t=>!t.recurrence_key && !t.completed_at && t.planned_date && t.planned_date<selectedDay);
  const backlog = roots.filter(t=>!t.completed_at && !t.planned_date);
  const col = (name,key) => {
    const list = dateTasks.filter(t=>t.category===key);
    const open = list.filter(t=>!t.completed_at);
    const old = carried.filter(t=>t.category===key).sort((a,b)=>b.planned_date.localeCompare(a.planned_date));
    const done = list.filter(t=>t.completed_at);
    const openCount=[...open,...old].flatMap(t=>[t,...descendantTasks(t.id)]).filter(t=>!t.completed_at).length;
    const emptyText=key==='work'?'例如添加「完成一个需求」，再拆成需求澄清、方案设计、开发联调、测试上线。':key==='learning'?'例如读几页书、练一道题，或记下一个新知识点。':'这一栏暂时没有待办。<br>给自己留一点空间。';
    return `<section class="task-column"><div class="column-head"><h2>${name}</h2><span class="count">${openCount} 件待办</span></div>${open.length?`<ul class="task-list">${open.map(taskRow).join('')}</ul>`:''}${old.length?`<div class="section-label">此前未完成 · ${old.length}</div><ul class="task-list">${old.map(taskRow).join('')}</ul>`:''}${!open.length&&!old.length?`<div class="empty">${emptyText}</div>`:''}${done.length?`<div class="section-label">已完成 ${done.length}</div><ul class="task-list">${done.map(taskRow).join('')}</ul>`:''}</section>`;
  };
  return `${head('TODAY',selectedDay===state.today?'今天，稳稳向前':dateLabel(selectedDay),'工作、生活与个人学习，都可以一步一步来。',`<div class="date-toolbar"><button class="icon-button" data-action="day-prev" aria-label="前一天">‹</button><input class="input" id="day-input" type="date" value="${selectedDay}" aria-label="选择日期"><button class="icon-button" data-action="day-next" aria-label="后一天">›</button></div>`)}
    <form class="quick-add" id="quick-add"><input name="title" placeholder="写下一件要做的事…" aria-label="新待办" required maxlength="240"><select class="input" name="category" aria-label="待办分类"><option value="work">工作</option><option value="life">生活</option><option value="learning">个人学习</option></select><label class="quick-deadline"><span>DDL</span><input class="input" id="quick-deadline" name="deadline_date" type="date" value="${selectedDay}" aria-label="截止日期，可留空"><button type="button" data-action="clear-quick-deadline" aria-label="不设截止日期" title="不设截止日期">×</button></label><button class="primary" type="submit">添加待办</button></form><p class="branch-help">复杂任务可以点「＋ 分支」逐层拆解；每一步都能单独勾选。勾选主任务会完成整棵分支。</p>
    <div class="today-columns">${col('工作','work')}${col('生活','life')}${col('个人学习','learning')}</div>
    ${backlog.length?`<details class="backlog"><summary>稍后安排 · ${backlog.length} 件无日期待办</summary><ul class="task-list">${backlog.map(taskRow).join('')}</ul></details>`:''}`;
}

function planProgress(p) {
  const ms = state.milestones.filter(m=>m.plan_id===p.id);
  if (!ms.length) return {value:p.manual_progress,source:'手动更新'};
  const all = ms.reduce((n,m)=>n+m.weight,0), done = ms.filter(m=>m.completed_at).reduce((n,m)=>n+m.weight,0);
  return {value:Math.round(done/all*100),source:`按 ${ms.length} 个里程碑计算`};
}
function plansPage() {
  const p = byId(state.plans,selectedPlan);
  const sidebar = ['long','medium','short'].map(h=>`<h3>${horizonLabel[h]}</h3>${state.plans.filter(p=>p.horizon===h).map(p=>`<button class="plan-select ${p.id===selectedPlan?'active':''}" data-action="select-plan" data-id="${p.id}"><strong>${esc(p.title)}</strong><span>${p.target_date?shortDate(p.target_date):'未设置期限'} · ${planProgress(p).value}%</span></button>`).join('')}`).join('');
  return `${head('PLANS','未来几年，我们要去哪里？','把方向写清楚，再把它拆成眼前能做的一步。','<button class="primary" data-action="new-plan">＋ 新建规划</button>')}
    <div class="plans-layout"><aside class="plans-sidebar" aria-label="规划列表">${sidebar||''}</aside><div>${p?planDetail(p):'<div class="plan-detail"><div class="empty"><h2>先写下一个想实现的目标</h2><p>可以从一个近期目标开始，之后再慢慢拓展。</p><button class="primary" data-action="new-plan">新建规划</button></div></div>'}</div></div>`;
}
function lineItems(items,collection) {
  return items.map(x=>`<div class="line-item"><input class="check" type="checkbox" data-action="toggle-${collection}" data-id="${x.id}" ${x.completed_at?'checked':''} aria-label="${x.completed_at?'取消完成':'完成'} ${esc(x.title)}"><div class="line-content" style="${x.completed_at?'color:#91a098;text-decoration:line-through':''}">${esc(x.title)}${x.target_date?`<small>${shortDate(x.target_date)}</small>`:''}</div><button type="button" data-action="delete-${collection}" data-id="${x.id}" title="删除">×</button></div>`).join('');
}
function planDetail(p) {
  const pr = planProgress(p), ms = state.milestones.filter(x=>x.plan_id===p.id), prereq = state.prerequisites.filter(x=>x.plan_id===p.id), tasks = state.tasks.filter(t=>t.plan_id===p.id);
  const blocked = prereq.some(x=>!x.completed_at);
  return `<article class="plan-detail"><div class="plan-detail-head"><div><span class="eyebrow">${horizonLabel[p.horizon]}</span><h2>${esc(p.title)}</h2></div><div class="page-actions"><button class="secondary tiny" data-action="edit-plan" data-id="${p.id}">编辑</button><span class="status-chip ${p.status}">${blocked&&p.status==='active'?'待准备':statusLabel[p.status]}</span></div></div>
    ${p.description?`<p class="plan-description">${esc(p.description)}</p>`:''}<div class="plan-meta">${p.parent_id&&byId(state.plans,p.parent_id)?`<span>上级规划 <strong>${esc(byId(state.plans,p.parent_id).title)}</strong></span>`:''}<span>开始 <strong>${p.start_date?shortDate(p.start_date):'未设置'}</strong></span><span>目标 <strong>${p.target_date?shortDate(p.target_date):'未设置'}</strong></span><span>更新 <strong>${shortDate(localStampDay(p.updated_at))}</strong></span></div>
    <div class="progress-head"><strong>完成进度</strong><span>${pr.value}% · ${pr.source}</span></div><div class="progress-track" role="progressbar" aria-valuenow="${pr.value}" aria-valuemin="0" aria-valuemax="100" aria-label="规划完成进度"><div class="progress-fill" style="width:${pr.value}%"></div></div>
    <section class="plan-section"><h3>交付物</h3><p>${p.deliverable?esc(p.deliverable):'写下一个能看得见、能验证的结果。'}</p></section>
    <section class="plan-section"><h3>前提准备</h3>${prereq.length?lineItems(prereq,'prerequisites'):'<p>暂时没有前提准备。</p>'}<form class="inline-add" data-form="add-prerequisite" data-plan="${p.id}"><input class="input" name="title" placeholder="例如：整理作品素材" required maxlength="240"><button class="secondary tiny" type="submit">添加</button></form></section>
    <section class="plan-section"><h3>里程碑</h3>${ms.length?lineItems(ms,'milestones'):'<p>用可验证的节点记录推进。</p>'}<form class="inline-add" data-form="add-milestone" data-plan="${p.id}"><input class="input" name="title" placeholder="例如：完成第一版作品集" required maxlength="240"><button class="secondary tiny" type="submit">添加</button></form></section>
    <section class="plan-section"><h3>关联待办</h3>${tasks.length?`<div class="linked-tasks">${tasks.slice(0,8).map(t=>`<div class="linked-task"><span>${t.completed_at?'✓ ':''}${esc(t.title)}</span><span>${t.planned_date?shortDate(t.planned_date):'未排期'}</span></div>`).join('')}</div>`:'<p>把目标拆成今天能执行的任务。</p>'}<button class="secondary tiny" data-action="new-linked-task" data-id="${p.id}">＋ 添加关联待办</button></section></article>`;
}

function historyItems() {
  const filtered=state.insights.filter(i=>[i.title,i.body,i.success_body,i.tags].join(' ').toLowerCase().includes(journalQuery.toLowerCase()));
  let month='';
  return filtered.map(i=>{const m=i.entry_date.slice(0,7), label=m!==month?`<div class="history-month">${m.replace('-',' 年 ')} 月</div>`:'';month=m;const parts=[i.success_body?'成功日记':'',i.body||i.title?'心得':''].filter(Boolean).join(' · ');return `${label}<button class="history-item ${selectedInsight===i.entry_date?'active':''}" data-action="select-insight" data-date="${i.entry_date}"><time>${dateLabel(i.entry_date)}</time><strong>${esc(i.title||i.success_body?.slice(0,18)||i.body.slice(0,18)||'一则记录')}</strong><span>${esc(parts)}${parts?' · ':''}${esc((i.success_body||i.body||i.tags||'').slice(0,46))}</span></button>`;}).join('')||`<div class="empty">${journalQuery?'没有找到相关记录。':'还没有历史记录。'}</div>`;
}
function insightsPage() {
  const entry=state.insights.find(x=>x.entry_date===selectedInsight)||{};
  const selected=new Date(`${selectedInsight}T12:00:00`);
  const week=Array.from({length:7},(_,i)=>dayShift(state.today,i-6));
  return `${head('JOURNAL','把日子写下来','成功日记记下做成的事，心得留给想法与感受。')}
    <div class="journal-nav"><div class="journal-nav-main"><button class="icon-button" type="button" data-action="insight-prev" aria-label="前一天">‹</button><input class="input" id="insight-date" type="date" value="${selectedInsight}" max="${state.today}" aria-label="选择心得日期"><button class="icon-button" type="button" data-action="insight-next" aria-label="后一天" ${selectedInsight>=state.today?'disabled':''}>›</button><button class="secondary tiny" type="button" data-action="insight-yesterday">昨天</button>${selectedInsight!==state.today?'<button class="quiet tiny" type="button" data-action="insight-today">回到今天</button>':''}</div><span class="journal-nav-hint">${entry.id?'这一天已记录':'这一天还没有记录，可以从这里写起'}</span></div>
    <div class="journal-layout"><section class="journal-editor"><div class="journal-paper-head"><div class="journal-day">${Number(selectedInsight.slice(8))}</div><div class="journal-paper-date"><strong>${selected.toLocaleDateString('zh-CN',{year:'numeric',month:'long',weekday:'long'})}</strong><span>${selectedInsight===state.today?'今天':selectedInsight===dayShift(state.today,-1)?'昨天':'往日的一页'}</span></div><span id="save-status" class="save-status">${entry.id?'已保存':'输入后自动保存'}</span></div>
      <div class="journal-section success-section"><div class="journal-section-head"><span class="journal-section-number">01</span><div><h2>成功日记</h2><p>今天做成了什么？再小的进展，也值得看见。</p></div></div><label class="sr-only" for="journal-success">成功日记</label><textarea class="journal-success-body" id="journal-success" placeholder="例如：主动推进了一件拖延的事；完成了一次有质量的沟通……&#10;每件事写一行就好。" aria-label="成功日记">${esc(entry.success_body||'')}</textarea></div>
      <div class="journal-section insight-section"><div class="journal-section-head"><span class="journal-section-number">02</span><div><h2>心得</h2><p>有什么新的想法、感受或收获？</p></div></div><label class="sr-only" for="journal-body">心得</label><textarea class="journal-body" id="journal-body" placeholder="把你的想法写在这里。" aria-label="心得正文">${esc(entry.body||'')}</textarea><details class="journal-extra" ${entry.title||entry.tags?'open':''}><summary>添加标题和标签 <span>可选</span></summary><div class="journal-extra-fields"><input class="input" id="journal-title" placeholder="给这一天起个标题" value="${esc(entry.title||'')}" maxlength="240" aria-label="心得标题"><input class="input" id="journal-tags" placeholder="标签，用逗号分隔" value="${esc(entry.tags||'')}" maxlength="400" aria-label="心得标签"></div></details></div>${entry.id?`<button class="text-button danger journal-delete" data-action="delete-insights" data-id="${entry.id}">删除这一天的全部记录</button>`:''}</section>
    <aside class="journal-history"><div class="journal-history-head"><h2>翻翻往日</h2><p>最近一周</p></div><div class="journal-week">${week.map(day=>`<button class="journal-week-day ${day===selectedInsight?'active':''}" data-action="select-insight" data-date="${day}" aria-label="查看 ${dateLabel(day)} 的记录"><span>${new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN',{weekday:'short'})}</span><strong>${Number(day.slice(8))}</strong><i class="${state.insights.some(x=>x.entry_date===day)?'recorded':''}" aria-hidden="true"></i></button>`).join('')}</div><input class="search-input" id="journal-search" placeholder="搜索以往的记录" value="${esc(journalQuery)}" aria-label="搜索记录"><div id="history-list">${historyItems()}</div></aside></div>`;
}
function dashboardPage() {
  const start=dayShift(state.today,-dashboardRange+1);
  const completed=state.tasks.filter(t=>t.completed_at && localStampDay(t.completed_at)>=start);
  const due=state.tasks.filter(t=>t.deadline_date && t.deadline_date>=start && t.deadline_date<=state.today);
  const dueDone=due.filter(t=>t.completed_at);
  const dailyDone=state.tasks.filter(t=>isDailyTask(t)&&t.completed_at&&t.planned_date<=state.today);
  const dailyInRange=dailyDone.filter(t=>t.planned_date>=start);
  const habitCount=(key,items)=>items.filter(t=>t.recurrence_key===key).length;
  const work=completed.filter(t=>t.category==='work').length, life=completed.filter(t=>t.category==='life').length, learning=completed.filter(t=>t.category==='learning').length;
  const journals=state.insights.filter(i=>i.entry_date>=start && i.entry_date<=state.today && (i.success_body||i.body||i.title));
  const active=state.plans.filter(p=>p.status==='active');
  const points=Array.from({length:dashboardRange},(_,i)=>{const day=dayShift(start,i);return completed.filter(t=>localStampDay(t.completed_at)===day).length;});
  const max=Math.max(1,...points);
  const upcoming=state.milestones.filter(m=>!m.completed_at && m.target_date && m.target_date>=state.today).sort((a,b)=>a.target_date.localeCompare(b.target_date)).slice(0,4);
  const recent=state.milestones.filter(m=>m.completed_at && localStampDay(m.completed_at)>=start).sort((a,b)=>b.completed_at.localeCompare(a.completed_at)).slice(0,4);
  return `${head('OVERVIEW','回头看看，已经走了多远','记录事实，不给自己打分。',`<div class="dashboard-top">${[7,30,90].map(n=>`<button class="secondary tiny ${dashboardRange===n?'active':''}" data-action="range" data-range="${n}">${n} 天</button>`).join('')}</div>`)}
    <div class="metric-grid"><div class="metric"><span class="label">完成待办</span><strong class="value">${completed.length}</strong><div class="sub">最近 ${dashboardRange} 天 · 含分支步骤</div></div><div class="metric"><span class="label">到期任务完成率</span><strong class="value">${due.length?`${Math.round(dueDone.length/due.length*100)}%`:'—'}</strong><div class="sub">${due.length?`${dueDone.length} / ${due.length} 件到期任务`:'暂无可计算数据'}</div></div><div class="metric"><span class="label">进行中的规划</span><strong class="value">${active.length}</strong><div class="sub">方向在慢慢清晰</div></div><div class="metric"><span class="label">写下记录的日子</span><strong class="value">${journals.length}</strong><div class="sub">最近 ${dashboardRange} 天</div></div></div>
    <section class="daily-summary" aria-label="每日任务完成次数"><div class="daily-summary-heading"><div><span class="eyebrow">每日任务</span><h2>坚持，正在留下记录</h2><p>最近 ${dashboardRange} 天完成 ${dailyInRange.length} 次 · 累计 ${dailyDone.length} 次</p></div><span class="daily-summary-icon" aria-hidden="true">✓</span></div><div class="daily-summary-stats"><div><span>扇贝单词</span><strong>${habitCount('english_vocab',dailyInRange)} 次</strong><small>累计 ${habitCount('english_vocab',dailyDone)} 次</small></div><div><span>扇贝听力</span><strong>${habitCount('english_listening',dailyInRange)} 次</strong><small>累计 ${habitCount('english_listening',dailyDone)} 次</small></div></div></section>
    <div class="dashboard-grid"><section class="chart-panel"><h2>每天完成的待办</h2><div class="bars" aria-label="每日完成待办柱形图">${points.map((n,i)=>`<div class="bar" style="height:${n?Math.max(5,Math.round(n/max*100)):1}%" data-tip="${shortDate(dayShift(start,i))} · ${n} 件" title="${shortDate(dayShift(start,i))}：${n} 件"></div>`).join('')}</div><div class="axis"><span>${shortDate(start)}</span><span>${shortDate(state.today)}</span></div></section>
    <section class="chart-panel"><h2>完成待办分类</h2><div class="split-row"><span>工作</span><strong>${work} 件</strong></div><div class="hbar"><div style="width:${completed.length?work/completed.length*100:0}%"></div></div><div class="split-row"><span>生活</span><strong>${life} 件</strong></div><div class="hbar life"><div style="width:${completed.length?life/completed.length*100:0}%"></div></div><div class="split-row"><span>个人学习</span><strong>${learning} 件</strong></div><div class="hbar learning"><div style="width:${completed.length?learning/completed.length*100:0}%"></div></div><p class="muted small" style="line-height:1.7;margin-top:27px">这里展示各类任务的完成数量。</p></section></div>
    <div class="dashboard-grid dashboard-lower"><section class="chart-panel"><h2>接下来的里程碑</h2>${upcoming.length?upcoming.map(m=>`<div class="recent-row"><span>${esc(m.title)} <span class="muted">· ${esc(byId(state.plans,m.plan_id)?.title||'')}</span></span><span>${shortDate(m.target_date)}</span></div>`).join(''):'<p class="muted small">还没有即将到来的里程碑。</p>'}</section><section class="chart-panel"><h2>最近达成</h2>${recent.length?recent.map(m=>`<div class="recent-row"><span>${esc(m.title)}</span><span>${shortDate(m.completed_at.slice(0,10))}</span></div>`).join(''):'<p class="muted small">完成一个里程碑后，会在这里留下记录。</p>'}</section></div>`;
}

function field(label,name,value='',type='text',extra='') { return `<label class="field ${extra}"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value??'')}"></label>`; }
function selectField(label,name,options,value,extra='') { return `<label class="field ${extra}"><span>${label}</span><select name="${name}">${options.map(([v,t])=>`<option value="${v}" ${v===value?'selected':''}>${t}</option>`).join('')}</select></label>`; }
function showDialog(title,fields,onSubmit,deleteAction,deleteMessage='确定删除这条记录吗？') {
  dialog.innerHTML=`<div class="dialog-inner"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭">×</button></div><form id="editor-form"><div class="form-grid">${fields}</div><div class="dialog-actions">${deleteAction?`<button class="text-button danger" type="button" data-action="dialog-delete">删除</button>`:'<span></span>'}<button class="primary" type="submit">保存</button></div></form></div>`;
  dialog.showModal();
  dialog.querySelector('input,textarea,select')?.focus();
  dialog.querySelector('#editor-form').onsubmit=async e=>{e.preventDefault(); const data=Object.fromEntries(new FormData(e.target));const ok=await onSubmit(data);if(ok)dialog.close();};
  dialog.querySelector('[data-action="close-dialog"]').onclick=()=>dialog.close();
  if(deleteAction) dialog.querySelector('[data-action="dialog-delete"]').onclick=async()=>{if(confirm(deleteMessage)){const ok=await deleteAction();if(ok)dialog.close();}};
}
function taskEditor(id=null,planId=null,parentTaskId=null) {
  const t=id?byId(state.tasks,id):null;
  const parent=byId(state.tasks,t?.parent_task_id||parentTaskId);
  const daily=!!t&&isDailyTask(t);
  const shared=`${field('任务内容 *','title',t?.title,'text','wide')}${field('截止日期（DDL，可留空）','deadline_date',t?(t.deadline_date||''):selectedDay,'date')}${field('计划时间','due_time',t?.due_time||'','time')}${selectField('优先级','priority',[['0','普通'],['1','优先'],['2','重要']],String(t?.priority||0))}<label class="field wide"><span>备注</span><textarea name="note">${esc(t?.note||'')}</textarea></label>`;
  const fields=daily?`<div class="subtle-box field wide">每日任务 · ${dateLabel(t.planned_date)}。完成后，下一天会生成新的任务；不设 DDL。</div>${field('任务内容 *','title',t.title,'text','wide')}<label class="field wide"><span>备注</span><textarea name="note">${esc(t.note||'')}</textarea></label>`:parent?`<div class="subtle-box field wide">属于「${esc(parent.title)}」；分支沿用主任务的计划日期和分类。</div>${shared}`:`${field('任务内容 *','title',t?.title,'text','wide')}${selectField('分类','category',[['work','工作'],['life','生活'],['learning','个人学习']],t?.category||'work')}${field('计划日期','planned_date',t?(t.planned_date||''):selectedDay,'date')}${field('截止日期（DDL，可留空）','deadline_date',t?(t.deadline_date||''):selectedDay,'date')}${field('计划时间','due_time',t?.due_time||'','time')}${selectField('优先级','priority',[['0','普通'],['1','优先'],['2','重要']],String(t?.priority||0))}${selectField('关联规划','plan_id',[['','不关联'],...state.plans.map(p=>[String(p.id),p.title])],String(t?.plan_id||planId||''),'wide')}<label class="field wide"><span>备注</span><textarea name="note">${esc(t?.note||'')}</textarea></label>`;
  showDialog(parent?(t?'编辑分支':'添加分支'):(t?'编辑待办':'添加待办'),fields,data=>{
    const payload=daily?{title:data.title,note:data.note}:parent?{title:data.title,deadline_date:data.deadline_date||null,due_time:data.due_time||null,priority:Number(data.priority),note:data.note,parent_task_id:parent.id}:{...data,priority:Number(data.priority),plan_id:data.plan_id||null,planned_date:data.planned_date||null,deadline_date:data.deadline_date||null,due_time:data.due_time||null};
    collapsedTasks.delete(parent?.id);
    return change('tasks',t?'PATCH':'POST',t?.id,payload,t?'待办已更新':parent?'分支已添加':'待办已添加');
  },t?()=>change('tasks','DELETE',t.id,undefined,'待办已删除'):null,descendantTasks(t?.id).length?'删除此任务及下面所有分支？':'确定删除这条待办吗？');
}
function planEditor(id=null) {
  const p=id?byId(state.plans,id):null;
  const fields=`${field('规划名称 *','title',p?.title,'text','wide')}${selectField('时间尺度','horizon',[['long','长期方向 · 1—3 年'],['medium','阶段目标 · 3—12 个月'],['short','近期行动 · 1—12 周']],p?.horizon||'short')}${selectField('状态','status',[['active','进行中'],['paused','已暂停'],['done','已完成']],p?.status||'active')}${field('开始日期','start_date',p?.start_date||'','date')}${field('目标日期','target_date',p?.target_date||'','date')}<label class="field wide"><span>交付物 · 什么结果算完成？</span><textarea name="deliverable" placeholder="例如：作品集网页正式上线">${esc(p?.deliverable||'')}</textarea></label><label class="field wide"><span>说明</span><textarea name="description">${esc(p?.description||'')}</textarea></label>${selectField('上级规划','parent_id',[['','无'],...state.plans.filter(x=>x.id!==p?.id).map(x=>[String(x.id),x.title])],String(p?.parent_id||''))}${field('手动进度（无里程碑时使用）','manual_progress',p?.manual_progress||0,'number')}`;
  showDialog(p?'编辑规划':'新建规划',fields,async data=>{const result=await change('plans',p?'PATCH':'POST',p?.id,{...data,manual_progress:Number(data.manual_progress),parent_id:data.parent_id||null,start_date:data.start_date||null,target_date:data.target_date||null},p?'规划已更新':'规划已创建');if(result&&!p)selectedPlan=result.id;render();return result;},p?()=>change('plans','DELETE',p.id,undefined,'规划已删除'):null);
}

async function saveJournal() {
  const title=document.querySelector('#journal-title')?.value,body=document.querySelector('#journal-body')?.value,tags=document.querySelector('#journal-tags')?.value,success_body=document.querySelector('#journal-success')?.value;
  const status=document.querySelector('#save-status');
  if(!status)return;
  const entryDate=selectedInsight;
  const mood=state.insights.find(i=>i.entry_date===entryDate)?.mood||'';
  if(!title&&!body&&!tags&&!success_body&&!state.insights.some(i=>i.entry_date===selectedInsight))return;
  status.textContent='保存中…';
  try {
    const saved=await request('/api/insights','POST',{entry_date:entryDate,title,body,tags,mood,success_body});
    state.insights=state.insights.filter(i=>i.entry_date!==entryDate).concat(saved).sort((a,b)=>b.entry_date.localeCompare(a.entry_date));
    if(selectedInsight===entryDate && document.querySelector('#save-status')===status)status.textContent='已保存';
    updateHistory(journalQuery);
  } catch(e) { status.textContent='保存失败'; toast(e.message,true); }
}
function updateHistory(query='') {
  journalQuery=query;
  const list=document.querySelector('#history-list');if(!list)return;
  list.innerHTML=historyItems();
}
async function switchInsightDate(day) {
  if(!day || day>state.today)return;
  if(journalTimer){clearTimeout(journalTimer);journalTimer=null;await saveJournal();}
  selectedInsight=day;
  render();
}

document.addEventListener('click',async e=>{
  const link=e.target.closest('[data-link]');if(link){e.preventDefault();if(journalTimer){clearTimeout(journalTimer);journalTimer=null;await saveJournal();}await go(link.getAttribute('href'));return;}
  const btn=e.target.closest('[data-action]');if(!btn)return;
  const a=btn.dataset.action,id=Number(btn.dataset.id);
  if(a==='day-prev'||a==='day-next'){selectedDay=dayShift(selectedDay,a==='day-prev'?-1:1);try{await refresh();}catch(err){toast(err.message,true);render();}}
  if(a==='edit-task')taskEditor(id);
  if(a==='new-linked-task')taskEditor(null,id);
  if(a==='new-branch')taskEditor(null,null,id);
  if(a==='clear-quick-deadline')document.querySelector('#quick-deadline').value='';
  if(a==='toggle-branch-open'){collapsedTasks.has(id)?collapsedTasks.delete(id):collapsedTasks.add(id);render();}
  if(a==='new-plan')planEditor();
  if(a==='edit-plan')planEditor(id);
  if(a==='select-plan'){selectedPlan=id;render();}
  if(a==='range'){dashboardRange=Number(btn.dataset.range);render();}
  if(a==='select-insight')await switchInsightDate(btn.dataset.date);
  if(a==='insight-prev')await switchInsightDate(dayShift(selectedInsight,-1));
  if(a==='insight-next')await switchInsightDate(dayShift(selectedInsight,1));
  if(a==='insight-yesterday')await switchInsightDate(dayShift(state.today,-1));
  if(a==='insight-today')await switchInsightDate(state.today);
  if(a.startsWith('delete-')){const c=a.slice(7);if(confirm(c==='insights'?'确定删除这一天的成功日记和心得吗？':'确定删除这条内容吗？'))await change(c,'DELETE',id,undefined,'已删除');}
});
document.addEventListener('change',async e=>{
  if(e.target.id==='day-input'){selectedDay=e.target.value||state.today;try{await refresh();}catch(err){toast(err.message,true);render();}return;}
  if(e.target.id==='insight-date'){await switchInsightDate(e.target.value);return;}
  const action=e.target.dataset.action;if(!action?.startsWith('toggle-'))return;
  const c=action.slice(7),id=Number(e.target.dataset.id);
  const result=await change(c,'PATCH',id,{completed:e.target.checked},e.target.checked?'已完成':'已恢复');
  if(!result)render();
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='quick-add'){
    e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
    if(await change('tasks','POST',null,{title:d.title,category:d.category,planned_date:selectedDay,deadline_date:d.deadline_date||null},'待办已添加'))e.target.reset();
  }
  if(e.target.dataset.form==='add-prerequisite'||e.target.dataset.form==='add-milestone'){
    e.preventDefault();const collection=e.target.dataset.form==='add-prerequisite'?'prerequisites':'milestones';
    const title=new FormData(e.target).get('title');
    await change(collection,'POST',null,{title,plan_id:Number(e.target.dataset.plan)},'已添加');
  }
});
document.addEventListener('input',e=>{
  if(['journal-title','journal-body','journal-tags','journal-success'].includes(e.target.id)){const s=document.querySelector('#save-status');if(s)s.textContent='尚未保存';clearTimeout(journalTimer);journalTimer=setTimeout(()=>{journalTimer=null;saveJournal();},650);}
  if(e.target.id==='journal-search')updateHistory(e.target.value);
});
window.addEventListener('popstate',async()=>{if(journalTimer){clearTimeout(journalTimer);journalTimer=null;await saveJournal();}try{await refresh(false);}catch(e){toast(e.message,true);}render();});
async function syncNewDay() {
  const currentDay=new Date().toLocaleDateString('sv-SE');
  if(currentDay===state.today)return;
  if(journalTimer){clearTimeout(journalTimer);journalTimer=null;await saveJournal();}
  if(selectedDay===state.today)selectedDay=currentDay;
  try{await refresh();}catch(e){toast(e.message,true);}
}
window.addEventListener('focus',syncNewDay);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncNewDay();});
setInterval(syncNewDay,60000);
document.querySelector('#backup-button').onclick=()=>{window.location.href='/api/backup';toast('备份文件正在下载');};
refresh().catch(e=>{app.innerHTML=`<div class="empty"><h2>暂时无法打开数据</h2><p>${esc(e.message)}</p><button class="primary" onclick="location.reload()">重试</button></div>`;});
