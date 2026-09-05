/*! Energia Consumi Card — card consumi interattiva per Home Assistant.
 *  Gira interamente nel browser e legge i dati da HA (recorder/statistics),
 *  quindi NON dipende dal mini PC/server esterno.
 *  Config (YAML della card):
 *    type: custom:energia-consumi-card
 *    title: Consumi di casa        # opzionale
 *    days_back: 8                  # 7/14/30
 *    open_on: today                # today | record
 *    prezzo_kwh: 0.30              # €/kWh (costo orientativo)
 *    soglia_media: 33             # % barra gialla
 *    soglia_alta: 66              # % barra rossa
 *    lampeggio_record: true       # 👑 lampeggio giorno record
 */
const CARD_VERSION = "1.0.1";
console.info(`%c ENERGIA-CONSUMI-CARD %c v${CARD_VERSION} `,
  "color:#241200;background:#ff8a3d;font-weight:700;border-radius:4px 0 0 4px",
  "color:#ffb020;background:#1a1b21;border-radius:0 4px 4px 0");

const WD = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

class EnergiaConsumiCard extends HTMLElement {
  setConfig(config) {
    this._cfg = Object.assign({
      title: "Consumi di casa",
      days_back: 8,
      open_on: "today",
      prezzo_kwh: 0.30,
      soglia_media: 33,
      soglia_alta: 66,
      lampeggio_record: true,
    }, config || {});
    this._loaded = false;
    this._data = null;
    this._curDay = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loaded = true;
      this._boot();
    }
  }

  getCardSize() { return 9; }

  async _boot() {
    this.innerHTML = this._shellHTML();
    this._root = this.querySelector(".eca");
    try {
      await this._load();
      this._render();
    } catch (e) {
      this._root.innerHTML =
        `<div class="err">⚡ Dati non disponibili<br><small>${(e && e.message) || e}</small></div>`;
      console.error("[energia-consumi-card]", e);
    }
  }

  // ---- dati da HA -----------------------------------------------------------
  async _load() {
    const hass = this._hass;
    let gridStat = "sensor.generale_channel_1_energy";
    let devs = [], names = {};
    try {
      const prefs = await hass.callWS({ type: "energy/get_prefs" });
      for (const s of (prefs.energy_sources || [])) {
        if (s.type === "grid" && s.stat_energy_from) { gridStat = s.stat_energy_from; break; }
      }
      for (const d of (prefs.device_consumption || [])) {
        if (d.stat_consumption) { devs.push(d.stat_consumption); names[d.stat_consumption] = d.name || d.stat_consumption; }
      }
    } catch (e) { /* prefs opzionali */ }
    // nomi leggibili dagli stati (fallback)
    for (const id of devs) {
      const st = hass.states[id];
      if ((!names[id] || names[id] === id) && st && st.attributes && st.attributes.friendly_name)
        names[id] = st.attributes.friendly_name;
    }

    const daysBack = parseInt(this._cfg.days_back) || 8;
    const now = new Date();
    const start = new Date(now.getTime() - daysBack * 86400000);
    const q = (ids) => hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(), end_time: now.toISOString(),
      statistic_ids: ids, period: "hour", types: ["change"],
    });

    // grid orario
    const gres = await q([gridStat]);
    const grows = (gres && gres[gridStat]) || [];
    const perDayHour = {};
    for (const r of grows) {
      const t = new Date(r.start);
      let ch = r.change; if (ch == null || ch < 0) ch = 0;
      const k = this._dkey(t);
      (perDayHour[k] = perDayHour[k] || new Array(24).fill(0))[t.getHours()] = Math.round(ch * 1000) / 1000;
    }
    const perDay = {};
    for (const k in perDayHour) perDay[k] = Math.round(perDayHour[k].reduce((a, b) => a + b, 0) * 100) / 100;

    // device orario
    const perDayRankRaw = {}, perDayHourRaw = {};
    if (devs.length) {
      const dres = await q(devs);
      for (const dev of devs) {
        for (const r of ((dres && dres[dev]) || [])) {
          let ch = r.change; if (ch == null || ch <= 0) continue;
          const t = new Date(r.start), day = this._dkey(t), h = t.getHours();
          (perDayRankRaw[day] = perDayRankRaw[day] || {});
          perDayRankRaw[day][dev] = (perDayRankRaw[day][dev] || 0) + ch;
          (perDayHourRaw[day] = perDayHourRaw[day] || {});
          (perDayHourRaw[day][h] = perDayHourRaw[day][h] || {});
          perDayHourRaw[day][h][dev] = (perDayHourRaw[day][h][dev] || 0) + ch;
        }
      }
    }
    const topn = (dic, n) => Object.entries(dic)
      .map(([k, v]) => ({ name: names[k] || k, kwh: Math.round(v * 1000) / 1000 }))
      .filter(x => x.kwh > 0.001).sort((a, b) => b.kwh - a.kwh).slice(0, n);
    const perDayRank = {}, perDayHourTop = {};
    for (const day in perDayRankRaw) perDayRank[day] = topn(perDayRankRaw[day], 10);
    for (const day in perDayHourRaw) {
      perDayHourTop[day] = {};
      for (const h in perDayHourRaw[day]) perDayHourTop[day][h] = topn(perDayHourRaw[day][h], 5);
    }

    const daysSorted = Object.keys(perDay).sort();
    const meta = daysSorted.map(k => {
      const d = new Date(k + "T12:00:00");
      return { date: k, label: `${WD[(d.getDay() + 6) % 7]} ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`, total: perDay[k] };
    });

    const today = this._dkey(new Date());
    const have = new Set(meta.map(d => d.date));
    let def;
    if (this._cfg.open_on === "record" && meta.length) def = meta.reduce((a, b) => b.total > a.total ? b : a).date;
    else if (have.has(today)) def = today;
    else def = meta.length ? meta[meta.length - 1].date : null;

    this._data = { meta, perDayHour, perDayRank, perDayHourTop };
    this._curDay = def;
    this._maxTot = Math.max(...meta.map(d => d.total), 0.001);
  }

  _dkey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

  // ---- helpers presentazione ------------------------------------------------
  _fmt(x) { return (Math.round(x * 100) / 100).toLocaleString("it-IT", { minimumFractionDigits: x < 10 ? 2 : 1, maximumFractionDigits: 2 }); }
  _fmtE(k) { return "≈ " + (k * (parseFloat(this._cfg.prezzo_kwh) || 0)).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"; }
  _color(v, max) {
    if (max <= 0) return "var(--eca-stroke)";
    const r = v / max, mid = (this._cfg.soglia_media || 33) / 100, hi = (this._cfg.soglia_alta || 66) / 100;
    if (r >= hi) return "linear-gradient(180deg,#ff7a4d,#ff5442)";
    if (r >= mid) return "linear-gradient(180deg,#ffd166,#ffb020)";
    return "linear-gradient(180deg,#5fe08c,#3fbf6f)";
  }

  _rankHTML(list) {
    if (!list || !list.length) return '<div class="eca-empty">Nessun consumo registrato</div>';
    const mx = Math.max(...list.map(x => x.kwh), 0.001);
    return list.map((x, i) => {
      const pct = Math.max(3, Math.round(x.kwh / mx * 100));
      return `<div class="eca-row"><div class="eca-pos">${i + 1}</div>
        <div class="eca-b"><div class="eca-nm">${this._esc(x.name.trim())}</div>
        <div class="eca-tr"><i style="width:${pct}%"></i></div></div>
        <div class="eca-kv">${this._fmt(x.kwh)}<small>kWh</small><span class="eca-eur">${this._fmtE(x.kwh)}</span></div></div>`;
    }).join("");
  }
  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  _render() {
    const d = this._data, cur = this._curDay;
    const day = d.meta.find(x => x.date === cur);
    const hrs = d.perDayHour[cur] || new Array(24).fill(0);
    const mxH = Math.max(...hrs, 0.001);
    const peak = hrs.indexOf(Math.max(...hrs));
    const rec = d.meta.reduce((a, b) => b.total > a.total ? b : a, d.meta[0]);
    const blink = this._cfg.lampeggio_record;

    // giorni
    const daysHTML = d.meta.map(x => {
      const isRec = blink && x.total === this._maxTot;
      const pct = Math.max(6, Math.round(x.total / this._maxTot * 100));
      return `<div class="eca-day${x.date === cur ? " sel" : ""}${isRec ? " rec" : ""}" data-day="${x.date}">
        ${isRec ? '<div class="eca-crown">👑</div>' : ""}<div class="eca-dl">${x.label}</div>
        <div class="eca-dk">${this._fmt(x.total)}<span class="eca-dku"> kWh</span></div>
        <div class="eca-sp"><i style="width:${pct}%;background:${this._color(x.total, this._maxTot)}"></i></div></div>`;
    }).join("");

    // ore
    const chartHTML = hrs.map((v, h) => {
      const hp = Math.max(2, Math.round(v / mxH * 100));
      return `<div class="eca-hcol${h === peak && v > 0 ? " pk" : ""}" data-h="${h}">
        ${h === peak && v > 0 ? `<div class="eca-flag">${this._fmt(v)}</div>` : ""}
        <div class="eca-bar" style="height:${hp}%;background:${v > 0 ? this._color(v, mxH) : "var(--eca-stroke)"}"></div>
        <div class="eca-hl">${h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div></div>`;
    }).join("");

    this._root.innerHTML = `
      <div class="eca-top">
        <div><h1>${this._esc(this._cfg.title)}</h1><div class="eca-sub">${day ? day.label : "—"}</div></div>
        <div class="eca-big"><div><span class="eca-n">${day ? this._fmt(day.total) : "0"}</span><span class="eca-u">kWh</span></div>
          <div class="eca-cost">${day ? this._fmtE(day.total) : ""}</div><div class="eca-cap">totale giorno</div></div>
      </div>
      <div class="eca-days">${daysHTML}</div>
      <div class="eca-chip"><div class="eca-ic">👑</div><div class="eca-cb">
        <div class="eca-clab">Giorno record (${d.meta.length} gg)</div><div class="eca-cday">${rec.label}</div></div>
        <div class="eca-cval">${this._fmt(rec.total)} kWh<small>${this._fmtE(rec.total)}</small></div><div class="eca-go">›</div></div>
      <div class="eca-panel"><h2>🕐 Consumo per ora</h2>
        <p class="eca-hint">Tocca un'ora per vedere quale elettrodomestico ha consumato di più</p>
        <div class="eca-chart">${chartHTML}</div></div>
      <div class="eca-panel"><h2>🏆 Classifica elettrodomestici</h2>
        <p class="eca-hint">Del giorno selezionato</p><div class="eca-rank">${this._rankHTML(d.perDayRank[cur])}</div></div>
      <div class="eca-add">➕ Aggiungi sensori di consumo</div>`;

    // eventi
    this._root.querySelectorAll(".eca-day").forEach(el =>
      el.onclick = () => { this._curDay = el.dataset.day; this._render(); });
    this._root.querySelectorAll(".eca-hcol").forEach(el =>
      el.onclick = () => this._openHour(parseInt(el.dataset.h)));
    const chip = this._root.querySelector(".eca-chip");
    const back = d.meta.length ? d.meta[d.meta.length - 1].date : rec.date;
    if (rec.date === cur) chip.classList.add("iscur");
    chip.onclick = () => { this._curDay = (this._curDay === rec.date) ? back : rec.date; this._render(); this._scrollSel(); };
    const add = this._root.querySelector(".eca-add");
    if (add) add.onclick = () => this._nav("/config/energy/dashboard");
    this._scrollSel();
  }

  // navigazione SPA dentro HA (verso la pagina di configurazione Energia)
  _nav(path) {
    try {
      history.pushState(null, "", path);
      this.dispatchEvent(new Event("location-changed", { bubbles: true, composed: true }));
    } catch (e) { window.location.href = path; }
  }

  _scrollSel() {
    try {
      const c = this._root.querySelector(".eca-days"), s = c.querySelector(".eca-day.sel");
      if (s) c.scrollLeft = s.offsetLeft - c.clientWidth / 2 + s.clientWidth / 2;
    } catch (e) {}
  }

  _openHour(h) {
    const d = this._data, cur = this._curDay;
    const day = d.meta.find(x => x.date === cur);
    const v = (d.perDayHour[cur] || [])[h] || 0;
    const top = (d.perDayHourTop[cur] || {})[String(h)] || [];
    let ov = this.querySelector(".eca-scrim");
    if (!ov) { ov = document.createElement("div"); ov.className = "eca-scrim"; this._root.appendChild(ov); }
    ov.innerHTML = `<div class="eca-modal">
      <div class="eca-mh"><div><div class="eca-mt">Ore ${String(h).padStart(2, "0")}:00</div>
      <div class="eca-ms">${day ? day.label : ""}</div></div><button class="eca-x">✕</button></div>
      <div class="eca-mtot">Consumo di quell'ora: ${this._fmt(v)} kWh · ${this._fmtE(v)}</div>
      <div class="eca-rank">${this._rankHTML(top)}</div></div>`;
    requestAnimationFrame(() => ov.classList.add("on"));
    const close = () => ov.classList.remove("on");
    ov.querySelector(".eca-x").onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
  }

  _shellHTML() {
    return `<style>
    .eca{--eca-panel:rgba(26,27,33,.72);--eca-solid:#1a1b21;--eca-stroke:rgba(255,255,255,.09);
      --eca-ink:#ecebe8;--eca-muted:#9c988f;--eca-faint:#6f6c66;--eca-acc:#ff8a3d;--eca-acc2:#ffb020;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--eca-ink);
      display:flex;flex-direction:column;gap:14px;padding:4px}
    .eca *{box-sizing:border-box}
    .eca h1{margin:0;font-size:18px;font-weight:800;letter-spacing:-.2px}
    .eca h2{margin:0 0 2px;font-size:14px;font-weight:800}
    .eca-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:2px}
    .eca-sub{margin-top:3px;font-size:12px;color:var(--eca-muted);font-weight:500}
    .eca-big{text-align:right;line-height:1}
    .eca-n{font-size:32px;font-weight:850;letter-spacing:-1px;font-variant-numeric:tabular-nums;
      background:linear-gradient(180deg,#fff,#ffb98a);-webkit-background-clip:text;background-clip:text;color:transparent}
    .eca-u{font-size:13px;color:var(--eca-muted);font-weight:700;margin-left:2px}
    .eca-cost{font-size:14px;font-weight:800;color:var(--eca-acc2);margin-top:3px;font-variant-numeric:tabular-nums}
    .eca-cap{font-size:9.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--eca-faint);font-weight:800;margin-top:3px}
    .eca-days{display:flex;gap:8px;overflow-x:auto;padding:6px 2px 8px;scrollbar-width:none}
    .eca-days::-webkit-scrollbar{display:none}
    .eca-day{position:relative;flex:0 0 auto;min-width:66px;padding:10px 12px;border-radius:16px;cursor:pointer;
      background:var(--eca-panel);border:1px solid var(--eca-stroke);display:flex;flex-direction:column;gap:5px;
      align-items:flex-start;transition:transform .15s,border-color .15s,background .15s}
    .eca-day:hover{transform:translateY(-2px)}
    .eca-dl{font-size:11px;color:var(--eca-muted);font-weight:700;white-space:nowrap}
    .eca-dk{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
    .eca-dku{font-size:10px;color:var(--eca-muted)}
    .eca-sp{width:100%;height:4px;border-radius:3px;background:var(--eca-stroke)}
    .eca-sp i{display:block;height:100%;border-radius:3px}
    .eca-day.sel{border-color:transparent;background:linear-gradient(160deg,rgba(255,138,61,.28),rgba(255,176,32,.14));
      box-shadow:0 0 0 1.5px var(--eca-acc) inset}
    .eca-day.sel .eca-dl{color:#ffd7b0}
    .eca-day.rec{animation:ecapulse 1.9s ease-in-out infinite}
    .eca-day.rec .eca-dk{color:#ffce8a}
    .eca-crown{position:absolute;top:-7px;right:-4px;font-size:13px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
    @keyframes ecapulse{0%,100%{box-shadow:0 0 0 1px rgba(255,84,66,.35),0 0 6px rgba(255,84,66,.15)}
      50%{box-shadow:0 0 0 1.6px rgba(255,84,66,.9),0 0 16px rgba(255,84,66,.55)}}
    .eca-chip{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:16px;cursor:pointer;
      background:linear-gradient(135deg,rgba(255,84,66,.16),rgba(255,138,61,.12));border:1px solid rgba(255,84,66,.32);transition:transform .15s,filter .15s}
    .eca-chip:hover{transform:translateY(-1px);filter:brightness(1.08)}
    .eca-chip.iscur{opacity:.55}
    .eca-ic{font-size:19px}.eca-cb{flex:1;min-width:0}
    .eca-clab{font-size:10px;letter-spacing:.8px;text-transform:uppercase;color:#ffb9a0;font-weight:800}
    .eca-cday{font-size:15px;font-weight:850;margin-top:1px}
    .eca-cval{font-size:13px;font-weight:800;color:var(--eca-acc2);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
    .eca-cval small{display:block;font-size:10.5px;color:#ffb9a0;font-weight:700;margin-top:1px}
    .eca-go{font-size:16px;color:#ffb9a0}
    .eca-panel{background:var(--eca-panel);border:1px solid var(--eca-stroke);border-radius:20px;padding:16px 15px 14px}
    .eca-hint{font-size:11px;color:var(--eca-faint);margin:0 0 14px;font-weight:500}
    .eca-chart{display:flex;align-items:flex-end;gap:3px;height:150px;padding-top:14px}
    .eca-hcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;cursor:pointer;gap:4px;position:relative}
    .eca-bar{width:100%;max-width:12px;border-radius:4px 4px 2px 2px;min-height:3px;transition:transform .12s,filter .12s}
    .eca-hcol:hover .eca-bar{transform:scaleY(1.03);filter:brightness(1.18)}
    .eca-hcol.pk .eca-bar{box-shadow:0 0 10px rgba(255,138,61,.7)}
    .eca-hl{font-size:8.5px;color:var(--eca-faint);font-weight:700;font-variant-numeric:tabular-nums}
    .eca-hcol.pk .eca-hl{color:var(--eca-acc2)}
    .eca-flag{position:absolute;top:-2px;transform:translateY(-100%);background:var(--eca-acc);color:#241200;
      font-size:9px;font-weight:850;padding:2px 6px;border-radius:7px;white-space:nowrap;font-variant-numeric:tabular-nums}
    .eca-rank{display:flex;flex-direction:column;gap:9px}
    .eca-row{display:grid;grid-template-columns:20px 1fr auto;align-items:center;gap:10px}
    .eca-pos{font-size:12px;font-weight:800;color:var(--eca-faint);text-align:center}
    .eca-row:first-child .eca-pos{color:var(--eca-acc2)}
    .eca-b{min-width:0}
    .eca-nm{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px}
    .eca-tr{height:7px;border-radius:4px;background:var(--eca-stroke);overflow:hidden}
    .eca-tr i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--eca-acc),var(--eca-acc2))}
    .eca-kv{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
    .eca-kv small{color:var(--eca-faint);font-weight:600;font-size:10px;margin-left:2px}
    .eca-eur{display:block;font-size:11px;font-weight:700;color:var(--eca-acc2);margin-top:2px}
    .eca-empty{color:var(--eca-muted);font-size:13px;text-align:center;padding:18px 0}
    .eca-add{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:16px;cursor:pointer;
      font-size:14px;font-weight:800;color:#ffd7b0;background:linear-gradient(135deg,rgba(255,138,61,.16),rgba(255,176,32,.10));
      border:1px solid rgba(255,138,61,.32);transition:transform .15s,filter .15s}
    .eca-add:hover{transform:translateY(-1px);filter:brightness(1.1)}
    .eca-err{color:var(--eca-muted);text-align:center;padding:40px 10px;font-size:14px}
    .eca-scrim{position:fixed;inset:0;background:rgba(4,5,8,.62);backdrop-filter:blur(6px);display:flex;
      align-items:center;justify-content:center;padding:22px;z-index:9;opacity:0;pointer-events:none;transition:opacity .18s}
    .eca-scrim.on{opacity:1;pointer-events:auto}
    .eca-modal{width:100%;max-width:360px;background:var(--eca-solid);border:1px solid rgba(255,255,255,.16);
      border-radius:24px;padding:20px 18px;box-shadow:0 24px 60px rgba(0,0,0,.6);transform:translateY(14px) scale(.97);transition:transform .2s}
    .eca-scrim.on .eca-modal{transform:none}
    .eca-mh{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px}
    .eca-mt{font-size:17px;font-weight:850}
    .eca-ms{font-size:11.5px;color:var(--eca-muted);font-weight:600;margin-top:2px}
    .eca-x{width:30px;height:30px;border-radius:50%;border:1px solid var(--eca-stroke);background:rgba(255,255,255,.05);color:var(--eca-ink);font-size:15px;cursor:pointer}
    .eca-mtot{font-size:12px;color:var(--eca-faint);margin:10px 0 14px;font-weight:600}
    @media (prefers-reduced-motion:reduce){.eca *{transition:none!important}
      .eca-day.rec{animation:none;box-shadow:0 0 0 1.5px rgba(255,84,66,.8),0 0 12px rgba(255,84,66,.4)}}
    </style><div class="eca"><div class="eca-err">⚡ Carico i consumi…</div></div>`;
  }
}

customElements.define("energia-consumi-card", EnergiaConsumiCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "energia-consumi-card",
  name: "Energia Consumi Card",
  description: "Consumi di casa interattivi: giorni, ore, popup elettrodomestici, costo €.",
});
