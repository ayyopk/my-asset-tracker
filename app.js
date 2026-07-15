(function () {
  "use strict";

  const DB_NAME = "aska-asset-tracker";
  const DB_VERSION = 1;
  const STORE = "app";
  const DATA_KEY = "main";
  const VAULT_KEY = "vault";
  const KDF_ITERATIONS = 310000;
  const APP_VERSION = "3.5.0";

  const categories = {
    taiwan: { name: "台灣資產", short: "台灣", icon: "taiwan", tone: "c1" },
    japan: { name: "日本資產", short: "日本", icon: "bank", tone: "c2" },
    retirement: { name: "退休資產", short: "退休", icon: "retirement", tone: "c3" },
    family: { name: "家庭暫存外幣", short: "暫存外幣", icon: "wallet", tone: "c4" }
  };

  let data;
  let privacyHidden = false;
  let db;
  let toastTimer;
  let vaultCryptoKey = null;
  let vaultSalt = null;
  let backgroundedAt = 0;
  let backgroundLockEnabled = true;

  const $ = selector => document.querySelector(selector);
  const app = document.getElementById("app");

  function seedData() {
    return {
      version: 1,
      settings: { baseCurrency: "TWD", lastBackupAt: null, backupAfterSave: true },
      accounts: [],
      snapshots: [],
      salaries: []
    };
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      };
      request.onsuccess = () => { db = request.result; resolve(db); };
      request.onerror = () => reject(request.error);
    });
  }

  function dbGet(key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbPut(key, value) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function dbDelete(key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < array.length; i += 1) binary += String.fromCharCode(array[i]);
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveVaultKey(password, salt) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: KDF_ITERATIONS },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function makeVault(payload, key, salt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return {
      format: "aska-asset-vault",
      version: 2,
      cipher: "AES-GCM-256",
      kdf: "PBKDF2-SHA256",
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
      updatedAt: new Date().toISOString()
    };
  }

  async function decryptVault(vault, password) {
    if (!vault || vault.format !== "aska-asset-vault") throw new Error("invalid vault");
    const salt = base64ToBytes(vault.salt);
    const key = await deriveVaultKey(password, salt);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(vault.iv) },
      key,
      base64ToBytes(vault.ciphertext)
    );
    return { data: JSON.parse(new TextDecoder().decode(clear)), key, salt };
  }

  async function persist() {
    if (!vaultCryptoKey || !vaultSalt) throw new Error("vault locked");
    const vault = await makeVault(data, vaultCryptoKey, vaultSalt);
    await dbPut(VAULT_KEY, vault);
    await dbDelete(DATA_KEY);
  }

  function latestSnapshot() {
    return [...data.snapshots].sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  }

  function previousSnapshot(current) {
    const sorted = [...data.snapshots].sort((a, b) => b.date.localeCompare(a.date));
    const index = sorted.findIndex(item => item.id === current.id);
    return index >= 0 ? sorted[index + 1] || null : null;
  }

  function activeAccounts(category) {
    return data.accounts.filter(account => account.active !== false && (!category || account.category === category));
  }

  function accountTwd(account, snapshot) {
    const value = Number(snapshot?.values?.[account.id] || 0);
    return account.currency === "JPY" ? value * Number(snapshot?.jpyRate || 0) : value;
  }

  function categoryTotal(category, snapshot) {
    return activeAccounts(category).reduce((sum, account) => sum + accountTwd(account, snapshot), 0);
  }

  function grandTotal(snapshot) {
    return activeAccounts().reduce((sum, account) => sum + accountTwd(account, snapshot), 0);
  }

  function formatTwd(value) {
    return "NT$ " + Math.round(Number(value || 0)).toLocaleString("zh-TW");
  }

  function formatNative(value, currency) {
    const prefix = currency === "JPY" ? "¥ " : "NT$ ";
    return prefix + Math.round(Number(value || 0)).toLocaleString("zh-TW");
  }

  function formatDate(date) {
    if (!date) return "尚未更新";
    const [y, m, d] = date.split("-");
    return `${y}年${Number(m)}月${Number(d)}日`;
  }

  function dateToday() {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function icon(name) {
    const paths = {
      home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V21h13V10.5M9.5 21v-6h5v6"/>',
      edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
      history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      salary: '<path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/><path d="M2 21h20"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
      eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
      eyeoff: '<path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-2.1 3M6.6 6.7C3.5 8.6 2 12 2 12s3.5 7 10 7a10 10 0 0 0 4.1-.8"/>',
      bank: '<path d="M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M2 21h20M12 3 3 7h18Z"/>',
      taiwan: '<path d="M14.5 2.5c2 2 2.2 4.4.8 6.2-1 1.3-1.1 2.2-.3 3.6.8 1.5.5 3.1-.9 4.1-1.4 1-1.8 2.5-1.3 4.1-2.3.2-4.1-.8-4.7-2.6-.5-1.4-1.8-2.1-3.3-2.2.7-2.2 1.8-3.9 3.3-5.1 1.5-1.2 2.2-2.9 2.2-5.1Z"/>',
      retirement: '<path d="M4 10h16v10H4zM7 10V7a5 5 0 0 1 10 0v3M8 14h8M8 17h5"/>',
      wallet: '<path d="M4 6h15a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12"/><path d="M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      save: '<path d="M5 3h12l3 3v15H4V4a1 1 0 0 1 1-1Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16"/>',
      upload: '<path d="M12 16V4m0 0 4 4m-4-4-4 4M4 20h16"/>',
      trash: '<path d="M3 6h18M8 6V3h8v3m3 0-1 15H6L5 6m4 4v7m6-7v7"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.wallet}</svg>`;
  }

  function normalizeData(value) {
    const normalized = validateBackup(value) ? value : seedData();
    normalized.settings ||= {};
    normalized.settings.baseCurrency ||= "TWD";
    normalized.settings.lastBackupAt ||= null;
    if (typeof normalized.settings.backupAfterSave !== "boolean") normalized.settings.backupAfterSave = true;
    if (!Array.isArray(normalized.salaries)) normalized.salaries = [];
    // 富邦外幣仍在台灣帳戶中，因此歸入台灣資產；既有歷史金額不會改變。
    normalized.accounts.forEach(account => {
      if (account.id === "jp-fubon" || account.name?.trim() === "富邦外幣") account.category = "taiwan";
    });
    return normalized;
  }

  function renderAuth(mode, legacyData) {
    const creating = mode === "create";
    app.innerHTML = `<main class="auth-screen">
      <section class="auth-card">
        <span class="version-badge" aria-label="應用程式版本">v${APP_VERSION}</span>
        <div class="auth-mark">${icon("wallet")}</div>
        <h1>${creating ? "設定開啟密碼" : "我的資產"}</h1>
        <p>${creating ? "密碼會用來加密手機內的資產資料與完整備份。" : "請輸入密碼以解鎖資產資料。"}</p>
        <label class="auth-field" for="vaultPassword"><span>密碼</span><input id="vaultPassword" type="password" autocomplete="${creating ? "new-password" : "current-password"}" inputmode="text" placeholder="至少 6 個字元"></label>
        ${creating ? '<label class="auth-field" for="vaultPasswordAgain"><span>再次輸入</span><input id="vaultPasswordAgain" type="password" autocomplete="new-password" placeholder="再次輸入相同密碼"></label>' : ""}
        <div id="authError" class="auth-error" role="alert"></div>
        <button class="primary-btn" id="authSubmit">${creating ? "建立密碼並開始" : "解鎖"}</button>
        ${creating ? '<div class="auth-warning">請務必記住密碼。密碼只保存在你的記憶中，忘記後無法由我們協助取回。</div>' : ""}
      </section>
    </main>`;
    const submit = async () => {
      const password = $("#vaultPassword").value;
      const error = $("#authError");
      error.textContent = "";
      if (password.length < 6) { error.textContent = "密碼至少需要 6 個字元。"; return; }
      if (creating && password !== $("#vaultPasswordAgain").value) { error.textContent = "兩次輸入的密碼不相同。"; return; }
      $("#authSubmit").disabled = true;
      $("#authSubmit").textContent = creating ? "正在加密…" : "正在解鎖…";
      try {
        if (creating) {
          vaultSalt = crypto.getRandomValues(new Uint8Array(16));
          vaultCryptoKey = await deriveVaultKey(password, vaultSalt);
          data = normalizeData(legacyData || seedData());
          await persist();
        } else {
          const vault = await dbGet(VAULT_KEY);
          const unlocked = await decryptVault(vault, password);
          data = normalizeData(unlocked.data);
          vaultCryptoKey = unlocked.key;
          vaultSalt = unlocked.salt;
        }
        render();
      } catch (cause) {
        error.textContent = creating ? "無法建立加密資料，請重新嘗試。" : "密碼不正確，請重新輸入。";
        $("#authSubmit").disabled = false;
        $("#authSubmit").textContent = creating ? "建立密碼並開始" : "解鎖";
      }
    };
    $("#authSubmit").addEventListener("click", submit);
    $("#vaultPassword").addEventListener("keydown", event => { if (event.key === "Enter" && !creating) submit(); });
    if (creating) $("#vaultPasswordAgain").addEventListener("keydown", event => { if (event.key === "Enter") submit(); });
    setTimeout(() => $("#vaultPassword")?.focus(), 80);
  }

  function lockApp() {
    data = null;
    vaultCryptoKey = null;
    vaultSalt = null;
    privacyHidden = false;
    renderAuth("unlock");
  }

  function nav(active) {
    return `<nav class="bottom-nav" aria-label="主要功能">
      ${navButton("overview", "總覽", "home", active)}
      ${navButton("update", "更新", "edit", active)}
      ${navButton("salary", "薪資", "salary", active)}
      ${navButton("history", "歷史", "history", active)}
      ${navButton("settings", "設定", "settings", active)}
    </nav>`;
  }

  function navButton(route, label, iconName, active) {
    return `<button class="nav-btn ${active === route ? "active" : ""}" data-route="${route}" aria-label="${label}">${icon(iconName)}<span>${label}</span></button>`;
  }

  function topbar(title, subtitle, back) {
    return `<header class="topbar">
      ${back ? `<button class="icon-btn" data-back aria-label="返回">${icon("back")}</button>` : ""}
      <div class="topbar-title" style="flex:1"><h1>${escapeHTML(title)}</h1>${subtitle ? `<p class="eyebrow">${escapeHTML(subtitle)}</p>` : ""}</div>
      <button class="icon-btn" data-privacy aria-label="${privacyHidden ? "顯示金額" : "隱藏金額"}">${icon(privacyHidden ? "eyeoff" : "eye")}</button>
    </header>`;
  }

  function renderOverview() {
    const current = latestSnapshot();
    const previous = current ? previousSnapshot(current) : null;
    const total = current ? grandTotal(current) : 0;
    const delta = previous ? total - grandTotal(previous) : null;
    const categoryRows = Object.entries(categories).map(([key, category], index) => {
      const value = categoryTotal(key, current);
      const percent = total ? value / total * 100 : 0;
      return `<button class="list-row" data-category="${key}">
        <span class="row-icon ${category.tone}">${icon(category.icon)}</span>
        <span class="row-main"><span class="row-title">${category.name}</span><span class="row-sub">${activeAccounts(key).length} 個項目</span></span>
        <span class="row-value privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatTwd(value)}<span class="row-percent">${percent.toFixed(1)}%</span></span>
        <span class="chev">›</span>
      </button>`;
    }).join("");

    app.innerHTML = `${topbar("我的資產", current ? `${formatDate(current.date)}更新` : "尚未建立紀錄", false)}
      <main>
        <section class="hero">
          <div class="hero-head">
            <div><div class="hero-label">總資產</div><div class="hero-value privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatTwd(total)}</div>
              <div class="delta privacy-value ${privacyHidden ? "is-hidden" : ""} ${delta == null || delta >= 0 ? "positive" : "negative"}">${delta == null ? "第一筆資產紀錄" : `較上次 ${delta >= 0 ? "+" : "−"}${formatTwd(Math.abs(delta))}`}</div>
            </div>
            <svg class="spark" viewBox="0 0 72 46" role="img" aria-label="資產趨勢圖"><path d="M3 38 16 28 27 32 39 18 50 22 68 5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M61 5h7v7" fill="none" stroke="currentColor" stroke-width="3"/></svg>
          </div>
        </section>
        <div class="section-head"><h2>資產分類</h2><span class="section-note">點入查看明細</span></div>
        <section class="stack">${categoryRows}</section>
        <div class="button-grid"><button class="primary-btn" data-route="update"><span class="btn-icon">${icon("edit")}</span>更新資產</button></div>
      </main>${nav("overview")}`;
    bindCommon();
  }

  function renderCategory(key) {
    const category = categories[key];
    if (!category) return go("overview");
    const snapshot = latestSnapshot();
    const total = categoryTotal(key, snapshot);
    const rows = activeAccounts(key).map(account => {
      const native = Number(snapshot?.values?.[account.id] || 0);
      const converted = accountTwd(account, snapshot);
      return `<button class="list-row" data-update-category="${key}">
        <span class="row-icon ${category.tone}">${icon(account.currency === "JPY" ? "bank" : category.icon)}</span>
        <span class="row-main"><span class="row-title">${escapeHTML(account.name)}</span><span class="row-sub">${account.currency}${account.currency === "JPY" ? ` · 約 <span class="privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatTwd(converted)}</span>` : ""}</span></span>
        <span class="row-value privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatNative(native, account.currency)}</span><span class="chev">›</span>
      </button>`;
    }).join("");

    app.innerHTML = `${topbar(category.name, snapshot ? `${formatDate(snapshot.date)}的餘額` : "尚未建立紀錄", true)}
      <main><section class="hero"><div class="hero-label">分類合計</div><div class="hero-value privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatTwd(total)}</div>
      ${key === "family" ? '<div class="info-box">此分類為暫放在親屬名義下、未來預計取回的日圓，會計入你的總資產，但與本人帳戶分開顯示。</div>' : ""}</section>
      <div class="section-head"><h2>帳戶明細</h2><span class="section-note">點選即可修改</span></div>
      <section class="stack">${rows || '<div class="empty"><strong>尚無項目</strong>請至設定新增資產項目。</div>'}</section>
      <div class="button-grid"><button class="primary-btn" data-update-category="${key}">${icon("edit")}修改此分類</button></div></main>${nav("")}`;
    bindCommon();
  }

  function renderUpdate(filterCategory) {
    const snapshot = latestSnapshot();
    const accounts = activeAccounts(filterCategory || null);
    const grouped = Object.keys(categories).filter(key => accounts.some(a => a.category === key)).map(key => {
      const categoryAccounts = accounts.filter(a => a.category === key);
      return `<div class="category-divider">${categories[key].name}</div>${categoryAccounts.map(accountInput).join("")}`;
    }).join("");

    function accountInput(account) {
      const value = Number(snapshot?.values?.[account.id] || 0);
      const converted = account.currency === "JPY" ? `<div class="converted privacy-value ${privacyHidden ? "is-hidden" : ""}" data-converted="${account.id}">約 ${formatTwd(value * Number(snapshot?.jpyRate || .21))}</div>` : "";
      return `<div class="account-input" data-account-card="${account.id}"><div class="input-top"><span class="input-name">${escapeHTML(account.name)}</span><span class="currency-pill">${account.currency}</span></div>
        <div class="money-input-wrap"><span class="money-prefix">${account.currency === "JPY" ? "¥" : "NT$"}</span><input class="money-input privacy-value ${privacyHidden ? "is-hidden" : ""}" inputmode="numeric" autocomplete="off" data-account-input="${account.id}" data-currency="${account.currency}" data-original-value="${Math.round(value)}" value="${Math.round(value).toLocaleString("en-US")}" aria-label="${escapeHTML(account.name)}金額"></div>${converted}</div>`;
    }

    app.innerHTML = `${topbar(filterCategory ? `更新${categories[filterCategory].name}` : "本月資產更新", "輸入完成後，按下方按鈕保存新紀錄", !!filterCategory)}
      <main><div class="form-grid"><div class="field-card"><label for="recordDate">紀錄日期</label><input id="recordDate" type="date" value="${dateToday()}"></div>
      <div class="field-card"><label for="jpyRate">日圓匯率（JPY→TWD）</label><input id="jpyRate" inputmode="decimal" type="number" min="0" step="0.001" value="${Number(snapshot?.jpyRate || .21).toFixed(3)}"></div></div>
      <div class="info-box">目前欄位已帶入上次餘額。只要改變有異動的帳戶，再儲存即可；舊日期紀錄不會被改變。</div>
      <section class="stack">${grouped}</section>
      <div class="button-grid"><button class="primary-btn" id="saveSnapshot">${icon("save")}儲存本次紀錄</button></div></main>${nav("update")}`;
    bindCommon();
    bindMoneyInputs();
    $("#jpyRate").addEventListener("input", () => { updateConversions(); markRateChanged(); });
    $("#saveSnapshot").addEventListener("click", () => saveSnapshot(filterCategory));
  }

  function bindMoneyInputs() {
    document.querySelectorAll("[data-account-input]").forEach(input => {
      input.addEventListener("focus", () => { input.value = input.value.replace(/,/g, ""); input.select(); });
      input.addEventListener("blur", () => { const value = parseMoney(input.value); input.value = Math.round(value).toLocaleString("en-US"); updateConversions(); });
      input.addEventListener("input", () => { updateConversions(); markInputChanged(input); });
    });
  }

  function markInputChanged(input) {
    const changed = parseMoney(input.value) !== Number(input.dataset.originalValue || 0);
    input.closest("[data-account-card]")?.classList.toggle("is-changed", changed);
  }

  function markRateChanged() {
    const rate = $("#jpyRate");
    if (!rate) return;
    rate.closest(".field-card")?.classList.toggle("is-changed", Math.abs(Number(rate.value) - Number(rate.defaultValue)) > .0000001);
  }

  function parseMoney(value) {
    const number = Number(String(value || "0").replace(/,/g, "").trim());
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function updateConversions() {
    const rate = Number($("#jpyRate")?.value || 0);
    document.querySelectorAll('[data-currency="JPY"]').forEach(input => {
      const target = document.querySelector(`[data-converted="${input.dataset.accountInput}"]`);
      if (target) target.textContent = "約 " + formatTwd(parseMoney(input.value) * rate);
    });
  }

  async function saveSnapshot(filterCategory) {
    const date = $("#recordDate").value;
    const rate = Number($("#jpyRate").value);
    if (!date) return showToast("請選擇紀錄日期");
    if (!Number.isFinite(rate) || rate <= 0) return showToast("請輸入正確的日圓匯率");
    const existing = data.snapshots.find(item => item.date === date);
    if (existing && !confirm(`${formatDate(date)}已有紀錄，要以目前輸入覆蓋嗎？`)) return;
    const baseValues = { ...(existing?.values || latestSnapshot()?.values || {}) };
    document.querySelectorAll("[data-account-input]").forEach(input => { baseValues[input.dataset.accountInput] = parseMoney(input.value); });
    const snapshot = { id: existing?.id || `snapshot-${date}-${Date.now()}`, date, jpyRate: rate, createdAt: new Date().toISOString(), values: baseValues };
    if (existing) data.snapshots[data.snapshots.indexOf(existing)] = snapshot; else data.snapshots.push(snapshot);
    data.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    await persist();
    showToast("資產紀錄已保存");
    const nextRoute = filterCategory ? `category:${filterCategory}` : "overview";
    if (data.settings.backupAfterSave) openPostSaveBackupSheet(nextRoute);
    else setTimeout(() => go(nextRoute), 250);
  }

  function renderHistory() {
    const snapshots = [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const latest = snapshots[snapshots.length - 1];
    const first = snapshots[0];
    const changeAmount = latest && first ? grandTotal(latest) - grandTotal(first) : 0;
    const change = latest && first && grandTotal(first) ? changeAmount / grandTotal(first) * 100 : 0;
    const changeSign = changeAmount > 0 ? "+" : changeAmount < 0 ? "−" : "";
    const changeAmountText = Math.abs(Math.round(changeAmount)).toLocaleString("zh-TW");
    const changePercentText = `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change).toFixed(1)}%`;
    app.innerHTML = `${topbar("資產趨勢", snapshots.length ? `共 ${snapshots.length} 筆歷史紀錄` : "尚無歷史紀錄", false)}
      <main>${snapshots.length ? `<section class="chart-panel"><div class="chart-title">總資產變化</div><div class="chart-big privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatTwd(grandTotal(latest))}</div>${historyChart(snapshots)}
      <div class="delta privacy-value ${privacyHidden ? "is-hidden" : ""} ${changeAmount >= 0 ? "positive" : "negative"}">自第一筆紀錄 ${changeSign}${changeAmountText}（${changePercentText}）</div></section>
      <div class="section-head"><h2>每次紀錄</h2><span class="section-note">最新在前</span></div>
      <section class="settings-group history-list">${[...snapshots].reverse().map(snapshot => `<div class="history-row"><div><div class="history-date">${formatDate(snapshot.date)}</div><div class="history-rate privacy-value ${privacyHidden ? "is-hidden" : ""}">日圓匯率 ${Number(snapshot.jpyRate).toFixed(3)}</div></div><div class="history-total privacy-value ${privacyHidden ? "is-hidden" : ""}">${formatTwd(grandTotal(snapshot))}</div></div>`).join("")}</section>` : '<div class="empty"><strong>還沒有歷史紀錄</strong>完成第一次更新後，這裡會出現資產趨勢。</div>'}</main>${nav("history")}`;
    bindCommon();
  }

  function historyChart(snapshots) {
    const width = 600, height = 250, left = 45, right = 14, top = 18, bottom = 42;
    const values = snapshots.map(grandTotal);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min *= .96; max *= 1.04; if (min === max) { min = 0; max = 1; } }
    const x = i => snapshots.length === 1 ? width / 2 : left + i * (width - left - right) / (snapshots.length - 1);
    const y = value => top + (max - value) * (height - top - bottom) / (max - min);
    const path = snapshots.map((snapshot, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`).join(" ");
    const grid = [0, .5, 1].map(f => {
      const gy = top + f * (height - top - bottom);
      const label = ((max - f * (max - min)) / 1000000).toFixed(1) + "M";
      return `<line x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}" stroke="var(--line)"/><text x="0" y="${gy+4}" fill="var(--muted)" font-size="12">${label}</text>`;
    }).join("");
    const points = snapshots.map((snapshot, i) => `<circle cx="${x(i)}" cy="${y(values[i])}" r="5" fill="var(--surface)" stroke="var(--teal)" stroke-width="3"><title>${formatDate(snapshot.date)} ${formatTwd(values[i])}</title></circle>`).join("");
    const labels = snapshots.length <= 6 ? snapshots.map((snapshot, i) => `<text x="${x(i)}" y="${height-10}" text-anchor="middle" fill="var(--muted)" font-size="12">${Number(snapshot.date.slice(5,7))}月</text>`).join("") : `<text x="${left}" y="${height-10}" fill="var(--muted)" font-size="12">${snapshots[0].date.slice(0,7)}</text><text x="${width-right}" y="${height-10}" text-anchor="end" fill="var(--muted)" font-size="12">${snapshots.at(-1).date.slice(0,7)}</text>`;
    return `<svg class="privacy-chart ${privacyHidden ? "is-hidden" : ""}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${privacyHidden ? "資產趨勢已隱藏" : "總資產隨日期變化折線圖"}"><title>${privacyHidden ? "資產趨勢已隱藏" : "資產趨勢"}</title>${grid}<path d="${path}" fill="none" stroke="var(--teal)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${points}${labels}</svg>`;
  }

  function sortedSalaries() {
    return [...data.salaries].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
  }

  function salaryPeriodLabel(effectiveMonth) {
    const [year, month] = String(effectiveMonth || "").split("-").map(Number);
    if (!year) return "未命名期間";
    return month === 1 ? `${year}年` : `${year}年${month}月後`;
  }

  function salaryMoney(value, currency) {
    return `${currency === "JPY" ? "¥" : "NT$"}${Math.round(Number(value || 0)).toLocaleString("zh-TW")}`;
  }

  function salaryCombinedTwd(record, rate = record?.jpyRate) {
    return Number(record?.taiwanGross || 0) + Number(record?.japanGross || 0) * Number(rate || 0);
  }

  function salaryCombinedJpy(record, rate = record?.jpyRate) {
    return Number(record?.japanGross || 0) + Number(record?.taiwanGross || 0) / Number(rate || 1);
  }

  function renderSalary(selectedId) {
    const records = sortedSalaries();
    const selected = records.find(item => item.id === selectedId) || records.at(-1);
    if (!selected) {
      app.innerHTML = `${topbar("我的薪資", "用時間感受收入，也記錄每年的成長", false)}
        <main><div class="empty salary-empty"><strong>還沒有薪資紀錄</strong>新增第一筆年度薪資後，這裡會自動計算台灣與日本的稅後時薪。</div>
        <div class="button-grid"><button class="primary-btn" id="addSalary">${icon("plus")}新增年度薪資</button></div></main>${nav("salary")}`;
      bindCommon();
      $("#addSalary").addEventListener("click", () => openSalarySheet());
      return;
    }

    const currentIndex = records.findIndex(item => item.id === selected.id);
    const previous = currentIndex > 0 ? records[currentIndex - 1] : null;
    const workDays = Number(selected.workDays || 22);
    const hoursPerDay = Number(selected.hoursPerDay || 8);
    const twDay = Number(selected.taiwanNet || 0) / workDays;
    const jpDay = Number(selected.japanNet || 0) / workDays;
    const twHour = twDay / hoursPerDay;
    const jpHour = jpDay / hoursPerDay;
    const twDeduction = Number(selected.taiwanGross) - Number(selected.taiwanNet);
    const jpDeduction = Number(selected.japanGross) - Number(selected.japanNet);
    const twRatio = Number(selected.taiwanGross) ? Number(selected.taiwanNet) / Number(selected.taiwanGross) * 100 : 0;
    const jpRatio = Number(selected.japanGross) ? Number(selected.japanNet) / Number(selected.japanGross) * 100 : 0;
    const totalTwd = salaryCombinedTwd(selected);
    const totalJpy = salaryCombinedJpy(selected);
    const previousAtCurrentRate = previous ? salaryCombinedTwd(previous, selected.jpyRate) : null;
    const growthAmount = previousAtCurrentRate == null ? null : totalTwd - previousAtCurrentRate;
    const growthPercent = previousAtCurrentRate ? growthAmount / previousAtCurrentRate * 100 : null;
    const hidden = privacyHidden ? "is-hidden" : "";
    const growthText = growthPercent == null ? "第一筆薪資紀錄" : `${growthAmount >= 0 ? "+" : "−"}${Math.abs(growthPercent).toFixed(2)}%`;

    const detailCard = (region, tone, gross, net, deduction, ratio) => `<section class="salary-detail ${tone}">
      <div class="salary-detail-head"><span class="salary-region-badge">${region === "台灣" ? "台" : "日"}</span><div><h3>${region}薪資</h3><p>實領比例 <span class="privacy-value ${hidden}">${ratio.toFixed(1)}%</span></p></div></div>
      <div class="salary-detail-grid">
        <div><span>稅前月薪</span><strong class="privacy-value ${hidden}">${salaryMoney(gross, region === "台灣" ? "TWD" : "JPY")}</strong></div>
        <div><span>稅後實領</span><strong class="positive privacy-value ${hidden}">${salaryMoney(net, region === "台灣" ? "TWD" : "JPY")}</strong></div>
        <div><span>扣除金額</span><strong class="negative privacy-value ${hidden}">${salaryMoney(deduction, region === "台灣" ? "TWD" : "JPY")}</strong></div>
      </div></section>`;

    app.innerHTML = `${topbar("我的薪資", "用時間感受收入，也記錄每年的成長", false)}
      <main>
        <div class="salary-toolbar"><label for="salaryPeriodSelect">顯示期間</label><select id="salaryPeriodSelect">${[...records].reverse().map(record => `<option value="${record.id}" ${record.id === selected.id ? "selected" : ""}>${salaryPeriodLabel(record.effectiveMonth)}</option>`).join("")}</select></div>
        <section class="salary-hourly-hero">
          <div class="salary-hero-label">現在的時間價值</div><div class="salary-hero-note">依每月 ${workDays} 天、每日 ${hoursPerDay} 小時計算</div>
          <div class="salary-hourly-grid"><div><span class="salary-region-badge">台</span><h3>台灣・稅後時薪</h3><strong class="privacy-value ${hidden}">${salaryMoney(twHour, "TWD")}</strong><small class="privacy-value ${hidden}">一天約 ${salaryMoney(twDay, "TWD")}</small></div>
          <div><span class="salary-region-badge japan">日</span><h3>日本・稅後時薪</h3><strong class="privacy-value ${hidden}">${salaryMoney(jpHour, "JPY")}</strong><small class="privacy-value ${hidden}">一天約 ${salaryMoney(jpDay, "JPY")}</small></div></div>
        </section>
        <div class="section-head"><h2>兩地稅前總薪資</h2><span class="section-note privacy-value ${hidden}">1 JPY＝NT$${Number(selected.jpyRate).toFixed(4)}</span></div>
        <section class="salary-total-card"><div><span>換算成台幣</span><strong class="privacy-value ${hidden}">${salaryMoney(totalTwd, "TWD")}</strong><small class="${growthAmount == null || growthAmount >= 0 ? "positive" : "negative"} privacy-value ${hidden}">${growthText}</small></div><div><span>換算成日幣</span><strong class="privacy-value ${hidden}">${salaryMoney(totalJpy, "JPY")}</strong>${growthAmount != null ? `<small class="${growthAmount >= 0 ? "positive" : "negative"} privacy-value ${hidden}">${growthAmount >= 0 ? "增加" : "減少"} ${salaryMoney(Math.abs(totalJpy - salaryCombinedJpy(previous, selected.jpyRate)), "JPY")}</small>` : ""}</div></section>
        <div class="section-head"><h2>各地薪資明細</h2><span class="section-note">月薪</span></div>
        <div class="salary-details">${detailCard("台灣", "taiwan", selected.taiwanGross, selected.taiwanNet, twDeduction, twRatio)}${detailCard("日本", "japan", selected.japanGross, selected.japanNet, jpDeduction, jpRatio)}</div>
        <div class="button-grid two"><button class="secondary-btn" id="editSalary">${icon("edit")}修改這筆</button><button class="primary-btn" id="addSalary">${icon("plus")}新增年度薪資</button></div>
      </main>${nav("salary")}`;
    bindCommon();
    $("#salaryPeriodSelect").addEventListener("change", event => go(`salary:${event.target.value}`));
    $("#editSalary").addEventListener("click", () => openSalarySheet(selected.id));
    $("#addSalary").addEventListener("click", () => openSalarySheet());
  }

  function openSalarySheet(recordId) {
    const record = data.salaries.find(item => item.id === recordId);
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    const field = (id, label, value, options = "") => `<div class="field-card"><label for="${id}">${label}</label><input id="${id}" ${options} value="${escapeHTML(value ?? "")}"></div>`;
    wrap.innerHTML = `<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="salarySheetTitle"><div class="sheet-handle"></div><h2 id="salarySheetTitle">${record ? "修改薪資紀錄" : "新增年度薪資"}</h2>
      <div class="info-box">台灣與日本薪資分開計稅。輸入稅前、稅後及換算匯率後，扣除金額、實領比例、日薪與時薪會自動計算。</div>
      <div class="form-grid salary-form">${field("salaryMonth", "適用起始月份", record?.effectiveMonth || `${new Date().getFullYear()}-01`, 'type="month"')}${field("salaryRate", "日圓匯率（JPY→TWD）", record?.jpyRate || "0.205", 'type="number" inputmode="decimal" min="0" step="0.0001"')}
      ${field("salaryWorkDays", "每月工作天數", record?.workDays || 22, 'type="number" inputmode="numeric" min="1" step="1"')}${field("salaryHours", "每日工時", record?.hoursPerDay || 8, 'type="number" inputmode="decimal" min="1" step="0.5"')}</div>
      <div class="category-divider">台灣月薪（TWD）</div><div class="form-grid salary-form">${field("salaryTwGross", "稅前月薪", record?.taiwanGross || "", 'type="number" inputmode="numeric" min="0" step="1"')}${field("salaryTwNet", "稅後／實領", record?.taiwanNet || "", 'type="number" inputmode="numeric" min="0" step="1"')}</div>
      <div class="category-divider">日本月薪（JPY）</div><div class="form-grid salary-form">${field("salaryJpGross", "稅前月薪", record?.japanGross || "", 'type="number" inputmode="numeric" min="0" step="1"')}${field("salaryJpNet", "稅後／實領", record?.japanNet || "", 'type="number" inputmode="numeric" min="0" step="1"')}</div>
      <div class="sheet-actions"><button class="primary-btn" id="saveSalary">儲存薪資紀錄</button>${record ? '<button class="danger-btn" id="deleteSalary">刪除這筆紀錄</button>' : ""}<button class="secondary-btn" id="closeSalarySheet">取消</button></div></section>`;
    document.body.appendChild(wrap);
    $("#closeSalarySheet").addEventListener("click", () => wrap.remove());
    wrap.addEventListener("click", event => { if (event.target === wrap) wrap.remove(); });
    $("#saveSalary").addEventListener("click", async () => {
      const effectiveMonth = $("#salaryMonth").value;
      const values = {
        jpyRate: Number($("#salaryRate").value), workDays: Number($("#salaryWorkDays").value), hoursPerDay: Number($("#salaryHours").value),
        taiwanGross: Number($("#salaryTwGross").value), taiwanNet: Number($("#salaryTwNet").value), japanGross: Number($("#salaryJpGross").value), japanNet: Number($("#salaryJpNet").value)
      };
      if (!effectiveMonth) return showToast("請選擇適用月份");
      if (!values.jpyRate || !values.workDays || !values.hoursPerDay) return showToast("請輸入正確的匯率、工作天數及工時");
      if (![values.taiwanGross, values.taiwanNet, values.japanGross, values.japanNet].every(value => Number.isFinite(value) && value >= 0)) return showToast("請輸入正確的薪資金額");
      if (values.taiwanNet > values.taiwanGross || values.japanNet > values.japanGross) return showToast("稅後實領不可高於稅前月薪");
      const samePeriod = data.salaries.find(item => item.effectiveMonth === effectiveMonth && item.id !== recordId);
      if (samePeriod && !confirm(`${salaryPeriodLabel(effectiveMonth)}已有紀錄，要以這次輸入取代嗎？`)) return;
      const target = record || samePeriod || { id: `salary-${Date.now()}`, createdAt: new Date().toISOString() };
      Object.assign(target, values, { effectiveMonth, updatedAt: new Date().toISOString() });
      if (!record && !samePeriod) data.salaries.push(target);
      await persist(); wrap.remove(); showToast("薪資紀錄已儲存");
      const nextRoute = `salary:${target.id}`;
      if (data.settings.backupAfterSave) openPostSaveBackupSheet(nextRoute); else go(nextRoute);
    });
    if (record) $("#deleteSalary").addEventListener("click", async () => {
      if (!confirm(`確定刪除「${salaryPeriodLabel(record.effectiveMonth)}」薪資紀錄嗎？`)) return;
      data.salaries = data.salaries.filter(item => item.id !== record.id); await persist(); wrap.remove(); go("salary"); showToast("薪資紀錄已刪除");
    });
  }

  function renderSettings() {
    const backupText = data.settings.lastBackupAt ? new Date(data.settings.lastBackupAt).toLocaleString("zh-TW") : "尚未備份";
    app.innerHTML = `${topbar("設定與備份", "資料只保存在此裝置，請定期備份", false)}
      <main><div class="section-head"><h2>安全性</h2></div>
      <section class="settings-group">
        <button class="settings-action" id="changePassword"><span><strong>變更開啟密碼</strong><small>會以新密碼重新加密手機內資料</small></span><span class="chev">›</span></button>
        <button class="settings-action" id="lockNow"><span><strong>立即鎖定</strong><small>下次查看需重新輸入密碼</small></span>${icon("eyeoff")}</button>
      </section>
      <div class="section-head"><h2>資產項目</h2><span class="section-note">${activeAccounts().length} 個</span></div>
      <section class="settings-group">${activeAccounts().map(account => `<div class="account-manage-row"><div><strong>${escapeHTML(account.name)}</strong><small>${categories[account.category]?.name || account.category} · ${account.currency}</small></div><button class="mini-btn" data-edit-account="${account.id}">編輯</button></div>`).join("")}</section>
      <div class="button-grid"><button class="secondary-btn" id="addAccount">${icon("plus")}新增資產項目</button></div>
      <div class="section-head"><h2>備份與匯出</h2><span class="section-note">${backupText}</span></div>
      <section class="settings-group">
        <button class="settings-action" id="backupJson"><span><strong>加密完整備份</strong><small>使用目前密碼加密，可保存到雲端</small></span>${icon("download")}</button>
        <button class="settings-action" id="restoreJson"><span><strong>從備份還原</strong><small>支援加密備份及舊版 JSON</small></span>${icon("upload")}</button>
        <button class="settings-action" id="toggleAutoBackup"><span><strong>更新後詢問備份</strong><small>${data.settings.backupAfterSave ? "目前已開啟" : "目前已關閉"}</small></span><span class="currency-pill">${data.settings.backupAfterSave ? "開" : "關"}</span></button>
        <button class="settings-action" id="exportExcel"><span><strong>匯出 Excel</strong><small>方便分析，但 Excel 檔本身沒有加密</small></span>${icon("download")}</button>
      </section>
      <div class="warning-box">移除 App、清除 Safari 網站資料或更換手機，都可能讓本機紀錄消失。建議每次更新後保存一份加密備份到 iCloud Drive、Google Drive 或 Dropbox。</div>
      <div class="section-head"><h2>資料管理</h2></div><section class="settings-group"><button class="settings-action danger" id="resetData"><span><strong>清除所有資料</strong><small>帳戶與歷史紀錄都會移除</small></span>${icon("trash")}</button></section>
      </main>${nav("settings")}`;
    bindCommon();
    $("#changePassword").addEventListener("click", openChangePasswordSheet);
    $("#lockNow").addEventListener("click", lockApp);
    $("#addAccount").addEventListener("click", () => openAccountSheet());
    document.querySelectorAll("[data-edit-account]").forEach(button => button.addEventListener("click", () => openAccountSheet(button.dataset.editAccount)));
    $("#backupJson").addEventListener("click", backupJSON);
    $("#restoreJson").addEventListener("click", () => { backgroundLockEnabled = false; $("#restoreFile").click(); });
    $("#toggleAutoBackup").addEventListener("click", async () => { data.settings.backupAfterSave = !data.settings.backupAfterSave; await persist(); renderSettings(); showToast(data.settings.backupAfterSave ? "已開啟更新後備份提醒" : "已關閉更新後備份提醒"); });
    $("#exportExcel").addEventListener("click", exportExcel);
    $("#resetData").addEventListener("click", resetData);
  }

  function openAccountSheet(accountId) {
    const account = data.accounts.find(item => item.id === accountId);
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle"><div class="sheet-handle"></div><h2 id="sheetTitle">${account ? "編輯資產項目" : "新增資產項目"}</h2>
      <div class="stack"><div class="field-card"><label for="accountName">名稱</label><input id="accountName" value="${escapeHTML(account?.name || "")}" placeholder="例如：郵局存款"></div>
      <div class="field-card"><label for="accountCategory">分類</label><select id="accountCategory">${Object.entries(categories).map(([key, category]) => `<option value="${key}" ${account?.category === key ? "selected" : ""}>${category.name}</option>`).join("")}</select></div>
      <div class="field-card"><label for="accountCurrency">原始幣別</label><select id="accountCurrency"><option value="TWD" ${account?.currency === "TWD" ? "selected" : ""}>台幣 TWD</option><option value="JPY" ${account?.currency === "JPY" ? "selected" : ""}>日圓 JPY</option></select></div></div>
      <div class="sheet-actions"><button class="primary-btn" id="saveAccount">儲存</button>${account ? '<button class="danger-btn" id="removeAccount">停用此項目</button>' : ""}<button class="secondary-btn" id="closeSheet">取消</button></div></section>`;
    document.body.appendChild(wrap);
    $("#closeSheet").addEventListener("click", () => wrap.remove());
    wrap.addEventListener("click", event => { if (event.target === wrap) wrap.remove(); });
    $("#saveAccount").addEventListener("click", async () => {
      const name = $("#accountName").value.trim();
      if (!name) return showToast("請輸入名稱");
      if (account) { account.name = name; account.category = $("#accountCategory").value; account.currency = $("#accountCurrency").value; }
      else data.accounts.push({ id: `account-${Date.now()}`, name, category: $("#accountCategory").value, currency: $("#accountCurrency").value, active: true });
      await persist(); wrap.remove(); renderSettings(); showToast("資產項目已儲存");
    });
    if (account) $("#removeAccount").addEventListener("click", async () => {
      if (!confirm(`確定停用「${account.name}」嗎？過去紀錄仍會保留在備份及 Excel 中。`)) return;
      account.active = false; await persist(); wrap.remove(); renderSettings(); showToast("項目已停用");
    });
    setTimeout(() => $("#accountName")?.focus(), 80);
  }

  function openChangePasswordSheet() {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="passwordSheetTitle"><div class="sheet-handle"></div><h2 id="passwordSheetTitle">變更開啟密碼</h2>
      <div class="warning-box">變更後，舊的加密備份仍需使用舊密碼才能還原。建議變更完成後立即建立一份新備份。</div>
      <div class="stack"><div class="field-card"><label for="newVaultPassword">新密碼</label><input id="newVaultPassword" type="password" autocomplete="new-password" placeholder="至少 6 個字元"></div>
      <div class="field-card"><label for="newVaultPasswordAgain">再次輸入</label><input id="newVaultPasswordAgain" type="password" autocomplete="new-password" placeholder="再次輸入相同密碼"></div></div>
      <div id="passwordSheetError" class="auth-error" role="alert"></div>
      <div class="sheet-actions"><button class="primary-btn" id="saveNewPassword">變更密碼</button><button class="secondary-btn" id="cancelNewPassword">取消</button></div></section>`;
    document.body.appendChild(wrap);
    $("#cancelNewPassword").addEventListener("click", () => wrap.remove());
    wrap.addEventListener("click", event => { if (event.target === wrap) wrap.remove(); });
    $("#saveNewPassword").addEventListener("click", async () => {
      const password = $("#newVaultPassword").value;
      const again = $("#newVaultPasswordAgain").value;
      const error = $("#passwordSheetError");
      error.textContent = "";
      if (password.length < 6) { error.textContent = "密碼至少需要 6 個字元。"; return; }
      if (password !== again) { error.textContent = "兩次輸入的密碼不相同。"; return; }
      $("#saveNewPassword").disabled = true;
      $("#saveNewPassword").textContent = "正在重新加密…";
      try {
        vaultSalt = crypto.getRandomValues(new Uint8Array(16));
        vaultCryptoKey = await deriveVaultKey(password, vaultSalt);
        await persist();
        wrap.remove();
        showToast("密碼已變更，建議立即建立新備份");
      } catch (cause) {
        error.textContent = "無法變更密碼，請重新嘗試。";
        $("#saveNewPassword").disabled = false;
        $("#saveNewPassword").textContent = "變更密碼";
      }
    });
    setTimeout(() => $("#newVaultPassword")?.focus(), 80);
  }

  function openPostSaveBackupSheet(nextRoute) {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `<section class="sheet" role="dialog" aria-modal="true" aria-labelledby="backupSheetTitle"><div class="sheet-handle"></div><h2 id="backupSheetTitle">本次紀錄已保存</h2>
      <div class="info-box">是否現在建立一份加密備份？在 iPhone 的分享選單中選擇「儲存到檔案」，即可放入 iCloud Drive、Google Drive 或 Dropbox。</div>
      <div class="sheet-actions"><button class="primary-btn" id="backupAfterSaveNow">${icon("download")}立即備份</button><button class="secondary-btn" id="backupAfterSaveLater">稍後再說</button></div></section>`;
    document.body.appendChild(wrap);
    $("#backupAfterSaveNow").addEventListener("click", async () => {
      $("#backupAfterSaveNow").disabled = true;
      $("#backupAfterSaveNow").textContent = "正在準備加密備份…";
      await backupJSON({ keepView: true });
      wrap.remove();
      go(nextRoute);
    });
    $("#backupAfterSaveLater").addEventListener("click", () => { wrap.remove(); go(nextRoute); });
  }

  function makeFile(content, type, name) { return new File([content], name, { type }); }

  async function shareOrDownload(file, title) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        backgroundLockEnabled = false;
        await navigator.share({ files: [file], title });
        return true;
      } catch (error) {
        if (error.name === "AbortError") return false;
      } finally {
        backgroundLockEnabled = true;
        backgroundedAt = 0;
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a"); link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000); return true;
  }

  async function backupJSON(options = {}) {
    await persist();
    const vault = await dbGet(VAULT_KEY);
    const stamp = dateToday().replaceAll("-", "");
    const backup = { format: "aska-asset-tracker-encrypted-backup", version: 2, vault };
    const file = makeFile(JSON.stringify(backup, null, 2), "application/json", `我的資產_加密備份_${stamp}.json`);
    if (await shareOrDownload(file, "我的資產加密備份")) {
      data.settings.lastBackupAt = new Date().toISOString();
      await persist();
      if (!options.keepView && location.hash.slice(1) === "settings") renderSettings();
      showToast("請選擇「儲存到檔案」，再選雲端資料夾");
      return true;
    }
    return false;
  }

  function validateBackup(value) {
    return value && Array.isArray(value.accounts) && Array.isArray(value.snapshots) && value.snapshots.every(item => item.date && item.values && Number.isFinite(Number(item.jpyRate)));
  }

  async function restoreFromFile(file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.format === "aska-asset-tracker-encrypted-backup" && parsed.vault) {
        const password = prompt("請輸入建立這份備份時使用的密碼：");
        if (password == null) return;
        const restored = await decryptVault(parsed.vault, password);
        const restoredData = normalizeData(restored.data);
        if (!confirm(`加密備份中有 ${restoredData.snapshots.length} 筆紀錄。還原後會取代目前資料，確定繼續嗎？`)) return;
        data = restoredData;
        vaultCryptoKey = restored.key;
        vaultSalt = restored.salt;
      } else {
        if (!validateBackup(parsed)) throw new Error("格式不正確");
        if (!confirm(`舊版備份中有 ${parsed.snapshots.length} 筆紀錄。還原後會取代目前資料，確定繼續嗎？`)) return;
        data = normalizeData(parsed);
      }
      await persist(); go("overview"); showToast("備份已成功還原");
    } catch (error) { showToast("無法還原：檔案損壞或密碼不正確"); }
    $("#restoreFile").value = "";
  }

  async function exportExcel() {
    if (!window.XLSX) return showToast("Excel 匯出元件未載入");
    const sorted = [...data.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    const overview = sorted.map(snapshot => ({
      日期: snapshot.date,
      日圓匯率: snapshot.jpyRate,
      台灣資產_TWD: Math.round(categoryTotal("taiwan", snapshot)),
      日本資產_TWD: Math.round(categoryTotal("japan", snapshot)),
      退休資產_TWD: Math.round(categoryTotal("retirement", snapshot)),
      家庭暫存外幣_TWD: Math.round(categoryTotal("family", snapshot)),
      總資產_TWD: Math.round(grandTotal(snapshot))
    }));
    const details = [];
    sorted.forEach(snapshot => data.accounts.forEach(account => details.push({
      日期: snapshot.date, 分類: categories[account.category]?.name || account.category, 資產項目: account.name,
      原始幣別: account.currency, 原始金額: Number(snapshot.values?.[account.id] || 0), 日圓匯率: snapshot.jpyRate,
      換算台幣: Math.round(accountTwd(account, snapshot)), 狀態: account.active === false ? "已停用" : "使用中"
    })));
    const salaryRows = sortedSalaries().map(record => {
      const days = Number(record.workDays || 22), hours = Number(record.hoursPerDay || 8);
      return {
        適用期間: salaryPeriodLabel(record.effectiveMonth), 起始月份: record.effectiveMonth, 日圓匯率: record.jpyRate,
        台灣稅前月薪_TWD: record.taiwanGross, 台灣稅後月薪_TWD: record.taiwanNet,
        台灣扣除金額_TWD: record.taiwanGross - record.taiwanNet, 台灣實領比例: record.taiwanGross ? record.taiwanNet / record.taiwanGross : 0,
        台灣稅後日薪_TWD: record.taiwanNet / days, 台灣稅後時薪_TWD: record.taiwanNet / days / hours,
        日本稅前月薪_JPY: record.japanGross, 日本稅後月薪_JPY: record.japanNet,
        日本扣除金額_JPY: record.japanGross - record.japanNet, 日本實領比例: record.japanGross ? record.japanNet / record.japanGross : 0,
        日本稅後日薪_JPY: record.japanNet / days, 日本稅後時薪_JPY: record.japanNet / days / hours,
        兩地稅前合計_TWD: salaryCombinedTwd(record), 兩地稅前合計_JPY: salaryCombinedJpy(record), 每月工作天數: days, 每日工時: hours
      };
    });
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(overview); const ws2 = XLSX.utils.json_to_sheet(details); const ws3 = XLSX.utils.json_to_sheet(salaryRows);
    ws1["!cols"] = [{wch:12},{wch:11},{wch:17},{wch:17},{wch:17},{wch:22},{wch:17}];
    ws2["!cols"] = [{wch:12},{wch:18},{wch:24},{wch:12},{wch:15},{wch:11},{wch:15},{wch:10}];
    ws3["!cols"] = Array.from({ length: 19 }, (_, index) => ({ wch: index < 3 ? 15 : 21 }));
    XLSX.utils.book_append_sheet(wb, ws1, "資產總覽"); XLSX.utils.book_append_sheet(wb, ws2, "帳戶明細"); XLSX.utils.book_append_sheet(wb, ws3, "薪資紀錄");
    const array = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const file = makeFile(array, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `我的資產_${dateToday().replaceAll("-", "")}.xlsx`);
    if (await shareOrDownload(file, "我的資產 Excel")) showToast("Excel 已產生");
  }

  async function resetData() {
    if (!confirm("這會清除所有帳戶、資產歷史與薪資紀錄，確定繼續嗎？")) return;
    if (!confirm("請再次確認：尚未備份的資料將無法恢復。")) return;
    data = seedData(); await persist(); go("overview"); showToast("所有資料已清除");
  }

  function bindCommon() {
    document.querySelectorAll("[data-route]").forEach(button => button.addEventListener("click", () => go(button.dataset.route)));
    document.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click", () => go(`category:${button.dataset.category}`)));
    document.querySelectorAll("[data-update-category]").forEach(button => button.addEventListener("click", () => go(`update:${button.dataset.updateCategory}`)));
    document.querySelectorAll("[data-back]").forEach(button => button.addEventListener("click", () => history.length > 1 ? history.back() : go("overview")));
    document.querySelectorAll("[data-privacy]").forEach(button => button.addEventListener("click", togglePrivacy));
  }

  function togglePrivacy() {
    const draftInputs = [...document.querySelectorAll("[data-account-input]")].map(input => ({
      id: input.dataset.accountInput,
      value: input.value,
      changed: input.closest("[data-account-card]")?.classList.contains("is-changed")
    }));
    const draftDate = $("#recordDate")?.value;
    const draftRate = $("#jpyRate")?.value;
    const rateChanged = $("#jpyRate")?.closest(".field-card")?.classList.contains("is-changed");
    privacyHidden = !privacyHidden;
    render();
    if (!draftInputs.length) return;
    if ($("#recordDate")) $("#recordDate").value = draftDate;
    if ($("#jpyRate")) $("#jpyRate").value = draftRate;
    draftInputs.forEach(draft => {
      const input = document.querySelector(`[data-account-input="${draft.id}"]`);
      if (!input) return;
      input.value = draft.value;
      input.closest("[data-account-card]")?.classList.toggle("is-changed", draft.changed);
    });
    $("#jpyRate")?.closest(".field-card")?.classList.toggle("is-changed", rateChanged);
    updateConversions();
  }

  function go(route) { location.hash = route; if (location.hash.slice(1) === route) render(); }

  function render() {
    if (!data || !vaultCryptoKey) return;
    window.scrollTo({ top: 0, behavior: "instant" });
    const route = location.hash.slice(1) || "overview";
    const [page, param] = route.split(":");
    if (page === "overview") renderOverview();
    else if (page === "category") renderCategory(param);
    else if (page === "update") renderUpdate(param);
    else if (page === "salary") renderSalary(param);
    else if (page === "history") renderHistory();
    else if (page === "settings") renderSettings();
    else go("overview");
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message; toast.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  async function init() {
    try {
      if (!crypto?.subtle) throw new Error("Web Crypto unavailable");
      await openDB();
      window.addEventListener("hashchange", render);
      document.getElementById("restoreFile").addEventListener("change", event => {
        backgroundLockEnabled = true;
        backgroundedAt = 0;
        if (event.target.files[0]) restoreFromFile(event.target.files[0]);
      });
      document.addEventListener("visibilitychange", () => {
        if (!backgroundLockEnabled) { backgroundedAt = 0; return; }
        if (document.hidden) backgroundedAt = Date.now();
        else if (vaultCryptoKey && backgroundedAt && Date.now() - backgroundedAt > 30000) lockApp();
      });
      window.addEventListener("pageshow", event => { if (event.persisted && vaultCryptoKey) lockApp(); });
      const vault = await dbGet(VAULT_KEY);
      const legacy = await dbGet(DATA_KEY);
      if (vault?.format === "aska-asset-vault") renderAuth("unlock");
      else renderAuth("create", validateBackup(legacy) ? legacy : seedData());
      if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./sw.js").catch(() => {});
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    } catch (error) {
      app.innerHTML = `<div class="empty"><strong>無法開啟資料庫</strong>請確認瀏覽器不是無痕模式，再重新開啟。</div>`;
      console.error(error);
    }
  }

  init();
})();
