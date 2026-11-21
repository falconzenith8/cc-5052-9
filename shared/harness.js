// Offline harness: authority <-> client over a simulated lossy link.
// Used by tests, the UI's headless mode and tools/verify.mjs.
//
// The link applies the *same* impairments as the browser server (reordering,
// latency, periodic middle-tile loss, slow acks). Every client install is
// compared against the authority's own quantized state for that tick.

import { AuthoritativeLink } from './link.js';

export async function runHeadlessSession({
  config = {}, ticks = 240, impairment = {}, onSample = null, seed = 7,
} = {}) {
  const link = new AuthoritativeLink({ config, impairment, seed });
  const samples = [];
  for (let i = 0; i < ticks; i++) {
    link.step();
    const sample = link.sample();
    samples.push(sample);
    if (onSample) onSample(sample);
    await tickDelay();
  }
  return { link, samples };
}

function tickDelay() { return new Promise(r => setImmediate(r)); }

export { AuthoritativeLink };
