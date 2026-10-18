/* FPL Draft 3: Tokyo Draft – league site
 * All data comes from the FPL draft API through the Worker set in config.js.
 */
(function () {
  'use strict';

  var C = window.CONFIG;
  var START = C.START_GW;
  var TYPES = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };

  // ------------------------------------------------------------------ helpers
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  var LS = 'tokyo:' + C.LEAGUE_ID + ':';

  function apiUrl(path) {
    var b = C.API_BASE;
    if (/script\.google(usercontent)?\.com/.test(b)) return b + (b.indexOf('?') > -1 ? '&' : '?') + 'path=' + encodeURIComponent(path);
    return b.replace(/\/+$/, '') + '/' + path;
  }

  var memo = {};
  function get(path, fresh) {
    if (!fresh && memo[path]) return memo[path];
    var p = fetch(apiUrl(path), { cache: fresh ? 'no-cache' : 'default' })
      .then(function (r) { if (!r.ok) throw new Error(path + ' → ' + r.status); return r.json(); })
      .then(function (j) { if (j && j.error) throw new Error(path + ' → ' + j.error); return j; });
    memo[path] = p;
    p.catch(function () { delete memo[path]; });
    return p;
  }

  function mapLimit(items, n, fn) {
    var i = 0;
    var workers = [];
    for (var w = 0; w < Math.min(n, items.length); w++) {
      workers.push((function next() {
        if (i >= items.length) return Promise.resolve();
        var k = i++;
        return Promise.resolve(fn(items[k], k)).then(next, next);
      })());
    }
    return Promise.all(workers);
  }

  function rankOf(list, value, key) {
    return 1 + list.filter(function (o) { return o[key] > value; }).length;
  }

  // ------------------------------------------------------------------ state
  var S = {
    gw: 0, finished: false,
    players: {}, events: [],
    managers: [], standings: [],
    histories: {}, picks: {}, live: {}, fixtures: {}, fixtureList: {},
    prevTotals: {}, phases: [], kitCodes: {},
    bonusMemo: {},
    view: { entry: null, gw: null },
    benchData: null, benchLoading: false,
    updated: null
  };

  function done(f) { return !!(f.finished || f.finished_provisional); }

  // ------------------------------------------------------------------ loading
  function boot() {
    var t0 = Date.now();
    applyTitles();
    Promise.all([get('game'), get('bootstrap-static'), get('league/' + C.LEAGUE_ID + '/details')])
      .then(function (r) {
        var game = r[0], bs = r[1], league = r[2];
        S.gw = game.current_event || 0;
        S.finished = !!game.current_event_finished;
        (bs.elements || []).forEach(function (e) {
          S.players[e.id] = { id: e.id, name: e.web_name, type: e.element_type, team: e.team };
        });
        S.events = Array.isArray(bs.events) ? bs.events : ((bs.events && bs.events.data) || []);
        (bs.teams || []).forEach(function (t) { if (t.code != null) S.kitCodes[t.id] = t.code; });
        setLeague(league);
        var jobs = S.managers.map(function (m) {
          return get('entry/' + m.entryId + '/history')
            .then(function (h) { S.histories[m.entryId] = h.history || []; })
            .catch(function () { S.histories[m.entryId] = []; });
        });
        if (S.gw >= START) jobs.push(loadGw(S.gw));
        if (C.OLD_LEAGUE_ID) jobs.push(get('league/' + C.OLD_LEAGUE_ID + '/details').then(setPrev).catch(function () {}));
        jobs.push(loadPhases());
        return Promise.all(jobs);
      })
      .then(function () {
        S.view.gw = S.gw >= START ? S.gw : null;
        S.view.entry = S.managers.length ? S.managers[0].entryId : null;
        renderAll();
        setTimeout(reveal, Math.max(0, C.MIN_LOADER_MS - (Date.now() - t0)));
        scheduleRefresh();
      })
      .catch(function (e) {
        console.error(e);
        $('#loader-text').textContent = "Couldn't reach the FPL data just now.";
        $('#retry').hidden = false;
      });
  }

  function applyTitles() {
    document.querySelectorAll('[data-title-top]').forEach(function (el) { el.textContent = C.TITLE_TOP; });
    document.querySelectorAll('[data-title]').forEach(function (el) { el.textContent = C.TITLE; });
    document.title = C.TITLE_TOP + ': ' + C.TITLE;
    $('#subtitle').textContent = 'Season ' + C.SEASON + ' · scoring from GW' + START;
    var logo = $('#loader-logo');
    logo.src = C.LOGO;
    logo.onerror = function () { logo.hidden = true; };
  }

  function reveal() {
    $('#app').hidden = false;
    $('#loader').classList.add('fade');
    setTimeout(function () { $('#loader').hidden = true; }, 450);
  }

  function setLeague(league) {
    S.managers = (league.league_entries || []).filter(function (e) { return e.entry_id; }).map(function (e) {
      return {
        lid: e.id, entryId: e.entry_id,
        name: ((e.player_first_name || '') + ' ' + (e.player_last_name || '')).trim(),
        team: e.entry_name || ''
      };
    });
    var st = league.standings || [];
    S.standings = S.managers.map(function (m) {
      var s = st.filter(function (x) { return x.league_entry === m.lid; })[0] || {};
      return { m: m, gw: s.event_total || 0, newDraft: s.total || 0 };
    });
    S.updated = new Date();
  }

  function setPrev(old) {
    // February: carry each manager's pre-January total across, matched by name.
    var byLid = {};
    (old.league_entries || []).forEach(function (e) {
      byLid[e.id] = ((e.player_first_name || '') + ' ' + (e.player_last_name || '')).trim();
    });
    (old.standings || []).forEach(function (s) { S.prevTotals[byLid[s.league_entry]] = s.total || 0; });
  }

  // FPL's main game supplies the official month groupings and each club's kit code.
  function loadPhases() {
    var cached = lsGet('tokyo:fplmeta');
    if (cached && cached.at > Date.now() - 864e5 && cached.list.length) {
      S.phases = cached.list;
      Object.keys(cached.codes || {}).forEach(function (k) { if (S.kitCodes[k] == null) S.kitCodes[k] = cached.codes[k]; });
      return Promise.resolve();
    }
    return get('fpl/bootstrap-static').then(function (bs) {
      var codes = {};
      (bs.teams || []).forEach(function (t) { if (t.code != null) codes[t.id] = t.code; });
      Object.keys(codes).forEach(function (k) { if (S.kitCodes[k] == null) S.kitCodes[k] = codes[k]; });
      var list = (bs.phases || []).filter(function (p) { return p.name !== 'Overall'; })
        .map(function (p) { return { name: p.name, start: p.start_event, stop: p.stop_event }; });
      if (!list.length) throw new Error('no phases');
      S.phases = list;
      lsSet('tokyo:fplmeta', { at: Date.now(), list: list, codes: codes });
    }).catch(function () {
      // Fallback: group gameweeks by the month of their deadline.
      var months = [];
      S.events.forEach(function (ev) {
        if (!ev.deadline_time) return;
        var name = new Date(ev.deadline_time).toLocaleString('en-GB', { month: 'long', timeZone: 'Europe/London' });
        var last = months[months.length - 1];
        if (last && last.name === name) last.stop = ev.id;
        else months.push({ name: name, start: ev.id, stop: ev.id });
      });
      S.phases = months;
    });
  }

  function loadGw(gw, fresh) {
    return get('event/' + gw + '/live', fresh).then(function (live) {
      S.live[gw] = live.elements || {};
      var fx = Array.isArray(live.fixtures) ? Promise.resolve(live.fixtures)
        : get('event/' + gw + '/fixtures', fresh).then(function (f) { return Array.isArray(f) ? f : []; }).catch(function () { return []; });
      return fx;
    }).then(function (fx) {
      S.fixtureList[gw] = fx;
      var byTeam = {};
      fx.forEach(function (f) {
        (byTeam[f.team_h] = byTeam[f.team_h] || []).push(f);
        (byTeam[f.team_a] = byTeam[f.team_a] || []).push(f);
      });
      S.fixtures[gw] = byTeam;
      delete S.bonusMemo[gw];
      return mapLimit(S.managers, 5, function (m) {
        var key = m.entryId + ':' + gw;
        if (S.picks[key]) return null;
        return get('entry/' + m.entryId + '/event/' + gw).then(function (r) {
          S.picks[key] = (r.picks || []).slice().sort(function (a, b) { return a.position - b.position; });
        }).catch(function () { S.picks[key] = []; });
      });
    });
  }

  // ------------------------------------------------------------------ scoring logic
  function info(id, gw) {
    var p = S.players[id] || { id: id, name: '#' + id, type: 0, team: 0 };
    var el = (S.live[gw] || {})[id] || {};
    var st = el.stats || {};
    var minutes = st.minutes || 0;
    var known = (S.fixtureList[gw] || []).length > 0;
    var fx = (S.fixtures[gw] || {})[p.team] || [];
    var status;
    if (!known) status = minutes > 0 ? 'played' : 'toPlay';
    else if (!fx.length) status = 'blank';
    else if (fx.every(done)) status = minutes > 0 ? 'played' : 'dnp';
    else if (fx.some(function (f) { return f.started && !done(f); })) status = 'playing';
    else status = 'toPlay';
    return { p: p, points: st.total_points || 0, minutes: minutes, bonus: st.bonus || 0, bps: st.bps || 0, status: status };
  }

  function formationOk(ids) {
    var c = { 1: 0, 2: 0, 3: 0, 4: 0 };
    ids.forEach(function (id) { var t = (S.players[id] || {}).type; if (c[t] != null) c[t]++; });
    return c[1] === 1 && c[2] >= 3 && c[3] >= 2 && c[4] >= 1;
  }

  // FPL autosub rules: a starter is replaced only once all his matches are over and he
  // played 0 minutes (or had no match). Bench players come on in bench order, must have
  // played, GK only for GK, and the formation must stay valid.
  function autosubs(picks, gw) {
    var lineup = picks.filter(function (p) { return p.position <= 11; }).map(function (p) { return p.element; });
    var bench = picks.filter(function (p) { return p.position > 11; }).map(function (p) { return p.element; });
    var out = {}, inn = {};
    lineup.slice().forEach(function (sid) {
      var s = info(sid, gw);
      if (s.status !== 'dnp' && s.status !== 'blank') return;
      var sGK = s.p.type === 1;
      for (var i = 0; i < bench.length; i++) {
        var bid = bench[i];
        if (inn[bid]) continue;
        var b = info(bid, gw);
        if ((b.p.type === 1) !== sGK) continue;
        var trial = lineup.map(function (x) { return x === sid ? bid : x; });
        if (!formationOk(trial)) continue;
        if (b.minutes <= 0) {
          // This bench player could still play: wait for him rather than skipping to the next one.
          if (b.status === 'toPlay' || b.status === 'playing') break;
          continue;
        }
        lineup = trial; out[sid] = true; inn[bid] = true;
        break;
      }
    });
    return {
      lineup: lineup,
      benchLeft: bench.filter(function (b) { return !inn[b]; }),
      out: out, inn: inn
    };
  }

  // Provisional bonus (3-2-1 on BPS) for matches in play whose bonus isn't added yet.
  function provisionalBonus(gw) {
    if (S.bonusMemo[gw]) return S.bonusMemo[gw];
    var res = {};
    var live = S.live[gw] || {};
    (S.fixtureList[gw] || []).forEach(function (f) {
      if (!f.started || f.finished) return;
      var inFixture = Object.keys(live).map(Number).filter(function (id) {
        var p = S.players[id];
        var st = (live[id] || {}).stats || {};
        return p && (p.team === f.team_h || p.team === f.team_a) && (st.minutes || 0) > 0;
      }).map(function (id) { return { id: id, bps: live[id].stats.bps || 0, bonus: live[id].stats.bonus || 0 }; });
      if (inFixture.some(function (x) { return x.bonus > 0; })) return; // already added
      inFixture.sort(function (a, b) { return b.bps - a.bps; });
      var vals = [3, 2, 1], awarded = 0, i = 0;
      while (i < inFixture.length && awarded < 3) {
        var bps = inFixture[i].bps;
        if (bps <= 0) break;
        var group = inFixture.filter(function (x) { return x.bps === bps; });
        group.forEach(function (x) { res[x.id] = vals[awarded]; });
        awarded += group.length;
        i += group.length;
      }
    });
    S.bonusMemo[gw] = res;
    return res;
  }

  function teamCalc(entryId, gw) {
    var picks = S.picks[entryId + ':' + gw] || [];
    if (!picks.length) return null;
    var subs = autosubs(picks, gw);
    var gwLive = gw === S.gw && !S.finished;
    var bonus = gwLive ? provisionalBonus(gw) : {};
    var base = 0, bonusPts = 0, bonusPlayers = [], ptp = 0, benchPts = 0;
    subs.lineup.forEach(function (id) {
      var i = info(id, gw);
      base += i.points;
      if (bonus[id]) { bonusPts += bonus[id]; bonusPlayers.push(i.p.name + ' (' + bonus[id] + ')'); }
    });
    picks.forEach(function (p) {
      if (p.position > 11) return;
      var st = info(p.element, gw).status;
      if (st === 'toPlay' || (C.PTP_COUNT_IN_PLAY && st === 'playing')) ptp++;
    });
    subs.benchLeft.forEach(function (id) { benchPts += info(id, gw).points; });
    return { total: base + bonusPts, base: base, bonusPts: bonusPts, bonusPlayers: bonusPlayers, ptp: ptp, benchPts: benchPts, subs: subs, bonus: bonus };
  }

  function liveGwPoints(m) {
    var calc = S.gw >= START ? teamCalc(m.entryId, S.gw) : null;
    var s = S.standings.filter(function (x) { return x.m.entryId === m.entryId; })[0];
    if (!calc) return { pts: s ? s.gw : 0, ptp: 0, calc: null };
    return { pts: calc.total, ptp: calc.ptp, calc: calc };
  }

  function gwPoints(m, gw) {
    if (gw === S.gw && !S.finished) return liveGwPoints(m).pts;
    var h = (S.histories[m.entryId] || []).filter(function (x) { return x.event === gw; })[0];
    return h ? (h.points || 0) : 0;
  }

  function officialRows() {
    var rows = S.standings.map(function (s) {
      var total = (S.prevTotals[s.m.name] || 0) + s.newDraft;
      return { m: s.m, gw: s.gw, total: total, prevTotal: total - s.gw };
    });
    rows.sort(function (a, b) { return (b.total - a.total) || a.m.name.localeCompare(b.m.name); });
    var started = rows.some(function (r) { return r.gw !== 0; });
    rows.forEach(function (r, i) {
      r.rank = rankOf(rows, r.total, 'total');
      r.move = started ? rankOf(rows, r.prevTotal, 'prevTotal') - r.rank : 0;
      r.gap = i === 0 ? null : rows[i - 1].total - r.total;
    });
    return rows;
  }

  // ------------------------------------------------------------------ rendering
  function renderAll() {
    renderStatus();
    renderTable();
    renderLive();
    renderTeams();
    renderMotm();
    renderForm();
    if (S.benchData) renderBench();
    route();
  }

  function renderStatus() {
    var el = $('#status');
    var txt;
    if (S.gw < START) txt = 'Pre-season · starts GW' + START;
    else if (S.finished) txt = 'GW' + S.gw + ' complete';
    else txt = 'Live · GW' + S.gw;
    el.classList.toggle('done', S.gw < START || S.finished);
    $('#status-text').textContent = txt;
  }

  function renderTable() {
    var rows = officialRows();
    var top = rows[0], second = rows[1];
    var topGw = rows.slice().sort(function (a, b) { return b.gw - a.gw; })[0];
    $('#tiles').innerHTML = [
      tile('Leader', top ? top.m.name : '–', top ? top.total : 0),
      tile(S.gw >= START ? 'Top GW' + S.gw : 'Top GW', topGw && topGw.gw ? topGw.m.name : '–', topGw ? topGw.gw : 0),
      tile('Gap 1st–2nd', 'Points', top && second ? top.total - second.total : 0)
    ].join('');
    $('#updated').textContent = S.updated ? 'Updated ' + S.updated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    $('#standings').innerHTML = rows.map(function (r, i) {
      var mv = r.move > 0 ? '<span class="mv up">▲' + r.move + '</span>'
        : r.move < 0 ? '<span class="mv down">▼' + Math.abs(r.move) + '</span>' : '<span class="mv">–</span>';
      var gap = i === 0 ? 'Leader' : (r.gap === 0 ? 'Level' : '−' + r.gap);
      return '<a class="grid-row standings-cols" href="#teams" data-entry="' + r.m.entryId + '">' +
        '<div class="pos"><span class="n">' + r.rank + '</span>' + mv + '</div>' +
        '<div class="who"><b>' + esc(r.m.name) + '</b><span>' + esc(r.m.team) + '</span></div>' +
        '<span class="gwpts">' + r.gw + '</span>' +
        '<div class="tot"><b>' + r.total + '</b><span>' + gap + '</span></div></a>';
    }).join('');
    renderRankChart();
  }

  function tile(label, name, num) {
    return '<div class="tile"><div class="tile-label">' + esc(label) + '</div><div class="tile-name">' + esc(name) +
      '</div><div class="tile-num">' + num + '</div></div>';
  }

  function renderRankChart() {
    var el = $('#rank-chart');
    var lastDone = S.finished ? S.gw : S.gw - 1;
    var cols = [];
    var cum = {};
    S.managers.forEach(function (m) { cum[m.entryId] = S.prevTotals[m.name] || 0; });
    for (var gw = START; gw <= lastDone; gw++) {
      S.managers.forEach(function (m) { cum[m.entryId] += gwPoints(m, gw); });
      cols.push({ label: 'GW' + gw, totals: Object.assign({}, cum) });
    }
    if (S.gw >= START && !S.finished) {
      var liveTot = {};
      S.managers.forEach(function (m) { liveTot[m.entryId] = cum[m.entryId] + liveGwPoints(m).pts; });
      cols.push({ label: 'GW' + S.gw + ' live', totals: liveTot });
    }
    if (cols.length < 2) {
      el.innerHTML = '<p class="empty">Rank history appears after two gameweeks from GW' + START + '.</p>';
      return;
    }
    var mgr = S.managers;
    var ranks = cols.map(function (c) {
      var list = mgr.map(function (m) { return { id: m.entryId, t: c.totals[m.entryId] }; });
      var r = {};
      list.forEach(function (x) { r[x.id] = rankOf(list, x.t, 't'); });
      return r;
    });
    var last = ranks[ranks.length - 1];
    var order = mgr.slice().sort(function (a, b) { return (last[a.entryId] - last[b.entryId]) || a.name.localeCompare(b.name); });
    var colors = ['#5B1468', '#E0711B', '#1E64C8'];
    var labelColors = ['#5B1468', '#B25510', '#1E64C8'];
    var hi = {};
    order.slice(0, 3).forEach(function (m, i) { hi[m.entryId] = i; });

    var n = cols.length, step = n <= 6 ? 80 : 40, rowH = 24;
    var x = function (i) { return 24 + i * step; };
    var y = function (r) { return 16 + (r - 1) * rowH; };
    var W = x(n - 1) + 150, H = y(mgr.length) + 40;
    var svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Rank by gameweek for each manager">';
    cols.forEach(function (c, i) { svg += '<line x1="' + x(i) + '" y1="8" x2="' + x(i) + '" y2="' + (y(mgr.length) + 8) + '" stroke="#EFECE6"/>'; });
    var line = function (m, color, width) {
      var pts = ranks.map(function (r, i) { return x(i) + ',' + y(r[m.entryId]); }).join(' ');
      return '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linejoin="round"><title>' + esc(m.name) + '</title></polyline>';
    };
    mgr.forEach(function (m) { if (hi[m.entryId] == null) svg += line(m, '#D3CDC4', 2); });
    order.slice(0, 3).reverse().forEach(function (m) { svg += line(m, colors[hi[m.entryId]], 3); });
    order.slice(0, 3).forEach(function (m) {
      svg += '<circle cx="' + x(n - 1) + '" cy="' + y(last[m.entryId]) + '" r="4" fill="' + colors[hi[m.entryId]] + '"/>';
    });
    // labels: group ties onto one line
    var byRank = {};
    order.forEach(function (m) { (byRank[last[m.entryId]] = byRank[last[m.entryId]] || []).push(m); });
    Object.keys(byRank).forEach(function (r) {
      var ms = byRank[r];
      var text = r + ' ' + (ms.length > 1 ? ms.map(function (m) { return m.name.split(' ').slice(-1)[0]; }).join(' · ') : ms[0].name);
      var h = hi[ms[0].entryId];
      svg += '<text x="' + (x(n - 1) + 12) + '" y="' + (y(+r) + 4) + '" font-size="12" ' +
        (h != null ? 'font-weight="600" fill="' + labelColors[h] + '"' : 'fill="#4A434F"') + '>' + esc(text) + '</text>';
    });
    cols.forEach(function (c, i) {
      svg += '<text x="' + x(i) + '" y="' + (H - 8) + '" font-size="12" font-weight="600" fill="#6B6470" text-anchor="middle">' + esc(c.label) + '</text>';
    });
    el.innerHTML = svg + '</svg>';
    el.scrollLeft = el.scrollWidth;
  }

  function renderLive() {
    if (S.gw < START) {
      $('#live-title').textContent = 'Pre-season';
      $('#live-gw').innerHTML = $('#live-table').innerHTML = '<p class="note">Scoring starts GW' + START + '.</p>';
      $('#bonus').innerHTML = '<p class="empty">No matches in play.</p>';
      $('#live-note').textContent = '';
      return;
    }
    $('#live-title').textContent = 'Gameweek ' + S.gw;
    $('#live-refresh').textContent = S.finished ? 'Gameweek complete' : 'Refreshes every minute';
    var official = officialRows();
    var rows = official.map(function (r) {
      var lg = liveGwPoints(r.m);
      return { m: r.m, gwPts: lg.pts, ptp: lg.ptp, calc: lg.calc, liveTotal: r.total - r.gw + lg.pts };
    });
    var byGw = rows.slice().sort(function (a, b) { return (b.gwPts - a.gwPts) || a.m.name.localeCompare(b.m.name); });
    var byTot = rows.slice().sort(function (a, b) { return (b.liveTotal - a.liveTotal) || a.m.name.localeCompare(b.m.name); });
    $('#live-gw').innerHTML = byGw.map(function (r) {
      return '<a class="grid-row gw-cols" href="#teams" data-entry="' + r.m.entryId + '"><span class="nm">' + esc(r.m.name) +
        '</span><span class="big">' + r.gwPts + '</span><span class="sm">' + r.ptp + '</span></a>';
    }).join('');
    $('#live-table').innerHTML = byTot.map(function (r) {
      return '<a class="grid-row lt-cols" href="#teams" data-entry="' + r.m.entryId + '"><span class="rk">' + rankOf(byTot, r.liveTotal, 'liveTotal') +
        '</span><span class="nm">' + esc(r.m.name) + '</span><span class="big">' + r.liveTotal + '</span></a>';
    }).join('');
    $('#live-note').textContent = 'PTP = starters whose match ' + (C.PTP_COUNT_IN_PLAY ? "hasn't finished" : "hasn't kicked off") +
      '. The live table includes provisional bonus and projected autosubs, and becomes official once FPL confirms the gameweek.';
    var withBonus = rows.filter(function (r) { return r.calc && r.calc.bonusPts > 0; })
      .sort(function (a, b) { return b.calc.bonusPts - a.calc.bonusPts; });
    var others = rows.length - withBonus.length;
    $('#bonus').innerHTML = (withBonus.length ? withBonus.map(function (r) {
      return '<div class="bonus-row"><div><b>' + esc(r.m.name) + '</b><span>' + esc(r.calc.bonusPlayers.join(' · ')) +
        '</span></div><span class="pts">+' + r.calc.bonusPts + '</span></div>';
    }).join('') : '') +
      (others ? '<div class="bonus-row"><div><b>' + (withBonus.length ? 'Everyone else' : 'No provisional bonus') + '</b><span>' +
        (S.finished ? 'Bonus is confirmed for this gameweek' : 'Nothing from matches in play yet') + '</span></div><span class="pts" style="color:#8E8892">0</span></div>' : '');
  }

  // ---------- Teams
  function renderTeams() {
    $('#chips').innerHTML = S.managers.map(function (m) {
      return '<button type="button" class="chip" data-chip="' + m.entryId + '" aria-pressed="' + (m.entryId === S.view.entry) + '">' + esc(m.name) + '</button>';
    }).join('');
    var m = S.managers.filter(function (x) { return x.entryId === S.view.entry; })[0];
    if (!m) return;
    $('#team-manager').textContent = m.name;
    $('#team-team').textContent = m.team;
    var gw = S.view.gw;
    if (gw == null) {
      $('#gw-label').textContent = '–';
      $('#gw-prev').disabled = $('#gw-next').disabled = true;
      $('#team-tiles').innerHTML = '';
      $('#pitch-wrap').innerHTML = '<div class="card pad"><p class="empty">Team sheets appear from GW' + START + '.</p></div>';
      return;
    }
    $('#gw-label').textContent = 'GW' + gw;
    $('#gw-prev').disabled = gw <= START;
    $('#gw-next').disabled = gw >= S.gw;

    if (!S.picks[m.entryId + ':' + gw]) {
      $('#pitch-wrap').innerHTML = '<div class="card pad"><p class="empty">Loading GW' + gw + '…</p></div>';
      loadGw(gw).then(function () { if (S.view.gw === gw) renderTeams(); });
      return;
    }
    var calc = teamCalc(m.entryId, gw);
    if (!calc) {
      $('#team-tiles').innerHTML = '';
      $('#pitch-wrap').innerHTML = '<div class="card pad"><p class="empty">No team found for GW' + gw + '.</p></div>';
      return;
    }
    $('#team-tiles').innerHTML =
      tile('Points', '', calc.total).replace('<div class="tile-name"></div>', '') +
      tile('To play', '', calc.ptp).replace('<div class="tile-name"></div>', '') +
      tile('Bench pts', '', calc.benchPts).replace('<div class="tile-name"></div>', '');

    var picks = S.picks[m.entryId + ':' + gw];
    var starters = picks.filter(function (p) { return p.position <= 11; }).map(function (p) { return p.element; });
    var bench = picks.filter(function (p) { return p.position > 11; }).map(function (p) { return p.element; });
    var lines = [1, 2, 3, 4].map(function (t) {
      return starters.filter(function (id) { return (S.players[id] || {}).type === t; });
    }).filter(function (l) { return l.length; });
    var html = '<section class="pitch" aria-label="Starting eleven"><div class="pitch-inner">' +
      lines.map(function (l) { return '<div class="line">' + l.map(function (id) { return playerTile(id, gw, calc, false); }).join('') + '</div>'; }).join('') +
      '</div></section>' +
      '<section class="bench" aria-label="Bench"><h2>Bench</h2><div class="line">' +
      bench.map(function (id) { return playerTile(id, gw, calc, true); }).join('') + '</div></section>';
    $('#pitch-wrap').innerHTML = html;
  }

  function plainShirt(type, bench, hidden) {
    var fill = bench ? '#F3F1EC' : (type === 1 ? '#3DF5A0' : '#FFFFFF');
    var stroke = bench ? '#8E8892' : '#2B0A31';
    return '<svg class="kit-fallback" width="40" height="36" viewBox="0 0 40 36" aria-hidden="true"' + (hidden ? ' hidden' : '') +
      '><path d="M12 2 4 8l4 8 3-2v20h18V14l3 2 4-8-8-6q-8 5-16 0Z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/></svg>';
  }

  // The club's real kit from FPL (goalkeepers get the keeper kit); plain shirt if the image fails.
  function shirt(p, bench) {
    var code = S.kitCodes[p.team];
    if (code == null || !C.KIT_URL) return plainShirt(p.type, bench, false);
    var src = C.KIT_URL.replace('{code}', code + (p.type === 1 ? '_1' : ''));
    return '<img class="kit" src="' + esc(src) + '" alt="" aria-hidden="true" loading="lazy" ' +
      'onerror="this.hidden=true;this.nextElementSibling.removeAttribute(\'hidden\')">' + plainShirt(p.type, bench, true);
  }

  function playerTile(id, gw, calc, isBench) {
    var i = info(id, gw);
    var b = calc.bonus[id] || 0;
    var pts = i.points + b;
    var bonusTxt = b ? ' <small>+' + b + '</small>' : '';
    var pill, off = calc.subs.out[id];
    if (off) pill = '<span class="pill pill-off">0 mins ▼</span>';
    else if (calc.subs.inn[id]) pill = '<span class="pill pill-in">▲ ' + pts + ' pts' + bonusTxt + '</span>';
    else if (i.status === 'blank') pill = '<span class="pill pill-off">No game</span>';
    else if (i.status === 'toPlay') pill = i.points ? '<span class="pill pill-toplay">' + i.points + ' · more</span>' : '<span class="pill pill-toplay">To play</span>';
    else if (i.status === 'playing') pill = '<span class="pill pill-live">● ' + pts + ' pts' + bonusTxt + '</span>';
    else pill = '<span class="pill pill-done">' + pts + ' pts</span>';
    var label = esc(i.p.name) + ', ' + (TYPES[i.p.type] || '') + (isBench ? ', bench' : '');
    return '<div class="pl' + (off ? ' off' : '') + '" title="' + label + '">' + shirt(i.p, isBench) +
      '<span class="nm">' + esc(i.p.name) + '</span>' + pill + '</div>';
  }

  // ---------- Awards
  function renderMotm() {
    var el = $('#motm');
    var phases = S.phases.filter(function (p) { return p.stop >= START; });
    if (!phases.length || S.gw < START) {
      el.innerHTML = '<div class="award-top"><h1>Manager of the Month</h1><div class="sub muted">Starts in GW' + START + '.</div></div>';
      return;
    }
    function monthPts(p) {
      var from = Math.max(p.start, START), to = Math.min(p.stop, S.gw);
      var list = S.managers.map(function (m) {
        var t = 0;
        for (var g = from; g <= to; g++) t += gwPoints(m, g);
        return { m: m, pts: t };
      });
      list.sort(function (a, b) { return (b.pts - a.pts) || a.m.name.localeCompare(b.m.name); });
      return list;
    }
    var current = phases.filter(function (p) { return p.start <= S.gw && p.stop >= S.gw; })[0] || phases[phases.length - 1];
    var list = monthPts(current);
    var monthDone = current.stop < S.gw || (current.stop === S.gw && S.finished);
    var lead = list[0], gap = list[1] ? lead.pts - list[1].pts : 0;
    var joint = list.filter(function (x) { return x.pts === lead.pts; });
    var from = Math.max(current.start, START);
    var html = '<div class="award-top"><div class="card-head"><h1>Manager of the Month</h1><span class="meta">' + esc(current.name) +
      ' · GW' + from + (current.stop > from ? '–GW' + current.stop : '') + '</span></div>' +
      '<div class="winner"><div class="trophy"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#FFD34D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg></div>' +
      '<div><div class="lbl">' + (monthDone ? 'Winner' : 'Leading' + (S.finished ? '' : ' · GW' + S.gw + ' still live')) + '</div>' +
      '<div class="big">' + esc(joint.map(function (x) { return x.m.name; }).join(' & ')) + '</div>' +
      '<div class="sub">' + lead.pts + ' pts this month' + (joint.length > 1 ? ' · tied' : ' · ' + gap + ' clear') + '</div></div></div></div>';
    html += list.slice(joint.length).map(function (x) {
      return '<div class="rank-row"><span class="n">' + rankOf(list, x.pts, 'pts') + '</span><span class="nm">' + esc(x.m.name) + '</span><span class="v">' + x.pts + '</span></div>';
    }).join('');
    var past = phases.filter(function (p) { return p !== current && (p.stop < S.gw || (p.stop === S.gw && S.finished)); }).reverse();
    html += '<div class="past"><div class="section-lbl">Previous winners</div>' + (past.length ? past.map(function (p) {
      var l = monthPts(p), top = l.filter(function (x) { return x.pts === l[0].pts; });
      return '<div class="past-row"><span><b>' + esc(p.name) + '</b> · ' + esc(top.map(function (x) { return x.m.name; }).join(' & ')) + '</span><span>' + l[0].pts + ' pts</span></div>';
    }).join('') : '<div class="empty">The first award is given when ' + esc(current.name) + ' ends.</div>') + '</div>';
    el.innerHTML = html;
  }

  // ---------- Form guide and best / worst gameweeks (completed gameweeks only)
  function completedGws() {
    var last = S.finished ? S.gw : S.gw - 1;
    var list = [];
    for (var g = START; g <= last; g++) list.push(g);
    return list;
  }

  function renderForm() {
    var gws = completedGws();
    if (!gws.length) {
      var msg = '<p class="note">Appears once GW' + START + ' is complete.</p>';
      $('#form').innerHTML = msg;
      $('#best').innerHTML = $('#worst').innerHTML = '<p class="note">After GW' + START + '.</p>';
      $('#form-note').textContent = '';
      return;
    }
    var last5 = gws.slice(-5);
    $('#form-note').textContent = gws.length === 1 ? 'GW' + gws[0] : 'GW' + gws[0] + '–GW' + gws[gws.length - 1];
    var rows = S.managers.map(function (m) {
      var pts = gws.map(function (g) { return gwPoints(m, g); });
      var recent = pts.slice(-5);
      var season = pts.reduce(function (a, b) { return a + b; }, 0) / pts.length;
      var l5 = recent.reduce(function (a, b) { return a + b; }, 0) / recent.length;
      var best = 0, worst = 0;
      pts.forEach(function (p, i) { if (p > pts[best]) best = i; if (p < pts[worst]) worst = i; });
      return {
        m: m, season: Math.round(season * 10) / 10, l5: Math.round(l5 * 10) / 10,
        best: { pts: pts[best], gw: gws[best] }, worst: { pts: pts[worst], gw: gws[worst] }
      };
    });
    rows.sort(function (a, b) { return (b.l5 - a.l5) || (b.season - a.season) || a.m.name.localeCompare(b.m.name); });
    var topL5 = rows[0].l5;
    $('#form').innerHTML = rows.map(function (r) {
      var t = r.l5 > r.season ? ['up', '▲'] : r.l5 < r.season ? ['down', '▼'] : ['level', '–'];
      return '<div class="grid-row form-cols' + (r.l5 === topL5 && topL5 > 0 ? ' lead' : '') + '">' +
        '<span class="nm">' + esc(r.m.name) + '</span><span class="s">' + r.season.toFixed(1) + '</span>' +
        '<span class="v">' + r.l5.toFixed(1) + '</span><span class="trend ' + t[0] + '" aria-label="' + t[0] + '">' + t[1] + '</span></div>';
    }).join('');
    function rec(key, dir) {
      var list = rows.slice().sort(function (a, b) { return dir * (b[key].pts - a[key].pts) || a.m.name.localeCompare(b.m.name); });
      return list.map(function (r) {
        return '<div class="grid-row rec-cols"><span class="nm">' + esc(r.m.name) + '</span><span class="gw">' + r[key].gw +
          '</span><span class="big">' + r[key].pts + '</span></div>';
      }).join('');
    }
    $('#best').innerHTML = rec('best', 1);
    $('#worst').innerHTML = rec('worst', -1);
    if (last5.length < 5) $('#form-note').textContent += ' · last 5 fills up by GW' + (START + 4);
  }

  function loadBench() {
    if (S.benchData || S.benchLoading || S.gw < START) { if (S.gw < START) renderBench(); return; }
    S.benchLoading = true;
    $('#bench-card').innerHTML = '<div class="card-head"><h2>Left on the bench</h2></div><p class="note">Loading bench scores…</p>';
    var gws = [];
    for (var g = START; g <= S.gw; g++) gws.push(g);
    var data = {};
    mapLimit(gws, 2, function (gw) {
      var finishedGw = gw < S.gw || S.finished;
      var cached = finishedGw ? lsGet(LS + 'bench:' + gw) : null;
      if (cached) { data[gw] = cached; return null; }
      return loadGw(gw).then(function () {
        var row = {};
        S.managers.forEach(function (m) { var c = teamCalc(m.entryId, gw); row[m.entryId] = c ? c.benchPts : 0; });
        data[gw] = row;
        if (finishedGw) lsSet(LS + 'bench:' + gw, row);
      });
    }).then(function () {
      S.benchData = data; S.benchLoading = false; renderBench();
    }).catch(function () {
      S.benchLoading = false;
      $('#bench-card').innerHTML = '<div class="card-head"><h2>Left on the bench</h2></div><p class="note">Couldn\'t load bench scores. Reopen this tab to try again.</p>';
    });
  }

  function renderBench() {
    var el = $('#bench-card');
    var head = '<div class="card-head" style="flex-direction:column;align-items:flex-start;gap:4px"><h2>Left on the bench</h2>' +
      '<span class="muted" style="font-size:14px">Points scored by bench players who never came on. Season total, GW' + START + ' onwards.</span></div>';
    if (!S.benchData) { el.innerHTML = head + '<p class="note">Bench scores load when you open this tab.</p>'; return; }
    var totals = S.managers.map(function (m) {
      var t = 0;
      Object.keys(S.benchData).forEach(function (g) {
        // the live gameweek is recalculated so it stays current
        var v = (+g === S.gw && !S.finished) ? ((teamCalc(m.entryId, S.gw) || {}).benchPts || 0) : (S.benchData[g][m.entryId] || 0);
        t += v;
      });
      return { m: m, pts: t };
    }).sort(function (a, b) { return (b.pts - a.pts) || a.m.name.localeCompare(b.m.name); });
    var worst = null;
    Object.keys(S.benchData).forEach(function (g) {
      S.managers.forEach(function (m) {
        var v = S.benchData[g][m.entryId] || 0;
        if (!worst || v > worst.v) worst = { v: v, m: m, gw: g };
      });
    });
    el.innerHTML = head +
      (worst && worst.v > 0 ? '<div class="worst"><div><span class="section-lbl">Worst single week</span><b>' + esc(worst.m.name) + ' · GW' + worst.gw +
        '</b></div><span class="v">' + worst.v + '</span></div>' : '') +
      totals.map(function (x) {
        return '<div class="rank-row"><span class="n">' + rankOf(totals, x.pts, 'pts') + '</span><span class="nm">' + esc(x.m.name) + '</span><span class="v">' + x.pts + '</span></div>';
      }).join('') + '<p class="note">Includes projected autosubs for the gameweek in progress.</p>';
  }

  // ------------------------------------------------------------------ navigation & events
  var TABS = ['table', 'live', 'teams', 'stats'];
  function route() {
    var t = location.hash.slice(1);
    if (t === 'awards') t = 'stats'; // old links still work
    if (TABS.indexOf(t) < 0) t = 'table';
    TABS.forEach(function (k) {
      $('#tab-' + k).hidden = k !== t;
      var a = document.querySelector('.tabs a[href="#' + k + '"]');
      if (k === t) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (t === 'stats') loadBench();
  }
  window.addEventListener('hashchange', function () { route(); window.scrollTo(0, 0); });

  document.addEventListener('click', function (e) {
    var row = e.target.closest('[data-entry]');
    if (row) { S.view.entry = +row.getAttribute('data-entry'); renderTeams(); }
    var chip = e.target.closest('[data-chip]');
    if (chip) { S.view.entry = +chip.getAttribute('data-chip'); renderTeams(); }
  });
  $('#gw-prev').addEventListener('click', function () { if (S.view.gw > START) { S.view.gw--; renderTeams(); } });
  $('#gw-next').addEventListener('click', function () { if (S.view.gw < S.gw) { S.view.gw++; renderTeams(); } });
  $('#retry').addEventListener('click', function () { location.reload(); });

  // ------------------------------------------------------------------ live refresh
  function scheduleRefresh() {
    setTimeout(function tick() {
      var live = S.gw >= START && !S.finished;
      if (!live || document.visibilityState !== 'visible') return setTimeout(tick, C.REFRESH_SECONDS * 1000);
      get('game', true).then(function (game) {
        if ((game.current_event || 0) !== S.gw) { location.reload(); return; }
        S.finished = !!game.current_event_finished;
        return Promise.all([get('league/' + C.LEAGUE_ID + '/details', true).then(setLeague), loadGw(S.gw, true)]);
      }).then(function () { renderAll(); }).catch(function (e) { console.warn('refresh failed', e); })
        .then(function () { setTimeout(tick, C.REFRESH_SECONDS * 1000); });
    }, C.REFRESH_SECONDS * 1000);
  }

  boot();
})();
