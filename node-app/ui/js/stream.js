'use strict';
// An answer while it is being written. Text arrives from the backend in bursts;
// here it is let out at an even pace, each new piece fading in, and only the
// block being written is drawn again, so what is already there never flickers.
(() => {
  const { h } = window.CF;

  /** What has arrived is on screen within about this long: the further behind, the faster. */
  const LAG = 450;
  /** Characters a second when little is waiting. */
  const MIN_RATE = 35;
  const FADE = 240;
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  /** Top-level blocks of a text (split at blank lines outside code fences), so finished ones are never rebuilt. */
  function chunks(text) {
    const result = [];
    let current = [], fence = null;
    for (const line of text.split('\n')) {
      const mark = /^\s*(```|~~~)/.exec(line);
      if (mark) { if (!fence) fence = mark[1]; else if (line.trim().startsWith(fence)) fence = null; }
      if (!fence && !mark && !line.trim()) { if (current.length) result.push(current.join('\n')); current = []; continue; }
      current.push(line);
    }
    if (current.length) result.push(current.join('\n'));
    return result;
  }

  /**
   * The block being written, with its half-written end shown as it will look
   * once finished: a marker waits for its text, a table and a code block for their first row,
   * open emphasis and code are closed, a link shows its text.
   */
  function tidy(source) {
    const lines = source.split('\n');
    const rest = count => lines.slice(0, lines.length - count).join('\n');
    let fence = false, opened = 0;
    lines.slice(0, -1).forEach((line, index) => { if (/^\s*(```|~~~)/.test(line)) { fence = !fence; opened = index; } });
    let last = lines[lines.length - 1];
    if (fence) {
      // A code block shows once it has a first line of code, not as an empty box.
      if (!lines.slice(opened + 1).join('').trim()) return rest(lines.length - opened);
      return /^\s*(`{1,3}|~{1,3})$/.test(last) ? rest(1) : source;
    }
    // A code block that is only just opening waits as well.
    if (/^\s*(```|~~~)/.test(last)) return rest(1);
    if (/^\s*(#{1,6}|[-*+]|\d+[.)]?|>|`{1,3}|~{1,3})\s*$/.test(last)) return rest(1);
    const row = /^\s*\|/.test(last);
    last = last.replace(/<!(--(?:(?!-->).)*|-)?$/, '').replace(/\[([^\]]*)\]\([^)]*$/, '$1').replace(/\[([^\]]*)$/, '$1');
    if ((last.match(/`/g) || []).length % 2) last = /`$/.test(last) ? last.slice(0, -1) : last + '`';
    else {
      last = last.replace(/\*{1,2}$/, '');
      if ((last.match(/\*\*/g) || []).length % 2) last += '**';
    }
    if (row) {
      let first = lines.length - 1;
      while (first > 0 && /^\s*\|/.test(lines[first - 1])) first -= 1;
      const run = lines.slice(first);
      const formed = run.length >= 3 && /^\s*\|.*\|\s*$/.test(run[0]) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(run[1]);
      if (!formed) return rest(run.length);
      if (/^\s*\|\s*$/.test(last)) return rest(1);
      if (!/\|\s*$/.test(last)) last += ' |';
    }
    lines[lines.length - 1] = last;
    return lines.join('\n');
  }

  /** Wraps the rendered characters of each batch in a span that fades in; a fade already under way goes on from where it was. */
  function fadeIn(root, batches, now) {
    if (!batches.length) return;
    const from = batches[0].from;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    let offset = 0;
    for (const node of texts) {
      const start = offset, end = offset + node.data.length;
      offset = end;
      if (end <= from) continue;
      const parts = [];
      let cursor = start;
      for (const batch of batches) {
        const a = Math.max(batch.from, cursor), b = Math.min(batch.to, end);
        if (a >= b) continue;
        if (a > cursor) parts.push(node.data.slice(cursor - start, a - start));
        const span = h('span.fade', node.data.slice(a - start, b - start));
        span.style.animationDelay = -(now - batch.at) + 'ms';
        parts.push(span);
        cursor = b;
      }
      if (cursor === start) continue;
      if (cursor < end) parts.push(node.data.slice(cursor - start));
      node.replaceWith(...parts);
    }
  }

  window.CF.stream = {
    /**
     * render(source) draws one block of Markdown. `revealed`: the text given here is
     * shown at once (an answer opened midway); otherwise it is written out from the start.
     * onDraw runs after each change on screen, onSettled once a finished text is all shown.
     */
    create({ render, text, revealed, onDraw, onSettled }) {
      const node = h('div.assistant.streaming');
      const blocks = [];
      let full = text, final = false, shown = revealed ? text.length : 0;
      let drawn = '', last = 0, frame = 0, told = false;

      const draw = (upTo, now) => {
        const sources = chunks(full.slice(0, upTo));
        if (sources.length && !(final && upTo === full.length)) {
          const end = tidy(sources[sources.length - 1]);
          if (end.trim()) sources[sources.length - 1] = end; else sources.pop();
        }
        const fade = still.matches ? 0 : FADE;
        sources.forEach((source, index) => {
          let block = blocks[index];
          if (!block) { block = { source: null, node: h('div.chunk'), length: 0, batches: [] }; blocks.push(block); node.append(block.node); }
          if (block.source === source) return;
          block.source = source;
          const fresh = h('div.chunk', render(source));
          const length = fresh.textContent.length;
          block.batches = block.batches.filter(batch => now - batch.at < fade && batch.from < length);
          for (const batch of block.batches) batch.to = Math.min(batch.to, length);
          if (fade && length > block.length) block.batches.push({ from: block.length, to: length, at: now });
          block.length = length;
          fadeIn(fresh, block.batches, now);
          block.node.replaceWith(fresh);
          block.node = fresh;
        });
        while (blocks.length > sources.length) blocks.pop().node.remove();
      };

      const step = now => {
        frame = 0;
        const backlog = full.length - shown;
        if (backlog > 0) {
          // After a pause (a hidden window, a long stall) most of what piled up is simply there.
          if (backlog > 1500) shown = full.length - 600;
          const elapsed = last ? Math.min(now - last, 100) / 1000 : 0;
          const rate = Math.max(MIN_RATE, (full.length - shown) / ((final ? LAG / 2 : LAG) / 1000));
          shown = Math.min(full.length, shown + rate * elapsed);
        }
        last = now;
        let upTo = Math.floor(shown);
        // A Latin word appears whole, not letter by letter.
        while (upTo > 0 && upTo < full.length && /\w/.test(full[upTo]) && /\w/.test(full[upTo - 1])) upTo += 1;
        const key = upTo + (final && upTo === full.length ? ':whole' : '');
        if (key !== drawn) { drawn = key; draw(upTo, now); onDraw?.(); }
        if (shown < full.length) { frame = requestAnimationFrame(step); return; }
        last = 0;
        if (final && !told) { told = true; onSettled?.(); }
      };

      const stream = {
        node,
        /** All of the text is on screen. */
        get settled() { return shown >= full.length; },
        /** The text so far; `finished` when no more will come. */
        set(next, finished) {
          // Text that does not continue what was there (it was replaced) is shown as it is.
          if (!next.startsWith(full)) shown = next.length;
          full = next;
          final = finished;
          if (!frame) frame = requestAnimationFrame(step);
        },
        /** Before the node moves to a rebuilt turn: a move would start every running fade again. */
        detach() {
          for (const span of node.querySelectorAll('.fade')) span.classList.remove('fade');
          return node;
        },
        stop() { cancelAnimationFrame(frame); frame = 0; },
      };
      draw(Math.floor(shown), performance.now());
      drawn = String(Math.floor(shown));
      return stream;
    },
  };
})();
