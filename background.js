"use strict";

const ALARM_NAME   = "first-response-check";
const INTERVAL_MIN = 2;

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

// ── Notificação ───────────────────────────────────────────────
function notify(id, title, message) {
  chrome.notifications.create(id, {
    type:    "basic",
    iconUrl: "icons/icon48.png",
    title,
    message
  });
}

// ── Lógica principal ──────────────────────────────────────────
async function runCheck() {
  const cfg  = await chrome.storage.local.get(["fr_title", "fr_phone"]);
  const tabs = await chrome.tabs.query({ url: "https://*.service-now.com/*" });
  if (!tabs.length) {
    console.log("[FirstResponse] Nenhuma aba do ServiceNow encontrada.");
    return;
  }

  const tab = tabs[0];

  try {
    // ── Passo 1: busca casos + identifica pendentes ───────────
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
            "&sysparm_fields=sys_id,number,short_description,u_operating_country,priority,u_name_first_comment" +
            "&sysparm_display_value=false&sysparm_limit=100"
          );
          const cases = cd.result || [];

          const pending = [];
          const p1cases = [];

          for (const c of cases) {
            const hasFirst = !!(c.u_name_first_comment?.value || c.u_name_first_comment);
            if (hasFirst) continue;
            if ((c.priority || "").startsWith("1")) { p1cases.push(c.number); continue; }
            pending.push({
              sys_id:              c.sys_id,
              number:              c.number,
              u_operating_country: c.u_operating_country?.value || c.u_operating_country || ""
            });
          }

          return {
            pending,
            p1cases,
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

    if (result.p1cases?.length) {
      notify("p1-alert-" + Date.now(), "⚠️ Caso P1 sem resposta!", "Requer atenção manual: " + result.p1cases.join(", "));
    }

    if (!result.pending?.length) {
      console.log("[FirstResponse]", new Date().toLocaleTimeString(), "Nenhum caso pendente.");
      await chrome.storage.local.set({ fr_last_check: Date.now(), fr_last_result: { sent: [], p1cases: result.p1cases } });
      return;
    }

    // ── Passo 2: envia comentários — executeScript por caso ───
    const sent   = [];
    const failed = [];
    const userName = result.userName;
    const title    = cfg.fr_title || "Hosting Operations Specialist";
    const phone    = cfg.fr_phone || "";

    for (const c of result.pending) {
      const isBR = (c.u_operating_country || "").trim().toUpperCase() === "BR";

      const sig = `[code]
<div style="display: flex; align-items: center;">
<img src="https://i.postimg.cc/NFB5VZyG/equinix-logo-icon-169199-resized.png" alt="Equinix Logo" style="width: 65px; height: 65px; margin-right: 10px;">
<div style="border-left: 1px solid #000; padding-left: 10px;">
<br>${userName}<br><b>${title}</b><br>${phone ? "Contato: " + phone + "<br>" : ""}EQUINIX
</div>
</div>[/code]`;

      const comment = isBR
        ? "Estou iniciando o atendimento, favor aguardar um próximo feedback com mais informações.\nPor favor, fique à vontade para entrar em contato conosco a qualquer momento.\n\nEstamos à disposição.\n\n[code]<em>Atenciosamente,</em>[/code]\n" + sig
        : "I'm starting the service. Please wait for a follow-up feedback with more information.\n\nFeel free to contact us at any time.\n\nWe are at your disposal.\n\n[code]<em>Sincerely,</em>[/code]\n" + sig;

      try {
        const patchResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          world:  "MAIN",
          func: async (sysId, cmt) => {
            const gck = window.g_ck || "";
            if (!gck) return { ok: false, error: "sem token" };
            const res = await fetch("/api/now/table/sn_customerservice_case/" + sysId, {
              method: "PATCH",
              headers: {
                "Accept":       "application/json",
                "Content-Type": "application/json",
                "X-UserToken":  gck
              },
              credentials: "include",
              body: JSON.stringify({ comments: cmt })
            });
            return { ok: res.ok, status: res.status };
          },
          args: [c.sys_id, comment]
        });

        const pr = patchResults?.[0]?.result;
        if (pr?.ok) {
          sent.push(c.number);
          console.log("[FirstResponse] Enviado:", c.number);
        } else {
          failed.push(c.number);
          console.warn("[FirstResponse] Falha:", c.number, pr);
        }
      } catch (err) {
        failed.push(c.number);
        console.error("[FirstResponse] Erro no envio de", c.number, err.message);
      }
    }

    if (sent.length)   notify("sent-" + Date.now(), "✅ First Response enviado",  "Casos respondidos: " + sent.join(", "));
    if (failed.length) notify("fail-" + Date.now(), "❌ Falha no envio",           "Não foi possível: "  + failed.join(", "));

    await chrome.storage.local.set({
      fr_last_check:  Date.now(),
      fr_last_result: { sent, failed, p1cases: result.p1cases }
    });

    console.log("[FirstResponse]", new Date().toLocaleTimeString(), { sent, failed, p1: result.p1cases });

  } catch (err) {
    console.error("[FirstResponse] Erro geral:", err.message);
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
