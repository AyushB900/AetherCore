'use strict';
const grid = document.getElementById('request-grid');
const run = document.getElementById('run-demo');
const reset = document.getElementById('reset-demo');
const committed = document.getElementById('committed');
const replayed = document.getElementById('replayed');
const charged = document.getElementById('charged');
const status = document.getElementById('demo-status');
let generation = 0;
function initialize() {
  generation++;
  grid.replaceChildren();
  for (let i = 0; i < 32; i++) {
    const cell = document.createElement('div');
    cell.className = 'request';
    cell.textContent = String(i + 1).padStart(2, '0');
    cell.setAttribute('aria-label', `Request ${i + 1}: waiting`);
    grid.appendChild(cell);
  }
  committed.textContent = '0'; replayed.textContent = '0'; charged.textContent = '$0';
  status.textContent = 'Ready. One $25 transfer, 32 identical requests.';
  run.disabled = false; reset.hidden = true;
}
run.addEventListener('click', () => {
  initialize();
  run.disabled = true;
  status.textContent = 'Simulating 32 identical requests with the same key…';
  const current = generation;
  [...grid.children].forEach((cell, i) => {
    setTimeout(() => {
      if (current !== generation) return;
      cell.classList.add(i === 0 ? 'committed' : 'replayed');
      cell.textContent = i === 0 ? '201' : '200';
      cell.setAttribute('aria-label', `Request ${i + 1}: ${i === 0 ? 'committed' : 'safe replay'}`);
      committed.textContent = '1'; replayed.textContent = String(i); charged.textContent = '$25';
      if (i === 31) {
        status.textContent = 'Complete. 1 posting. 31 safe replays. $25 moved once. (Simulation)';
        run.disabled = false; reset.hidden = false;
      }
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150 + i * 55);
  });
});
reset.addEventListener('click', initialize);
document.getElementById('copy-command').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText('./mvnw verify');
    button.textContent = 'Copied ✓';
  } catch (_) {
    button.textContent = 'Select: ./mvnw verify';
  }
});
initialize();
