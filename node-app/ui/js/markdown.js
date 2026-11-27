'use strict';
// Minimal Markdown → DOM renderer for assistant replies. Builds nodes only
// (never innerHTML), so model output cannot inject markup or scripts.
(() => {
  const { h } = window.CF;

  function inline(text) {
    const nodes = [];
    const pattern = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      if (match[1]) nodes.push(h('code', match[2]));
      else if (match[3] || match[4]) nodes.push(h('strong', inline(match[3] || match[4])));
      else if (match[5] || match[6]) nodes.push(h('em', inline(match[5] || match[6])));
      else if (match[7]) nodes.push(link(match[8], inline(match[7])));
      else if (match[9]) nodes.push(link(match[9], match[9]));
      last = match.index + match[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  function link(href, children) {
    // Only web links are clickable; file and other schemes stay plain text. The desktop shell opens them in the system browser.
    // conv:<id> names a conversation; whoever shows the text decides what it opens (领航 does).
    if (/^conv:[\w-]+$/.test(href)) return h('span', { dataset: { conv: href.slice(5) } }, children);
    if (!/^https?:\/\//i.test(href)) return h('span', children);
    return h('a', { href, title: href, target: '_blank', rel: 'noopener noreferrer' }, children);
  }

  function table(lines) {
    const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    const [head, , ...body] = lines;
    return h('table', h('thead', h('tr', cells(head).map(cell => h('th', inline(cell))))),
      h('tbody', body.map(row => h('tr', cells(row).map(cell => h('td', inline(cell)))))));
  }

  window.CF.markdown = source => {
    const root = document.createDocumentFragment();
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
      if (fence) {
        const body = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
        index += 1;
        // A job's criteria (see job.js) read as a checklist, not as code.
        if (/^\s*```\s*(标准|做完的标准)\s*$/.test(line) && window.CF.job) { root.append(window.CF.job.criteriaBlock(body.join('\n'))); continue; }
        root.append(h('pre', h('code', { dataset: { lang: fence[2] || '' } }, body.join('\n'))));
        continue;
      }
      if (!line.trim()) { index += 1; continue; }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) { root.append(h('h' + Math.min(heading[1].length + 0, 3), inline(heading[2]))); index += 1; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.append(h('hr')); index += 1; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1] || '')) {
        const rows = [];
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) rows.push(lines[index++]);
        root.append(table(rows));
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
        root.append(h('blockquote', window.CF.markdown(quote.join('\n'))));
        continue;
      }
      const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) {
        const ordered = /\d/.test(item[2]);
        const list = h(ordered ? 'ol' : 'ul');
        while (index < lines.length) {
          const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
          if (!current || /\d/.test(current[2]) !== ordered) break;
          const parts = [current[3]];
          index += 1;
          while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index])) parts.push(lines[index++].trim());
          const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(parts[0]);
          list.append(h('li', checkbox ? [checkbox[1] === ' ' ? '☐ ' : '☑ ', inline([checkbox[2], ...parts.slice(1)].join(' '))] : inline(parts.join(' '))));
        }
        root.append(list);
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[index])) paragraph.push(lines[index++]);
      if (!paragraph.length) paragraph.push(lines[index++]);
      const nodes = [];
      paragraph.forEach((text, position) => { if (position) nodes.push(h('br')); nodes.push(...inline(text)); });
      root.append(h('p', nodes));
    }
    return root;
  };
})();
