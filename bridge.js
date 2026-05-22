// Roda no contexto MAIN — acessa window.g_ck
(async function (config) {
  const gck = window.g_ck || "";

  async function api(path, method = "GET", body = null) {
    const opts = {
      method,
      headers: { "Accept": "application/json", "Content-Type": "application/json", "X-UserToken": gck },
      credentials: "include"
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path.split("?")[0]}`);
    return res.json();
  }

  try {
    // ── Ação: postar comentário num caso ──────────────────────
    if (config.action === "post_comment") {
      const { sysId, comment } = config;
      await api(`/api/now/table/sn_customerservice_case/${sysId}`, "PATCH", { comments: comment });
      return { ok: true, sysId };
    }

    // ── Ação: carregar fila de casos ──────────────────────────
    if (config.action === "load_queue") {
      const { userSysId } = config;

      // Busca casos atribuídos ao usuário em andamento
      const casesData = await api(
        `/api/now/table/sn_customerservice_case` +
        `?sysparm_query=assigned_to=${userSysId}^stateNOT IN6,7,8` +
        `&sysparm_fields=sys_id,number,short_description,state,u_operating_country,u_operational_scope,opened_at,account` +
        `&sysparm_display_value=true&sysparm_limit=100`
      );
      const cases = casesData.result || [];

      if (!cases.length) return { cases: [] };

      // Para cada caso, verifica se tem interação humana no journal
      const results = await Promise.all(cases.map(async c => {
        const jd = await api(
          `/api/now/table/sys_journal_field` +
          `?sysparm_query=element_id=${c.sys_id}^elementINwork_notes,comments` +
          `&sysparm_fields=sys_id,sys_created_by&sysparm_limit=50`
        );
        const entries = jd.result || [];

        // Filtra entradas humanas (ignora system, integrations)
        const humanEntries = entries.filter(e => {
          const by = (e.sys_created_by || "").toLowerCase();
          return by !== "system" && by !== "guest" && by !== "anonymous" &&
                 !by.includes("integration") && !by.includes("svc_");
        });

        return {
          ...c,
          hasFirstResponse: humanEntries.length > 0,
          interactionCount: humanEntries.length
        };
      }));

      return { cases: results };
    }

    return { error: "Ação desconhecida" };

  } catch (err) {
    return { error: err.message };
  }
});
