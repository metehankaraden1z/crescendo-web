"use strict";

// The phone apps' robot check (see captcha.html). Tokens go to the app's "CrescendoCaptcha" channel;
// an empty string means the token expired or the check failed, so the app asks again.
(async function () {
  const send = (token) => { if (window.CrescendoCaptcha) window.CrescendoCaptcha.postMessage(token); };
  const box = document.getElementById("ts");
  let key = null;
  try {
    key = (await (await fetch("/api/config")).json()).turnstile_sitekey;
  } catch { /* offline: the app shows its own error */ }
  if (!key) { send("off"); return; }
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.onload = () => window.turnstile.render(box, {
    sitekey: key, theme: "dark", action: "signup",
    callback: send, "expired-callback": () => send(""), "error-callback": () => send(""),
  });
  script.onerror = () => { box.textContent = "The robot check couldn't load. Check your connection."; };
  document.head.append(script);
})();
