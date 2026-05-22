"use strict";

const $ = id => document.getElementById(id);

// ── DOM ──────────────────────────────────────────────────────
const stLoading    = $("st-loading");
const stLoadingMsg = $("st-loading-msg");
const stWrong      = $("st-wrong");
const stError      = $("st-error");
const summaryEl    = $("summary");
const caseListEl   = $("case-list");
const countdownEl  = $("countdown");
const userNameEl   = $("user-name");
const settingsEl   = $("settings-panel");
const inpTitle     = $("inp-title");
const inpPhone     = $("inp-phone");
const lastCheckEl  = $("last-check");

// ── State ────────────────────────────────────────────────────
let currentTab  = null;
let currentUser = null;
let userConfig  = { title: "", phone: "" };
let cases       = [];
let tickTimer   = null;
let nextCheckAt = null;
const INTERVAL_MS = 2 * 60 * 1000; // 2 minutos
let sendingInProgress = false;

// ── Utils ────────────────────────────────────────────────────
const esc = s => String(s || "")
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function isBrazil(c) {
  return FirstResponseShared.isBrazilCountry(c.u_operating_country);
}

function fmtTime(d) {
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function buildComment(c) {
  const name  = currentUser.user_display_name || currentUser.user_name || "";
  return FirstResponseShared.buildFirstResponseComment({
    countryCode: c.u_operating_country,
    userName: name,
    title: userConfig.title || FirstResponseShared.DEFAULT_TITLE,
    phone: userConfig.phone || ""
  });
}

// ── Page bridge ───────────────────────────────────────────────
async function runInPage(cfg) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: false },
    world:  "MAIN",
    func: (config) => {
      return (async () => {
        const gck = window.g_ck || "";
        async function api(path, method, body) {
          const opts = {
            method: method || "GET",
            headers: { "Accept":"application/json","Content-Type":"application/json","X-UserToken":gck },
            credentials: "include"
          };
          if (body) opts.body = JSON.stringify(body);
          const res = await fetch(path, opts);
          if (!res.ok) throw new Error("HTTP " + res.status + " " + path.split("?")[0].split("/").pop());
          return res.json();
        }

        try {
          // ── Usuário logado ──────────────────────────────────
          if (config.action === "get_user") {
            const d = await api("/api/now/ui/user/current_user");
            return d.result || null;
          }

          // ── Fila de casos ───────────────────────────────────
          if (config.action === "load_queue") {
            const cd = await api(
              "/api/now/table/sn_customerservice_case" +
              "?sysparm_query=assigned_to=" + config.userSysId + "^state=21" +
              "&sysparm_fields=sys_id,number,short_description,state,u_operating_country,priority,u_name_first_comment" +
              "&sysparm_display_value=false&sysparm_limit=100"
            );
            const cases = cd.result || [];
            if (!cases.length) return { cases: [] };

            // u_name_first_comment vazio = sem interação de analista
            const withFlags = cases.map(c => {
              const hasFirstResponse = !!(c.u_name_first_comment?.value || c.u_name_first_comment);
              return Object.assign({}, c, { hasFirstResponse });
            });
            return { cases: withFlags };
          }

          // ── Postar comentário ───────────────────────────────
          if (config.action === "post_comment") {
            await api(
              "/api/now/table/sn_customerservice_case/" + config.sysId,
              "PATCH",
              { comments: config.comment }
            );
            return { ok: true };
          }

          return { error: "unknown action" };
        } catch(e) {
          return { error: e.message };
        }
      })();
    },
    args: [cfg]
  });
  return results?.[0]?.result;
}

// ── Render ────────────────────────────────────────────────────
function renderCases() {
  const needs = cases.filter(c => !c.hasFirstResponse);
  const done  = cases.filter(c =>  c.hasFirstResponse);

  $("s-total").textContent = cases.length;
  $("s-needs").textContent = needs.length;
  $("s-done").textContent  = done.length;
  $("btn-send-all").disabled = needs.length === 0;
  summaryEl.style.display = "block";

  caseListEl.innerHTML = "";

  [...needs, ...done].forEach(c => {
    const br      = isBrazil(c);
    const langChip = br
      ? `<span class="chip chip-br">🇧🇷 PT-BR</span>`
      : `<span class="chip chip-en">🌐 EN</span>`;
    const isP1   = (c.priority || "").startsWith("1");
    const stChip = c.hasFirstResponse
      ? `<span class="chip chip-ok">✓ Respondido</span>`
      : isP1
        ? `<span class="chip" style="background:#2d1a1a;color:#f87171">🚫 P1 — ignorado</span>`
        : `<span class="chip chip-warn">⚠ Sem resposta</span>`;
    const account = c.account?.display_value || c.account || "";

    const card = document.createElement("div");
    card.className = "case-card " + (c.hasFirstResponse ? "done" : "needs");
    card.id = "card-" + c.sys_id;
    card.innerHTML = `
      <div class="case-top">
        <div class="case-info">
          <div class="case-num">${esc(c.number)}</div>
          <div class="case-desc" title="${esc(c.short_description)}">${esc(c.short_description)}</div>
          ${account ? `<div class="case-account">${esc(account)}</div>` : ""}
          <div class="case-chips">${langChip}${stChip}</div>
        </div>
        ${c.hasFirstResponse
          ? `<button class="btn-send btn-sent" disabled>✓</button>`
          : isP1
            ? `<button class="btn-send" disabled style="background:var(--subtle);color:var(--muted)" title="P1 não recebe resposta automática">P1</button>`
            : `<button class="btn-send" id="btn-${c.sys_id}">Enviar</button>`
        }
      </div>`;

    if (!c.hasFirstResponse) {
      card.querySelector("#btn-" + c.sys_id)
          .addEventListener("click", () => sendOne(c));
    }
    caseListEl.appendChild(card);
  });
}

function updateSummaryNums() {
  $("s-needs").textContent = cases.filter(c => !c.hasFirstResponse).length;
  $("s-done").textContent  = cases.filter(c =>  c.hasFirstResponse).length;
  $("btn-send-all").disabled = cases.filter(c => !c.hasFirstResponse).length === 0;
}

// ── Send ──────────────────────────────────────────────────────
async function sendOne(c) {
  const btn  = $("btn-" + c.sys_id);
  const card = $("card-" + c.sys_id);
  if (!btn || c.hasFirstResponse) return;
  if ((c.priority || "").startsWith("1")) return; // ignora P1

  btn.disabled = true;
  btn.textContent = "…";
  if (card) card.className = "case-card sending";

  const result = await runInPage({
    action:  "post_comment",
    sysId:   c.sys_id,
    comment: buildComment(c)
  });

  if (result?.ok) {
    c.hasFirstResponse = true;
    if (btn) { btn.className = "btn-send btn-sent"; btn.textContent = "✓"; }
    if (card) card.className = "case-card done";
    updateSummaryNums();
  } else {
    if (btn) { btn.disabled = false; btn.textContent = "Retry"; }
    if (card) card.className = "case-card needs";
    stError.textContent = "Erro ao enviar " + c.number + ": " + (result?.error || "desconhecido");
    stError.style.display = "block";
  }
}

async function sendAll() {
  if (sendingInProgress) return;
  sendingInProgress = true;
  const btn = $("btn-send-all");
  btn.disabled = true;
  btn.textContent = "Enviando…";
  for (const c of cases.filter(x => !x.hasFirstResponse)) {
    await sendOne(c);
  }
  btn.textContent = "Responder todos";
  sendingInProgress = false;
}

// ── Load queue ────────────────────────────────────────────────
async function loadQueue(silent = false) {
  if (!silent) {
    stLoading.style.display = "flex";
    stLoadingMsg.textContent = "Verificando fila…";
    stError.style.display = "none";
    stWrong.style.display  = "none";
  }

  const result = await runInPage({
    action:    "load_queue",
    userSysId: currentUser.user_sys_id
  });

  stLoading.style.display = "none";
  lastCheckEl.textContent = "Última verificação: " + fmtTime(new Date());

  if (!result || result.error) {
    if (!silent) {
      stError.textContent = "Erro: " + (result?.error || "falha ao buscar casos");
      stError.style.display = "block";
    }
    return;
  }

  cases = result.cases || [];

  if (!cases.length) {
    if (!silent) {
      stWrong.textContent = "Nenhum caso ativo na sua fila.";
      stWrong.style.display = "block";
    }
    summaryEl.style.display = "none";
    caseListEl.innerHTML = "";
    return;
  }

  // Auto-envia casos sem resposta silenciosamente (ciclo automático)
  if (silent) {
    const pending = cases.filter(c => !c.hasFirstResponse);
    for (const c of pending) await sendOne(c);
    updateSummaryNums();
  } else {
    renderCases();
  }
}

// ── Countdown ticker ─────────────────────────────────────────
function startCountdown() {
  if (tickTimer) clearInterval(tickTimer);
  nextCheckAt = Date.now() + INTERVAL_MS;
  countdownEl.className = "countdown ticking";

  tickTimer = setInterval(async () => {
    const remaining = nextCheckAt - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = "verificando…";
      countdownEl.className = "countdown";
      await loadQueue(true);           // silencioso — auto-envia e atualiza
      renderCases();                   // atualiza UI
      nextCheckAt = Date.now() + INTERVAL_MS;
      countdownEl.className = "countdown ticking";
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      countdownEl.textContent = m + ":" + String(s).padStart(2, "0");
    }
  }, 1000);
}

// ── Settings ──────────────────────────────────────────────────
$("btn-settings").addEventListener("click", () => {
  settingsEl.style.display = settingsEl.style.display === "block" ? "none" : "block";
});
$("btn-save").addEventListener("click", () => {
  userConfig.title = inpTitle.value.trim();
  userConfig.phone = inpPhone.value.trim();
  chrome.storage.local.set({ fr_title: userConfig.title, fr_phone: userConfig.phone });
  settingsEl.style.display = "none";
});
$("btn-send-all").addEventListener("click", sendAll);
$("btn-refresh").addEventListener("click", async () => {
  // Dispara verificação imediata no background
  if (sendingInProgress) return;
  chrome.runtime.sendMessage({ action: "check_now" });
  nextCheckAt = Date.now() + INTERVAL_MS;
  await loadQueue(false);
  renderCases();
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  // Carrega config salva
  await new Promise(resolve => {
    chrome.storage.local.get(["fr_title","fr_phone"], d => {
      userConfig.title = d.fr_title || "";
      userConfig.phone = d.fr_phone || "";
      inpTitle.value   = userConfig.title;
      inpPhone.value   = userConfig.phone;
      resolve();
    });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("service-now.com")) {
    stLoading.style.display = "none";
    stWrong.textContent = "Abra o ServiceNow para usar este plugin.";
    stWrong.style.display = "block";
    return;
  }
  currentTab = tab;

  stLoadingMsg.textContent = "Identificando usuário…";

  const user = await runInPage({ action: "get_user" });
  if (!user || user.error) {
    stLoading.style.display = "none";
    stError.textContent = "Não foi possível identificar o usuário logado.";
    stError.style.display = "block";
    return;
  }
  currentUser = user;
  userNameEl.textContent = user.user_display_name || user.user_name;

  // Mostra último resultado do background enquanto carrega
  chrome.runtime.sendMessage({ action: "get_status" }, status => {
    if (status?.fr_last_check) {
      const t = new Date(status.fr_last_check);
      lastCheckEl.textContent = "Última verificação: " + fmtTime(t);
      summaryEl.style.display = "block";
    }
  });

  await loadQueue(false);
  startCountdown();
}

init();
