/* Independent renderer of the captured coverage contract; no inline/data HTML. */
'use strict';
const status = document.getElementById('status');
const source = document.getElementById('source');
const expressions = document.getElementById('expressions');
const refresh = document.getElementById('refresh');

async function renderCoverage() {
  refresh.disabled = true;
  status.textContent = 'Loading coverage…';
  source.textContent = '';
  expressions.replaceChildren();
  try {
    const endpoint = new URL(location.href);
    endpoint.pathname = endpoint.pathname.replace(/:ruleCoverage\.html$/, ':ruleCoverage');
    const response = await fetch(endpoint, {cache: 'no-store', signal: AbortSignal.timeout(30000)});
    const report = await response.json();
    if (!response.ok) throw new Error(report.error?.message || `HTTP ${response.status}`);
    const text = report.rules.files.map(file => file.content).join('\n');
    source.textContent = text;
    const scalars = Array.from(text);
    const pending = [...(report.report || [])].reverse();
    let count = 0;
    while (pending.length) {
      const node = pending.pop();
      const position = node.sourcePosition;
      const section = document.createElement('details');
      section.className = 'coverage-expr';
      const summary = document.createElement('summary');
      const visits = (node.values || []).reduce((sum, value) => sum + value.count, 0);
      summary.textContent = `Line ${position.line}:${position.column} — ${visits} retained visits`;
      const code = document.createElement('pre');
      code.textContent = scalars.slice(position.currentOffset, position.endOffset + 1).join('');
      const values = document.createElement('pre');
      values.textContent = node.values?.length ? JSON.stringify(node.values, null, 2) : 'No retained values: not evaluated or omitted. Check report completeness above.';
      section.append(summary, code, values);
      expressions.append(section);
      count++;
      pending.push(...[...(node.children || [])].reverse());
    }
    const info = report.firesideCoverage;
    status.textContent = info?.truncated
      ? `Incomplete coverage: ${info.omittedValues} omitted values, ${info.omittedOperations} omitted operations, ${info.evictedProjects} evicted project histories. ${count} expressions shown.`
      : `${count} expressions. Actual evaluator visits; refresh manually for current results.`;
  } catch (error) {
    status.textContent = `Coverage unavailable: ${error.message}`;
  } finally {
    refresh.disabled = false;
  }
}
refresh.addEventListener('click', renderCoverage);
renderCoverage();
