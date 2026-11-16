// Monthly AI allowances per tier (UTC calendar month). See src/aiMeter.js.
//
//   monthly            — tap-started AI uses ("credits"), shown to the user
//   programGenerator   — sub-limit for the program generator (0 = not on this plan)
//   draftMessage       — sub-limit for coach message drafts (0 = not on this plan)
//   background         — per-feature cap for AI that loads on its own (Home
//                        brief, Body takeaways, …). These don't spend the
//                        visible monthly credits, so opening the app never
//                        eats a paying user's allowance, but they are capped
//                        so cost stays bounded. 0 = not on this plan.
//   allowedFeatures    — when set, only these feature keys are allowed.
//
// Coach 'programGenerator: 100' is fair use, shown in the app as "unlimited".
module.exports = {
  free: {
    monthly: 5, programGenerator: 0, draftMessage: 0, background: 0,
    allowedFeatures: ['checkin-summary', 'plateau-detector', 'macro-advisor',
      'sleep-insight', 'nutrition-review', 'program-analyser'],
  },
  pro: { monthly: 150, programGenerator: 10, draftMessage: 0, background: 100 },
  coach: { monthly: 400, programGenerator: 100, draftMessage: 300, background: 100 },
  // Client Pro (PAY2-9): Pro included by the client's coach, with a smaller
  // AI allowance and no program generator. Used when the effective plan
  // comes from source 'coach_client' (aiMeter tierFor).
  coach_client: { monthly: 30, programGenerator: 0, draftMessage: 0, background: 100 },
};

// Every AI route → feature key. Paths are relative to /api/ai.
// kind: 'credit' spends monthly credits; 'background' uses its own cap.
// limitKey: the tier field holding this feature's sub-limit.
module.exports.FEATURES = {
  '/chat':                  { key: 'coach-chat', kind: 'credit' },
  '/coach':                 { key: 'coach-chat', kind: 'credit' }, // 1 per user message
  '/coach/import-program':  { key: 'program-import', kind: 'credit' },
  '/coach/brief':           { key: 'home-brief', kind: 'background' },
  '/coach/body':            { key: 'body-takeaways', kind: 'background' },
  '/coach/review':          { key: 'weekly-review', kind: 'background' },
  '/coach/nutrition-review':{ key: 'nutrition-review', kind: 'credit' },
  '/checkin-summary':       { key: 'checkin-summary', kind: 'credit' },
  '/macro-advice':          { key: 'macro-advisor', kind: 'credit' },
  '/program-analysis':      { key: 'program-analyser', kind: 'credit' },
  '/generate-program':      { key: 'program-generator', kind: 'credit', limitKey: 'programGenerator' },
  '/plateau-check':         { key: 'plateau-detector', kind: 'credit' },
  '/coach-draft-message':   { key: 'coach-draft-message', kind: 'credit', limitKey: 'draftMessage' },
  '/profile-summary':       { key: 'profile-summary', kind: 'credit' },
  '/sleep-insight':         { key: 'sleep-insight', kind: 'credit' },
  '/rehab-plan':            { key: 'rehab-plan', kind: 'credit' },
  '/classify-exercises':    { key: 'classify-exercises', kind: 'background' },
  '/food-search-assist':    { key: 'food-search-assist', kind: 'background' },
};
