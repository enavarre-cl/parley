/**
 * "Read aloud" (TTS) section of the config panel: engine selector (system / Piper), voice list,
 * speed and test/update buttons. Split out of config.js. Re-renders via config.js's renderConfig.
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { $ } from '../core/dom.js';
import { tts } from '../features/tts.js';
import { fieldRow, renderConfig } from './config.js';

const configFields = $('configFields');

// Read aloud configuration section.
export function renderTtsConfig() {
  const h = document.createElement('div');
  h.className = 'group-head';
  h.textContent = t('Read aloud');
  configFields.appendChild(h);

  const engine = tts.prefs.engine || 'system';

  // Engine selector: system voices vs neural Piper.
  const eng = document.createElement('select');
  [['system', t('System (Web Speech)')], ['piper', t('Piper (neural, better quality)')]].forEach(([val, label]) => {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    if (val === engine) o.selected = true;
    eng.appendChild(o);
  });
  eng.addEventListener('change', () => { tts.prefs.engine = eng.value; tts.save(); tts.stop(); renderConfig(); });
  configFields.appendChild(fieldRow(t('Engine'), eng));

  if (engine === 'system') {
    if (!tts.voices.length) {
      const note = document.createElement('div');
      note.className = 'cfg-note';
      note.textContent = tts.triedVoices ? t("Couldn't load system voices.") : t('Loading system voices…');
      configFields.appendChild(note);
      if (tts.triedVoices) {
        const retry = document.createElement('button');
        retry.className = 'btn-secondary';
        retry.textContent = t('Retry');
        retry.addEventListener('click', () => { tts.loadVoices(); if (!tts.voices.length && tts.pollVoices) tts.pollVoices(); renderConfig(); });
        const row = document.createElement('div');
        row.className = 'sysref-actions';
        row.appendChild(retry);
        configFields.appendChild(row);
      }
      return;
    }
    // Voice selector (Spanish first).
    const sel = document.createElement('select');
    for (const v of tts.sortedVoices()) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang})`;
      if (v.voiceURI === tts.prefs.voiceURI) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { tts.prefs.voiceURI = sel.value; tts.save(); });
    configFields.appendChild(fieldRow(t('Voice'), sel));
  } else {
    // Piper: the selector offers ONLY DOWNLOADED voices. The Custom option appears only if there
    // is a .onnx path configured in Settings (or if it is the current selection) — for a
    // normal user without a custom path, the dropdown shows exclusively downloaded voices.
    const dl = tts.downloadedVoices;
    const showCustom = tts.customSet || tts.prefs.piperVoice === 'custom';
    const available = tts.piperVoices.filter((v) =>
      v.id === 'custom' ? showCustom : dl.has(v.id)
    );
    const realVoices = available.filter((v) => v.id !== 'custom');
    // If the selected voice is no longer downloaded, reassign to a valid one (1st real, or Custom).
    if (tts.prefs.piperVoice !== 'custom' && !dl.has(tts.prefs.piperVoice)) {
      tts.prefs.piperVoice = realVoices.length ? realVoices[0].id : 'custom';
      tts.save();
    }
    const sel = document.createElement('select');
    for (const v of available) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.id === 'custom' ? v.label + t('Custom (path in Settings)') : v.label;
      if (v.id === tts.prefs.piperVoice) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { tts.prefs.piperVoice = sel.value; tts.save(); tts.stop(); renderConfig(); });
    configFields.appendChild(fieldRow(t('Voice'), sel));

    const note = document.createElement('div');
    note.className = 'cfg-note';
    note.textContent = tts.prefs.piperVoice === 'custom'
      ? t('Set the .onnx model path in Settings (jotflow.tts.piperModel).')
      : !realVoices.length
        ? t('No voices downloaded. Add one from the Jotflow panel (Voices ➕).')
        : t('Downloaded voices work offline. Add more from the Jotflow panel (Voices ➕).');
    configFields.appendChild(note);
  }

  // Speed (shared by both engines).
  const rateWrap = document.createElement('div');
  rateWrap.className = 'tts-rate';
  const rate = document.createElement('input');
  rate.type = 'range'; rate.min = '0.5'; rate.max = '2'; rate.step = '0.05';
  rate.value = String(tts.prefs.rate || 1);
  const rateVal = document.createElement('span');
  rateVal.className = 'tts-rate-val';
  rateVal.textContent = (tts.prefs.rate || 1).toFixed(2) + '×';
  rate.addEventListener('input', () => { rateVal.textContent = Number(rate.value).toFixed(2) + '×'; });
  rate.addEventListener('change', () => { tts.prefs.rate = Number(rate.value); tts.save(); });
  rateWrap.appendChild(rate); rateWrap.appendChild(rateVal);
  configFields.appendChild(fieldRow(t('Speed'), rateWrap));

  // Buttons: test and (Piper with curated voice only) update.
  const testRow = document.createElement('div');
  testRow.className = 'sysref-actions';
  const test = document.createElement('button');
  test.className = 'btn-secondary';
  test.textContent = '🔊 ' + t('Test voice');
  test.addEventListener('click', () => tts.speak(t('Hello, this is a voice test.'), null));
  testRow.appendChild(test);
  if (engine === 'piper' && tts.prefs.piperVoice && tts.prefs.piperVoice !== 'custom') {
    const upd = document.createElement('button');
    upd.className = 'btn-secondary';
    upd.textContent = '↻ ' + t('Update');
    upd.title = t('Re-download the Piper engine and voice (e.g. if updated upstream).');
    upd.addEventListener('click', () => {
      tts.stop();
      vscode.postMessage({ type: 'ttsUpdate', voice: tts.prefs.piperVoice });
    });
    testRow.appendChild(upd);
  }
  configFields.appendChild(testRow);
}
