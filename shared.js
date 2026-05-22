"use strict";

(function (global) {
  const DEFAULT_TITLE = "Hosting Operations Specialist";

  function isBrazilCountry(code) {
    return (code || "").trim().toUpperCase() === "BR";
  }

  function buildSignature({ userName, title, phone }) {
    const safeTitle = title || DEFAULT_TITLE;
    const safePhone = phone || "";
    return `[code]\n<div style="display: flex; align-items: center;">\n<img src="https://i.postimg.cc/NFB5VZyG/equinix-logo-icon-169199-resized.png" alt="Equinix Logo" style="width: 65px; height: 65px; margin-right: 10px;">\n<div style="border-left: 1px solid #000; padding-left: 10px;">\n<br>${userName}<br><b>${safeTitle}</b><br>${safePhone ? "Contato: " + safePhone + "<br>" : ""}EQUINIX\n</div>\n</div>[/code]`;
  }

  function buildFirstResponseComment({ countryCode, userName, title, phone }) {
    const signature = buildSignature({ userName, title, phone });
    if (isBrazilCountry(countryCode)) {
      return "Estou iniciando o atendimento, favor aguardar um próximo feedback com mais informações.\\nPor favor, fique à vontade para entrar em contato conosco a qualquer momento.\\n\\nEstamos à disposição.\\n\\n[code]<em>Atenciosamente,</em>[/code]\\n" + signature;
    }
    return "I'm starting the service. Please wait for a follow-up feedback with more information.\\n\\nFeel free to contact us at any time.\\n\\nWe are at your disposal.\\n\\n[code]<em>Sincerely,</em>[/code]\\n" + signature;
  }

  global.FirstResponseShared = {
    DEFAULT_TITLE,
    isBrazilCountry,
    buildFirstResponseComment
  };
})(typeof self !== "undefined" ? self : window);
