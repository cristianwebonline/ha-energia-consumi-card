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
const MESI = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
  "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
const CARD_VERSION = "1.3.1";
console.info(`%c ENERGIA-CONSUMI-CARD %c v${CARD_VERSION} `,
  "color:#241200;background:#ff8a3d;font-weight:700;border-radius:4px 0 0 4px",
  "color:#ffb020;background:#1a1b21;border-radius:0 4px 4px 0");

const WD = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

// Impedisce a librerie tipo "hass-swipe-navigation" di leggere un tocco/trascinamento
// dentro questa card come uno swipe di cambio-vista/vista-precedente. Fermiamo la
// propagazione del gesto qui (senza preventDefault): lo scroll verticale della pagina
// e i tap sui pulsanti continuano a funzionare normalmente, solo il "bubbling" verso
// i listener globali della libreria viene interrotto.
// hass-swipe-navigation stesso ignora già i gesti dentro <hui-card-edit-mode>
// (il wrapper che HA mette intorno alle card quando la dashboard è in
// modifica, per non rubare il drag-and-drop di riordino) — controllando lì
// dentro NON dobbiamo bloccare nulla noi. Il tentativo precedente (guardare
// "edit=1" nell'URL) era sbagliato: le dashboard "sections" non cambiano
// l'URL entrando in modifica, per questo il riordino restava bloccato.
function ecInEditMode(e) {
  const path = e.composedPath ? e.composedPath() : [];
  return path.some(n => n.tagName === "HUI-CARD-EDIT-MODE");
}
function stopSwipeNavHijack(el) {
  ["touchstart", "touchmove", "touchend", "pointerdown", "pointermove"].forEach(evt =>
    el.addEventListener(evt, e => { if (!ecInEditMode(e)) e.stopPropagation(); }, { passive: true }));
}

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

  // editor visuale nativo (compare quando modifichi la card nella dashboard)
  static getConfigElement() { return document.createElement("energia-consumi-card-editor"); }
  static getStubConfig() {
    return { type: "custom:energia-consumi-card", title: "Consumi di casa",
      days_back: 8, open_on: "today", prezzo_kwh: 0.30, soglia_media: 33, soglia_alta: 66, lampeggio_record: true };
  }

  async _boot() {
    this.innerHTML = this._shellHTML();
    this._root = this.querySelector(".eca");
    stopSwipeNavHijack(this._root);
    try {
      // L'archivio dei mesi parte SUBITO, in parallelo: sono poche decine di
      // righe (una per mese) e arriva quasi sempre per primo, cosi la card ha
      // gia qualcosa da mostrare mentre i giorni sono ancora per strada.
      // Prima partiva per ultimo, in fila dietro a tutto il resto.
      const mesi = this._caricaMesi();
      await this._load();
      this._render();
      // La card e gia in pagina: i dispositivi arrivano fra un attimo.
      this._caricaGiorno(this._curDay);
      await mesi;
    } catch (e) {
      this._root.innerHTML =
        `<div class="err">⚡ Dati non disponibili<br><small>${(e && e.message) || e}</small></div>`;
      console.error("[energia-consumi-card]", e);
    }
  }

  // ---- dati da HA -----------------------------------------------------------
  // Il carico si divide in due tempi. Prima la RETE: sono 8 giorni per ora,
  // meno di duecento righe, e bastano a disegnare tutto cio che si vede
  // aprendo la card. Poi i DISPOSITIVI, in secondo piano e solo del giorno
  // che stai guardando.
  //
  // Prima si chiedevano insieme 8 giorni di dati orari per TUTTI i
  // dispositivi: in questa casa sono 43, cioe circa ottomila righe in un
  // colpo solo, e sul Raspberry con il registro su disco esterno la card
  // restava vuota per parecchi secondi. Adesso ne chiede un ottavo, e solo
  // dopo aver gia disegnato il resto.
  async _prefsEnergia() {
    if (this._prefs) return this._prefs;
    const hass = this._hass;
    let gridStat = "sensor.generale_channel_1_energy";
    const devs = [], names = {};
    try {
      const prefs = await hass.callWS({ type: "energy/get_prefs" });
      for (const src of (prefs.energy_sources || [])) {
        if (src.type === "grid" && src.stat_energy_from) { gridStat = src.stat_energy_from; break; }
      }
      for (const d of (prefs.device_consumption || [])) {
        if (d.stat_consumption) { devs.push(d.stat_consumption); names[d.stat_consumption] = d.name || d.stat_consumption; }
      }
    } catch (e) { /* prefs opzionali */ }
    for (const id of devs) {
      const st = hass.states[id];
      if ((!names[id] || names[id] === id) && st && st.attributes && st.attributes.friendly_name)
        names[id] = st.attributes.friendly_name;
    }
    this._prefs = { gridStat, devs, names };
    return this._prefs;
  }

  _q(ids, dal, al) {
    return this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: dal.toISOString(), end_time: al.toISOString(),
      statistic_ids: ids, period: "hour", types: ["change"],
    });
  }

  async _load() {
    const { gridStat } = await this._prefsEnergia();
    const daysBack = parseInt(this._cfg.days_back) || 8;
    const now = new Date();
    const start = new Date(now.getTime() - daysBack * 86400000);

    const gres = await this._q([gridStat], start, now);
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

    // I dispositivi arrivano dopo: qui restano vuoti, e la card lo dice.
    this._data = { meta, perDayHour, perDayRank: {}, perDayHourTop: {} };
    this._curDay = def;
    this._maxTot = Math.max(...meta.map(d => d.total), 0.001);
  }

  // ---- confronto fra mesi ---------------------------------------------------
  // Dodici righe in tutto (period: month), quindi si puo chiedere senza
  // pensarci. Arriva dopo il resto perche il mese non e la prima cosa che si
  // guarda aprendo la card.
  async _caricaMesi() {
    if (this._mesi) return;
    try {
      const { gridStat } = await this._prefsEnergia();
      const oggi = new Date();
      // TUTTO lo storico, non gli ultimi dodici mesi. Le statistiche mensili
      // di Home Assistant non scadono mai e sono una riga per mese: chiedere
      // dieci anni costa quanto chiederne uno. Fermandosi a dodici mesi non si
      // poteva sapere quanto era costato il 2025, e il confronto con lo stesso
      // mese dell'anno prima cadeva proprio sui mesi piu vecchi.
      const dal = new Date(oggi.getFullYear() - 10, 0, 1);
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: dal.toISOString(), end_time: oggi.toISOString(),
        statistic_ids: [gridStat], period: "month", types: ["change"],
      });
      const righe = (res && res[gridStat]) || [];
      this._mesi = righe.map(r => {
        const t = new Date(r.start);
        return {
          anno: t.getFullYear(), mese: t.getMonth(), nome: MESI[t.getMonth()],
          kwh: Math.max(0, Math.round((r.change || 0) * 100) / 100),
          giorni: new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate(),
        };
      }).filter(m => m.kwh > 0);
    } catch (e) {
      this._mesi = [];
      console.warn("[energia-consumi-card] mesi non disponibili:", e);
    }
    this._anni = this._riepilogoAnni();
    // Si apre sull'anno in corso: e quello che si guarda per primo.
    if (this._annoAperto == null) {
      this._annoAperto = this._anni.length ? this._anni[this._anni.length - 1].anno : new Date().getFullYear();
    }
    if (this._data) this._render();
  }

  // Il mese in corso non e finito: confrontarlo tale e quale con uno finito
  // direbbe sempre "stai consumando meno", che e una bugia. Si guarda il ritmo
  // dei giorni gia passati e si dice dove si andra a finire.
  // Un anno per riga: totale, spesa, e quanti mesi ci sono davvero dentro.
  // I mesi incompleti si dicono, perche un anno con nove mesi di dati non si
  // confronta con uno intero senza avvisare.
  _riepilogoAnni() {
    const per = {};
    for (const m of (this._mesi || [])) {
      const a = (per[m.anno] = per[m.anno] || { anno: m.anno, kwh: 0, mesi: 0, mesiDentro: [] });
      a.kwh += m.kwh;
      a.mesi += 1;
      a.mesiDentro.push(m.mese);
    }
    const oggi = new Date();
    return Object.values(per).sort((x, y) => x.anno - y.anno).map(a => {
      a.kwh = Math.round(a.kwh * 100) / 100;
      a.inCorso = a.anno === oggi.getFullYear();
      a.completo = a.mesi >= 12;
      return a;
    });
  }

  // L'archivio: gli anni in alto, i mesi dell'anno scelto sotto. Prima c'era
  // una striscia di dodici barre senza anni, e non si poteva andare indietro.
  _archivioHTML() {
    if (!this._mesi) return '<div class="eca-empty">Sto leggendo l\'archivio...</div>';
    if (!this._mesi.length) return '<div class="eca-empty">Nessuno storico mensile</div>';

    const anni = this._anni || [];
    const anno = this._annoAperto;
    const suo = anni.find(a => a.anno === anno);
    const prima = anni.find(a => a.anno === anno - 1);

    const pillole = anni.map(a =>
      '<button type="button" class="eca-anno' + (a.anno === anno ? " sel" : "") + '" data-anno="' + a.anno + '">'
      + '<span class="eca-annon">' + a.anno + '</span>'
      + '<span class="eca-annok">' + this._fmt(a.kwh) + ' kWh</span></button>').join("");

    // Il confronto fra anni ha senso solo fra pezzi uguali: si confrontano i
    // mesi che ci sono in TUTTI E DUE gli anni. Vale nei due sensi — l'anno in
    // corso e incompleto, ma anche il primo anno registrato lo e: senza questa
    // regola il 2024 risultava "+115% sul 2023" solo perche del 2023 ci sono
    // sei mesi, e non era vero niente.
    let cfr = "";
    if (suo && prima) {
      const suoi = new Set(suo.mesiDentro), quelli = new Set(prima.mesiDentro);
      const comuni = suo.mesiDentro.filter(x => quelli.has(x));
      const dentro = new Set(comuni);
      const somma = a => (this._mesi || [])
        .filter(m => m.anno === a && dentro.has(m.mese))
        .reduce((t, m) => t + m.kwh, 0);
      const mio = comuni.length === 12 ? suo.kwh : somma(anno);
      const rif = comuni.length === 12 ? prima.kwh : somma(anno - 1);
      const nota = comuni.length === 12 ? "" : " (stessi " + comuni.length + (comuni.length === 1 ? " mese" : " mesi") + ")";
      if (rif > 0) {
        const pct = Math.round((mio - rif) / rif * 100);
        const su = mio > rif;
        // Arrotondato a zero vuol dire "uguale": una freccia rossa su "0%"
        // fa suonare un allarme per una differenza che non c'e.
        const pari = pct === 0;
        cfr = '<div class="eca-mcmp ' + (pari ? "pari" : (su ? "su" : "giu")) + '">'
          + '<span class="eca-mfr">' + (pari ? "=" : (su ? "\u25b2" : "\u25bc") + " " + Math.abs(pct) + "%") + '</span>'
          + "<span>" + (pari ? "come il " : "rispetto al ") + (anno - 1) + nota
          + " (" + this._fmt(rif) + " kWh \u00b7 " + this._fmtE(rif) + ")</span></div>";
      }
    }

    const testa = suo
      ? '<div class="eca-mtesta"><div><div class="eca-mnome">Tutto il ' + anno
        + (suo.completo ? "" : " \u00b7 " + suo.mesi + (suo.mesi === 1 ? " mese" : " mesi")) + '</div>'
        + '<div class="eca-mval">' + this._fmt(suo.kwh) + ' <small>kWh</small>'
        + '<span class="eca-eur">' + this._fmtE(suo.kwh) + '</span></div></div></div>'
      : "";

    const oggi = new Date();
    const dellAnno = (this._mesi || []).filter(m => m.anno === anno);
    const mx = Math.max(...dellAnno.map(m => m.kwh), 0.001);
    const media = dellAnno.length ? dellAnno.reduce((t, m) => t + m.kwh, 0) / dellAnno.length : 0;
    const barre = MESI.map((nome, i) => {
      const m = dellAnno.find(x => x.mese === i);
      if (!m) {
        return '<div class="eca-mcol vuoto" title="' + nome + " " + anno + ': nessun dato"><div class="eca-mbar"></div>'
          + '<div class="eca-ml">' + nome.slice(0, 3) + "</div></div>";
      }
      const corso = m.anno === oggi.getFullYear() && m.mese === oggi.getMonth();
      const alt = Math.max(3, Math.round(m.kwh / mx * 100));
      return '<div class="eca-mcol' + (corso ? " corso" : "") + '" data-mese="' + m.anno + "-" + m.mese
        + '" title="' + this._esc(nome) + " " + m.anno + ": " + this._fmt(m.kwh) + " kWh, "
        + (media > 0 ? (m.kwh >= media ? "sopra" : "sotto") + " la media dell'anno (" + this._fmt(media) + " kWh)" : "")
        + ' \u2014 tocca per aprirlo">'
        + '<div class="eca-mbar" style="height:' + alt + '%;background:' + this._coloreMese(m.kwh, media) + '"></div>'
        + '<div class="eca-ml">' + nome.slice(0, 3) + "</div></div>";
    }).join("");

    return '<div class="eca-anni">' + pillole + "</div>" + testa + cfr
      + '<div class="eca-mesi">' + barre + "</div>"
      + '<div class="eca-hint">Tocca un mese per aprirlo</div>';
  }

  // I dispositivi di UN giorno solo. Si tiene quello che si e gia chiesto:
  // tornando su un giorno gia visto non si richiede niente.
  async _caricaGiorno(giorno) {
    if (!giorno || !this._data) return;
    if (this._data.perDayRank[giorno]) return;
    if (this._inCorso === giorno) return;
    this._inCorso = giorno;
    this._render();
    try {
      const { devs, names } = await this._prefsEnergia();
      if (!devs.length) { this._data.perDayRank[giorno] = []; this._inCorso = null; this._render(); return; }
      const dal = new Date(giorno + "T00:00:00");
      const al = new Date(dal.getTime() + 86400000);
      const res = await this._q(devs, dal, al);
      const perDev = {}, perOra = {};
      for (const dev of devs) {
        for (const r of ((res && res[dev]) || [])) {
          let ch = r.change; if (ch == null || ch <= 0) continue;
          const t = new Date(r.start);
          if (this._dkey(t) !== giorno) continue;
          const h = t.getHours();
          perDev[dev] = (perDev[dev] || 0) + ch;
          (perOra[h] = perOra[h] || {});
          perOra[h][dev] = (perOra[h][dev] || 0) + ch;
        }
      }
      const topn = (dic, n) => Object.entries(dic)
        .map(([k, v]) => ({ name: names[k] || k, kwh: Math.round(v * 1000) / 1000 }))
        .filter(x => x.kwh > 0.001).sort((a, b) => b.kwh - a.kwh).slice(0, n);
      this._data.perDayRank[giorno] = topn(perDev, 10);
      this._data.perDayHourTop[giorno] = {};
      for (const h in perOra) this._data.perDayHourTop[giorno][h] = topn(perOra[h], 5);
    } catch (e) {
      this._data.perDayRank[giorno] = [];
      console.warn("[energia-consumi-card] dispositivi non disponibili:", e);
    }
    this._inCorso = null;
    this._render();
  }

  _dkey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

  // ---- helpers presentazione ------------------------------------------------
  _fmt(x) { return (Math.round(x * 100) / 100).toLocaleString("it-IT", { minimumFractionDigits: x < 10 ? 2 : 1, maximumFractionDigits: 2 }); }
  _fmtE(k) { return "≈ " + (k * (parseFloat(this._cfg.prezzo_kwh) || 0)).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"; }
  // I mesi di un anno si somigliano quasi tutti (qui vanno da 276 a 425 kWh):
  // colorandoli rispetto al mese piu alto finivano TUTTI in cima alla scala,
  // tutti rossi, e il colore non diceva piu niente. Rispetto alla media
  // invece si legge a colpo d'occhio quali mesi sono stati sopra e quali
  // sotto — che e la domanda che ci si fa guardando un anno.
  _coloreMese(v, media) {
    if (!media || media <= 0) return "var(--eca-stroke)";
    const r = v / media;
    if (r >= 1.15) return "linear-gradient(180deg,#ff7a4d,#ff5442)";
    if (r >= 1.02) return "linear-gradient(180deg,#ffd166,#ffb020)";
    if (r >= 0.88) return "linear-gradient(180deg,#9fe3b4,#6cc98c)";
    return "linear-gradient(180deg,#5fe08c,#3fbf6f)";
  }

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
      <div class="eca-panel"><h2>📅 Archivio</h2>
        <p class="eca-hint">Anno per anno e mese per mese, da quando Home Assistant registra</p>
        ${this._archivioHTML()}</div>
      <div class="eca-panel"><h2>🏆 Classifica elettrodomestici</h2>
        <p class="eca-hint">Del giorno selezionato</p><div class="eca-rank">${
          d.perDayRank[cur] ? this._rankHTML(d.perDayRank[cur])
            : `<div class="eca-empty">Sto leggendo i dispositivi...</div>`
        }</div></div>`;

    // eventi
    this._root.querySelectorAll(".eca-day").forEach(el =>
      el.onclick = () => { this._curDay = el.dataset.day; this._render(); this._caricaGiorno(this._curDay); });
    this._root.querySelectorAll(".eca-hcol").forEach(el =>
      el.onclick = () => this._openHour(parseInt(el.dataset.h)));
    this._root.querySelectorAll("[data-anno]").forEach(el =>
      el.onclick = () => { this._annoAperto = parseInt(el.dataset.anno); this._render(); });
    this._root.querySelectorAll("[data-mese]").forEach(el =>
      el.onclick = () => {
        const [a, m] = el.dataset.mese.split("-").map(Number);
        this._openMese(a, m);
      });
    const chip = this._root.querySelector(".eca-chip");
    const back = d.meta.length ? d.meta[d.meta.length - 1].date : rec.date;
    if (rec.date === cur) chip.classList.add("iscur");
    chip.onclick = () => { this._curDay = (this._curDay === rec.date) ? back : rec.date; this._render(); this._scrollSel(); this._caricaGiorno(this._curDay); };
    // Evita che lo scroll orizzontale dei giorni venga letto da hass-swipe-navigation
    // (o simili) come uno swipe di cambio-vista: fermiamo la propagazione del gesto
    // touch/pointer qui, la card scrolla comunque da sola.
    const daysEl = this._root.querySelector(".eca-days");
    ["touchstart", "touchmove", "touchend", "pointerdown", "pointermove"].forEach(evt =>
      daysEl.addEventListener(evt, e => e.stopPropagation(), { passive: true }));
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

  // ---- archivio dei mesi ----------------------------------------------------
  // Le barre da sole sono un disegno: si vede la forma ma non si puo entrare.
  // Toccandone una si apre il mese vero, con i suoi giorni, il confronto con
  // gli altri e chi ha consumato di piu in quel mese.
  async _openMese(anno, mese) {
    const m = (this._mesi || []).find(x => x.anno === anno && x.mese === mese);
    if (!m) return;
    let ov = this.querySelector(".eca-scrim");
    if (!ov) { ov = document.createElement("div"); ov.className = "eca-scrim"; this._root.appendChild(ov); }

    const oggi = new Date();
    const inCorso = m.anno === oggi.getFullYear() && m.mese === oggi.getMonth();
    const giorniFatti = inCorso ? oggi.getDate() : m.giorni;
    const stima = inCorso && giorniFatti > 0 ? m.kwh / giorniFatti * m.giorni : null;

    const disegna = (giorni, classifica) => {
      // Confronti: il mese prima e lo stesso mese dell'anno scorso. Sono i due
      // paragoni che si fanno davvero guardando una bolletta.
      const tutti = this._mesi || [];
      const prima = tutti.find(x => (x.anno * 12 + x.mese) === (m.anno * 12 + m.mese - 1));
      const scorso = tutti.find(x => x.anno === m.anno - 1 && x.mese === m.mese);
      const riga = (rif, etichetta) => {
        if (!rif) return "";
        const mio = stima != null ? stima : m.kwh;
        const pct = rif.kwh > 0 ? Math.round((mio - rif.kwh) / rif.kwh * 100) : 0;
        const su = mio > rif.kwh;
        return '<div class="eca-mcmp ' + (su ? "su" : "giu") + '">'
          + '<span class="eca-mfr">' + (su ? "\u25b2" : "\u25bc") + " " + Math.abs(pct) + '%</span>'
          + "<span>rispetto a " + etichetta + " (" + this._fmt(rif.kwh) + " kWh \u00b7 " + this._fmtE(rif.kwh) + ")</span></div>";
      };

      let grafico = '<div class="eca-empty">Sto leggendo i giorni...</div>';
      if (giorni) {
        if (!giorni.length) grafico = '<div class="eca-empty">Nessun dato per questo mese</div>';
        else {
          const mxG = Math.max(...giorni.map(g => g.kwh), 0.001);
          grafico = '<div class="eca-gg">' + giorni.map(g =>
            '<div class="eca-gcol" title="' + g.n + ": " + this._fmt(g.kwh) + ' kWh">'
            + '<div class="eca-gbar" style="height:' + Math.max(2, Math.round(g.kwh / mxG * 100)) + "%;background:"
            + this._color(g.kwh, mxG) + '"></div>'
            + '<div class="eca-gl">' + (g.n % 5 === 0 || g.n === 1 ? g.n : "") + "</div></div>").join("") + "</div>";
        }
      }

      ov.innerHTML = '<div class="eca-modal">'
        + '<div class="eca-mh"><div><div class="eca-mt">' + this._esc(m.nome) + " " + m.anno + "</div>"
        + '<div class="eca-ms">' + (inCorso ? "mese in corso, " + giorniFatti + " giorni su " + m.giorni : m.giorni + " giorni") + "</div></div>"
        + '<button class="eca-x">\u2715</button></div>'
        + '<div class="eca-mtesta"><div><div class="eca-mnome">Consumato</div>'
        + '<div class="eca-mval">' + this._fmt(m.kwh) + ' <small>kWh</small>'
        + '<span class="eca-eur">' + this._fmtE(m.kwh) + "</span></div></div>"
        + (stima != null
          ? '<div class="eca-mstim"><div class="eca-mslab">a fine mese</div>'
            + '<div class="eca-msval">' + this._fmt(stima) + ' <small>kWh</small></div>'
            + '<div class="eca-eur">' + this._fmtE(stima) + "</div></div>"
          : '<div class="eca-mstim"><div class="eca-mslab">media al giorno</div>'
            + '<div class="eca-msval">' + this._fmt(m.kwh / m.giorni) + ' <small>kWh</small></div>'
            + '<div class="eca-eur">' + this._fmtE(m.kwh / m.giorni) + "</div></div>")
        + "</div>"
        + riga(prima, prima ? this._esc(prima.nome) : "")
        + riga(scorso, scorso ? this._esc(scorso.nome) + " " + scorso.anno : "")
        + '<h2 class="eca-mh2">Giorno per giorno</h2>' + grafico
        + '<h2 class="eca-mh2">Chi ha consumato di piu</h2>'
        + '<div class="eca-rank">' + (classifica ? this._rankHTML(classifica)
            : '<div class="eca-empty">Sto leggendo i dispositivi...</div>') + "</div>"
        + "</div>";

      const chiudi = () => ov.classList.remove("on");
      ov.querySelector(".eca-x").onclick = chiudi;
      ov.onclick = e => { if (e.target === ov) chiudi(); };
    };

    disegna(null, null);
    requestAnimationFrame(() => ov.classList.add("on"));

    // I dati del mese arrivano dopo: la finestra e gia aperta e si vede che
    // sta lavorando, invece di restare fermi ad aspettare che si apra.
    const dal = new Date(anno, mese, 1);
    const al = new Date(anno, mese + 1, 1);
    let giorni = [], classifica = [];
    try {
      const { gridStat } = await this._prefsEnergia();
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: dal.toISOString(), end_time: al.toISOString(),
        statistic_ids: [gridStat], period: "day", types: ["change"],
      });
      giorni = ((res && res[gridStat]) || []).map(r => ({
        n: new Date(r.start).getDate(),
        kwh: Math.max(0, Math.round((r.change || 0) * 100) / 100),
      }));
    } catch (e) { giorni = []; }
    disegna(giorni, null);

    try {
      const { devs, names } = await this._prefsEnergia();
      if (devs.length) {
        const res = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: dal.toISOString(), end_time: al.toISOString(),
          statistic_ids: devs, period: "month", types: ["change"],
        });
        const somme = {};
        devs.forEach(dev => {
          ((res && res[dev]) || []).forEach(r => {
            const k = r.change; if (k == null || k <= 0) return;
            somme[dev] = (somme[dev] || 0) + k;
          });
        });
        classifica = Object.entries(somme)
          .map(([k, v]) => ({ name: names[k] || k, kwh: Math.round(v * 1000) / 1000 }))
          .filter(x => x.kwh > 0.001).sort((a, b) => b.kwh - a.kwh).slice(0, 12);
      }
    } catch (e) { classifica = []; }
    disegna(giorni, classifica);
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
    .eca-days{display:flex;gap:8px;overflow-x:auto;padding:6px 2px 8px;scrollbar-width:none;touch-action:pan-x}
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
    .eca-mtesta{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:10px}
    .eca-mnome{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;opacity:.6}
    .eca-mval{font-size:26px;font-weight:900;line-height:1.1;font-variant-numeric:tabular-nums}
    .eca-mval small{font-size:14px;font-weight:800;opacity:.6;margin-left:2px}
    .eca-mstim{margin-left:auto;text-align:right}
    .eca-mslab{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;opacity:.5}
    .eca-msval{font-size:19px;font-weight:900;font-variant-numeric:tabular-nums;opacity:.85}
    .eca-mcmp{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 11px;border-radius:11px;
      font-size:12px;font-weight:600;line-height:1.4;margin-bottom:12px}
    .eca-mcmp.su{background:rgba(255,92,92,.13);color:#ffb0a3}
    .eca-mcmp.giu{background:rgba(56,224,138,.13);color:#8ff0b4}
    .eca-mfr{font-size:14px;font-weight:900;flex:0 0 auto}
    /* Gli anni: una fila di pillole che scorre, cosi ne stanno quanti se ne
       vuole anche sul telefono senza schiacciare i mesi sotto. */
    .eca-mcmp.pari{background:rgba(255,255,255,.05);border-color:var(--eca-stroke,rgba(255,255,255,.12));
      color:var(--eca-muted)}
    .eca-anni{display:flex;gap:7px;overflow-x:auto;padding:0 0 10px;
      scrollbar-width:none;-webkit-overflow-scrolling:touch}
    .eca-anni::-webkit-scrollbar{display:none}
    .eca-anno{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-start;gap:1px;
      padding:8px 13px;border-radius:14px;cursor:pointer;font:inherit;text-align:left;
      border:1px solid var(--eca-stroke,rgba(255,255,255,.12));background:rgba(255,255,255,.04);
      color:var(--eca-ink);transition:background .15s,border-color .15s}
    .eca-anno:hover{background:rgba(255,255,255,.09)}
    .eca-annon{font-size:14px;font-weight:850;font-variant-numeric:tabular-nums}
    .eca-annok{font-size:10.5px;font-weight:700;color:var(--eca-muted);font-variant-numeric:tabular-nums}
    .eca-anno.sel{background:linear-gradient(135deg,rgba(255,138,61,.20),rgba(255,176,32,.12));
      border-color:rgba(255,138,61,.45)}
    .eca-anno.sel .eca-annok{color:#ffd7b0}
    /* Un mese senza dati resta al suo posto, spento: i dodici mesi ci sono
       sempre, senno gennaio e dicembre finiscono appiccicati e non si capisce
       quale mese manca. */
    .eca-mcol.vuoto{cursor:default;opacity:.30}
    .eca-mcol.vuoto .eca-mbar{height:3px;background:var(--eca-muted)}
    .eca-mesi{display:flex;align-items:flex-end;gap:5px;height:110px}
    .eca-mcol{cursor:pointer}
    .eca-mcol:hover .eca-mbar{filter:brightness(1.25)}
    .eca-mcol:hover .eca-ml{opacity:1}
    .eca-mh2{margin:14px 0 6px;font-size:13px;font-weight:800}
    .eca-gg{display:flex;align-items:flex-end;gap:2px;height:92px}
    .eca-gcol{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
    .eca-gbar{width:100%;border-radius:3px 3px 0 0;min-height:2px}
    .eca-gl{font-size:8px;font-weight:800;opacity:.45;margin-top:3px;height:10px}
    .eca-mcol{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;
      justify-content:flex-end;align-items:center;position:relative}
    .eca-mbar{width:100%;border-radius:5px 5px 0 0;min-height:3px}
    /* La stima e un contorno tratteggiato dietro la barra vera: si vede dove
       si andra a finire senza far credere che sia gia successo. */
    .eca-mstima{position:absolute;bottom:16px;left:0;right:0;
      border:1.5px dashed rgba(255,255,255,.4);border-bottom:none;border-radius:5px 5px 0 0}
    .eca-ml{font-size:9px;font-weight:800;opacity:.55;margin-top:4px;text-transform:uppercase}
    .eca-mcol.corso .eca-ml{opacity:1;color:var(--eca-acc,#ffb020)}
    .eca-empty{color:var(--eca-muted);font-size:13px;text-align:center;padding:18px 0}
    .eca-add{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:16px;cursor:pointer;
      font-size:14px;font-weight:800;color:#ffd7b0;background:linear-gradient(135deg,rgba(255,138,61,.16),rgba(255,176,32,.10));
      border:1px solid rgba(255,138,61,.32);transition:transform .15s,filter .15s}
    .eca-add:hover{transform:translateY(-1px);filter:brightness(1.1)}
    .eca-err{color:var(--eca-muted);text-align:center;padding:40px 10px;font-size:14px}
    .eca-scrim{position:fixed;inset:0;background:rgba(4,5,8,.62);backdrop-filter:blur(6px);display:flex;
      align-items:center;justify-content:center;padding:22px;z-index:9;opacity:0;pointer-events:none;transition:opacity .18s}
    .eca-scrim.on{opacity:1;pointer-events:auto}
    /* Il tetto in altezza serve davvero: l'archivio di un mese e alto quasi
       1000px, e senza tetto un foglio centrato piu alto dello schermo esce
       SOPRA il bordo (misurato: y=-194 in una finestra da 551) e quella parte
       non si raggiunge in nessun modo, perche il traboccamento verso l'alto
       non si puo scorrere. Con il tetto il foglio scorre dentro se stesso. */
    .eca-modal{width:100%;max-width:420px;max-height:100%;overflow-y:auto;overscroll-behavior:contain;
      -webkit-overflow-scrolling:touch;background:var(--eca-solid);border:1px solid rgba(255,255,255,.16);
      border-radius:24px;padding:20px 18px;box-shadow:0 24px 60px rgba(0,0,0,.6);transform:translateY(14px) scale(.97);transition:transform .2s}
    .eca-modal::-webkit-scrollbar{width:8px}
    .eca-modal::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px}
    .eca-scrim.on .eca-modal{transform:none}
    /* I margini negativi laterali servono: senza, la fascia ferma in cima e
       larga quanto il testo e il contenuto le scorre di fianco, scoperto. */
    .eca-mh{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;
      position:sticky;top:-20px;z-index:2;padding:20px 18px 8px;margin:-20px -18px 4px;
      background:var(--eca-solid);border-radius:24px 24px 0 0}
    .eca-mt{font-size:17px;font-weight:850}
    .eca-ms{font-size:11.5px;color:var(--eca-muted);font-weight:600;margin-top:2px}
    .eca-x{width:30px;height:30px;border-radius:50%;border:1px solid var(--eca-stroke);background:rgba(255,255,255,.05);color:var(--eca-ink);font-size:15px;cursor:pointer}
    .eca-mtot{font-size:12px;color:var(--eca-faint);margin:10px 0 14px;font-weight:600}
    @media (prefers-reduced-motion:reduce){.eca *{transition:none!important}
      .eca-day.rec{animation:none;box-shadow:0 0 0 1.5px rgba(255,84,66,.8),0 0 12px rgba(255,84,66,.4)}}
    </style><div class="eca"><div class="eca-err">⚡ Carico i consumi…</div></div>`;
  }
}

// ===========================================================================
// Editor visuale della card (impostazioni) — compare in modifica dashboard
// ===========================================================================
class EnergiaConsumiCardEditor extends HTMLElement {
  // HA richiama setConfig() sull'editor anche quando il cambiamento arriva
  // dall'editor stesso. Ridisegnare da capo mentre l'utente scrive nel
  // titolo gli fa perdere il fuoco a ogni carattere — su telefono si vede la
  // tastiera aprirsi e chiudersi ad ogni lettera. _typingLock (acceso da
  // focus/blur sui campi di testo, vedi _render) salta il ridisegno mentre
  // è attivo.
  setConfig(config) {
    this._config = Object.assign({}, config);
    if (this._typingLock) return;
    this._render();
  }
  set hass(h) { this._hass = h; }

  _emit() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }
  _set(key, val) { this._config = Object.assign({}, this._config, { [key]: val }); this._emit(); }
  _nav(path) {
    try { history.pushState(null, "", path); this.dispatchEvent(new Event("location-changed", { bubbles: true, composed: true })); }
    catch (e) { window.location.href = path; }
  }

  _render() {
    const c = this._config || {};
    const g = (k, d) => (c[k] !== undefined ? c[k] : d);
    this.innerHTML = `<style>
      .ece{display:flex;flex-direction:column;gap:14px;padding:6px 2px;font-family:inherit}
      .ece .fld{display:flex;flex-direction:column;gap:6px}
      .ece label{font-size:13px;font-weight:600;color:var(--primary-text-color)}
      .ece .h{font-size:11px;color:var(--secondary-text-color);font-weight:400}
      .ece input,.ece select{padding:10px 11px;border-radius:8px;font-size:15px;font-family:inherit;
        border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color)}
      .ece .row{display:flex;gap:12px}.ece .row>.fld{flex:1}
      .ece .sw{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:14px;font-weight:600;color:var(--primary-text-color)}
      .ece .addbtn{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:12px;cursor:pointer;
        font-size:14px;font-weight:700;color:#fff;background:var(--primary-color);border:none;margin-top:4px}
      .ece .sep{height:1px;background:var(--divider-color);margin:2px 0}
      .ece .note{font-size:11.5px;color:var(--secondary-text-color);line-height:1.5}
    </style>
    <div class="ece">
      <div class="fld"><label>Titolo</label>
        <input type="text" id="f_title" value="${(g("title","Consumi di casa")+"").replace(/"/g,"&quot;")}"></div>
      <div class="row">
        <div class="fld"><label>Giorni</label>
          <select id="f_days"><option value="7"${g("days_back",8)==7?" selected":""}>7 giorni</option>
            <option value="14"${g("days_back",8)==14?" selected":""}>14 giorni</option>
            <option value="30"${g("days_back",8)==30?" selected":""}>30 giorni</option>
            ${[7,14,30].includes(+g("days_back",8))?"":`<option value="${g("days_back",8)}" selected>${g("days_back",8)} giorni</option>`}
          </select></div>
        <div class="fld"><label>All'apertura</label>
          <select id="f_open"><option value="today"${g("open_on","today")==="today"?" selected":""}>Oggi</option>
            <option value="record"${g("open_on","today")==="record"?" selected":""}>Giorno record</option></select></div>
      </div>
      <div class="fld"><label>Prezzo energia (€/kWh)</label>
        <span class="h">Costo orientativo accanto ai kWh (media mercato ~0,30)</span>
        <input type="number" id="f_price" step="0.01" min="0" max="5" value="${g("prezzo_kwh",0.30)}"></div>
      <div class="row">
        <div class="fld"><label>Soglia gialla (%)</label>
          <input type="number" id="f_smid" min="5" max="95" value="${g("soglia_media",33)}"></div>
        <div class="fld"><label>Soglia rossa (%)</label>
          <input type="number" id="f_shigh" min="10" max="100" value="${g("soglia_alta",66)}"></div>
      </div>
      <div class="sw">👑 Lampeggio giorno record
        <input type="checkbox" id="f_blink" ${g("lampeggio_record",true)?"checked":""}></div>
      <div class="sep"></div>
      <button class="addbtn" id="f_add">➕ Aggiungi sensori di consumo</button>
      <div class="note">Apre la pagina Energia di Home Assistant dove aggiungi/togli le prese monitorate. La card si aggiorna da sola.</div>
    </div>`;

    const on = (id, ev, fn) => { const el = this.querySelector(id); if (el) el.addEventListener(ev, fn); };
    on("#f_title", "input", e => this._set("title", e.target.value));
    on("#f_days", "change", e => this._set("days_back", parseInt(e.target.value)));
    on("#f_open", "change", e => this._set("open_on", e.target.value));
    on("#f_price", "change", e => this._set("prezzo_kwh", parseFloat(String(e.target.value).replace(",", ".")) || 0.30));
    on("#f_smid", "change", e => this._set("soglia_media", parseInt(e.target.value) || 33));
    on("#f_shigh", "change", e => this._set("soglia_alta", parseInt(e.target.value) || 66));
    on("#f_blink", "change", e => this._set("lampeggio_record", e.target.checked));
    on("#f_add", "click", () => this._nav("/config/energy/dashboard"));
    this.querySelectorAll('input[type="text"], input[type="number"]').forEach(inp => {
      inp.addEventListener("focus", () => { this._typingLock = true; });
      inp.addEventListener("blur", () => { this._typingLock = false; });
    });
  }
}
customElements.define("energia-consumi-card-editor", EnergiaConsumiCardEditor);

customElements.define("energia-consumi-card", EnergiaConsumiCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "energia-consumi-card",
  name: "Energia Consumi Card",
  description: "Consumi di casa interattivi: giorni, ore, popup elettrodomestici, costo €.",
  preview: true,
  documentationURL: "https://github.com/cristianwebonline/ha-energia-consumi-card",
});
