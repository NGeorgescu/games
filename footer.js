/* Shared footer for every game page.
   Include once, at the end of <body>:  <script src="/games/footer.js"></script>
   Injects a "back to games · buy me a coffee" bar styled from the global CSS vars
   (--accent / --fg-dim / --rule / --sans) that all pages already load via /style.css. */
(function () {
  if (document.getElementById("site-footer")) return;   // guard against double-include

  var DONATE = "https://www.paypal.com/donate/?business=54V2KAS86LPMU" +
    "&no_recurring=0" +
    "&item_name=%E2%80%9CI+love+making+things+for+people+and+hope+you%E2%80%99ll+consider+supporting+that%E2%80%9D" +
    "&currency_code=USD";

  var style = document.createElement("style");
  style.textContent =
    ".site-footer{text-align:center;padding:1.5rem 1rem 2rem;margin:2rem 0 0;" +
    "font-size:.8rem;letter-spacing:.15em;text-transform:uppercase;" +
    "color:var(--fg-dim,#888);border-top:1px solid var(--rule,#333);" +
    'font-family:var(--sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}' +
    ".site-footer a{color:var(--accent,#6ab2d4);text-decoration:none}" +
    ".site-footer a:hover{text-decoration:underline}" +
    ".site-footer .sep{margin:0 .5em;opacity:.55}";
  document.head.appendChild(style);

  var f = document.createElement("footer");
  f.id = "site-footer";
  f.className = "site-footer";
  f.innerHTML =
    '<a href="/games/">↩ back to games</a>' +
    '<span class="sep">·</span>' +
    '<a href="' + DONATE + '" target="_blank" rel="noopener">buy me a coffee ☕</a>';
  document.body.appendChild(f);
})();
