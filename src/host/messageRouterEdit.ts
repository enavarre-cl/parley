/** Message-editing + find/replace handlers (delete/merge/edit/replace), split from the router. */
import { tr } from './i18n';
import { isHiddenToolMsg } from './chatHelpers';
import { replaceInString, FindOpts } from './findReplace';
import { ChatMessage } from './providers/types';
import type { RouterCtx, WebviewMessage } from './messageRouter';

export async function routeEdit(msg: WebviewMessage, ctx: RouterCtx): Promise<void> {
  switch (msg.type) {
    case 'deleteMessage': {
      if (ctx.busyRef.value) break;
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = msg.index ?? -1;
      if (Number.isInteger(i) && i >= 0 && i < doc.messages.length) {
        if (!(await ctx.confirmDelete(msg, tr('Delete this message?')))) break;
        // Also drags the adjacent HIDDEN tool chain (assistant with toolCalls + 'tool' results)
        // on BOTH sides: before (complete turn) and after (broken turn without a final response).
        // Otherwise they would remain orphaned in the JSON.
        let start = i;
        let end = i;
        while (start > 0 && isHiddenToolMsg(doc.messages[start - 1])) start--;
        while (end + 1 < doc.messages.length && isHiddenToolMsg(doc.messages[end + 1])) end++;
        doc.messages.splice(start, end - start + 1);
        // If only tool remnants remain (no displayable message), clear entirely.
        if (!doc.messages.some((m) => !isHiddenToolMsg(m))) doc.messages = [];
        doc.summary = undefined; // summary indices changed
        await ctx.writeDoc(doc);
        ctx.sendHistory();
      }
      break;
    }
    case 'deleteFrom': {
      // Deletes message `index` and all subsequent ones (⌥/Alt + trash).
      if (ctx.busyRef.value) break;
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = msg.index ?? -1;
      if (Number.isInteger(i) && i >= 0 && i < doc.messages.length) {
        if (!(await ctx.confirmDelete(msg, tr('Delete this message and all below?')))) break;
        // Includes the hidden tool chain preceding the cut point.
        let start = i;
        while (start > 0 && isHiddenToolMsg(doc.messages[start - 1])) start--;
        doc.messages.splice(start); // removes from start to the end
        doc.summary = undefined;
        await ctx.writeDoc(doc);
        ctx.sendHistory();
      }
      break;
    }
    case 'mergeMessage': {
      // Merges message `index` with the previous one (same role) into a single message.
      if (ctx.busyRef.value) break;
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = msg.index ?? -1;
      if (
        Number.isInteger(i) && i > 0 && i < doc.messages.length &&
        doc.messages[i].role === doc.messages[i - 1].role
      ) {
        const prev = doc.messages[i - 1];
        const cur = doc.messages[i];
        prev.content = `${prev.content}\n\n${cur.content}`.trim();
        const merged = [prev.thinking, cur.thinking].filter(Boolean).join('\n\n');
        if (merged) prev.thinking = merged;
        doc.messages.splice(i, 1);
        doc.summary = undefined; // summary indices changed
        await ctx.writeDoc(doc);
        ctx.sendHistory();
      }
      break;
    }
    case 'editMessage': {
      if (ctx.busyRef.value) break;
      const doc = ctx.getDoc();
      if (!doc) break;
      const i = msg.index ?? -1;
      if (Number.isInteger(i) && i >= 0 && i < doc.messages.length && typeof msg.content === 'string') {
        const m = doc.messages[i];
        m.content = msg.content;
        // If the message has variants, edit the active one.
        if (Array.isArray(m.variants) && typeof m.active === 'number' && m.variants[m.active]) {
          m.variants[m.active].content = msg.content;
        }
        doc.summary = undefined; // content changed: invalidate the summary
        await ctx.writeDoc(doc);
        ctx.sendHistory();
      }
      break;
    }
    // Find/Replace (webview's replace row). `replaceOne` targets one occurrence (by ordinal
    // within a message); `replaceAll` rewrites every occurrence across the conversation. Both
    // operate on the raw message source (case-insensitive, matching the find highlight).
    case 'replaceOne':
    case 'replaceAll': {
      if (ctx.busyRef.value) break;
      const doc = ctx.getDoc();
      if (!doc) break;
      const query = msg.query, replacement = msg.replacement;
      if (typeof query !== 'string' || query === '' || typeof replacement !== 'string') break;
      const fopts: FindOpts = (msg.opts && typeof msg.opts === 'object') ? msg.opts : {};
      const editActive = (m: ChatMessage, nth: number): number => {
        const hasVar = Array.isArray(m.variants) && typeof m.active === 'number' && m.variants[m.active];
        const cur = hasVar ? m.variants![m.active!].content : m.content;
        const r = replaceInString(typeof cur === 'string' ? cur : '', query, replacement, nth, fopts);
        if (r.count) {
          m.content = r.content;
          if (hasVar) m.variants![m.active!].content = r.content;
        }
        return r.count;
      };
      let total = 0;
      if (msg.type === 'replaceOne') {
        const i = msg.index ?? -1;
        const ord = msg.ordinal ?? 0;
        const nth = Number.isInteger(ord) && ord >= 1 ? ord : 1;
        if (Number.isInteger(i) && i >= 0 && i < doc.messages.length) total = editActive(doc.messages[i], nth);
      } else {
        for (const m of doc.messages) total += editActive(m, 0); // 0 = all occurrences
        // Replace All also rewrites the context summary text (it is shown as a bubble and may
        // contain the term) — without destroying it: a content replace leaves coverage valid.
        if (doc.summary && typeof doc.summary.text === 'string') {
          const r = replaceInString(doc.summary.text, query, replacement, 0, fopts);
          if (r.count) { doc.summary.text = r.content; total += r.count; }
        }
      }
      if (total) { await ctx.writeDoc(doc); ctx.sendHistory(); }
      break;
    }
  }
}
