/* The intake flow, for somebody who has not seen any of this before.
 *
 * Four steps shown one at a time: choose a file, agree and send, check what we read, keep
 * the recovery code. A page showing all four at once reads as a form to fill in rather than
 * a thing to do, and this person did not come here to fill in a form.
 *
 * The CV is read in the browser. Its text goes to the Worker only after an explicit tick,
 * and the file itself never leaves this tab — what the Worker stores is the text, encrypted
 * under a key it keeps and we never see.
 */
(() => {
  "use strict";

  const WORKER = document.body.dataset.worker || "";
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  /* Session keys. The token lives in localStorage because losing it means losing access and
     there is no reset — see docs/cv-intake.md. Wrapped because storage throws in a private
     window, and a page that cannot remember you should still work. */
  const K = { tok: "cv.token", id: "cv.seeker" };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* nothing to do */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* nothing to do */ } },
  };

  const $ = (id) => document.getElementById(id);
  const state = { cvText: "", filename: "", profile: null, facts: [] };

  /* ---------------------------------------------------------------- steps */

  function show(step) {
    for (const panel of document.querySelectorAll("[data-step]")) {
      panel.hidden = panel.dataset.step !== String(step);
    }
    document.querySelectorAll(".steps li").forEach((li, index) => {
      const n = index + 1;
      li.toggleAttribute("aria-current", n === step);
      li.toggleAttribute("data-done", n < step);
    });
    // Move focus to the heading so a screen reader announces the new step rather than
    // leaving the user where the old button was.
    const heading = document.querySelector(`[data-step="${step}"] h2`);
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function say(where, kind, message) {
    const box = $(where);
    box.hidden = false;
    box.className = "note " + kind;
    box.textContent = message;
  }

  function clear(where) { $(where).hidden = true; }

  /* ---------------------------------------------------------------- file */

  async function readFile(file) {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error("That file is larger than 8 MB. A CV is usually well under one.");
    }
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") return readPDF(file);
    if (/\.(txt|md|rtf)$/.test(name) || file.type.startsWith("text/")) return file.text();
    if (name.endsWith(".docx")) {
      throw new Error(
        "Word files cannot be read here yet. Please export the CV as a PDF and try again.",
      );
    }
    throw new Error("That file type cannot be read. Please upload a PDF or a text file.");
  }

  /* pdf.js is loaded only when a PDF is actually chosen: most of the weight of this page
     would otherwise be a library many visitors never need. */
  let pdfReady = null;
  function loadPDFJS() {
    if (pdfReady) return pdfReady;
    pdfReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDFJS;
      script.onload = () => {
        if (!window.pdfjsLib) return reject(new Error("the PDF reader did not load"));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error("the PDF reader could not be downloaded"));
      document.head.appendChild(script);
    });
    return pdfReady;
  }

  async function readPDF(file) {
    const pdfjsLib = await loadPDFJS();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    // Twenty pages is far more than a CV; a longer document is something else.
    for (let n = 1; n <= Math.min(pdf.numPages, 20); n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(" "));
    }
    const text = pages.join("\n").replace(/\s+\n/g, "\n").trim();
    if (text.length < 100) {
      throw new Error(
        "Almost no text could be read from that PDF. If it is a scan, please upload a " +
          "version with selectable text.",
      );
    }
    return text;
  }

  async function chooseFile(file) {
    if (!file) return;
    clear("fileNote");
    $("fileName").textContent = "Reading " + file.name + "…";
    try {
      state.cvText = await readFile(file);
      state.filename = file.name;
      $("fileName").textContent = `${file.name} — ${state.cvText.length.toLocaleString()} characters read`;
      $("toConsent").disabled = false;
      say("fileNote", "ok", "Read in your browser. Nothing has been sent anywhere yet.");
    } catch (error) {
      state.cvText = "";
      $("fileName").textContent = "";
      $("toConsent").disabled = true;
      say("fileNote", "bad", error.message);
    }
  }

  /* ---------------------------------------------------------------- send */

  async function submit() {
    const email = $("email").value.trim();
    const consent = $("consent").checked;
    if (!email) return say("sendNote", "bad", "An email address is needed.");
    if (!consent) {
      return say("sendNote", "bad", "Please tick the box to allow the CV to be analysed.");
    }
    if (!WORKER) {
      return say("sendNote", "bad", "This site is not configured to accept uploads yet.");
    }

    $("send").disabled = true;
    $("send").innerHTML = '<span class="spinner"></span>Reading your CV…';
    clear("sendNote");

    try {
      const response = await fetch(WORKER.replace(/\/$/, "") + "/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cv_text: state.cvText,
          email,
          consent: true,
          filename: state.filename,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "That did not work. Please try again.");

      state.profile = body.profile;
      state.facts = body.facts || [];
      store.set(K.tok, body.token);
      store.set(K.id, body.seeker_id);
      $("tokenValue").textContent = body.token;
      renderProfile();
      show(3);
    } catch (error) {
      say("sendNote", "bad", error.message);
    } finally {
      $("send").disabled = false;
      $("send").textContent = "Analyse my CV";
    }
  }

  /* ---------------------------------------------------------------- review */

  function renderProfile() {
    const profile = state.profile;
    $("headline").value = profile.headline || "";

    const list = $("skills");
    list.textContent = "";
    for (const skill of profile.skills || []) list.appendChild(skillRow(skill));

    const facts = $("facts");
    facts.textContent = "";
    for (const fact of state.facts) {
      const li = document.createElement("li");
      const id = document.createElement("span");
      id.className = "id";
      id.textContent = fact.id;
      li.append(id, document.createTextNode(fact.text));
      facts.appendChild(li);
    }
    $("factCount").textContent = state.facts.length;
    $("summary").textContent =
      [
        (profile.sectors || []).join(", ") || "no sector",
        (profile.countries || []).join(", ") || "no country",
        (profile.languages || []).join(", ") || "no language",
      ].join(" · ");
  }

  function skillRow(skill) {
    const row = document.createElement("div");
    row.className = "skill";

    const term = document.createElement("input");
    term.type = "text";
    term.value = skill.term;
    term.setAttribute("aria-label", "Skill");

    const weight = document.createElement("input");
    weight.type = "number";
    weight.min = "-10";
    weight.max = "10";
    weight.step = "1";
    weight.value = skill.weight;
    weight.setAttribute("aria-label", "How important " + skill.term + " is");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => row.remove());

    row.append(term, weight, remove);
    if (skill.aliases?.length) {
      const aliases = document.createElement("p");
      aliases.className = "aliases";
      aliases.textContent = "also matches: " + skill.aliases.join(", ");
      row.appendChild(aliases);
    }
    row._read = () => ({
      term: term.value.trim(),
      weight: Number(weight.value) || 1,
      aliases: skill.aliases || [],
    });
    return row;
  }

  async function saveProfile() {
    const skills = Array.from($("skills").children)
      .map((row) => row._read())
      .filter((skill) => skill.term);
    const profile = { ...state.profile, headline: $("headline").value.trim(), skills };

    $("save").disabled = true;
    $("save").innerHTML = '<span class="spinner"></span>Saving…';
    try {
      const response = await fetch(WORKER.replace(/\/$/, "") + "/api/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + store.get(K.tok),
          "x-seeker-id": store.get(K.id),
        },
        body: JSON.stringify({ profile }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "That did not save. Please try again.");
      }
      show(4);
    } catch (error) {
      say("reviewNote", "bad", error.message);
    } finally {
      $("save").disabled = false;
      $("save").textContent = "This looks right";
    }
  }

  /* ---------------------------------------------------------------- erase */

  async function erase() {
    if (!$("confirmErase").checked) {
      return say("doneNote", "bad", "Please tick the box to confirm.");
    }
    $("erase").disabled = true;
    try {
      const response = await fetch(WORKER.replace(/\/$/, "") + "/api/seeker", {
        method: "DELETE",
        headers: {
          authorization: "Bearer " + store.get(K.tok),
          "x-seeker-id": store.get(K.id),
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "That did not work.");
      store.del(K.tok);
      store.del(K.id);
      say("doneNote", "ok", body.detail || "Your data has been deleted.");
      $("erase").hidden = true;
    } catch (error) {
      say("doneNote", "bad", error.message);
      $("erase").disabled = false;
    }
  }

  /* ---------------------------------------------------------------- wiring */

  function init() {
    const drop = $("drop");
    const input = $("file");
    input.addEventListener("change", () => chooseFile(input.files[0]));

    for (const event of ["dragenter", "dragover"]) {
      drop.addEventListener(event, (e) => {
        e.preventDefault();
        drop.setAttribute("data-over", "");
      });
    }
    for (const event of ["dragleave", "drop"]) {
      drop.addEventListener(event, (e) => {
        e.preventDefault();
        drop.removeAttribute("data-over");
      });
    }
    drop.addEventListener("drop", (e) => chooseFile(e.dataTransfer?.files?.[0]));

    $("toConsent").addEventListener("click", () => show(2));
    $("backToFile").addEventListener("click", () => show(1));
    $("send").addEventListener("click", submit);
    $("save").addEventListener("click", saveProfile);
    $("erase").addEventListener("click", erase);

    $("copyToken").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("tokenValue").textContent);
        $("copyToken").textContent = "Copied";
        setTimeout(() => ($("copyToken").textContent = "Copy"), 1800);
      } catch {
        // Clipboard access is refused in some views; selecting the text still works.
        const range = document.createRange();
        range.selectNodeContents($("tokenValue"));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });

    show(1);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
