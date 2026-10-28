// Tests for the AI food search assist (src/nutrition/searchAssist.js) with a
// fake model and a fake searcher. No network. Run: node scripts/test-search-assist.js
'use strict';

const sa = require('../src/nutrition/searchAssist');

let total = 0;
let failures = 0;
const check = (label, cond, extra) => {
  total++;
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};

// ── Parsing the model's reply ───────────────────────────────────────────────
{
  const r = sa.parseReply('Sure! {"corrected":"griekse yoghurt 0%","english":"greek yogurt nonfat","brand":null,"alternatives":["magere kwark","skyr naturel","griekse yoghurt 0%","x","a","b","c"]} hope that helps', 'yoghurd griekse 0%');
  check('parse: rewrite read from surrounding text', r && r.corrected === 'griekse yoghurt 0%' && r.english === 'greek yogurt nonfat' && r.brand === null);
  check('parse: alternatives deduped, too-short dropped, max 3', r && JSON.stringify(r.alternatives) === '["magere kwark","skyr naturel"]', r && r.alternatives);
}
{
  const r = sa.parseReply('{"corrected":"<script>alert(1)</script> kwark","english":"quark","brand":"Jumbo<b>","alternatives":[]}', 'kwrak');
  check('parse: markup characters stripped', r && !/[<>]/.test(r.corrected + r.brand) && r.corrected.includes('kwark'), r);
}
check('parse: not JSON → null', sa.parseReply('I cannot help with that', 'x y') === null);
check('parse: empty strings → null', sa.parseReply('{"corrected":"","english":"","brand":null,"alternatives":[]}', 'xy') === null);
check('parse: long terms cut to 60 chars', sa.parseReply(`{"corrected":"${'a'.repeat(200)}","english":"b b","brand":null,"alternatives":[]}`, 'xy').corrected.length === 60);
check('cleanQuery: too short / ok', sa.cleanQuery(' a ') === null && sa.cleanQuery('  Yoghurd  ') === 'yoghurd');

// ── assist() with fakes ─────────────────────────────────────────────────────
const mk = (id, name, source, extra = {}) => ({ id, source, name, brand: '', per100: { kcal: 50, protein: 9, carbs: 4, fat: 0 }, servings: [], ...extra });

function fakeSearcher() {
  const calls = [];
  return {
    calls,
    search: async (q, { sources }) => {
      calls.push({ q, sources });
      if (sources === 'off') return { foods: [mk('off:2', 'Griekse yoghurt 10%', 'off', { nl: true }), mk('off:1', 'Griekse yoghurt 0%', 'off', { nl: true })], sources: { off: 'ok' } };
      return { foods: [mk('usda:1', 'Yogurt, Greek, plain, nonfat', 'usda', { dataType: 'Survey (FNDDS)' })], sources: { usda: 'ok' } };
    },
  };
}

(async () => {
  try {
    let modelCalls = 0;
    const model = async (_m, params) => {
      modelCalls++;
      check('model: only the search words are sent', params.messages[0].content === JSON.stringify({ search: 'yoghurd griekse 0%' }));
      return { content: [{ type: 'text', text: '{"corrected":"griekse yoghurt 0%","english":"greek yogurt nonfat","brand":null,"alternatives":["magere kwark"]}' }] };
    };
    const searcher = fakeSearcher();
    const assist = sa.createSearchAssist({ searcher, createMessageFn: model, log: { warn() {} } });
    const out = await assist.assist('yoghurd griekse 0%');
    check('assist: rewrite returned', out.rewrite && out.rewrite.corrected === 'griekse yoghurt 0%' && out.rewrite.alternatives[0] === 'magere kwark');
    check('assist: OFF searched with the corrected words, USDA with the English ones',
      searcher.calls.some(c => c.sources === 'off' && c.q === 'griekse yoghurt 0%') && searcher.calls.some(c => c.sources === 'usda' && c.q === 'greek yogurt nonfat'), searcher.calls);
    check('assist: Dutch match first, USDA generic included', out.foods[0].id === 'off:1' && out.foods.some(f => f.id === 'usda:1'), out.foods.map(f => f.id));
    await assist.assist('yoghurd griekse 0%');
    check('assist: same search again uses the cached rewrite (no model call)', modelCalls === 1, modelCalls);

    const bad = sa.createSearchAssist({ searcher: fakeSearcher(), createMessageFn: async () => ({ content: [{ type: 'text', text: 'nope' }] }), log: { warn() {} } });
    const none = await bad.assist('qqqq');
    check('assist: unusable reply → rewrite null, no foods, no search', none.rewrite === null && none.foods.length === 0);

    const failing = sa.createSearchAssist({ searcher: fakeSearcher(), createMessageFn: async () => { throw new Error('all providers down'); }, log: { warn() {} } });
    let threw = false;
    try { await failing.assist('kwark'); } catch { threw = true; }
    check('assist: model failure surfaces as an error (route answers 502)', threw);
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    console.log(`\n${total - failures}/${total} passed`);
    process.exitCode = failures ? 1 : 0;
  }
})();
