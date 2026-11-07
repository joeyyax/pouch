/* Receipt lifecycle, the send flow that follows it, the Dashboard/API toggle, term popovers and copy buttons. Each runs only where its markup exists. */
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
  function show(i, via) {
    document.dispatchEvent(new CustomEvent("pouch:step", { detail: { step: i, via } }));
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
    const via = messages.indexOf(m);
    show(0, via);
    card.classList.remove("swap");
    await wait(1100); show(1, via);
    await wait(1600); show(2, via);
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
  const box = document.querySelector(".flow");
  if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const views = [...box.querySelectorAll("svg")];
  let run = 0;

  function travel(name, id, ms = 700) {
    const start = performance.now();
    const legs = views.map((svg) => {
      const path = svg.querySelector(`[data-seg~="${name}"]`);
      path.classList.add("on");
      return { path, dot: svg.querySelector("[data-dot]"), len: path.getTotalLength() };
    });
    return new Promise((done) => {
      const frame = (now) => {
        if (id !== run) return;
        const t = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - t, 3);
        legs.forEach(({ path, dot, len }) => {
          const p = path.getPointAtLength(e * len);
          dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y);
        });
        if (t < 1) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
  }

  document.addEventListener("pouch:step", async ({ detail: { step, via } }) => {
    const id = ++run;
    box.classList.add("live");
    const inboxes = box.querySelectorAll("[data-inbox]");
    if (step === 0) {
      box.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
      inboxes.forEach((el) => el.classList.remove("ok"));
      box.querySelectorAll(`[data-provider="${via}"]`).forEach((el) => el.classList.add("on"));
      await travel("a", id);
    }
    if (step === 1) {
      await travel(`b${via}`, id, 600);
      await travel(`c${via}`, id, 600);
      if (id === run) inboxes.forEach((el) => el.classList.add("ok"));
    }
    if (step === 2) {
      await travel("e", id, 800);
      await travel("w", id, 800);
    }
  });
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
