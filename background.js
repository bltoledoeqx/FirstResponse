"use strict";
const ALARM_NAME   = "first-response-check";
const INTERVAL_MIN = 1;
const FAST_INTERVAL_MS = 2000;

// ── Garante alarme sempre ativo ───────────────────────────────
function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, alarm => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: INTERVAL_MIN });
      console.log("[FirstResponse] Alarme criado.");
    }
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm(); // recria se SW acordou após ser terminado

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM_NAME) return;
  runCheck();
});

setInterval(() => {
  runCheck();
}, FAST_INTERVAL_MS);

// ── Notificação ───────────────────────────────────────────────
function notify(id, title, message) {
  return new Promise(resolve => {
    chrome.notifications.create(id, {
      type:    "basic",
      iconUrl: "icons/icon48.png",
      title,
      message
    }, () => resolve());
  });
}

// ── Lógica principal ──────────────────────────────────────────
async function runCheck() {
  const lock = await chrome.storage.local.get(["fr_is_running"]);
  if (lock.fr_is_running) {
    console.log("[FirstResponse] Execução ignorada: já existe verificação em andamento.");
    return;
  }
  await chrome.storage.local.set({ fr_is_running: true });
  const tabs = await chrome.tabs.query({ url: "https://*.service-now.com/*" });
  if (!tabs.length) {
    console.log("[FirstResponse] Nenhuma aba do ServiceNow encontrada.");
    return;
  }

  const tab = tabs[0];

  try {
    // ── Passo 1: busca todos os casos da fila ──────────────────
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world:  "MAIN",
      func: async () => {
        const gck = window.g_ck || "";
        if (!gck) return { error: "Token g_ck não disponível. Recarregue o ServiceNow." };

        async function api(path, method, body) {
          const opts = {
            method: method || "GET",
            headers: {
              "Accept":       "application/json",
              "Content-Type": "application/json",
              "X-UserToken":  gck
            },
            credentials: "include"
          };
          if (body) opts.body = JSON.stringify(body);
          const res = await fetch(path, opts);
          if (!res.ok) throw new Error("HTTP " + res.status + " em " + path.split("?")[0].split("/").pop());
          return res.json();
        }

        try {
          const ud   = await api("/api/now/ui/user/current_user");
          const user = ud.result;
          if (!user?.user_sys_id) return { error: "Usuário não encontrado." };

          const cd = await api(
            "/api/now/table/sn_customerservice_case" +
            "?sysparm_query=assigned_to=" + user.user_sys_id + "^state=21" +
            "&sysparm_fields=sys_id,number,short_description,priority,account" +
            "&sysparm_display_value=false&sysparm_limit=100"
          );
          const cases = cd.result || [];

          const pending = [];

          for (const c of cases) {
            pending.push({
              sys_id: c.sys_id,
              number: c.number,
              priority: c.priority || "",
              short_description: c.short_description || "",
          account: c.account || "",
              account: c.account?.display_value || c.account || ""
            });
          }

          return {
            pending,
            userName: user.user_display_name || user.user_name || ""
          };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: []
    });

    const result = results?.[0]?.result;
    if (!result || result.error) {
      console.warn("[FirstResponse] Erro na verificação:", result?.error);
      return;
    }

    const seenData = await chrome.storage.local.get(["fr_seen_case_ids"]);
    const seenIds = new Set(seenData.fr_seen_case_ids || []);

    const newlyArrived = result.pending.filter(c => !seenIds.has(c.sys_id));

    if (newlyArrived.length) {
      for (const c of newlyArrived) {
        const prio = (c.priority || "N/A").trim() || "N/A";
        const desc = (c.short_description || "Sem descrição").trim() || "Sem descrição";
        await notify(
          "new-case-" + c.sys_id + "-" + Date.now(),
          `🆕 Entrada na fila: ${c.number}`,
          `Conta: ${(c.account || "N/A").trim() || "N/A"}
Prioridade: ${prio}
Descrição: ${desc}`
        );
      }
    }

    await chrome.storage.local.set({
      fr_seen_case_ids: result.pending.map(c => c.sys_id),
      fr_last_check: Date.now(),
      fr_last_result: {
        initialized: true,
        notified: newlyArrived.map(c => ({
          number: c.number,
          priority: c.priority || "",
          short_description: c.short_description || "",
          account: c.account || ""
        }))
      }
    });

    console.log("[FirstResponse]", new Date().toLocaleTimeString(), {
      active: result.pending.length,
      notified: newlyArrived.map(c => c.number)
    });

  } catch (err) {
    console.error("[FirstResponse] Erro geral:", err.message);
  } finally {
    await chrome.storage.local.set({ fr_is_running: false });
  }
}

// ── Mensagens do popup ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === "check_now") {
    runCheck().then(() => reply({ ok: true }));
    return true;
  }
  if (msg.action === "get_status") {
    chrome.storage.local.get(["fr_last_check", "fr_last_result"], d => reply(d));
    return true;
  }
});
