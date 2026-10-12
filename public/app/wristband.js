import { qrSVG } from '/shared/qr.js';
import { getToken, request, cached } from '/shared/api.js';
import { esc } from '/shared/dom.js';

const bands = document.getElementById('bands');
const countInput = document.getElementById('count');
const printButton = document.getElementById('print');

/** 1–10 bands. A typo of 300 should not queue three hundred pages. */
const count = () => Math.max(1, Math.min(10, Math.round(Number(countInput.value) || 1)));

function render(group) {
  const n = count();
  countInput.value = n;
  const code = esc(group.joinCode);
  // The QR is the same for every band; build it once.
  const qr = qrSVG(group.joinCode, { size: 108 });
  bands.innerHTML = Array.from({ length: n }, () => `
    <div class="band">
      <div class="qr" role="img" aria-label="QR code for ${code}">${qr}</div>
      <div class="who">
        <div class="brand">कुंभ-अ-मित्र · KUMBH-A-MITRA</div>
        <div class="code">${code}</div>
        <div class="line">नाम / Name</div><div class="write"></div>
        <div class="line" style="margin-top:4px">उम्र / Age &nbsp;·&nbsp; कोई दवा / Medication</div><div class="write"></div>
      </div>
      <div class="tell">
        मिलने पर किसी स्वयंसेवक को दिखाएँ<br>
        <b>Show this to any volunteer</b>
      </div>
    </div>`).join('');
}

async function load() {
  let group = cached('group');
  try {
    if (getToken()) {
      const groups = await request('/api/groups/mine');
      group = groups[0]?.group ?? null;
    }
  } catch { /* cached group is fine, this page must work offline */ }

  if (!group) {
    bands.innerHTML = `<div class="empty"><strong>अभी कोई समूह नहीं</strong>
      पहले ऐप में समूह बनाइए, फिर यहाँ पट्टी छापिए।<br>
      <span style="font-size:15px">Make a group in the app first.</span></div>`;
    printButton.disabled = true;
    return;
  }
  render(group);
  countInput.oninput = () => render(group);
  // Big − / + buttons: easier than a tiny number box for most hands.
  const step = (d) => { countInput.value = count() + d; render(group); sync(); };
  const sync = () => {
    document.getElementById('count-down').disabled = count() <= 1;
    document.getElementById('count-up').disabled = count() >= 10;
  };
  document.getElementById('count-down').onclick = () => step(-1);
  document.getElementById('count-up').onclick = () => step(1);
  countInput.addEventListener('input', sync);
  sync();
}

printButton.onclick = () => window.print();
load();
