// Built-in objectionable-content list for display names, bios and usernames
// (App Store Guideline 1.2 requires filtering objectionable material). Extra
// terms can be added without a code change via OBJECTIONABLE_TERMS in .env.
//
// Matching (see containsObjectionable in src/routes/profiles.js) is
// case-insensitive and whole-word unless a term uses `*`:
//   'dick'    — only the word itself, so "Dickson" is fine
//   'bitch*'  — words starting with it: bitches, bitchy
//   '*fuck*'  — anywhere inside a word: motherfucker, clusterfuck
// Deliberately NOT listed because they're everyday or fitness words in this
// app: ass (ass day), hell, damn, crap, boobs, breast, sex, cracker, gringo.
// Letter-swapping evasions (f*ck, sh1t) are not caught; reports cover those.

const PROFANITY = [
  '*fuck*', 'fck', 'fcking', 'fuk', 'fuking', 'stfu', 'wtf',
  '*shit*',
  'cunt*',
  'bitch*', 'sonofabitch',
  'bastard*',
  'asshole*', 'arsehole*', 'dumbass*', 'jackass*', 'dumbarse*',
  'dick', 'dicks', 'dickhead*',
  'cock', 'cocks', 'cocksuck*',
  'prick', 'pricks',
  'piss', 'pisser', 'pissing',
  'twat*', 'wank*', 'bollock*', 'bellend*', 'knobhead*', 'tosser*',
  'douche*', 'bullshit*',
  'pussy', 'pussies',
  'slut*', 'whore*', 'skank*', 'thot', 'thots',
  // sexual
  'blowjob*', 'handjob*', 'rimjob*', 'porn*', 'cum', 'cumshot*', 'jizz*',
  'dildo*', 'tits', 'titties', 'milf*', 'onlyfans',
];

const SLURS = [
  // racial / ethnic
  'nigger*', 'nigga*', 'niggaz', 'nig', 'negro', 'negroes',
  'coon', 'coons', 'jungle bunny', 'porch monkey',
  'chink*', 'gook*', 'jap', 'japs', 'zipperhead*', 'chinaman', 'slanty',
  'spic', 'spics', 'spick*', 'wetback*', 'beaner*',
  'kike*', 'kyke', 'yid', 'yids', 'heeb', 'hymie',
  'paki', 'pakis', 'raghead*', 'towelhead*', 'camel jockey',
  'wog', 'wogs', 'golliwog*', 'dago*', 'wop', 'wops', 'polack*',
  'gyppo*', 'gypo', 'pikey*', 'kaffir*', 'abo', 'abos',
  'redskin*', 'injun*', 'halfbreed*',
  // homophobic / transphobic
  'faggot*', 'fag', 'fags', 'faggy', 'dyke', 'dykes', 'lesbo*',
  'homo', 'homos', 'poof', 'poofs', 'poofter*', 'batty boy', 'tranny', 'trannies', 'shemale*',
  // ableist
  'retard', 'retards', 'retarded', 'spaz', 'spastic', 'mong', 'mongoloid*',
  // hate
  'heil hitler', 'sieg heil', 'white power', 'kkk', '1488',
];

module.exports = { DEFAULT_OBJECTIONABLE_TERMS: [...PROFANITY, ...SLURS] };
