/**
 * Dispatches messages from the extension host to the right feature module. The single window
 * 'message' listener lives in main.js and forwards each event here.
 */
import { $ } from '../core/dom.js';
import { getDoc, setDoc } from '../ui/store.js';
import { onFileResults } from '../features/autocomplete.js';
import { tts } from '../features/tts.js';
import { applySpellLang } from '../features/spell.js';
import { renderConfig } from '../panels/config.js';
import { renderStatus, renderModels, updateModelCtx, updateUsage, updateContextBar } from '../panels/models.js';
import {
  renderConversation, streamStart, streamReasoning, streamDelta, streamEnd, streamError,
  toolCall, toolResult,
} from '../chat/conversation.js';
import { setStreaming, setSummarizing, applyDocZoom } from '../chat/composer.js';
import { applyPanelState } from '../chat/panels.js';
import { notice, showSummarizing, hideSummarizing, showTtsProgress, hideTtsProgress } from '../ui/notifications.js';

const providerSelect = $('providerSelect') as HTMLSelectElement;
const spellSelect = $('spellSelect') as HTMLSelectElement;
const configPanel = $('config');

// Applies a language: translates static HTML and re-renders dynamic content. `bundle` is the
// active language's translations (sent fresh on a live change so any locale works, not just es).
function applyLanguage(lang, bundle) {
  window.LangI18n.set(lang);
  if (bundle) window.LangI18n.setBundle(bundle);
  window.LangI18n.applyStatic(document);
  document.documentElement.lang = lang;
  if (getDoc()) { renderConfig(); renderConversation(); updateUsage(); updateContextBar(); }
  updateModelCtx(); // refresh capability/context tooltips + status
}

export function handleMessage(msg) {
  switch (msg.type) {
    case 'lang':
      applyLanguage(msg.lang, msg.bundle);
      break;
    case 'atFilesResult':
      onFileResults(msg.q, msg.files, msg.reqId);
      break;
    case 'spellWords':
      if (window.LangSpell) window.LangSpell.setWords(msg.words || []);
      break;
    case 'piperVoices':
      // Downloaded Piper voices: the chat selector only offers these (+ Custom).
      tts.downloadedVoices = new Set(msg.ids || []);
      if (getDoc() && !configPanel.classList.contains('hidden')) renderConfig();
      break;
    case 'chatterboxVoices':
      // Cloned Chatterbox voices available in the selector.
      tts.chatterboxVoices = Array.isArray(msg.voices) ? msg.voices : [];
      if (getDoc() && !configPanel.classList.contains('hidden')) renderConfig();
      break;
    case 'doc': {
      const doc = msg.doc;
      setDoc(doc);
      providerSelect.value = doc.provider;
      if (spellSelect) spellSelect.value = doc.spellLang || 'auto'; // per-chat spell-checker language
      applySpellLang();
      applyPanelState(doc); // restore the per-conversation Reasoning/Tools panel visibility
      applyDocZoom(doc);    // restore the per-conversation chat zoom
      renderConfig();
      renderConversation();
      updateContextBar();
      updateUsage();
      break;
    }
    case 'status':
      renderStatus(msg.info, msg.state, msg.detail);
      break;
    case 'models': {
      // Ignore responses from a backend that is no longer active.
      const doc = getDoc();
      if (msg.provider && doc && msg.provider !== doc.provider) break;
      renderModels(msg.models, msg.current, msg.error);
      break;
    }
    case 'streamStart':
      streamStart();
      setStreaming(true);
      break;
    case 'streamReasoning':
      streamReasoning(msg.delta);
      break;
    case 'toolCall':
      toolCall(msg.name, msg.args);
      break;
    case 'toolResult':
      toolResult(msg.name, msg.content);
      break;
    case 'streamDelta':
      streamDelta(msg.delta);
      break;
    case 'streamEnd':
      streamEnd();
      setStreaming(false);
      break;
    case 'history': {
      // Authoritative history after send/delete/merge: re-render with indices and actions.
      const doc = getDoc();
      if (doc) {
        doc.messages = msg.messages; // doc.usage is unused: updateUsage() recalculates from messages
        if ('summary' in msg) doc.summary = msg.summary || undefined; // keep the summary in sync
      }
      renderConversation();
      updateContextBar();
      updateUsage();
      break;
    }
    case 'summarizing':
      setSummarizing(!!msg.active); // block sending for the duration
      if (msg.active) showSummarizing(msg.message); else hideSummarizing();
      break;
    case 'notice':
      notice(msg.message, false);
      break;
    case 'error':
      notice(msg.message, true);
      // Close the mid-stream turn so a late delta does not write into the old bubble.
      streamError();
      setStreaming(false);
      break;
    case 'ttsProgress':
      // Slow neural TTS (Chatterbox): show a fill bar while the audio is synthesised.
      if (msg.id === undefined || msg.id === tts.reqId) showTtsProgress(msg.pct, msg.text);
      break;
    case 'ttsAudio':
      hideTtsProgress(); // synthesis finished → about to play
      tts.playWav(msg.data, msg.id);
      break;
    case 'ttsDone':
      hideTtsProgress();
      break;
    case 'ttsError':
      hideTtsProgress();
      if (msg.id === undefined || msg.id === tts.reqId) { // ignore errors from stale requests
        tts.stop();
        notice(msg.message, true);
      }
      break;
  }
}
