// VHB Quote & Reference Tool — GTL Advantage Plus ELITE
// All premium figures are derived from data/*.json at runtime. Nothing here is a hardcoded rate.

const DATA_DIR = "data/";

const store = {
  manifest: null,
  underwriting: null,
  overview: null,
  rateFilesByName: new Map(), // filename -> parsed JSON (shared cache; TX/PA point at the same file)
  currentStateCode: null,
  currentRates: null, // the rate JSON object for the selected state
};

const quote = {
  dob: defaultDobForAge(65),
  age: 65, // derived from dob on every render — see recomputeAge()
  sex: "female",
  dayOption: 7,
  dailyBenefit: 300,
  riders: {
    cancer: { choice: "none", amount: 5000 }, // choice: none | basic | recurrence
    ambulance: { enabled: false, amount: 100 },
    dentalVision: { enabled: false, amount: 400 },
    criticalAccident: { enabled: false, amount: 5000 },
    outpatientTherapy: { enabled: false, option: "15_day" },
    outpatientSurgical: { enabled: false, amount: 250 },
    gpoWellness: { enabled: false },
    snf: { choice: "none", amount: 100 }, // choice: none | option_1 | option_2
    lumpSumHospital: { enabled: false, amount: 250 },
  },
};

// ---------- generic helpers ----------

function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Resolves a value out of a table keyed either by exact age ("66") or by an
// inclusive age band ("40-65"). Returns undefined if age falls outside every key.
function resolveBand(table, age) {
  if (!table) return undefined;
  const exact = table[String(age)];
  if (exact !== undefined) return exact;
  for (const key of Object.keys(table)) {
    if (key.includes("-")) {
      const [lo, hi] = key.split("-").map(Number);
      if (age >= lo && age <= hi) return table[key];
    }
  }
  return undefined;
}

// ---------- date-of-birth / age helpers ----------

function defaultDobForAge(age) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  return d.toISOString().slice(0, 10);
}

// "Age last birthday" as of today — used for every rate-table lookup.
function computeAge(dobStr) {
  if (!dobStr) return null;
  const dob = new Date(dobStr + "T00:00:00");
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const hadBirthdayThisYear =
    today.getMonth() > dob.getMonth() ||
    (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
  if (!hadBirthdayThisYear) age--;
  return age;
}

// Adds a (possibly fractional, e.g. 64.5) number of years to a date, for precise
// Guaranteed Issue windowing — the JSON expresses the GI window as "64.5" years.
function addFractionalYears(date, years) {
  const wholeYears = Math.floor(years);
  const fracYears = years - wholeYears;
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + wholeYears);
  if (fracYears) d.setMonth(d.getMonth() + Math.round(fracYears * 12));
  return d;
}

function isInGiWindow(dobStr, giLoYears, giHiYears) {
  const dob = new Date(dobStr + "T00:00:00");
  if (Number.isNaN(dob.getTime())) return false;
  const today = new Date();
  const loDate = addFractionalYears(dob, giLoYears);
  const hiDate = addFractionalYears(dob, giHiYears);
  return today >= loDate && today < hiDate;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// Renders a row of pill buttons; `options` is [{value, label, disabled?}]. Calls
// onSelect(value) and re-renders into the same container when a pill is clicked.
function pillGroup(container, options, selectedValue, onSelect, extraClass) {
  container.innerHTML = "";
  for (const opt of options) {
    const btn = el("button", {
      type: "button",
      class: "pill" + (extraClass ? " " + extraClass : "") + (String(opt.value) === String(selectedValue) ? " active" : ""),
      disabled: opt.disabled ? "disabled" : null,
      onclick: (e) => { e.stopPropagation(); onSelect(opt.value); },
    }, opt.label);
    container.append(btn);
  }
}

function toggleSwitch(checked, onChange) {
  const input = el("input", {
    type: "checkbox",
    onchange: (e) => { e.stopPropagation(); onChange(e.target.checked); },
  });
  input.checked = checked;
  return el("label", { class: "switch", onclick: (e) => e.stopPropagation() }, [input, el("span", { class: "switch-track" })]);
}

// ---------- data loading ----------

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function loadRateFile(filename) {
  if (store.rateFilesByName.has(filename)) return store.rateFilesByName.get(filename);
  const data = await fetchJson(DATA_DIR + filename);
  store.rateFilesByName.set(filename, data);
  return data;
}

async function init() {
  const [manifest, underwriting, overview] = await Promise.all([
    fetchJson(DATA_DIR + "states-manifest.json"),
    fetchJson(DATA_DIR + "underwriting-rules.json"),
    fetchJson(DATA_DIR + "product-overview.json"),
  ]);
  store.manifest = manifest;
  store.underwriting = underwriting;
  store.overview = overview;

  renderStatePills();
  wireContextBar();
  wireTabs();

  const firstState = Object.keys(manifest.states)[0];
  await selectState(firstState);

  renderUnderwriting();
  renderHandoff();
}

function renderStatePills() {
  const container = document.getElementById("state-pills");
  const options = Object.entries(store.manifest.states).map(([code, info]) => ({
    value: code,
    label: code,
    title: info.label,
  }));
  pillGroup(container, options, store.currentStateCode, (code) => selectState(code));
  // pillGroup doesn't set title attrs; add them for a hover hint with the full state name.
  [...container.children].forEach((btn, i) => btn.title = options[i].title);
}

async function selectState(code) {
  const info = store.manifest.states[code];
  store.currentStateCode = code;
  store.currentRates = await loadRateFile(info.rate_file);
  renderStatePills();
  renderDayOptionPills();
  renderSexPills();
  renderQuote();
  renderUnderwriting(); // state-variance row highlight depends on selected state
}

function renderDayOptionPills() {
  const container = document.getElementById("day-option-pills");
  const options = store.currentRates.general.day_options;
  if (!options.includes(quote.dayOption)) quote.dayOption = options[0];
  const pillOptions = options.map((d) => ({ value: d, label: d === 1 ? "1 day" : `${d} days` }));
  pillGroup(container, pillOptions, quote.dayOption, (val) => {
    quote.dayOption = Number(val);
    clampDailyBenefit();
    if (quote.dayOption === 1) quote.riders.lumpSumHospital.enabled = false;
    renderQuote();
  });
}

// ---------- context bar ----------

function dailyBenefitRange() {
  const g = store.currentRates.general;
  return quote.dayOption === 1
    ? { min: g.one_day_benefit_range[0], max: g.one_day_benefit_range[1] }
    : { min: g.multi_day_benefit_range[0], max: g.multi_day_benefit_range[1] };
}

function clampDailyBenefit() {
  const { min, max } = dailyBenefitRange();
  let v = Math.round(quote.dailyBenefit / 10) * 10;
  v = Math.max(min, Math.min(max, v));
  quote.dailyBenefit = v;
}

function updateDailyBenefitHint() {
  const { min, max } = dailyBenefitRange();
  document.getElementById("daily-benefit-range-hint").textContent = `${fmtMoney(min)}–${fmtMoney(max)}, $10 increments`;
  const slider = document.getElementById("in-daily-benefit-slider");
  const number = document.getElementById("in-daily-benefit");
  slider.min = min;
  slider.max = max;
  slider.step = 10;
  slider.value = quote.dailyBenefit;
  number.min = min;
  number.max = max;
  number.step = 10;
  number.value = quote.dailyBenefit;
}

// Outside the product's [40,85] issue-age range, or DOB unset/invalid — pricing can't run.
function ageOutOfRange() {
  const [min, max] = store.currentRates.general.issue_ages;
  return quote.age === null || quote.age < min || quote.age > max;
}

function updateAgeReadout() {
  const readout = document.getElementById("age-readout");
  if (quote.age === null) {
    readout.textContent = "Enter a date of birth";
  } else if (ageOutOfRange()) {
    const [min, max] = store.currentRates.general.issue_ages;
    readout.textContent = `Age ${quote.age} — outside issuable range (${min}–${max})`;
  } else {
    readout.textContent = `Age ${quote.age}`;
  }
}

function updateGiFlag() {
  const uw = store.underwriting;
  const field = document.getElementById("gi-flag-field");
  const flag = document.getElementById("gi-flag");
  const [giLo, giHi] = uw.guaranteed_issue.age_range;
  const excluded = uw.guaranteed_issue.states_without_guaranteed_issue.includes(store.currentStateCode);

  if (quote.age === null) {
    field.hidden = true;
    return;
  }
  field.hidden = false;

  if (excluded) {
    flag.textContent = `No Guaranteed Issue in ${store.currentStateCode}`;
    flag.className = "gi-flag gi-flag--warn";
  } else if (isInGiWindow(quote.dob, giLo, giHi)) {
    flag.textContent = `Guaranteed Issue window (age ${giLo}–${giHi})`;
    flag.className = "gi-flag";
  } else {
    flag.textContent = "Outside GI window — full medical questions apply";
    flag.className = "gi-flag gi-flag--warn";
  }
}

function wireContextBar() {
  const dobInput = document.getElementById("in-dob");
  dobInput.value = quote.dob;
  dobInput.addEventListener("input", () => {
    quote.dob = dobInput.value;
    renderQuote();
  });

  const dailyBenefitSlider = document.getElementById("in-daily-benefit-slider");
  const dailyBenefitNumber = document.getElementById("in-daily-benefit");

  dailyBenefitSlider.addEventListener("input", () => {
    quote.dailyBenefit = Number(dailyBenefitSlider.value);
    renderQuote({ skipDailyBenefitSliderSync: true });
  });

  dailyBenefitNumber.addEventListener("input", () => {
    const v = Number(dailyBenefitNumber.value);
    if (!Number.isFinite(v)) return;
    quote.dailyBenefit = v;
    renderQuote({ skipDailyBenefitNumberSync: true });
  });

  dailyBenefitNumber.addEventListener("blur", () => {
    clampDailyBenefit();
    renderQuote();
  });
}

// Sex pill options come straight from the Critical Accident rider's pricing keys
// ("female"/"male") so the UI never hardcodes a set of sexes independent of the data.
function renderSexPills() {
  const container = document.getElementById("sex-pills");
  const sexes = Object.keys(store.currentRates.riders.critical_accident.pricing);
  const options = sexes.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));
  pillGroup(container, options, quote.sex, (val) => {
    quote.sex = val;
    renderQuote();
  });
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    });
  });
}

// ---------- pricing engine ----------
// Each function returns an annual dollar amount (or undefined if unavailable at the current age).

function priceBase() {
  const band = resolveBand(store.currentRates.base_rates_per_10_daily_benefit, quote.age);
  if (!band) return undefined;
  const rate = band[String(quote.dayOption)];
  if (rate === undefined) return undefined;
  return round2((quote.dailyBenefit / 10) * rate);
}

function priceCancer() {
  const r = quote.riders.cancer;
  if (r.choice === "none") return 0;
  const riderKey = r.choice === "recurrence" ? "lump_sum_cancer_with_recurrence" : "lump_sum_cancer";
  const rider = store.currentRates.riders[riderKey];
  const ageObj = rider.pricing[String(quote.age)];
  if (!ageObj) return undefined;
  return ageObj[String(r.amount)];
}

function priceAmbulance() {
  const r = quote.riders.ambulance;
  if (!r.enabled) return 0;
  const rider = store.currentRates.riders.ambulance;
  if (quote.age > rider.max_issue_age) return undefined;
  const band = resolveBand(rider.pricing, quote.age);
  if (!band) return undefined;
  return band[String(r.amount)];
}

function priceDentalVision() {
  const r = quote.riders.dentalVision;
  if (!r.enabled) return 0;
  const band = resolveBand(store.currentRates.riders.dental_vision.pricing, quote.age);
  if (!band) return undefined;
  return band[String(r.amount)];
}

function priceCriticalAccident() {
  const r = quote.riders.criticalAccident;
  if (!r.enabled) return 0;
  const sexTable = store.currentRates.riders.critical_accident.pricing[quote.sex];
  const band = resolveBand(sexTable, quote.age);
  if (!band) return undefined;
  return band[String(r.amount)];
}

function priceOutpatientTherapy() {
  const r = quote.riders.outpatientTherapy;
  if (!r.enabled) return 0;
  const band = resolveBand(store.currentRates.riders.outpatient_therapy.pricing, quote.age);
  if (!band) return undefined;
  return band[r.option];
}

function priceOutpatientSurgical() {
  const r = quote.riders.outpatientSurgical;
  if (!r.enabled) return 0;
  const band = resolveBand(store.currentRates.riders.outpatient_surgical.pricing, quote.age);
  if (!band) return undefined;
  return band[String(r.amount)];
}

function priceGpo(baseAnnual) {
  const r = quote.riders.gpoWellness;
  if (!r.enabled) return 0;
  const rider = store.currentRates.riders.guaranteed_purchase_option;
  if (quote.age > rider.max_issue_age) return undefined;
  const factor = resolveBand(rider.factor_table, quote.age);
  if (factor === undefined || baseAnnual === undefined) return undefined;
  return round2(baseAnnual * factor);
}

function priceWellness() {
  const r = quote.riders.gpoWellness;
  if (!r.enabled) return 0;
  const val = resolveBand(store.currentRates.riders.wellness.pricing, quote.age);
  return val === undefined ? undefined : val;
}

const SNF_OPTION_KEYS = { option_1: "option_1_days_1_50", option_2: "option_2_days_21_100" };

function priceSnf() {
  const r = quote.riders.snf;
  if (r.choice === "none") return 0;
  const rider = store.currentRates.riders.skilled_nursing_facility;
  const table = rider[SNF_OPTION_KEYS[r.choice]].pricing_per_10_daily_benefit;
  const rate = table[String(quote.age)];
  if (rate === undefined) return undefined;
  return round2((r.amount / 10) * rate);
}

function priceLumpSumHospital() {
  const r = quote.riders.lumpSumHospital;
  if (!r.enabled) return 0;
  if (quote.dayOption === 1) return undefined; // not available with 1-day benefit period
  const band = resolveBand(store.currentRates.riders.lump_sum_hospital_confinement.pricing, quote.age);
  if (!band) return undefined;
  return band[String(r.amount)];
}

// ---------- rider metadata (drives both the explainer text and the amount selectors) ----------

function riderDataFor(key) {
  return store.currentRates.riders[key];
}

// ---------- rendering: quote tab ----------

function renderQuote(opts = {}) {
  if (!store.currentRates) return;
  quote.age = computeAge(quote.dob);
  clampDailyBenefit();

  renderStatePills();
  renderDayOptionPills();
  renderSexPills();

  const dobInput = document.getElementById("in-dob");
  if (document.activeElement !== dobInput) dobInput.value = quote.dob || "";
  if (!opts.skipDailyBenefitSliderSync) document.getElementById("in-daily-benefit-slider").value = quote.dailyBenefit;
  if (!opts.skipDailyBenefitNumberSync) document.getElementById("in-daily-benefit").value = quote.dailyBenefit;
  updateDailyBenefitHint();
  updateAgeReadout();
  updateGiFlag();

  const baseRow = document.getElementById("base-plan-row");
  const ridersList = document.getElementById("riders-list");

  if (quote.age === null || ageOutOfRange()) {
    const [min, max] = store.currentRates.general.issue_ages;
    const msg = quote.age === null
      ? "Enter the applicant's date of birth above to build a quote."
      : `This applicant's age (${quote.age}) is outside the issuable range for this product (${min}–${max}).`;
    baseRow.innerHTML = "";
    baseRow.append(el("div", { class: "rider-card" }, el("div", { class: "rider-card__desc" }, msg)));
    ridersList.innerHTML = "";
    renderTotals([]);
    return;
  }

  const baseAnnual = priceBase();
  renderBaseRow(baseAnnual);

  ridersList.innerHTML = "";

  const lines = [];
  lines.push({ label: "Base Plan", annual: baseAnnual });

  ridersList.append(renderCancerCard());
  if (quote.riders.cancer.choice !== "none") {
    lines.push({
      label: quote.riders.cancer.choice === "recurrence" ? "Lump Sum Cancer w/ Recurrence" : "Lump Sum Cancer",
      annual: priceCancer(),
    });
  }

  ridersList.append(renderToggleAmountCard({
    name: "Ambulance",
    riderKey: "ambulance",
    priceFn: priceAmbulance,
    enabledRef: quote.riders.ambulance,
    description: riderDataFor("ambulance").notes,
  }));
  if (quote.riders.ambulance.enabled) lines.push({ label: "Ambulance", annual: priceAmbulance() });

  ridersList.append(renderToggleAmountCard({
    name: "Dental/Vision",
    riderKey: "dental_vision",
    priceFn: priceDentalVision,
    enabledRef: quote.riders.dentalVision,
    description: riderDataFor("dental_vision").notes,
    extraDetailsPairs: [],
  }));
  if (quote.riders.dentalVision.enabled) lines.push({ label: "Dental/Vision", annual: priceDentalVision() });

  ridersList.append(renderCriticalAccidentCard());
  if (quote.riders.criticalAccident.enabled) lines.push({ label: "Critical Accident", annual: priceCriticalAccident() });

  ridersList.append(renderOutpatientTherapyCard());
  if (quote.riders.outpatientTherapy.enabled) lines.push({ label: "Outpatient Therapy", annual: priceOutpatientTherapy() });

  ridersList.append(renderToggleAmountCard({
    name: "Outpatient Surgical",
    riderKey: "outpatient_surgical",
    priceFn: priceOutpatientSurgical,
    enabledRef: quote.riders.outpatientSurgical,
    description: riderDataFor("outpatient_surgical").notes,
  }));
  if (quote.riders.outpatientSurgical.enabled) lines.push({ label: "Outpatient Surgical", annual: priceOutpatientSurgical() });

  ridersList.append(renderGpoWellnessCard(baseAnnual));
  if (quote.riders.gpoWellness.enabled) {
    lines.push({ label: "Guaranteed Purchase Option", annual: priceGpo(baseAnnual) });
    lines.push({ label: "Wellness", annual: priceWellness() });
  }

  ridersList.append(renderSnfCard());
  if (quote.riders.snf.choice !== "none") {
    lines.push({
      label: quote.riders.snf.choice === "option_1" ? "Skilled Nursing Facility (Days 1–50)" : "Skilled Nursing Facility (Days 21–100)",
      annual: priceSnf(),
    });
  }

  ridersList.append(renderToggleAmountCard({
    name: "Lump Sum Hospital Confinement",
    riderKey: "lump_sum_hospital_confinement",
    priceFn: priceLumpSumHospital,
    enabledRef: quote.riders.lumpSumHospital,
    description: riderDataFor("lump_sum_hospital_confinement").notes,
    disabledOverride: quote.dayOption === 1 ? "Not available with 1-day benefit period" : null,
  }));
  if (quote.riders.lumpSumHospital.enabled) lines.push({ label: "Lump Sum Hospital Confinement", annual: priceLumpSumHospital() });

  renderTotals(lines);
}

// ---------- rider card building blocks ----------

function priceLabel(amount) {
  if (amount === undefined) return el("span", { class: "rider-card__price zero" }, "Unavailable at this age");
  if (amount === 0) return el("span", { class: "rider-card__price zero" }, "—");
  return el("span", { class: "rider-card__price" }, `${fmtMoney(amount)}/yr`);
}

function amountPillRow(amounts, selected, onSelect, label = "Benefit amount") {
  const wrap = el("div", { class: "rider-card__sub" });
  wrap.append(el("div", { class: "rider-card__sub-label" }, label));
  const group = el("div", { class: "pill-group" });
  pillGroup(group, amounts.map((a) => ({ value: a, label: fmtMoney(a) })), selected, onSelect, "pill--sm");
  wrap.append(group);
  return wrap;
}

// Builds a standard rider card: name + optional on/off switch, live price, a short
// always-visible description, disabled/pairing tags, whatever sub-controls the rider
// needs (amount pills, a slider, a type picker), and a collapsible details panel.
function riderCardShell({ name, toggle, price, selected, disabled, disabledReason, description, tags = [], subControls, detailsPairs }) {
  const card = el("div", { class: "rider-card" + (selected ? " selected" : "") + (disabled ? " disabled" : "") });

  const nameNode = toggle
    ? el("div", { class: "rider-card__name-row" }, [toggle, el("span", { class: "rider-card__name" }, name)])
    : el("span", { class: "rider-card__name" }, name);
  card.append(el("div", { class: "rider-card__head" }, [nameNode, priceLabel(price)]));

  if (description) card.append(el("div", { class: "rider-card__desc" }, description));

  const tagNodes = [];
  if (disabled && disabledReason) tagNodes.push(el("span", { class: "tag tag--disabled" }, disabledReason));
  for (const t of tags) tagNodes.push(el("span", { class: "tag" }, t));
  if (tagNodes.length) card.append(el("div", { class: "tag-row" }, tagNodes));

  if (subControls && !disabled) card.append(subControls);

  if (detailsPairs && detailsPairs.length) {
    const dl = el("dl", { class: "rider-card__details" });
    for (const [term, def] of detailsPairs) dl.append(el("dt", {}, term), el("dd", {}, def));
    const btn = el("button", {
      type: "button",
      class: "rider-card__details-btn",
      onclick: () => dl.classList.toggle("open"),
    }, "Details");
    card.append(btn, dl);
  }

  return card;
}

function renderBaseRow(baseAnnual) {
  const row = document.getElementById("base-plan-row");
  row.innerHTML = "";
  row.append(riderCardShell({
    name: `Base Plan — ${quote.dayOption === 1 ? "1-day" : quote.dayOption + "-day"} benefit period`,
    price: baseAnnual,
    selected: true,
    description: `${fmtMoney(quote.dailyBenefit)}/day daily benefit. Adjust age, benefit period, and daily benefit above to see this update live.`,
    detailsPairs: [
      ["What it pays", store.currentRates.general.base_includes],
      ["Rate basis", "Base annual premium = (daily benefit ÷ $10) × the age/day-option rate from the rate table."],
    ],
  }));
}

function renderCancerCard() {
  const basic = riderDataFor("lump_sum_cancer");
  const recurrence = riderDataFor("lump_sum_cancer_with_recurrence");
  const r = quote.riders.cancer;
  const annual = priceCancer();

  const sub = el("div", { class: "rider-card__sub" });
  sub.append(el("div", { class: "rider-card__sub-label" }, "Rider"));
  const typeGroup = el("div", { class: "pill-group" });
  pillGroup(typeGroup, [
    { value: "none", label: "None" },
    { value: "basic", label: "Cancer" },
    { value: "recurrence", label: "Cancer + Recurrence" },
  ], r.choice, (val) => { r.choice = val; renderQuote(); }, "pill--sm");
  sub.append(typeGroup);

  if (r.choice !== "none") {
    const amounts = (r.choice === "recurrence" ? recurrence : basic).amounts;
    if (!amounts.includes(r.amount)) r.amount = amounts[0];
    sub.append(amountPillRow(amounts, r.amount, (val) => { r.amount = Number(val); renderQuote(); }));
  }

  return riderCardShell({
    name: "Lump Sum Cancer",
    price: annual,
    selected: r.choice !== "none",
    description: `Lump sum on covered cancer diagnosis. ${basic.includes}`,
    subControls: sub,
    detailsPairs: [
      ["Waiting period", `${basic.waiting_period_days} days from effective date.`],
      ["With Recurrence option", `Adds a second payout if cancer recurs: Year 1: ${recurrence.recurrence_payout_schedule_pct_of_lump_sum.year_1}% of the lump sum, Years 2–3: ${recurrence.recurrence_payout_schedule_pct_of_lump_sum.years_2_3}%, Year 4: ${recurrence.recurrence_payout_schedule_pct_of_lump_sum.year_4}%, Year 5+: ${recurrence.recurrence_payout_schedule_pct_of_lump_sum.year_5_plus}%.`],
      ["Underwriting note", "Medical questions must be answered for this rider regardless of age — it is NOT covered by the Guaranteed Issue window."],
    ],
  });
}

function renderToggleAmountCard({ name, riderKey, priceFn, enabledRef, description, extraDetailsPairs = [], disabledOverride }) {
  const rider = riderDataFor(riderKey);
  const disabledByAge = rider.max_issue_age !== undefined && quote.age > rider.max_issue_age;
  const disabled = disabledByAge || !!disabledOverride;
  const active = enabledRef.enabled && !disabled;
  const annual = priceFn();

  const toggle = toggleSwitch(active, (checked) => { enabledRef.enabled = checked; renderQuote(); });
  if (disabled) toggle.querySelector("input").disabled = true;

  let sub = null;
  if (active) {
    if (!rider.amounts.includes(enabledRef.amount)) enabledRef.amount = rider.amounts[0];
    sub = amountPillRow(rider.amounts, enabledRef.amount, (val) => { enabledRef.amount = Number(val); renderQuote(); });
  }

  const detailsPairs = [["Details", rider.notes || "—"]];
  if (rider.waiting_period_days) detailsPairs.push(["Waiting period", `${rider.waiting_period_days} days.`]);
  if (rider.deductible !== undefined) detailsPairs.push(["Deductible / coinsurance", `${fmtMoney(rider.deductible)} annual deductible, ${rider.coinsurance_pct}% coinsurance.`]);
  detailsPairs.push(...extraDetailsPairs);

  return riderCardShell({
    name,
    toggle,
    price: active ? annual : 0,
    selected: active,
    disabled,
    disabledReason: disabledByAge ? `Max issue age ${rider.max_issue_age}` : disabledOverride,
    description,
    subControls: sub,
    detailsPairs,
  });
}

function renderCriticalAccidentCard() {
  const rider = riderDataFor("critical_accident");
  const r = quote.riders.criticalAccident;
  const annual = priceCriticalAccident();
  const noWaitState = store.currentStateCode === "TX";

  const toggle = toggleSwitch(r.enabled, (checked) => { r.enabled = checked; renderQuote(); });

  let sub = null;
  if (r.enabled) {
    if (!rider.amounts.includes(r.amount)) r.amount = rider.amounts[0];
    sub = amountPillRow(rider.amounts, r.amount, (val) => { r.amount = Number(val); renderQuote(); }, "Plan amount");
  }

  const payout = rider.payout_schedule[`${r.amount}_plan`] || rider.payout_schedule[`${rider.amounts[0]}_plan`];

  return riderCardShell({
    name: "Critical Accident",
    toggle,
    price: r.enabled ? annual : 0,
    selected: r.enabled,
    description: rider.notes,
    tags: ["Priced by sex"],
    subControls: sub,
    detailsPairs: [
      ["Payout schedule", `Accidental death ${fmtMoney(payout.accidental_death)}; hip/skull fracture ${fmtMoney(payout.hip_or_skull_fracture)}; hip dislocation ${fmtMoney(payout.hip_dislocation)}; knee dislocation/ligament tear ${fmtMoney(payout.knee_dislocation_or_ligament_tear)}; other fracture ${fmtMoney(payout.fracture_other)}.`],
      ["Waiting period", noWaitState ? `${rider.waiting_period_note} (this quote is for ${store.currentStateCode}).` : `${rider.waiting_period_days} days.`],
    ],
  });
}

function renderOutpatientTherapyCard() {
  const rider = riderDataFor("outpatient_therapy");
  const r = quote.riders.outpatientTherapy;
  const annual = priceOutpatientTherapy();

  const toggle = toggleSwitch(r.enabled, (checked) => { r.enabled = checked; renderQuote(); });

  let sub = null;
  if (r.enabled) {
    sub = el("div", { class: "rider-card__sub" });
    sub.append(el("div", { class: "rider-card__sub-label" }, "Visit allowance"));
    const group = el("div", { class: "pill-group" });
    pillGroup(group, rider.options.map((o) => ({ value: o, label: o.replace("_", "-") })), r.option, (val) => { r.option = val; renderQuote(); }, "pill--sm");
    sub.append(group);
  }

  return riderCardShell({
    name: "Outpatient Therapy",
    toggle,
    price: r.enabled ? annual : 0,
    selected: r.enabled,
    description: `${fmtMoney(rider.daily_benefit)}/day. ${rider.notes}`,
    subControls: sub,
  });
}

function renderGpoWellnessCard(baseAnnual) {
  const gpo = riderDataFor("guaranteed_purchase_option");
  const wellness = riderDataFor("wellness");
  const r = quote.riders.gpoWellness;
  const disabledByAge = quote.age > gpo.max_issue_age;
  const gpoAnnual = priceGpo(baseAnnual);
  const wellnessAnnual = priceWellness();
  const active = r.enabled && !disabledByAge;
  const total = active && gpoAnnual !== undefined && wellnessAnnual !== undefined ? round2(gpoAnnual + wellnessAnnual) : undefined;

  const toggle = toggleSwitch(active, (checked) => { r.enabled = checked; renderQuote(); });
  if (disabledByAge) toggle.querySelector("input").disabled = true;

  let sub = null;
  if (active) {
    sub = el("div", { class: "rider-card__sub" });
    sub.append(el("div", { class: "rider-card__sub-label" }, "Breakdown"));
    sub.append(el("div", { class: "rider-card__desc" }, `GPO: ${fmtMoney(gpoAnnual)}/yr  ·  Wellness: ${fmtMoney(wellnessAnnual)}/yr`));
  }

  return riderCardShell({
    name: "Guaranteed Purchase Option + Wellness",
    toggle,
    price: active ? total : 0,
    selected: active,
    disabled: disabledByAge,
    disabledReason: `Max issue age ${gpo.max_issue_age}`,
    description: "Automatically increases the hospital confinement benefit over time, paired with an annual wellness-visit cash benefit.",
    tags: ["Sold together — required pairing"],
    subControls: sub,
    detailsPairs: [
      ["GPO — what it does", gpo.notes],
      ["GPO pricing basis", `Priced as a % of the Base Plan premium (${gpo.applies_to}): current age factor applied to this quote's base premium.`],
      ["Wellness — what it pays", `${fmtMoney(wellness.annual_benefit)}/year for a routine physical exam by a Doctor, NP, or PA. Waiting period: ${wellness.waiting_period_days} days.`],
      ["Why they're bundled", "GTL requires GPO and Wellness to be sold together — neither is available on its own."],
    ],
  });
}

function renderSnfCard() {
  const rider = riderDataFor("skilled_nursing_facility");
  const r = quote.riders.snf;
  const annual = priceSnf();
  const [min, max] = rider.benefit_range;

  const sub = el("div", { class: "rider-card__sub" });
  sub.append(el("div", { class: "rider-card__sub-label" }, "Option"));
  const typeGroup = el("div", { class: "pill-group" });
  pillGroup(typeGroup, [
    { value: "none", label: "None" },
    { value: "option_1", label: "Option 1 (Days 1–50)" },
    { value: "option_2", label: "Option 2 (Days 21–100)" },
  ], r.choice, (val) => { r.choice = val; renderQuote(); }, "pill--sm");
  sub.append(typeGroup);

  if (r.choice !== "none") {
    r.amount = Math.max(min, Math.min(max, r.amount));
    const sliderWrap = el("div", { class: "rider-card__sub" });
    sliderWrap.append(el("div", { class: "rider-card__sub-label" }, `Daily benefit: ${fmtMoney(r.amount)} ($${min}–$${max})`));
    const row = el("div", { class: "slider-row" });
    row.append(el("input", {
      type: "range", min, max, step: 10, value: r.amount,
      oninput: (e) => { r.amount = Number(e.target.value); renderQuote(); },
    }));
    sliderWrap.append(row);
    sub.append(sliderWrap);
  }

  return riderCardShell({
    name: "Skilled Nursing Facility",
    price: annual,
    selected: r.choice !== "none",
    description: rider.notes,
    subControls: sub,
    detailsPairs: [
      ["Only one option may be chosen", "Option 1 covers days 1–50 of an SNF stay; Option 2 covers days 21–100. They cannot be combined."],
    ],
  });
}

// ---------- totals table ----------

function renderTotals(lines) {
  const g = store.currentRates.general;
  const modes = [
    ["annual", "Annual"],
    ["semi_annual", "Semi-Annual"],
    ["quarterly", "Quarterly"],
    ["monthly_pac", "Monthly PAC"],
  ];
  const freq = { annual: 1, semi_annual: 2, quarterly: 4, monthly_pac: 12 };

  const tbody = document.getElementById("totals-tbody");
  const tfoot = document.getElementById("totals-tfoot");
  tbody.innerHTML = "";
  tfoot.innerHTML = "";

  let annualSubtotal = 0;
  let hasUnavailable = false;

  for (const line of lines) {
    if (line.annual === undefined) { hasUnavailable = true; continue; }
    annualSubtotal += line.annual;
    const row = el("tr");
    row.append(el("td", {}, line.label));
    for (const [modeKey] of modes) {
      row.append(el("td", {}, fmtMoney(round2(line.annual * g.payment_mode_factors[modeKey]))));
    }
    tbody.append(row);
  }

  const feeRow = el("tr");
  feeRow.append(el("td", {}, "Annual Policy Fee"));
  for (const [modeKey] of modes) {
    feeRow.append(el("td", {}, fmtMoney(round2(g.annual_policy_fee * g.payment_mode_factors[modeKey]))));
  }
  tbody.append(feeRow);

  const totalAnnual = round2(annualSubtotal + g.annual_policy_fee);

  const totalRow = el("tr");
  totalRow.append(el("th", {}, "Total"));
  for (const [modeKey] of modes) {
    totalRow.append(el("td", {}, fmtMoney(round2(totalAnnual * g.payment_mode_factors[modeKey]))));
  }
  tfoot.append(totalRow);

  const heroAmount = document.getElementById("hero-total-amount");
  const heroSub = document.getElementById("hero-total-sub");
  if (lines.length === 0) {
    heroAmount.textContent = "—";
    heroSub.textContent = "";
  } else {
    heroAmount.textContent = fmtMoney(totalAnnual);
    const monthly = round2(totalAnnual * g.payment_mode_factors.monthly_pac);
    heroSub.textContent = `${fmtMoney(monthly)}/mo on Monthly PAC · incl. ${fmtMoney(g.annual_policy_fee)} policy fee`;
  }

  const warning = document.getElementById("min-premium-warning");
  if (hasUnavailable) {
    warning.hidden = false;
    warning.textContent = "One or more selected riders are unavailable at this applicant's age and are excluded from the total above — check the rider's max issue age.";
  } else if (totalAnnual < g.min_annual_premium) {
    warning.hidden = false;
    warning.textContent = `Calculated annual premium (${fmtMoney(totalAnnual)}, incl. policy fee) is below GTL's ${fmtMoney(g.min_annual_premium)} minimum annual premium. Confirm actual billed amount with the writing agent at binding.`;
  } else {
    warning.hidden = true;
  }

  document.getElementById("mode-fine-print").textContent =
    `Semi-Annual/Quarterly/Monthly PAC amounts include GTL's modal payment load (factors: annual ${g.payment_mode_factors.annual}, semi-annual ${g.payment_mode_factors.semi_annual}, quarterly ${g.payment_mode_factors.quarterly}, monthly PAC ${g.payment_mode_factors.monthly_pac} — each × ${freq.annual}/${freq.semi_annual}/${freq.quarterly}/${freq.monthly_pac} payments per year respectively). Ballpark only — carrier system of record governs at binding.`;
}

// ---------- underwriting reference tab ----------

function renderUnderwriting() {
  const uw = store.underwriting;
  const container = document.getElementById("uw-content");
  container.innerHTML = "";

  const [giLo, giHi] = uw.guaranteed_issue.age_range;

  container.append(
    section("Guaranteed Issue", [
      p(`Ages <b>${giLo}–${giHi}</b> (up to but not including ${giHi}): medical questions are waived, regardless of health, <b>except</b> the Lump Sum Cancer rider, which always requires medical questions.`),
      p(`${uw.guaranteed_issue.note}`),
      p(`No Guaranteed Issue at all in: <b>${uw.guaranteed_issue.states_without_guaranteed_issue.join(", ")}</b>. ${uw.guaranteed_issue.utah_note}`),
    ]),

    section("Medical Underwriting", [
      p(uw.medical_underwriting.rule),
      p(`<b>Cancer rider exception:</b> ${uw.medical_underwriting.cancer_rider_exception}`),
    ]),

    section("Pre-Existing Condition Rules", [
      p(`<b>Lookback: ${uw.pre_existing_condition.lookback_months} months.</b> ${uw.pre_existing_condition.definition}`),
      p(uw.pre_existing_condition.coverage_trigger),
      p(`<b>NC:</b> ${uw.pre_existing_condition.state_exceptions.NC} &nbsp; <b>MD:</b> ${uw.pre_existing_condition.state_exceptions.MD}`),
      p(uw.pre_existing_condition.state_exceptions.note),
    ]),

    section("Application & Effective Date Rules", [
      p(`<b>Application staleness:</b> ${uw.application_rules.note_staleness} (${uw.application_rules.application_staleness_days} days).`),
      p(`<b>Effective date:</b> ${uw.application_rules.note_effective_date}`),
      p(`<b>Spouse policy fee:</b> ${uw.application_rules.spouse_policy_fee}`),
      p(`Requires SSN: ${uw.application_rules.requires_ssn ? "Yes" : "No"} · Requires US citizen/green card: ${uw.application_rules.requires_us_citizen_or_green_card ? "Yes" : "No"} · POA/guardianship acceptable: ${uw.application_rules.poa_or_guardianship_acceptable ? "Yes" : "No"}`),
      p(uw.application_rules.agent_requirement),
    ]),

    section("Cross-Product Benefit Overlap Limits", [
      p("Applies across GTL and UNL products combined, not just within Advantage Plus Elite."),
      ul(Object.entries(uw.cross_product_overlap_limits).filter(([k]) => k !== "note").map(([k, v]) => overlapLine(k, v))),
    ]),

    section("Policy Change Rules", [
      p(`<b>Benefit increase / new rider:</b> ${uw.policy_changes.benefit_increase_or_new_rider}`),
      p(`<b>Changing benefit period:</b> ${uw.policy_changes.cancel_rewrite_trigger}`),
      p(`<b>Replacing an older plan:</b> ${uw.policy_changes.replacement_of_older_plan}`),
      p(`<b>Adding Dental/Vision:</b> ${uw.policy_changes.adding_dental_vision}`),
      p(`<b>Rider-only addition:</b> ${uw.policy_changes.rider_only_addition}`),
      p(`<b>Reinstatement window:</b> ${uw.policy_changes.reinstatement_window_months} months.`),
    ]),

    stateVarianceSection(uw),
  );

  wireUwSearch();
}

function overlapLine(key, val) {
  const label = key.replace(/_/g, " ");
  const parts = Object.entries(val).filter(([k]) => k !== "note").map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(", ");
  const note = val.note ? ` — ${val.note}` : "";
  return el("li", {}, `${label} — ${parts}${note}`);
}

function stateVarianceSection(uw) {
  const sec = el("section", { class: "uw-section", "data-uw-section": "true" });
  sec.append(el("h3", {}, "State-Specific Variances"));
  sec.append(p("Only states with a documented variance from standard product rules are listed. No row = standard rules apply."));

  const table = el("table", { class: "uw-state-table" });
  const thead = el("thead", {}, el("tr", {}, [el("th", {}, "State"), el("th", {}, "Variance")]));
  const tbody = el("tbody");
  for (const [code, text] of Object.entries(uw.state_specific_variances)) {
    const row = el("tr", { class: code === store.currentStateCode ? "current-state" : "" });
    row.append(el("td", {}, code), el("td", {}, text));
    tbody.append(row);
  }
  table.append(thead, tbody);
  sec.append(table);
  return sec;
}

function section(title, children) {
  return el("section", { class: "uw-section", "data-uw-section": "true" }, [el("h3", {}, title), ...children]);
}
function p(html) { return el("p", { html }); }
function ul(children) { return el("ul", {}, children); }

function wireUwSearch() {
  const input = document.getElementById("uw-search");
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll("[data-uw-section]").forEach((sec) => {
      const matches = !q || sec.textContent.toLowerCase().includes(q);
      sec.classList.toggle("hidden-by-search", !matches);
    });
    document.querySelectorAll(".uw-state-table tbody tr").forEach((row) => {
      const matches = !q || row.textContent.toLowerCase().includes(q);
      row.classList.toggle("hidden-by-search", !matches);
    });
  };
}

// ---------- handoff tab ----------

function renderHandoff() {
  const overview = store.overview;
  const uw = store.underwriting;
  const container = document.getElementById("handoff-content");
  container.innerHTML = "";

  container.append(
    el("div", { class: "disclosure-box" }, overview.not_a_substitute_disclosure)
  );

  const grid = el("div", { class: "handoff-grid" });

  const scriptCard = el("div", { class: "handoff-card" });
  scriptCard.append(el("h3", {}, "Handoff Script"));
  const scriptLines = [
    "\"Based on what we've walked through, this looks like a great fit — here's the ballpark on pricing and how the riders would work for you.\"",
    "\"I'm not yet appointed with Guarantee Trust Life, so to actually get this policy bound for you today, I'm going to bring in one of my licensed teammates who is appointed with GTL.\"",
    "\"They'll confirm the exact premium, walk through the medical questions, and get your application submitted — nothing changes about what we just discussed, they're just the one who can officially write it.\"",
    "\"Do you have a few more minutes to stay on the line while I loop them in?\"",
  ];
  for (const line of scriptLines) scriptCard.append(el("p", { class: "script-line" }, line));
  grid.append(scriptCard);

  const scenarioCard = el("div", { class: "handoff-card" });
  scenarioCard.append(el("h3", {}, "Sample Talk-Track Scenario"));
  const sc = overview.example_talk_track_scenario;
  scenarioCard.append(
    el("p", { class: "script-line" }, [el("b", {}, "Premise: "), sc.premise]),
    el("p", { class: "script-line" }, [el("b", {}, "Event: "), sc.event]),
    el("p", { class: "script-line" }, [el("b", {}, "GTL solution: "), sc.gtl_solution]),
    el("p", { class: "script-line" }, [el("b", {}, "Illustrative premium: "), `${sc.sample_premium_reference} — always quote live from this tool instead.`]),
    el("p", { class: "script-line" }, [el("b", {}, "Closing point: "), sc.closing_point])
  );
  grid.append(scenarioCard);

  const sellingCard = el("div", { class: "handoff-card" });
  sellingCard.append(el("h3", {}, "Key Selling Points"));
  sellingCard.append(el("ul", {}, overview.key_selling_points.map((pt) => el("li", {}, pt))));
  grid.append(sellingCard);

  const exclusionsCard = el("div", { class: "handoff-card" });
  exclusionsCard.append(el("h3", {}, "General Policy Exclusions"));
  exclusionsCard.append(el("ul", {}, overview.general_policy_exclusions.map((pt) => el("li", {}, pt))));
  grid.append(exclusionsCard);

  const contactsCard = el("div", { class: "handoff-card" });
  contactsCard.append(el("h3", {}, "Contacts for the Appointed Agent"));
  const contactEntries = [
    ["Sales support", uw.new_business_submission.sales_support_phone],
    ["Underwriting support", uw.new_business_submission.underwriting_support_phone],
    ["Customer service", uw.new_business_submission.customer_service_phone],
    ["Voice verification line", uw.new_business_submission.voice_verification_phone],
  ];
  const list = el("ul", { class: "contact-list" }, contactEntries.map(([label, phone]) =>
    el("li", {}, [el("span", {}, label), el("span", { class: "contact-phone" }, phone)])
  ));
  contactsCard.append(list);
  contactsCard.append(p(`<b>Voice verification needed when:</b> ${uw.new_business_submission.voice_verification_who}`));
  grid.append(contactsCard);

  container.append(grid);
}

init().catch((err) => {
  document.body.prepend(el("div", { style: "background:#5c1a1a;color:#fff;padding:12px;font-family:monospace" }, `Failed to load data: ${err.message}`));
  console.error(err);
});
