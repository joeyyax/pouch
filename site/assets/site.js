/* Receipt lifecycle, the Dashboard/API toggle, term popovers and copy buttons. Each runs only where its markup exists. */
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const card = document.getElementById("receipt");
  if (!card) return;
  const rows = [...card.querySelectorAll("[data-step]")];
  const list = card.querySelector(".timeline");
  const f = (name) => card.querySelector(`[data-f="${name}"]`);
  const chip = f("chip");

  const messages = [
    { subject: "Your receipt", to: "sam@example.net", via: "SES us-west-2", reply: "250 2.0.0 OK mx.example.net" },
    { subject: "Reset your password", to: "ada@example.org", via: "Mailpace", reply: "250 2.0.0 Ok: queued as 4Tq9Lm" },
    { subject: "Your invite is ready", to: "lin@example.com", via: "Cloudflare Email Service", reply: "250 2.6.0 Message accepted" },
  ];
  const states = [["Queued", ""], ["Sent", "info"], ["Delivered", "ok"]];
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function setChip(i) {
    const [label, tone] = states[i];
    chip.textContent = label;
    chip.className = `chip ${tone}`.trim();
    chip.classList.remove("pop"); void chip.offsetWidth; chip.classList.add("pop");
  }
  function show(i) {
    rows.forEach((row, n) => {
      row.classList.toggle("pending", n > i);
      row.classList.toggle("current", n === i && i < rows.length - 1);
    });
    list.style.setProperty("--fill", i === 0 ? "0px" : `${rows[i].offsetTop}px`);
    setChip(i);
  }

  async function play(m) {
    const start = new Date();
    f("subject").textContent = m.subject;
    f("to").textContent = m.to;
    f("via").textContent = m.via;
    f("reply").textContent = m.reply;
    f("t0").textContent = clock(start);
    f("t1").textContent = clock(new Date(+start + 1000));
    f("t2").textContent = clock(new Date(+start + 3000));
    show(0);
    card.classList.remove("swap");
    await wait(1100); show(1);
    await wait(1600); show(2);
    await wait(4200);
    card.classList.add("swap");
    await wait(420);
  }

  (async () => {
    await wait(3000);
    card.classList.add("swap");
    await wait(420);
    for (let i = 1; ; i = (i + 1) % messages.length) await play(messages[i]);
  })();
})();
(() => {
  const bento = document.getElementById("bento");
  if (!bento) return;
  const buttons = document.querySelectorAll(".seg button");
  buttons.forEach((b) => b.addEventListener("click", () => {
    bento.dataset.view = b.dataset.view;
    buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
})();
(() => {
  const place = (tip) => {
    const trigger = document.querySelector(`[popovertarget="${tip.id}"]`);
    const r = trigger.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.min(Math.max(16, r.left), innerWidth - w - 16);
    const below = r.bottom + 8 + h < innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 8 : r.top - 8 - h}px`;
  };
  document.querySelectorAll(".tip").forEach((tip) => tip.addEventListener("toggle", (e) => { if (e.newState === "open") place(tip); }));
  addEventListener("scroll", () => document.querySelectorAll(".tip:popover-open").forEach((t) => t.hidePopover()), { passive: true });
})();
(() => {
  document.querySelectorAll(".copy-field button").forEach((button) => button.addEventListener("click", async () => {
    const text = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      button.classList.add("copied");
      button.setAttribute("aria-label", "Copied");
      setTimeout(() => { button.classList.remove("copied"); button.setAttribute("aria-label", "Copy"); }, 1600);
    } catch {}
  }));
})();
