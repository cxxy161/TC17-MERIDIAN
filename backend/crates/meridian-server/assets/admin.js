let overview = null;
let catalog = null;
let compFilter = 'ALL';
let compSearch = '';
let selectedCompId = null;
let confirmingReset = false;

const ITEM_NAMES = {};
const PROF_NAMES = {};

const fmt = (n, d = 1) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let authReady = false;
let wsInstance = null;
let wsRetryTimer = null;
const sysLogs = [];

function appendSysLog(tick, level, message) {
  sysLogs.push({ tick, level, message });
  if (sysLogs.length > 250) sysLogs.splice(0, sysLogs.length - 250);
  renderSysLogs();
}

function renderSysLogs() {
  const box = document.getElementById('sysLogList');
  const cnt = document.getElementById('sysLogCount');
  cnt.textContent = `${sysLogs.length} 条`;
  if (sysLogs.length === 0) {
    box.innerHTML = '<div class="muted">暂无系统日志，运行回合后将实时输出...</div>';
    return;
  }
  box.innerHTML = sysLogs
    .slice(-120)
    .reverse()
    .map((l) => {
      const cls =
        l.level === 'error'
          ? 'red'
          : l.level === 'warn'
            ? 'amber'
            : l.level === 'ctrl'
              ? 'green'
              : 'blue';
      const tag =
        l.level === 'error'
          ? 'ERR'
          : l.level === 'warn'
            ? 'WARN'
            : l.level === 'ctrl'
              ? 'CTRL'
              : 'SYS';
      return `<div class="syslog-row">
        <span class="syslog-tick">T${esc(l.tick)}</span>
        <span class="${cls}" style="min-width:38px;">[${tag}]</span>
        <span>${esc(l.message)}</span>
      </div>`;
    })
    .join('');
}

function showAuthModal(noticeText, isErr = false) {
  authReady = false;
  const modal = document.getElementById('authModal');
  const notice = document.getElementById('authNotice');
  notice.textContent = noticeText;
  notice.className = isErr ? 'amber' : 'muted';
  modal.classList.add('open');
  const badge = document.getElementById('wsBadge');
  badge.textContent = '未鉴权（等待管理员登录）';
  badge.className = 'amber';
  if (wsInstance) {
    try { wsInstance.close(); } catch (_) {}
    wsInstance = null;
  }
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
}

function hideAuthModal() {
  document.getElementById('authModal').classList.remove('open');
  document.getElementById('authError').textContent = '';
}

async function loadMe() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      document.getElementById('adminUserBadge').style.display = 'none';
      document.getElementById('btnAdminLogout').style.display = 'none';
      return null;
    }
    const me = await res.json();
    const badge = document.getElementById('adminUserBadge');
    badge.textContent = `${me.nickname || me.email} (${me.role})`;
    badge.style.display = 'inline-block';
    document.getElementById('btnAdminLogout').style.display = 'inline-block';
    return me;
  } catch (_) {
    return null;
  }
}

async function simCtrl(action, tickMs) {
  const res = await fetch('/api/sim/control', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tickMs !== undefined ? { action, tick_ms: tickMs } : { action }),
  });
  if (res.status === 401 || res.status === 403) {
    showAuthModal('管理员会话已失效或权限不足，请重新登录管理员账号', true);
    return;
  }
  appendSysLog(
    overview?.tick ?? 0,
    'ctrl',
    tickMs !== undefined ? `管理指令: ${action} (${tickMs}ms)` : `管理指令: ${action}`,
  );
  await refreshAll();
}

async function loadCatalog() {
  try {
    const res = await fetch('/api/catalog', { credentials: 'same-origin' });
    if (!res.ok) return;
    catalog = await res.json();
    for (const it of catalog.items || []) ITEM_NAMES[it.id] = it.name;
    for (const pr of catalog.professions || []) PROF_NAMES[pr.id] = pr.name;
  } catch (_) {}
}

let refreshInFlight = false;
let lastRefreshAt = 0;
let lastRttMs = 0;
let refreshTimer = null;
let selectedSandbox = null;

function fmtBytes(bytes) {
  const b = Number(bytes || 0);
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function fmtDuration(secs) {
  const s = Math.max(0, Math.floor(Number(secs || 0)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  return `${m}m ${r}s`;
}

function fmtTs(ts) {
  if (!ts) return '从未';
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function refreshAll() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const t0 = performance.now();
  try {
    const res = await fetch('/api/admin/overview', { credentials: 'same-origin' });
    if (res.status === 401) {
      showAuthModal('未检测到登录会话（更换设备访问时需先登录管理员账号，才能同步后台数据与实时推送）。');
      return;
    }
    if (res.status === 403) {
      const me = await loadMe();
      const who = me ? `${me.nickname || me.email} [${me.role}]` : '当前账号';
      showAuthModal(`${who} 没有管理员权限（需要 role=admin），请在下方切换为管理员账号登录。`, true);
      return;
    }
    if (!res.ok) return;
    const wasReady = authReady;
    authReady = true;
    hideAuthModal();
    if (!wasReady) {
      await loadMe();
      connectWs();
    }
    overview = await res.json();
    lastRttMs = performance.now() - t0;
    lastRefreshAt = performance.now();
    renderAll();
  } catch (_) {
  } finally {
    refreshInFlight = false;
  }
}

function scheduleRefresh() {
  const elapsed = performance.now() - lastRefreshAt;
  if (elapsed >= 200 && !refreshInFlight) {
    refreshAll();
  } else if (!refreshTimer) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAll();
    }, Math.max(20, 200 - elapsed));
  }
}

function renderResetBox() {
  const box = document.getElementById('resetBox');
  if (!confirmingReset) {
    box.innerHTML = `<button id="btnAskReset" class="danger">重置星系</button>`;
    document.getElementById('btnAskReset').onclick = () => {
      confirmingReset = true;
      renderResetBox();
    };
  } else {
    box.innerHTML = `<span class="confirm-reset">
      <span class="red">确认重置?</span>
      <button id="btnDoReset" class="danger">确定</button>
      <button id="btnCancelReset">取消</button>
    </span>`;
    document.getElementById('btnDoReset').onclick = async () => {
      confirmingReset = false;
      renderResetBox();
      await simCtrl('reset');
    };
    document.getElementById('btnCancelReset').onclick = () => {
      confirmingReset = false;
      renderResetBox();
    };
  }
}

function renderAll() {
  if (!overview) return;
  document.getElementById('kTick').textContent = overview.tick;
  document.getElementById('kCpi').textContent = Number(overview.cpi).toFixed(3);
  document.getElementById('kMinted').textContent = fmt(overview.total_minted, 0);
  const errEl = document.getElementById('kErr');
  errEl.textContent = overview.conservation_error;
  errEl.className = overview.conservation_error === 0 ? 'green' : 'red';

  const comps = overview.companies || [];
  const pCnt = comps.filter((c) => c.is_player).length;
  const nCnt = comps.length - pCnt;
  document.getElementById('kCompCount').textContent = `${comps.length} (${pCnt}玩家 / ${nCnt}NPC)`;
  document.getElementById('kFlightCount').textContent = (overview.in_flight || []).length;

  const stEl = document.getElementById('kStatus');
  stEl.textContent = overview.paused
    ? '已暂停'
    : overview.tick_ms === 0
      ? '全速运行 (0ms)'
      : `运行 (${overview.tick_ms}ms)`;
  stEl.className = overview.paused ? 'amber' : 'green';

  const btnPR = document.getElementById('btnPauseResume');
  btnPR.textContent = overview.paused ? '继续运行' : '暂停模拟';
  btnPR.className = overview.paused ? 'primary' : 'danger';

  document.querySelectorAll('#speedBtns button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.ms) === overview.tick_ms);
  });
  if (document.activeElement !== document.getElementById('customMs')) {
    document.getElementById('customMs').value = overview.tick_ms;
  }

  const l = overview.ledger || {};
  document.getElementById('lMinted').textContent = fmt(l.total_minted, 1);
  document.getElementById('lBurned').textContent = fmt(l.total_burned, 1);
  document.getElementById('lWages').textContent = fmt(l.total_wages_paid, 1);
  document.getElementById('lTradeFee').textContent = fmt(l.total_trade_fees, 1);
  document.getElementById('lStoreFee').textContent = fmt(l.total_storage_fees, 1);

  const rt = overview.runtime || {};
  const cpu = rt.cpu || {};
  const mem = rt.memory || {};
  document.getElementById('kTps').textContent = `${Number(rt.tps || 0).toFixed(2)} t/s`;
  const latEl = document.getElementById('kTickLat');
  const lastMs = Number(rt.tick_last_ms || 0);
  latEl.textContent = `${lastMs.toFixed(1)}ms`;
  latEl.className = overview.tick_ms > 0 && lastMs > overview.tick_ms ? 'red' : lastMs > 200 ? 'amber' : 'green';
  document.getElementById('kCpu').textContent = `${Number(cpu.proc_pct_one_core || 0).toFixed(1)}% / 宿主 ${Number(cpu.host_pct || 0).toFixed(0)}%`;
  document.getElementById('kMem').textContent = fmtBytes(mem.rss_bytes || 0);
  document.getElementById('kWs').textContent = `${rt.ws_total || 0}`;
  document.getElementById('kRtt').textContent = `${lastRttMs.toFixed(0)}ms`;

  renderRuntime();
  renderEconCharts();
  renderAccounts();
  renderPlanetFilters();
  renderPlanets();
  renderCompanies();
  renderMatrix();
  renderFlights();
  renderTrades();
  renderDetail();
}

function renderRuntime() {
  const grid = document.getElementById('runtimeGrid');
  const rt = overview.runtime || {};
  const ph = rt.phases || {};
  const cpu = rt.cpu || {};
  const mem = rt.memory || {};
  const st = rt.storage || {};
  const sb = rt.sandbox || {};
  const sc = overview.supply_chain || {};

  const missingTop = (sc.missing_inputs_top || [])
    .slice(0, 5)
    .map((m) => `<span class="tag off">${esc(ITEM_NAMES[m.item_id] || m.item_id)} ×${m.idle_count}</span>`)
    .join('') || '<span class="muted">暂无明显缺料</span>';
  const profSummary = Object.entries(sc.profession_npc_counts || {})
    .map(([k, v]) => `${esc(PROF_NAMES[k] || k)}:${v}`)
    .join(' · ') || '--';

  const cgTxt = mem.cgroup_current_bytes
    ? `${fmtBytes(mem.cgroup_current_bytes)}${mem.cgroup_limit_bytes ? ' / ' + fmtBytes(mem.cgroup_limit_bytes) : ' (无限额)'}`
    : '非容器环境';

  grid.innerHTML = `
    <div class="card">
      <div class="card-hd">
        <span>Tick 速度与分段耗时</span>
        <span class="mono blue">${Number(rt.tps || 0).toFixed(2)} t/s</span>
      </div>
      <div class="card-bd mono">
        <div class="kv"><span>最近 / 均值 / P95 / 最大</span><b>${Number(rt.tick_last_ms || 0).toFixed(1)} / ${Number(rt.tick_avg_ms || 0).toFixed(1)} / ${Number(rt.tick_p95_ms || 0).toFixed(1)} / ${Number(rt.tick_max_ms || 0).toFixed(1)} ms</b></div>
        <div class="kv"><span>共享快照准备</span><b>${Number(ph.snapshot_ms || 0).toFixed(2)} ms</b></div>
        <div class="kv"><span>玩家JS / NPC决策</span><b>${Number(ph.players_ms || 0).toFixed(2)} / ${Number(ph.npc_ms || 0).toFixed(2)} ms</b></div>
        <div class="kv"><span>核心经济与撮合</span><b>${Number(ph.world_tick_ms || 0).toFixed(2)} ms</b></div>
        <div class="kv"><span>SQLite 事务落盘</span><b>${Number(ph.persist_ms || 0).toFixed(2)} ms</b></div>
        <div class="kv"><span>广播组装 / 总览生成</span><b>${Number(ph.broadcast_ms || 0).toFixed(2)} / ${Number(rt.overview_gen_ms || 0).toFixed(1)} ms</b></div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd">
        <span>CPU 与玩家 JS 沙盒</span>
        <span class="mono muted">${cpu.cores || 1} 核</span>
      </div>
      <div class="card-bd mono">
        <div class="kv"><span>进程 CPU (单核/全核)</span><b>${Number(cpu.proc_pct_one_core || 0).toFixed(1)}% / ${Number(cpu.proc_pct_all_cores || 0).toFixed(1)}%</b></div>
        <div class="kv"><span>宿主机 CPU / Load</span><b>${Number(cpu.host_pct || 0).toFixed(1)}% · ${Number(cpu.load_1m || 0).toFixed(2)} / ${Number(cpu.load_5m || 0).toFixed(2)} / ${Number(cpu.load_15m || 0).toFixed(2)}</b></div>
        <div class="kv"><span>活跃玩家脚本</span><b>${sb.active_scripts || 0} 家</b></div>
        <div class="kv"><span>本回合 JS 累计耗时</span><b>${Number(sb.total_cpu_used_ms || 0).toFixed(2)} ms</b></div>
        <div class="kv"><span>最慢脚本</span><b>${sb.max_script_company ? esc(sb.max_script_company) + ' (' + Number(sb.max_script_cpu_ms || 0).toFixed(2) + 'ms)' : '--'}</b></div>
        <div class="kv"><span>累计超时 / OOM / 拒单</span><b class="${(sb.total_timeouts || 0) + (sb.total_ooms || 0) > 0 ? 'red' : ''}">${sb.total_timeouts || 0} / ${sb.total_ooms || 0} / ${sb.total_rejected_intents || 0}</b></div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd">
        <span>内存、存储与连接健康</span>
        <span class="mono muted">运行 ${fmtDuration(rt.uptime_secs || 0)}</span>
      </div>
      <div class="card-bd mono">
        <div class="kv"><span>进程 RSS / 峰值 HWM</span><b class="blue">${fmtBytes(mem.rss_bytes)} / ${fmtBytes(mem.hwm_bytes)}</b></div>
        <div class="kv"><span>宿主机可用 / 总内存</span><b>${fmtBytes(mem.host_avail_bytes)} / ${fmtBytes(mem.host_total_bytes)}</b></div>
        <div class="kv"><span>容器 Cgroup 内存</span><b>${cgTxt}</b></div>
        <div class="kv"><span>DB / WAL / SHM 体积</span><b>${fmtBytes(st.db_bytes)} / ${fmtBytes(st.wal_bytes)} / ${fmtBytes(st.shm_bytes)}</b></div>
        <div class="kv"><span>上次全量存盘</span><b>T${rt.last_persisted_tick || 0} (${rt.last_persisted_ago_secs || 0}s 前)</b></div>
        <div class="kv"><span>WS在线 / 账号 / 有效会话</span><b>${rt.ws_total || 0} / ${rt.users_total || 0} / ${rt.active_sessions || 0}</b></div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd">
        <span>宏观生态与供应链瓶颈</span>
        <span class="mono muted">玩家 ${sc.player_count || 0} / NPC ${sc.npc_count || 0}</span>
      </div>
      <div class="card-bd mono">
        <div class="kv"><span>玩家总净资产 / NPC</span><b><span class="green">${fmt(sc.player_net_liquid, 0)}</span> / <span class="blue">${fmt(sc.npc_net_liquid, 0)}</span></b></div>
        <div class="kv"><span>工厂运行 / 停工 / 总数</span><b>${(sc.active_buildings || 0) - (sc.idle_buildings || 0)} / <span class="${(sc.idle_buildings || 0) > 0 ? 'amber' : ''}">${sc.idle_buildings || 0}</span> / ${sc.total_buildings || 0}</b></div>
        <div class="kv"><span>星系空地 / 挂牌 / 总可开发</span><b>${sc.total_unclaimed_plots || 0} / ${sc.total_listed_plots || 0} / ${sc.total_developable_plots || 0}</b></div>
        <div class="kv"><span>NPC 职业分布</span><b style="font-size:10px;">${profSummary}</b></div>
        <div style="margin-top:4px; font-size:10.5px;">
          <span class="muted">停工缺料排行：</span>${missingTop}
        </div>
      </div>
    </div>
  `;
}

function buildSparkSvg(seriesList, width = 360, height = 96) {
  const pad = 6;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const s of seriesList) {
    for (const v of s.data) {
      if (Number.isFinite(v)) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
    return `<svg viewBox="0 0 ${width} ${height}" class="chart-svg"><text x="12" y="52" fill="#64748b" font-size="11">等待采样点...</text></svg>`;
  }
  if (Math.abs(maxV - minV) < 1e-9) {
    maxV += 1;
    minV -= 1;
  }
  const paths = seriesList.map((s) => {
    const n = s.data.length;
    if (n === 0) return '';
    if (n === 1) {
      const y = height - pad - ((s.data[0] - minV) / (maxV - minV)) * (height - pad * 2);
      return `<circle cx="${width / 2}" cy="${y.toFixed(1)}" r="2.5" fill="${s.color}" />`;
    }
    const pts = s.data.map((v, idx) => {
      const x = pad + (idx / (n - 1)) * (width - pad * 2);
      const y = height - pad - ((v - minV) / (maxV - minV)) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polyline fill="none" stroke="${s.color}" stroke-width="1.6" points="${pts}" />`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="chart-svg">${paths}</svg>`;
}

function renderEconCharts() {
  const grid = document.getElementById('econChartsGrid');
  const hist = overview.economy_history || [];
  const firstT = hist.length ? hist[0].tick : 0;
  const lastT = hist.length ? hist[hist.length - 1].tick : 0;
  const span = hist.length ? `T${firstT} ~ T${lastT} (${hist.length}点)` : '暂无采样';

  const cpiLast = hist.length ? Number(hist[hist.length - 1].cpi).toFixed(3) : '--';
  const mintedLast = hist.length ? fmt(hist[hist.length - 1].total_minted, 0) : '--';
  const pLast = hist.length ? fmt(hist[hist.length - 1].player_net_liquid, 0) : '--';
  const nLast = hist.length ? fmt(hist[hist.length - 1].npc_net_liquid, 0) : '--';
  const fillsLast = hist.length ? hist[hist.length - 1].fills_count : 0;
  const idleLast = hist.length ? hist[hist.length - 1].idle_buildings : 0;

  grid.innerHTML = `
    <div class="card">
      <div class="card-hd">
        <span>CPI 物价指数走势</span>
        <span class="mono muted">${span} · 当前 <b class="amber">${cpiLast}</b></span>
      </div>
      <div class="card-bd">
        ${buildSparkSvg([{ color: '#f2cc60', data: hist.map((h) => Number(h.cpi)) }])}
        <div class="mono muted" style="font-size:10px; margin-top:4px;">货币流通总量当前：${mintedLast}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd">
        <span>玩家 vs NPC 净流动资产曲线</span>
        <span class="mono muted"><span class="green">玩家 ${pLast}</span> / <span class="blue">NPC ${nLast}</span></span>
      </div>
      <div class="card-bd">
        ${buildSparkSvg([
          { color: '#3fb950', data: hist.map((h) => Number(h.player_net_liquid)) },
          { color: '#38bdf8', data: hist.map((h) => Number(h.npc_net_liquid)) },
        ])}
        <div class="mono muted" style="font-size:10px; margin-top:4px;">绿线：全部玩家公司净资产 · 蓝线：全部 NPC 净资产</div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd">
        <span>每回合撮合成交笔数 / 停工设施数</span>
        <span class="mono muted">成交 <b class="green">${fillsLast}</b> · 停工 <b class="amber">${idleLast}</b></span>
      </div>
      <div class="card-bd">
        ${buildSparkSvg([
          { color: '#3fb950', data: hist.map((h) => Number(h.fills_count)) },
          { color: '#f85149', data: hist.map((h) => Number(h.idle_buildings)) },
        ])}
        <div class="mono muted" style="font-size:10px; margin-top:4px;">绿线：成交笔数 · 红线：停工工厂数</div>
      </div>
    </div>
  `;
}

function renderAccounts() {
  const list = overview.accounts || [];
  const onlineTotal = list.filter((a) => (a.ws_connections || 0) > 0).length;
  document.getElementById('accountsSummary').textContent = `共 ${list.length} 个账号 · 当前 WS 在线 ${onlineTotal} 户`;
  const body = document.getElementById('accountsBody');
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:12px;">暂无注册账号</td></tr>';
    return;
  }
  body.innerHTML = list.map((a) => {
    const disabled = a.status !== 'active';
    const wsOn = (a.ws_connections || 0) > 0;
    const ua = (a.user_agents || [])[0] || '';
    return `<tr>
      <td>
        <div>
          <span class="tag ${a.role === 'admin' ? 'off' : 'player'}">${esc(a.role)}</span>
          <b>${esc(a.nickname)}</b>
          ${disabled ? '<span class="tag off">已禁用</span>' : ''}
        </div>
        <div class="mono muted" style="font-size:10px;">#${a.id} · ${esc(a.email)}</div>
      </td>
      <td>
        <div><b>${esc(a.company_name)}</b></div>
        <div class="mono muted" style="font-size:10px;">${esc(a.company_id)}</div>
      </td>
      <td class="num mono ${a.net_liquid >= 0 ? 'blue' : 'red'}"><b>${fmt(a.net_liquid, 1)}</b></td>
      <td class="mono" style="font-size:10.5px;">
        <div>
          <span class="${wsOn ? 'green' : 'muted'}">${wsOn ? `● WS在线(${a.ws_connections})` : '○ 离线'}</span>
          · 会话 ${a.active_sessions || 0}
        </div>
        <div class="muted" style="font-size:9.5px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(ua)}">${esc(ua || '--')}</div>
      </td>
      <td class="mono" style="font-size:10px;">
        <div>登录: ${esc(fmtTs(a.last_login_at))}</div>
        <div class="muted">活跃: ${esc(fmtTs(a.last_seen_at))}</div>
      </td>
      <td class="mono">
        <button class="xs ${a.script_enabled ? 'primary' : 'danger'}" data-action="toggle-script" data-company-id="${esc(a.company_id)}" data-enabled="${!a.script_enabled}">
          ${a.script_enabled ? '运行中 (点此熔断)' : '已停用 (点此恢复)'}
        </button>
      </td>
      <td>
        <div style="display:flex; gap:4px; flex-wrap:wrap;">
          <button class="xs" data-action="inspect-sandbox" data-company-id="${esc(a.company_id)}">看沙盒</button>
          <button class="xs" data-action="reset-password" data-user-id="${a.id}" data-email="${esc(a.email)}">改密码</button>
          <button class="xs" data-action="kick-user" data-user-id="${a.id}" data-nickname="${esc(a.nickname)}">踢下线</button>
          <button class="xs ${disabled ? 'primary' : 'danger'}" data-action="set-status" data-user-id="${a.id}" data-status="${disabled ? 'active' : 'disabled'}" data-nickname="${esc(a.nickname)}">
            ${disabled ? '解封' : '禁用'}
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderTrades() {
  const list = overview.recent_trades || [];
  document.getElementById('tradesSummary').textContent = `最新 ${list.length} 笔`;
  const body = document.getElementById('tradesBody');
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:12px;">暂无历史成交</td></tr>';
    return;
  }
  body.innerHTML = list.map((t) => `<tr class="mono">
    <td>T${t.tick}</td>
    <td>${esc(t.station_id)}</td>
    <td>${esc(ITEM_NAMES[t.item_id] || t.item_id)} <span class="muted">(${esc(t.item_id)})</span></td>
    <td class="num">${t.qty}</td>
    <td class="num blue">${Number(t.price).toFixed(2)}</td>
    <td class="num muted">${Number(t.fee).toFixed(2)}</td>
    <td>${esc(t.buyer_id)} &rarr; ${esc(t.seller_id)}</td>
  </tr>`).join('');
}

async function inspectPlayerSandbox(cid) {
  try {
    const res = await fetch(`/api/admin/player/${encodeURIComponent(cid)}/sandbox`, { credentials: 'same-origin' });
    if (!res.ok) {
      appendSysLog(overview?.tick ?? 0, 'error', `读取 ${cid} 沙盒失败 (${res.status})`);
      return;
    }
    selectedSandbox = await res.json();
    selectedCompId = cid;
    renderDetail();
  } catch (_) {}
}

async function togglePlayerScript(cid, enable) {
  const res = await fetch(`/api/admin/player/${encodeURIComponent(cid)}/script-toggle`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enable }),
  });
  if (!res.ok) {
    const txt = await res.text();
    appendSysLog(overview?.tick ?? 0, 'error', `切换 ${cid} 脚本失败: ${txt}`);
    return;
  }
  appendSysLog(overview?.tick ?? 0, 'ctrl', `已${enable ? '恢复' : '熔断停用'}玩家 ${cid} 的自动脚本`);
  await refreshAll();
}

async function setUserStatus(uid, nextStatus, nickname) {
  if (nextStatus === 'disabled' && !confirm(`确认禁用账号「${nickname}」并踢掉其全部登录会话？`)) return;
  const res = await fetch(`/api/admin/users/${uid}/status`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: nextStatus }),
  });
  if (!res.ok) {
    const txt = await res.text();
    alert(`操作失败: ${txt}`);
    return;
  }
  appendSysLog(overview?.tick ?? 0, 'ctrl', `账号 ${nickname} (#${uid}) 状态已变更为 ${nextStatus}`);
  await refreshAll();
}

async function kickUser(uid, nickname) {
  const res = await fetch(`/api/admin/users/${uid}/kick`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    alert(`踢下线失败 (${res.status})`);
    return;
  }
  const data = await res.json().catch(() => ({}));
  appendSysLog(overview?.tick ?? 0, 'ctrl', `已吊销 ${nickname} (#${uid}) 的 ${data.revoked ?? 0} 个活跃会话`);
  await refreshAll();
}

async function resetUserPassword(uid, email) {
  const pwd = prompt(`为账号 ${email} (#${uid}) 设置新密码（至少 8 位）：`);
  if (pwd === null) return;
  if (pwd.length < 8) {
    alert('密码至少需要 8 位');
    return;
  }
  const res = await fetch(`/api/admin/users/${uid}/password`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd }),
  });
  if (!res.ok) {
    const txt = await res.text();
    alert(`重置密码失败: ${txt}`);
    return;
  }
  appendSysLog(overview?.tick ?? 0, 'ctrl', `已重置 ${email} (#${uid}) 密码并吊销旧会话`);
  await refreshAll();
}

function renderPlanetFilters() {
  const wrap = document.getElementById('planetFilterBtns');
  const pids = (overview.planets || []).map((p) => p.id);
  if (!['ALL', 'PLAYER', 'NPC'].includes(compFilter) && !pids.includes(compFilter)) {
    compFilter = 'ALL';
  }
  wrap.innerHTML = pids
    .map((pid) => `<button data-f="${esc(pid)}" class="${compFilter === pid ? 'active' : ''}">${esc(pid)}</button>`)
    .join('');
  document.querySelectorAll('#compFilters button').forEach((b) => {
    b.classList.toggle('active', b.dataset.f === compFilter);
  });
}

function renderPlanets() {
  const grid = document.getElementById('planetGrid');
  const stations = overview.stations || {};
  const cards = (overview.planets || []).map((p) => {
    const st = stations['ST:' + p.id] || { bid_orders: 0, ask_orders: 0 };
    const demCount = Object.keys(p.demands || {}).length;
    const habPct = Math.round(Number(p.habitability || 0) * 100);
    return `<div class="card">
      <div class="card-hd">
        <span>${esc(p.name)} (${esc(p.id)})</span>
        <span class="mono muted">${esc(p.archetype)}</span>
      </div>
      <div class="card-bd mono">
        <div class="kv"><span>宜居度 / 城市数</span><b>${habPct}% · ${Number(p.city_count || 0)} 城</b></div>
        <div class="kv"><span>人口 / 繁荣</span><b>${Math.round(p.population).toLocaleString()} · ${Number(p.prosperity).toFixed(2)}x</b></div>
        <div class="kv"><span>星球金库</span><b class="blue">${fmt(p.treasury, 0)}</b></div>
        <div class="kv"><span>准备金 / 存 / 贷</span><b>${fmt(p.bank_reserves, 0)} / ${fmt(p.bank_deposits, 0)} / ${fmt(p.bank_loans, 0)}</b></div>
        <div class="kv"><span>年化利率 / 废料</span><b>${(p.bank_rate_bps / 100).toFixed(2)}% · 废料 ${p.waste_backlog}</b></div>
        <div class="kv"><span>余地 / 挂牌 / 买/卖单</span><b>${p.unclaimed_plots} / ${p.land_listings_count} / ${st.bid_orders}/${st.ask_orders}</b></div>
        <div class="kv"><span>城市消费品类</span><b>${demCount} 项</b></div>
      </div>
    </div>`;
  });

  const primarySys = (overview.systems || [])[0] || {};
  const hubSid = primarySys.hub_station_id || 'ST:HUB';
  const hubRadius = Number(overview.hub_orbit_radius ?? primarySys.hub_orbit_radius ?? 1.45).toFixed(2);
  const hub = stations[hubSid] || { bid_orders: 0, ask_orders: 0 };
  const hubVol = (overview.market_tickers || [])
    .filter((t) => t.station_id === hubSid)
    .reduce((a, b) => a + (b.vol_50t || 0), 0);
  cards.push(`<div class="card">
    <div class="card-hd">
      <span class="blue">${esc(primarySys.name || '中心贸易枢纽')} (${esc(hubSid)})</span>
      <span class="mono muted">${hubRadius} AU · ${(overview.planets || []).length} 星球</span>
    </div>
    <div class="card-bd mono">
      <div class="kv"><span>Hub 买单数</span><b>${hub.bid_orders}</b></div>
      <div class="kv"><span>Hub 卖单数</span><b>${hub.ask_orders}</b></div>
      <div class="kv"><span>Hub 50回合总量</span><b class="green">${hubVol}</b></div>
      <div class="kv"><span>在途飞船总数</span><b>${(overview.in_flight || []).length}</b></div>
    </div>
  </div>`);
  grid.innerHTML = cards.join('');
}

function renderCompanies() {
  const planetIds = new Set((overview.planets || []).map((p) => p.id));
  const comps = (overview.companies || []).filter((c) => {
    if (compFilter === 'PLAYER' && !c.is_player) return false;
    if (compFilter === 'NPC' && c.is_player) return false;
    if (planetIds.has(compFilter) && c.home_planet_id !== compFilter) return false;
    if (compSearch) {
      const q = compSearch.toLowerCase();
      if (!c.id.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const body = document.getElementById('compBody');
  body.innerHTML = comps.map((c) => {
    const bTags = (c.buildings || []).map((b) => {
      const cls = b.active ? 'on' : 'off';
      const idleTxt = b.idle_ticks > 0 ? ` 闲${b.idle_ticks}` : '';
      return `<span class="tag ${cls} mono">${esc(b.recipe_id)}${idleTxt}</span>`;
    }).join('') || '<span class="muted">无设施</span>';

    const gItems = Object.entries(c.ground_inv || {}).map(([pid, m]) =>
      Object.entries(m).map(([k, q]) => `${esc(ITEM_NAMES[k] || k)}:${q}`).join(' ')
    ).join(' | ');
    const sItems = Object.entries(c.station_inv || {}).map(([sid, m]) =>
      `${esc(sid)}[` + Object.entries(m).map(([k, q]) => `${esc(ITEM_NAMES[k] || k)}:${q}`).join(' ') + `]`
    ).join(' ');

    const shipsTxt = (c.ships || []).map((s) => `${s.location}(${Math.round(s.durability)}%)`).join(', ');
    const selCls = selectedCompId === c.id ? 'selected' : '';
    return `<tr class="comp-row ${selCls}" data-cid="${esc(c.id)}">
      <td>
        <span class="tag ${c.is_player ? 'player' : 'npc'}">${c.is_player ? '玩家' : 'NPC'}</span>
        <b>${esc(c.name)}</b>
        <div class="mono muted" style="font-size:10px;">${esc(c.id)}</div>
      </td>
      <td>
        <div>${esc(c.home_planet_id)}</div>
        <div class="muted" style="font-size:10px;">${esc(PROF_NAMES[c.profession] || c.profession)}</div>
      </td>
      <td class="num mono ${c.net_liquid >= 0 ? 'blue' : 'red'}"><b>${fmt(c.net_liquid, 1)}</b></td>
      <td class="num mono" style="font-size:10.5px;">
        <div>${fmt(c.cash, 0)} / <span class="green">${fmt(c.savings, 0)}</span> / <span class="${c.debt > 0 ? 'red' : 'muted'}">${fmt(c.debt, 0)}</span></div>
      </td>
      <td class="num mono ${c.distress_ticks > 0 ? 'red' : 'muted'}">${c.distress_ticks}</td>
      <td class="mono" style="font-size:10.5px;">
        <div>地${c.plots_count} · 船${(c.ships || []).length} · 单${c.open_orders_count}</div>
        <div class="muted" style="font-size:10px;">${esc(shipsTxt)}</div>
      </td>
      <td>${bTags}</td>
      <td style="font-size:10.5px; max-width:220px; word-break:break-word;">
        ${gItems ? `<div><span class="muted">地:</span> ${gItems}</div>` : ''}
        ${sItems ? `<div><span class="blue">站:</span> ${sItems}</div>` : ''}
        ${!gItems && !sItems ? '<span class="muted">空仓</span>' : ''}
      </td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr.comp-row').forEach((tr) => {
    tr.onclick = () => {
      selectedCompId = tr.dataset.cid;
      selectedSandbox = null;
      renderCompanies();
      renderDetail();
    };
  });
}

function renderDetail() {
  const titleEl = document.getElementById('detailTitle');
  const subEl = document.getElementById('detailSub');
  const box = document.getElementById('detailBox');
  if (selectedSandbox && selectedSandbox.company_id === selectedCompId) {
    const sb = selectedSandbox;
    const out = sb.last_output || {};
    const logsHtml = (out.logs || []).slice(-40).map((l) =>
      `<div class="mono" style="font-size:10.5px;">[${esc(l.level)}] ${esc(l.message)}</div>`
    ).join('') || '<span class="muted">最近一次运行无控制台日志</span>';
    titleEl.textContent = `沙盒详情 · ${sb.company_id}`;
    subEl.innerHTML = `<button class="xs" data-action="clear-sandbox">切回企业 JSON</button>`;
    box.innerHTML = `
      <div class="kv"><span>脚本状态</span><b>${sb.enabled ? '<span class="green">启用</span>' : '<span class="red">已停用</span>'} · 本回合 CPU ${Number(out.cpu_used_ms || 0).toFixed(2)} ms</b></div>
      <div class="kv"><span>Memory 占用</span><b>${fmtBytes(sb.memory_bytes)} / ${fmtBytes(sb.memory_limit_bytes)}</b></div>
      ${out.error ? `<div class="red mono" style="margin:6px 0;">最近异常: ${esc(out.error)}</div>` : ''}
      <div class="muted" style="margin:6px 0 3px;">最近控制台日志：</div>
      <div style="background:#12171f; padding:6px; border-radius:2px; margin-bottom:8px;">${logsHtml}</div>
      <div class="muted" style="margin:6px 0 3px;">Memory JSON：</div>
      <pre style="margin-bottom:8px;">${esc(sb.memory_json)}</pre>
      <div class="muted" style="margin:6px 0 3px;">脚本模块（${Object.keys(sb.modules || {}).length} 个）：</div>
      <pre>${esc(JSON.stringify(sb.modules, null, 2))}</pre>
    `;
    return;
  }
  if (!selectedCompId || !overview) return;
  const comp = (overview.companies || []).find((c) => c.id === selectedCompId);
  if (!comp) {
    box.innerHTML = '<span class="muted">该企业已被清算或重置</span>';
    return;
  }
  titleEl.textContent = `${comp.name} (${comp.id})`;
  subEl.innerHTML = comp.is_player
    ? `PLAYER · ${esc(comp.home_planet_id)} <button class="xs" data-action="inspect-sandbox" data-company-id="${esc(comp.id)}">查看沙盒/日志</button>`
    : `NPC · ${esc(comp.home_planet_id)}`;
  box.innerHTML = `<pre>${esc(JSON.stringify(comp, null, 2))}</pre>`;
}

function renderMatrix() {
  const tickers = overview.market_tickers || [];
  const byKey = {};
  const itemsSet = new Set();
  for (const t of tickers) {
    byKey[`${t.item_id}::${t.station_id}`] = t;
    itemsSet.add(t.item_id);
  }
  const items = Array.from(itemsSet).sort();
  const hubSids = (overview.systems || []).map((s) => s.hub_station_id);
  const sids = [
    ...(hubSids.length ? hubSids : ['ST:HUB']),
    ...(overview.planets || []).map((p) => 'ST:' + p.id),
  ];
  const titleEl = document.getElementById('matrixTitle');
  if (titleEl) {
    titleEl.textContent = `${items.length}×${sids.length} 全站即时报价与 50 回合量矩阵（买一 / 卖一 / 最新价 / 50T量）`;
  }
  document.getElementById('matrixHead').innerHTML = `<tr>
    <th>物资</th>
    ${sids.map((sid) => `<th class="num">${esc(sid)}</th>`).join('')}
    <th class="num">50T总量</th>
  </tr>`;

  const cellHtml = (t) => {
    if (!t) return '<td class="num muted">--</td>';
    const bb = t.best_bid !== null && t.best_bid !== undefined ? Number(t.best_bid).toFixed(2) : '--';
    const ba = t.best_ask !== null && t.best_ask !== undefined ? Number(t.best_ask).toFixed(2) : '--';
    const lp = Number(t.last_price).toFixed(2);
    return `<td class="num mono" style="font-size:10.5px;">
      <span class="green">${bb}</span>/<span class="red">${ba}</span> · <b>${lp}</b>
      ${t.vol_50t > 0 ? `<span class="blue">(${t.vol_50t})</span>` : ''}
    </td>`;
  };

  document.getElementById('matrixBody').innerHTML = items.map((it) => {
    const totVol = sids.reduce((s, sid) => s + (byKey[`${it}::${sid}`]?.vol_50t || 0), 0);
    return `<tr>
      <td><b>${esc(ITEM_NAMES[it] || it)}</b> <span class="muted mono">${esc(it)}</span></td>
      ${sids.map((sid) => cellHtml(byKey[`${it}::${sid}`])).join('')}
      <td class="num mono ${totVol > 0 ? 'green' : 'muted'}"><b>${totVol}</b></td>
    </tr>`;
  }).join('');
}

function renderFlights() {
  const list = overview.in_flight || [];
  document.getElementById('flightSummary').textContent = `${list.length} 艘航行中`;
  const body = document.getElementById('flightBody');
  if (list.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center;padding:16px;">当前无在途飞船</td></tr>';
    return;
  }
  body.innerHTML = list.map((f) => {
    const cargoTxt = (f.cargo || []).map(([k, q]) => `${esc(ITEM_NAMES[k] || k)}×${q}`).join(', ');
    return `<tr class="mono">
      <td>#${f.ship_id}</td>
      <td>${esc(f.owner_id)}</td>
      <td>${esc(f.from)} &rarr; ${esc(f.to)}</td>
      <td class="num">T${f.arrival_tick}</td>
      <td>${cargoTxt}</td>
    </tr>`;
  }).join('');
}

document.getElementById('btnPauseResume').onclick = () => {
  if (!overview) return;
  simCtrl(overview.paused ? 'resume' : 'pause');
};
document.getElementById('btnStep').onclick = () => simCtrl('step');
document.querySelectorAll('#speedBtns button').forEach((b) => {
  b.onclick = () => simCtrl('speed', Number(b.dataset.ms));
});
document.getElementById('btnSetMs').onclick = () => {
  const v = Number(document.getElementById('customMs').value);
  if (Number.isFinite(v) && v >= 0) simCtrl('speed', v);
};
document.getElementById('compFilters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  compFilter = b.dataset.f;
  document.querySelectorAll('#compFilters button').forEach((x) => x.classList.toggle('active', x === b));
  renderCompanies();
});
document.getElementById('compSearch').oninput = (e) => {
  compSearch = e.target.value.trim();
  renderCompanies();
};

document.getElementById('btnClearSysLog').onclick = () => {
  sysLogs.length = 0;
  renderSysLogs();
};
document.getElementById('btnAdminLogout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  document.getElementById('adminUserBadge').style.display = 'none';
  document.getElementById('btnAdminLogout').style.display = 'none';
  showAuthModal('已退出当前会话，请重新登录管理员账号。');
};
document.getElementById('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('authError');
  const btn = document.getElementById('authSubmitBtn');
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const remember = document.getElementById('authRemember').checked;
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    // 先清掉可能存在的普通玩家 Cookie，确保新 Cookie  cleanly 生效
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = data.message || `登录失败 (${res.status})`;
      return;
    }
    if (data.role !== 'admin') {
      errEl.textContent = `账号 ${data.email || email} 不是管理员（role=${data.role || 'player'}），无法访问管理后台。`;
      return;
    }
    await loadCatalog();
    await refreshAll();
  } catch (err) {
    errEl.textContent = '网络请求失败，请检查服务器连接。';
  } finally {
    btn.disabled = false;
    btn.textContent = '登录并同步数据';
  }
};

function connectWs() {
  if (!authReady) return;
  if (wsInstance && wsInstance.readyState <= WebSocket.OPEN) return;
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  wsInstance = ws;
  const badge = document.getElementById('wsBadge');
  ws.onopen = () => { badge.textContent = 'WS 实时推送已连接'; badge.className = 'green'; };
  ws.onclose = () => {
    if (wsInstance === ws) wsInstance = null;
    if (!authReady) return;
    badge.textContent = 'WS 已断开，2秒后重连...';
    badge.className = 'red';
    wsRetryTimer = setTimeout(connectWs, 2000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg && msg.kind === 'tick') {
        if (msg.conservation_error !== 0) {
          appendSysLog(
            msg.tick,
            'error',
            `货币守恒异常！Δ=${msg.conservation_error} · 成交 ${msg.fills_count} 笔 · CPI ${Number(msg.cpi || 1).toFixed(3)}`,
          );
        } else if (msg.fills_count > 0 || msg.rejected_intents > 0) {
          appendSysLog(
            msg.tick,
            'sys',
            `本回合撮合成交 ${msg.fills_count} 笔 · 货币误差 Δ=${msg.conservation_error}${msg.rejected_intents > 0 ? ` · 拒绝意图 ${msg.rejected_intents}` : ''} · CPI ${Number(msg.cpi || 1).toFixed(3)}`,
          );
        }
        if (Array.isArray(msg.bankruptcies) && msg.bankruptcies.length > 0) {
          appendSysLog(msg.tick, 'warn', `NPC 破产清算：${msg.bankruptcies.join(', ')}`);
        }
      }
    } catch (_) {}
    scheduleRefresh();
  };
}

renderResetBox();
loadMe();
loadCatalog().then(refreshAll);
setInterval(() => { if (authReady) refreshAll(); }, 3000);

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'toggle-script') {
    togglePlayerScript(btn.dataset.companyId, btn.dataset.enabled === 'true');
  } else if (action === 'inspect-sandbox') {
    inspectPlayerSandbox(btn.dataset.companyId);
  } else if (action === 'reset-password') {
    resetUserPassword(Number(btn.dataset.userId), btn.dataset.email || '');
  } else if (action === 'kick-user') {
    kickUser(Number(btn.dataset.userId), btn.dataset.nickname || '');
  } else if (action === 'set-status') {
    setUserStatus(Number(btn.dataset.userId), btn.dataset.status || 'disabled', btn.dataset.nickname || '');
  } else if (action === 'clear-sandbox') {
    selectedSandbox = null;
    renderDetail();
  }
});
