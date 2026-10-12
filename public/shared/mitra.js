/**
 * Mitra — the assistant's brain.
 *
 * Runs identically on the phone (offline, instant) and on the server. It is
 * deliberately not a language model: it understands a fixed set of things a
 * pilgrim actually needs, in Hindi, Marathi, English and romanised Hindi, and
 * answers each one by CALLING the same routing, crowd and group data the rest
 * of the app uses. It cannot invent a place, a route or a time, because it
 * never writes one — it only reads them.
 *
 * What makes it more than keyword spotting:
 *
 *  - Word-boundary matching for short Latin words ("eat" no longer fires on
 *    "great", "bus" on "business"), and Devanagari normalised so ड़/ड and
 *    ँ/ं spellings match.
 *  - An ordered rule set rather than a score race, so "where is the medical
 *    post" finds the medical post instead of raising an emergency, and
 *    "पानी कहाँ है" means water, not family.
 *  - Place nicknames and typo tolerance ("sangham", "gate 2", "bhandara").
 *  - Memory of the last place, so "is it crowded there?", "how far?",
 *    "another one?" and "let's go" mean what they say.
 *  - Answers carry actions (start walking, show on map, call 108, raise an
 *    alert) and follow-up suggestions, not just a sentence.
 */

import { NODES, NODE_BY_ID, EDGES } from './mela-map.js';
import { route, directions, nearest, levelFor } from './routing.js';

/* ----------------------------------------------------------- text ----- */

const DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };

/** Lowercase, drop punctuation and nuktas, unify ँ/ं and Devanagari digits. */
export function norm(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/़/g, '')            // nukta: ड़ -> ड, ज़ -> ज
    .replace(/ँ/g, 'ं')      // chandrabindu -> anusvara
    .normalize('NFC')
    .toLowerCase()
    .replace(/[०-९]/g, (d) => DIGITS[d])
    .replace(/[?!.,;:।॥"'`()\-–—/&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isLatin = (s) => /^[a-z0-9 ]+$/.test(s);

/**
 * Does the (normalised) text contain this keyword, as words?
 *
 *  - Latin: whole words, plus a plural "s"/"es" — "toilet" matches
 *    "toilets", but "eat" does not match "great" and "hi" not "hindi".
 *  - Devanagari: from the start of a word, so inflections still match
 *    ("घाट" in "घाटों"); keywords of one or two letters must be the whole
 *    word, so Marathi "हो" (yes) does not fire inside "होगा".
 */
const patterns = new Map();
function has(t, keyword) {
  const k = norm(keyword);
  if (!k) return false;
  let re = patterns.get(k);
  if (!re) {
    if (isLatin(k)) re = new RegExp(`(^| )${k}(s|es)?(?= |$)`);
    else if ([...k].length <= 2) re = new RegExp(`(^| )${k}(?= |$)`);
    else re = new RegExp(`(^| )${k}`);
    patterns.set(k, re);
  }
  return re.test(t);
}
const any = (t, list) => list.some((k) => has(t, k));

function edits(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length];
}

/* -------------------------------------------------------- vocabulary --- */

const W = {
  where: ['where', 'kahan', 'kaha', 'kidhar', 'कहाँ', 'कहां', 'किधर', 'कुठे'],
  when: ['when', 'what time', 'timing', 'kab', 'kitne baje', 'samay', 'schedule', 'कब', 'कितने बजे', 'समय', 'कधी', 'किती वाजता', 'वेळ'],
  crowd: ['crowd', 'crowded', 'crowds', 'rush', 'busy', 'packed', 'bheed', 'bheedh', 'bhid', 'bheer', 'bhir', 'rash', 'भीड', 'गर्दी', 'रश'],
  less: ['least', 'less', 'empty', 'quiet', 'khali', 'kam bheed', 'kam bhid', 'कम', 'खाली', 'शांत', 'सबसे कम', 'कमी', 'रिकामा'],
  which: ['which', 'kaunsa', 'kaun sa', 'konsa', 'best', 'कौन सा', 'कौनसा', 'कोणता', 'सबसे अच्छा', 'सर्वात'],
  there: ['there', 'that place', 'it', 'wahan', 'waha', 'vahan', 'udhar', 'वहाँ', 'वहां', 'उधर', 'तिथे', 'तिकडे', 'तेथे'],
  far: ['how far', 'distance', 'kitni door', 'kitna door', 'kitna dur', 'kitni dur', 'कितनी दूर', 'कितना दूर', 'दूरी', 'किती लांब', 'किती दूर', 'अंतर'],
  another: ['another', 'other one', 'something else', 'next one', 'aur koi', 'dusra', 'doosra', 'koi aur', 'और कोई', 'दूसरा', 'कोई और', 'आणखी', 'दुसरा', 'दुसरे'],
  go: ['lets go', 'let s go', 'start', 'take me', 'navigate', 'chalo', 'le chalo', 'chalen', 'चलो', 'ले चलो', 'चलें', 'चला', 'घेऊन चला', 'सुरू करा'],
  yes: ['yes', 'ok', 'okay', 'haan', 'han', 'ha ji', 'theek hai', 'हाँ', 'हां', 'ठीक है', 'होय', 'हो'],
  way: ['route', 'way to', 'directions', 'how to reach', 'how do i get', 'rasta', 'raasta', 'kaise jaye', 'kaise jau', 'kaise pahunche', 'रास्ता', 'कैसे जाएं', 'कैसे जाऊं', 'कैसे पहुंचे', 'मार्ग', 'कसे जायचे', 'वाट'],
  greet: ['hi', 'hello', 'hey', 'namaste', 'namaskar', 'pranam', 'ram ram', 'jai shri ram', 'har har mahadev', 'नमस्ते', 'नमस्कार', 'प्रणाम', 'राम राम', 'जय श्री राम', 'हर हर महादेव'],
  thanks: ['thanks', 'thank you', 'thank u', 'dhanyavad', 'dhanyawad', 'shukriya', 'धन्यवाद', 'शुक्रिया', 'आभार'],
  capabilities: ['what can you do', 'what do you do', 'how to use', 'help me use', 'kya kar sakte', 'kya kya', 'तुम क्या कर', 'आप क्या कर', 'क्या कर सकते', 'तू काय करू', 'काय करू शकतो'],
  whereAmI: ['where am i', 'my location', 'my place', 'main kahan hoon', 'main kaha hu', 'mai kahan hu', 'मैं कहाँ हूँ', 'मैं कहां हूं', 'मेरी जगह', 'मी कुठे आहे', 'माझे ठिकाण'],
  notices: ['notice', 'announcement', 'news', 'update', 'suchna', 'khabar', 'ghoshna', 'सूचना', 'घोषणा', 'खबर', 'बातमी', 'नोटीस'],
  helpline: ['helpline', 'help line', 'helplines', 'phone number', 'emergency number', 'emergency numbers', 'contact number', 'police number', 'ambulance number', 'हेल्पलाइन', 'आपातकालीन नंबर', 'इमरजेंसी नंबर', 'आपत्कालीन क्रमांक'],
  number: ['number', 'numbers', 'नंबर', 'क्रमांक'],
  family: ['family', 'my group', 'parivar', 'pariwar', 'ghar wale', 'gharwale', 'saathi', 'परिवार', 'घरवाले', 'साथी', 'कुटुंब', 'मेरा ग्रुप'],
  relation: ['papa', 'pappa', 'mummy', 'mummy', 'mom', 'dad', 'maa', 'baba', 'beta', 'beti', 'son', 'daughter', 'dadi', 'dada', 'nani', 'nana', 'bhai', 'behen', 'wife', 'husband', 'patni', 'pati', 'पापा', 'मम्मी', 'माँ', 'मां', 'बाबा', 'बेटा', 'बेटी', 'दादी', 'दादा', 'नानी', 'नाना', 'भाई', 'बहन', 'पत्नी', 'पति', 'आई', 'वडील', 'मुलगा', 'मुलगी', 'आजी', 'आजोबा'],
  lost: ['lost', 'missing', 'kho gaya', 'kho gayi', 'kho gya', 'gum ho', 'gum gaya', 'nahi mil raha', 'nahi mil rahi', 'cant find', 'cannot find', 'can t find', 'खो गया', 'खो गई', 'खोया', 'गुम', 'नहीं मिल रहा', 'नहीं मिल रही', 'हरवले', 'हरवला', 'हरवली', 'सापडत नाही'],
  item: ['phone', 'mobile', 'bag', 'purse', 'wallet', 'chappal', 'shoes', 'joote', 'saman', 'samaan', 'luggage', 'keys', 'chabi', 'फोन', 'मोबाइल', 'बैग', 'पर्स', 'बटुआ', 'चप्पल', 'जूते', 'सामान', 'चाबी', 'पिशवी', 'पाकीट'],
};

/** Urgent phrases. Deliberately specific: "doctor kahan hai" is a question, not an emergency. */
const URGENT = {
  lost_self: ['i am lost', 'im lost', 'i m lost', 'i got lost', 'main kho gaya', 'main kho gayi', 'mai kho gaya', 'raasta bhool', 'rasta bhool', 'मैं खो गया', 'मैं खो गई', 'रास्ता भूल', 'मी हरवलो', 'मी हरवले', 'वाट चुकलो', 'वाट चुकले'],
  crowd_crush: ['stampede', 'crush', 'bhagdad', 'bhagdar', 'dab raha', 'dam ghut', 'saans nahi aa', 'can t breathe', 'cannot breathe', 'pushing', 'dhakka mukki', 'भगदड', 'दम घुट', 'धक्का मुक्की', 'चेंगराचेंगरी', 'दबा जा', 'सांस नहीं आ'],
  medical: ['ambulance', 'unconscious', 'fainted', 'not breathing', 'heart attack', 'chest pain', 'bleeding', 'accident', 'injured', 'seizure', 'behosh', 'gir gaya', 'gir gayi', 'chot lagi', 'khoon beh', 'saans nahi le', 'dil ka daura', 'बेहोश', 'गिर गया', 'गिर गई', 'चोट लगी', 'खून बह', 'सांस नहीं ले', 'सीने में दर्द', 'दिल का दौरा', 'बेशुद्ध', 'अपघात', 'छातीत दुखत'],
  other: ['bachao', 'save me', 'i need help', 'need help now', 'emergency', 'madad karo', 'madad chahiye', 'बचाओ', 'मदद करो', 'मदद चाहिए', 'वाचवा', 'मदत करा', 'मदत हवी'],
};

const FACILITY = [
  { type: 'toilet', words: ['toilet', 'washroom', 'bathroom', 'loo', 'urinal', 'shauchalay', 'latrine', 'peshab', 'शौचालय', 'बाथरूम', 'टॉयलेट', 'पेशाब', 'स्वच्छतागृह', 'मुतारी'] },
  { type: 'water', words: ['water', 'drinking', 'pani', 'paani', 'thirsty', 'pyaas', 'pyas', 'पानी', 'प्यास', 'पाणी', 'तहान'] },
  { type: 'medical', words: ['medical', 'first aid', 'doctor', 'hospital', 'clinic', 'medicine', 'dawa', 'dawai', 'chikitsa', 'aspatal', 'डॉक्टर', 'दवा', 'दवाई', 'चिकित्सा', 'अस्पताल', 'दवाखाना', 'वैद्यकीय', 'औषध'] },
  { type: 'food', words: ['food', 'eat', 'eating', 'hungry', 'meal', 'bhandara', 'khana', 'bhookh', 'bhukh', 'langar', 'prasad', 'खाना', 'भूख', 'भंडारा', 'लंगर', 'प्रसाद', 'जेवण', 'भूक'] },
  { type: 'police', words: ['police', 'chowki', 'lost and found', 'khoya paya', 'पुलिस', 'चौकी', 'खोया पाया', 'पोलीस'] },
  { type: 'ghat', words: ['ghat', 'snan', 'bathing', 'dip', 'nahana', 'nahane', 'घाट', 'स्नान', 'नहाना', 'नहाने', 'आंघोळ'] },
  { type: 'gate', words: ['gate', 'exit', 'way out', 'bahar', 'nikas', 'nikalna', 'गेट', 'बाहर', 'निकास', 'निकलना', 'बाहेर'] },
  { type: 'camp', words: ['camp', 'tent', 'shivir', 'sector', 'शिविर', 'तंबू', 'सेक्टर', 'शिबिर'] },
];

/** Nicknames people actually use for places. Names in all three languages are added automatically. */
const ALIASES = {
  ghat_sangam: ['sangam', 'sangam ghat', 'triveni', 'संगम', 'त्रिवेणी'],
  ghat_ram: ['ram ghat', 'raam ghat'],
  ghat_hanuman: ['hanuman ghat', 'hanuman', 'हनुमान'],
  gate_1: ['gate 1', 'gate one', 'gate number 1', 'gate no 1', 'bus stand', 'bus adda', 'बस अड्डा', 'गेट 1', 'बस स्थानक'],
  gate_2: ['gate 2', 'gate two', 'gate number 2', 'gate no 2', 'railway', 'railway station', 'station', 'रेलवे', 'स्टेशन', 'गेट 2'],
  gate_3: ['gate 3', 'gate three', 'gate number 3', 'gate no 3', 'parking', 'पार्किंग', 'गेट 3'],
  police_1: ['chowki', 'lost and found', 'khoya paya', 'police chowki', 'चौकी', 'खोया पाया'],
  food_1: ['bhandara', 'bhandara hall', 'langar', 'भंडारा'],
  med_1: ['medical post 1', 'medical 1'],
  med_2: ['medical post 2', 'medical 2'],
  toilet_1: ['north toilet', 'toilet north', 'toilets north'],
  toilet_2: ['south toilet', 'toilet south', 'toilets south'],
  water_1: ['water point 1', 'water 1'],
  water_2: ['water point 2', 'water 2'],
  camp_a: ['sector a', 'camp a'],
  camp_b: ['sector b', 'camp b'],
  camp_c: ['sector c', 'camp c'],
  camp_d: ['sector d', 'camp d'],
  j_c: ['main crossing'],
};

const PLACE_NAMES = (() => {
  const list = [];
  for (const node of NODES) {
    const names = new Set([...(ALIASES[node.id] ?? []), ...Object.values(node.name)].map(norm));
    for (const n of names) if (n.length >= 3) list.push({ id: node.id, name: n });
  }
  // Longest first, so "sangam approach" beats "sangam".
  return list.sort((a, b) => b.name.length - a.name.length);
})();

/** The place named in the text, if any — exact first, then a near spelling. */
export function findPlace(text) {
  const t = norm(text);
  for (const { id, name } of PLACE_NAMES) if (has(t, name)) return NODE_BY_ID[id];
  // Typo tolerance for Latin spellings ("sangham ghat", "hanumaan").
  const tokens = t.split(' ').filter((w) => isLatin(w));
  let best = null;
  for (const { id, name } of PLACE_NAMES) {
    if (!isLatin(name) || name.length < 5) continue;
    const words = name.split(' ').length;
    for (let i = 0; i + words <= tokens.length; i += 1) {
      const chunk = tokens.slice(i, i + words).join(' ');
      const d = edits(chunk, name);
      const allowed = name.length >= 9 ? 2 : 1;
      if (d <= allowed && (!best || d < best.d)) best = { id, d };
    }
  }
  return best ? NODE_BY_ID[best.id] : null;
}

/* ----------------------------------------------------------- phrases --- */

const nameOf = (node, lang) => node?.name?.[lang] ?? node?.name?.hi ?? node?.name?.en ?? '';

const TYPE_WORD = {
  toilet: { en: 'toilet', hi: 'शौचालय', mr: 'स्वच्छतागृह' },
  water: { en: 'water point', hi: 'पानी केंद्र', mr: 'पाणी केंद्र' },
  medical: { en: 'medical post', hi: 'चिकित्सा केंद्र', mr: 'वैद्यकीय केंद्र' },
  food: { en: 'food hall', hi: 'भंडारा', mr: 'भंडारा' },
  police: { en: 'Lost & Found chowki', hi: 'खोया-पाया चौकी', mr: 'हरवले-सापडले चौकी' },
  ghat: { en: 'ghat', hi: 'घाट', mr: 'घाट' },
  gate: { en: 'gate', hi: 'गेट', mr: 'गेट' },
  camp: { en: 'camp', hi: 'शिविर', mr: 'शिबिर' },
};

const P = {
  en: {
    nearest: (type, place, m, min) => `Nearest ${type}: ${place} — ${m} m, about ${min} min walk.`,
    routeTo: (place, m, min) => `${place} — ${m} m, about ${min} min walk.`,
    here: (place) => `You are already at ${place}.`,
    alsoCrowded: 'Part of the way is very crowded and there is no quieter route — go slowly.',
    allClosed: (place) => `Every way to ${place} is closed right now. Please wait or ask a volunteer.`,
    noneLeft: (type) => `That was the last ${type} I can reach from here.`,
    crowd: {
      packed: (p, min) => `${p} is packed${min != null ? ` — full in about ${min} min` : ''}. Do not go there now.`,
      filling: (p, min) => `${p} is filling up fast${min != null ? ` — packed in about ${min} min` : ''}.`,
      heavy: (p) => `The paths to ${p} are very crowded right now.`,
      busy: (p) => `${p} is busy, but moving.`,
      clear: (p) => `${p} is clear right now.`,
      closed: (p) => `Every way into ${p} is closed right now.`,
      partClosed: (n) => ` ${n} approach${n > 1 ? 'es are' : ' is'} closed.`,
    },
    tryInstead: (p, min) => `Try ${p} instead — ${min} min walk, calmer.`,
    overall: (list) => `Crowd building at: ${list}.`,
    overallCalm: 'No crowd warnings right now. All main paths are moving.',
    closedPaths: (n) => ` ${n} path${n > 1 ? 's are' : ' is'} closed — your route avoids ${n > 1 ? 'them' : 'it'}.`,
    bestGhat: (p, min, word) => `Best ghat right now: ${p} — ${min} min walk, ${word}.`,
    avoid: (list) => ` Avoid ${list} for now.`,
    calmWord: { 1: 'clear', 2: 'a little busy', 3: 'crowded', 4: 'closed' },
    youAre: (p, gps) => `You are at ${p}${gps ? ' (from your GPS)' : ' (the place you chose)'}.`,
    nearby: (list) => ` Nearby: ${list}.`,
    member: (name, p, ago) => `${name} is at ${p}${ago ? `, ${ago}` : ''}.`,
    memberHidden: (name) => `${name} is not sharing their place right now.`,
    memberUnknown: (name) => `${name} has not shared a place yet.`,
    noGroup: 'You have not made a family group yet. Make one so you can see each other on the map.',
    nobodyShared: 'Nobody in your group is sharing their place right now.',
    event: (title, when, p) => `${title} — ${when}${p ? `, at ${p}` : ''}.`,
    noEvents: 'Nothing else is scheduled today.',
    notices: (list) => list,
    noNotices: 'No announcements right now.',
    helplines: 'Emergency numbers. In the mela, the Lost & Found chowki and any volunteer can also help.',
    lostItem: (p, min) => `For a lost ${'item'}, go to ${p} — ${min} min walk. Volunteers there keep a lost-and-found register.`,
    far: (p, m, min) => `${p} is ${m} m away — about ${min} min walk.`,
    sos: {
      lost_self: 'Stay where you are. I will alert a volunteer with your place — press the red button below.',
      crowd_crush: 'Move to the side, away from the push, and keep your arms up near your chest. Press the red button to alert volunteers now.',
      medical: 'Press the red button to send a volunteer with medical training. For an ambulance, call 108.',
      lost_person: 'Press the red button and describe them — volunteers will start looking straight away.',
      other: 'Press the red button and a volunteer will come to your place.',
    },
    medicalSafety: 'If someone is badly hurt, do not walk — raise an alert instead.',
    greet: 'Namaste! Ask me where things are, which ghat is least crowded, when the aarti is, or where your family is.',
    thanks: 'You are welcome. Stay safe and keep your group together.',
    capabilities: 'I can find toilets, water, food and medical posts, show the least crowded ghat, tell you if a place is crowded, find your family, tell you event times and announcements, and give emergency numbers. I work even with no network.',
    unknown: 'I did not quite follow. You can ask things like these:',
    happening: 'happening now',
    inMin: (n) => `in ${n} min`,
    inHours: (n) => `in ${n} h`,
    agoMin: (n) => (n < 1 ? 'just now' : `${n} min ago`),
  },
  hi: {
    nearest: (type, place, m, min) => `सबसे पास ${type}: ${place} — ${m} मीटर, लगभग ${min} मिनट पैदल।`,
    routeTo: (place, m, min) => `${place} — ${m} मीटर, लगभग ${min} मिनट पैदल।`,
    here: (place) => `आप पहले से ${place} पर हैं।`,
    alsoCrowded: 'रास्ते का एक हिस्सा बहुत भीड़ वाला है और दूसरा शांत रास्ता नहीं है — धीरे चलिए।',
    allClosed: (place) => `${place} जाने के सभी रास्ते अभी बंद हैं। रुकिए या स्वयंसेवक से पूछिए।`,
    noneLeft: (type) => `यहाँ से पहुँचने लायक यह आखिरी ${type} था।`,
    crowd: {
      packed: (p, min) => `${p} पूरी तरह भरा है${min != null ? ` — लगभग ${min} मिनट में` : ''}। अभी वहाँ मत जाइए।`,
      filling: (p, min) => `${p} तेज़ी से भर रहा है${min != null ? ` — लगभग ${min} मिनट में पूरा भर जाएगा` : ''}।`,
      heavy: (p) => `${p} के रास्तों पर अभी बहुत भीड़ है।`,
      busy: (p) => `${p} पर भीड़ है, पर लोग आगे बढ़ रहे हैं।`,
      clear: (p) => `${p} पर अभी भीड़ नहीं है।`,
      closed: (p) => `${p} जाने के सभी रास्ते अभी बंद हैं।`,
      partClosed: (n) => ` ${n} रास्ते बंद हैं।`,
    },
    tryInstead: (p, min) => `इसके बजाय ${p} जाइए — ${min} मिनट पैदल, कम भीड़।`,
    overall: (list) => `इन जगहों पर भीड़ बढ़ रही है: ${list}।`,
    overallCalm: 'अभी कहीं भीड़ की चेतावनी नहीं है। मुख्य रास्ते चल रहे हैं।',
    closedPaths: (n) => ` ${n} रास्ते बंद हैं — आपका रास्ता उनसे बचकर जाएगा।`,
    bestGhat: (p, min, word) => `अभी सबसे अच्छा घाट: ${p} — ${min} मिनट पैदल, ${word}।`,
    avoid: (list) => ` अभी ${list} से बचिए।`,
    calmWord: { 1: 'भीड़ नहीं', 2: 'थोड़ी भीड़', 3: 'भारी भीड़', 4: 'बंद' },
    youAre: (p, gps) => `आप ${p} पर हैं${gps ? ' (GPS से)' : ' (आपकी चुनी हुई जगह)'}।`,
    nearby: (list) => ` पास में: ${list}।`,
    member: (name, p, ago) => `${name} ${p} पर हैं${ago ? `, ${ago}` : ''}।`,
    memberHidden: (name) => `${name} अभी अपनी जगह नहीं दिखा रहे।`,
    memberUnknown: (name) => `${name} ने अभी जगह साझा नहीं की।`,
    noGroup: 'आपने अभी परिवार समूह नहीं बनाया है। समूह बनाइए ताकि नक्शे पर एक-दूसरे को देख सकें।',
    nobodyShared: 'आपके समूह में अभी कोई जगह नहीं दिखा रहा।',
    event: (title, when, p) => `${title} — ${when}${p ? `, ${p} पर` : ''}।`,
    noEvents: 'आज और कोई कार्यक्रम नहीं है।',
    notices: (list) => list,
    noNotices: 'अभी कोई सूचना नहीं है।',
    helplines: 'आपातकालीन नंबर। मेले में खोया-पाया चौकी और कोई भी स्वयंसेवक मदद कर सकता है।',
    lostItem: (p, min) => `खोया सामान: ${p} जाइए — ${min} मिनट पैदल। वहाँ खोया-पाया रजिस्टर है।`,
    far: (p, m, min) => `${p} ${m} मीटर दूर है — लगभग ${min} मिनट पैदल।`,
    sos: {
      lost_self: 'जहाँ हैं वहीं रुकिए। नीचे लाल बटन दबाइए — स्वयंसेवक को आपकी जगह भेजी जाएगी।',
      crowd_crush: 'धक्के से हटकर किनारे जाइए, हाथ सीने के पास ऊपर रखिए। अभी लाल बटन दबाइए।',
      medical: 'लाल बटन दबाइए — चिकित्सा प्रशिक्षित स्वयंसेवक आएगा। एम्बुलेंस के लिए 108 पर कॉल कीजिए।',
      lost_person: 'लाल बटन दबाइए और उनका हुलिया बताइए — स्वयंसेवक तुरंत ढूँढना शुरू करेंगे।',
      other: 'लाल बटन दबाइए — स्वयंसेवक आपकी जगह पर आएगा।',
    },
    medicalSafety: 'अगर किसी को गंभीर चोट है तो चलिए मत — लाल बटन दबाइए।',
    greet: 'नमस्ते! पूछिए — शौचालय कहाँ है, कौन सा घाट खाली है, आरती कब है, या परिवार कहाँ है।',
    thanks: 'आपका स्वागत है। सुरक्षित रहिए और अपने लोगों के साथ रहिए।',
    capabilities: 'मैं शौचालय, पानी, भोजन और चिकित्सा केंद्र ढूँढ सकता हूँ, सबसे कम भीड़ वाला घाट बता सकता हूँ, किसी जगह की भीड़ बता सकता हूँ, परिवार को ढूँढ सकता हूँ, कार्यक्रम और सूचनाएँ बता सकता हूँ, और आपातकालीन नंबर दे सकता हूँ। बिना नेटवर्क के भी।',
    unknown: 'मैं ठीक से समझ नहीं पाया। ऐसे पूछिए:',
    happening: 'अभी चल रहा है',
    inMin: (n) => `${n} मिनट में`,
    inHours: (n) => `${n} घंटे में`,
    agoMin: (n) => (n < 1 ? 'अभी' : `${n} मिनट पहले`),
  },
  mr: {
    nearest: (type, place, m, min) => `जवळचे ${type}: ${place} — ${m} मीटर, सुमारे ${min} मिनिटे चालत.`,
    routeTo: (place, m, min) => `${place} — ${m} मीटर, सुमारे ${min} मिनिटे चालत.`,
    here: (place) => `तुम्ही आधीच ${place} येथे आहात.`,
    alsoCrowded: 'मार्गाचा काही भाग खूप गर्दीचा आहे आणि शांत मार्ग नाही — हळू चला.',
    allClosed: (place) => `${place} कडे जाणारे सर्व मार्ग सध्या बंद आहेत. थांबा किंवा स्वयंसेवकाला विचारा.`,
    noneLeft: (type) => `इथून पोहोचता येणारे हे शेवटचे ${type} होते.`,
    crowd: {
      packed: (p, min) => `${p} पूर्ण भरले आहे${min != null ? ` — सुमारे ${min} मिनिटांत` : ''}. आत्ता तिथे जाऊ नका.`,
      filling: (p, min) => `${p} वेगाने भरत आहे${min != null ? ` — सुमारे ${min} मिनिटांत पूर्ण भरेल` : ''}.`,
      heavy: (p) => `${p} कडील मार्गांवर सध्या खूप गर्दी आहे.`,
      busy: (p) => `${p} वर गर्दी आहे, पण लोक पुढे सरकत आहेत.`,
      clear: (p) => `${p} वर सध्या गर्दी नाही.`,
      closed: (p) => `${p} कडे जाणारे सर्व मार्ग सध्या बंद आहेत.`,
      partClosed: (n) => ` ${n} मार्ग बंद आहेत.`,
    },
    tryInstead: (p, min) => `त्याऐवजी ${p} ला जा — ${min} मिनिटे चालत, कमी गर्दी.`,
    overall: (list) => `इथे गर्दी वाढत आहे: ${list}.`,
    overallCalm: 'सध्या कुठेही गर्दीची सूचना नाही. मुख्य मार्ग चालू आहेत.',
    closedPaths: (n) => ` ${n} मार्ग बंद आहेत — तुमचा मार्ग ते टाळेल.`,
    bestGhat: (p, min, word) => `सध्या सर्वात चांगला घाट: ${p} — ${min} मिनिटे चालत, ${word}.`,
    avoid: (list) => ` सध्या ${list} टाळा.`,
    calmWord: { 1: 'गर्दी नाही', 2: 'थोडी गर्दी', 3: 'खूप गर्दी', 4: 'बंद' },
    youAre: (p, gps) => `तुम्ही ${p} येथे आहात${gps ? ' (GPS वरून)' : ' (तुम्ही निवडलेले ठिकाण)'}.`,
    nearby: (list) => ` जवळ: ${list}.`,
    member: (name, p, ago) => `${name} ${p} येथे आहेत${ago ? `, ${ago}` : ''}.`,
    memberHidden: (name) => `${name} सध्या ठिकाण दाखवत नाहीत.`,
    memberUnknown: (name) => `${name} यांनी अजून ठिकाण शेअर केलेले नाही.`,
    noGroup: 'तुम्ही अजून कुटुंब गट बनवलेला नाही. गट बनवा म्हणजे नकाशावर एकमेकांना पाहता येईल.',
    nobodyShared: 'तुमच्या गटातील कोणीही सध्या ठिकाण दाखवत नाही.',
    event: (title, when, p) => `${title} — ${when}${p ? `, ${p} येथे` : ''}.`,
    noEvents: 'आज आणखी कार्यक्रम नाही.',
    notices: (list) => list,
    noNotices: 'सध्या कोणतीही सूचना नाही.',
    helplines: 'आपत्कालीन क्रमांक. मेळ्यात हरवले-सापडले चौकी आणि कोणताही स्वयंसेवक मदत करू शकतो.',
    lostItem: (p, min) => `हरवलेले सामान: ${p} ला जा — ${min} मिनिटे चालत. तिथे हरवले-सापडले नोंदवही आहे.`,
    far: (p, m, min) => `${p} ${m} मीटर दूर आहे — सुमारे ${min} मिनिटे चालत.`,
    sos: {
      lost_self: 'जिथे आहात तिथेच थांबा. खालील लाल बटण दाबा — स्वयंसेवकाला तुमचे ठिकाण कळेल.',
      crowd_crush: 'धक्क्यापासून बाजूला व्हा, हात छातीजवळ वर ठेवा. आत्ता लाल बटण दाबा.',
      medical: 'लाल बटण दाबा — वैद्यकीय प्रशिक्षित स्वयंसेवक येईल. रुग्णवाहिकेसाठी 108 वर कॉल करा.',
      lost_person: 'लाल बटण दाबा आणि त्यांचे वर्णन द्या — स्वयंसेवक लगेच शोध सुरू करतील.',
      other: 'लाल बटण दाबा — स्वयंसेवक तुमच्या ठिकाणी येईल.',
    },
    medicalSafety: 'कोणाला गंभीर इजा असेल तर चालू नका — लाल बटण दाबा.',
    greet: 'नमस्कार! विचारा — स्वच्छतागृह कुठे, कोणता घाट मोकळा, आरती कधी, किंवा कुटुंब कुठे आहे.',
    thanks: 'आपले स्वागत आहे. सुरक्षित रहा आणि आपल्या लोकांसोबत रहा.',
    capabilities: 'मी स्वच्छतागृह, पाणी, जेवण आणि वैद्यकीय केंद्र शोधू शकतो, सर्वात कमी गर्दीचा घाट सांगू शकतो, एखाद्या ठिकाणची गर्दी सांगू शकतो, कुटुंब शोधू शकतो, कार्यक्रम आणि सूचना सांगू शकतो, आणि आपत्कालीन क्रमांक देऊ शकतो. नेटवर्कशिवायही.',
    unknown: 'मला नीट समजले नाही. असे विचारा:',
    happening: 'आत्ता सुरू आहे',
    inMin: (n) => `${n} मिनिटांत`,
    inHours: (n) => `${n} तासांत`,
    agoMin: (n) => (n < 1 ? 'आत्ता' : `${n} मिनिटांपूर्वी`),
  },
};

/** Ready-made questions, also used as follow-up chips. */
const ASK = {
  en: {
    toilet: 'Nearest toilet', water: 'Where is water?', bestGhat: 'Least crowded ghat', crowdSangam: 'Is Sangam crowded?',
    family: 'Where is my family?', aarti: 'When is the aarti?', helpline: 'Emergency numbers', whereAmI: 'Where am I?',
    notices: 'Any announcements?', crowdThere: 'Is it crowded there?', another: 'Another one', go: 'Take me there', far: 'How far?',
  },
  hi: {
    toilet: 'नज़दीकी शौचालय', water: 'पानी कहाँ है?', bestGhat: 'सबसे कम भीड़ वाला घाट', crowdSangam: 'संगम पर भीड़ है?',
    family: 'मेरा परिवार कहाँ है?', aarti: 'आरती कब है?', helpline: 'आपातकालीन नंबर', whereAmI: 'मैं कहाँ हूँ?',
    notices: 'कोई सूचना?', crowdThere: 'वहाँ भीड़ है?', another: 'कोई और', go: 'वहाँ ले चलो', far: 'कितनी दूर है?',
  },
  mr: {
    toilet: 'जवळचे स्वच्छतागृह', water: 'पाणी कुठे आहे?', bestGhat: 'सर्वात कमी गर्दीचा घाट', crowdSangam: 'संगमवर गर्दी आहे का?',
    family: 'माझे कुटुंब कुठे आहे?', aarti: 'आरती कधी आहे?', helpline: 'आपत्कालीन क्रमांक', whereAmI: 'मी कुठे आहे?',
    notices: 'काही सूचना?', crowdThere: 'तिथे गर्दी आहे का?', another: 'आणखी एक', go: 'तिथे घेऊन चला', far: 'किती लांब आहे?',
  },
};
const chip = (lang, key) => ({ label: (ASK[lang] ?? ASK.hi)[key], text: (ASK[lang] ?? ASK.hi)[key] });

export function suggestions(lang = 'hi') {
  return ['toilet', 'bestGhat', 'crowdSangam', 'family', 'aarti', 'helpline'].map((k) => chip(lang, k));
}

/** Real Indian helplines. */
export const HELPLINES = [
  { number: '112', label: { en: 'Emergency', hi: 'आपातकाल', mr: 'आपत्काल' } },
  { number: '108', label: { en: 'Ambulance', hi: 'एम्बुलेंस', mr: 'रुग्णवाहिका' } },
  { number: '1098', label: { en: 'Child helpline', hi: 'चाइल्ड हेल्पलाइन', mr: 'बाल हेल्पलाइन' } },
  { number: '181', label: { en: 'Women helpline', hi: 'महिला हेल्पलाइन', mr: 'महिला हेल्पलाइन' } },
];

/* ------------------------------------------------------- understanding --- */

function memberMatch(t, members) {
  for (const m of members ?? []) {
    const label = norm(m.label);
    if (!label) continue;
    const first = label.split(' ')[0];
    if (has(t, label) || (first.length >= 3 && has(t, first))) return m;
  }
  return null;
}

function eventMatch(t, schedule, now) {
  const upcoming = (schedule ?? [])
    .filter((e) => new Date(e.endsAt).getTime() > now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const e of upcoming) {
    const words = Object.values(e.title).flatMap((s) => norm(s).split(' ')).filter((w) => w.length >= 4);
    if (words.some((w) => has(t, w))) return e;
  }
  return null;
}

/**
 * What is being asked. Ordered rules, most safety-critical first.
 * @returns {{intent: string, place?: object, slot?: string, member?: object, event?: object, kind?: string}}
 */
export function understand(text, ctx = {}) {
  const t = norm(text);
  const memory = ctx.memory ?? {};
  if (!t) return { intent: 'unknown' };

  const place = findPlace(t);
  const remembered = memory.lastPlace && NODE_BY_ID[memory.lastPlace] ? NODE_BY_ID[memory.lastPlace] : null;
  const slot = FACILITY.find((f) => any(t, f.words))?.type ?? null;

  // 1. Emergencies. A lost phone is not a lost child.
  if (any(t, W.lost) && any(t, W.item)) return { intent: 'lost_item' };
  for (const kind of ['lost_self', 'crowd_crush', 'medical']) {
    if (any(t, URGENT[kind])) return { intent: 'sos', kind };
  }
  if (any(t, W.lost) && !any(t, W.item)) return { intent: 'sos', kind: 'lost_person' };
  // "Emergency numbers" is asking for numbers, not raising an alert.
  if (any(t, W.helpline)) return { intent: 'helplines' };
  if (any(t, URGENT.other)) return { intent: 'sos', kind: 'other' };

  // 2. Small talk, when that is all it is.
  const words = t.split(' ').length;
  if (any(t, W.thanks) && words <= 5) return { intent: 'thanks' };
  if (any(t, W.capabilities)) return { intent: 'capabilities' };
  if (any(t, W.greet) && words <= 4 && !place && !slot) return { intent: 'greet' };

  // 3. Specific questions.
  if (any(t, W.whereAmI)) return { intent: 'where_am_i' };
  if (any(t, W.number) && !place && !slot) return { intent: 'helplines' };
  if (any(t, W.notices)) return { intent: 'notices' };

  const crowdWords = any(t, W.crowd);
  if ((slot === 'ghat' || has(t, 'ghat') || has(t, 'घाट')) && (any(t, W.less) || any(t, W.which)) && !place) {
    return { intent: 'best_ghat' };
  }
  if (any(t, W.when)) {
    const event = eventMatch(t, ctx.schedule, ctx.now ?? Date.now());
    return { intent: 'schedule', event };
  }
  // "Is Sangam empty?" is a crowd question too.
  if (crowdWords || (place && any(t, W.less))) {
    const target = place ?? (any(t, W.there) || words <= 3 ? remembered : null);
    return target ? { intent: 'crowd_at', place: target } : { intent: 'crowd_overall' };
  }

  // 4. People.
  const member = memberMatch(t, ctx.members);
  if (member) return { intent: 'family', member };
  if (any(t, W.family) || any(t, W.relation)) return { intent: 'family' };

  // 5. Follow-ups about the last place.
  if (remembered && !place && !slot) {
    if (any(t, W.far)) return { intent: 'distance', place: remembered };
    if (any(t, W.another)) return { intent: 'another' };
    if (any(t, W.go) || any(t, W.yes) || (any(t, W.way) && any(t, W.there))) return { intent: 'go', place: remembered };
    if (any(t, W.there)) return { intent: 'route_to', place: remembered };
  }

  // 6. Going somewhere.
  if (place) return { intent: any(t, W.far) ? 'distance' : 'route_to', place };
  if (slot) return { intent: 'nearest', slot };
  if (any(t, W.another) && memory.lastSlot) return { intent: 'another' };

  return { intent: 'unknown' };
}

/* ------------------------------------------------------------ answers --- */

function walk(fromId, toId, flags) {
  return route(fromId, toId, { flags });
}

/** How crowded a place is now, from live warnings and the paths into it. */
export function crowdAt(nodeId, { flags = {}, warnings = [] } = {}) {
  const edges = EDGES.filter((e) => e.a === nodeId || e.b === nodeId);
  const levels = edges.map((e) => levelFor(e, flags));
  const closed = levels.filter((l) => l >= 4).length;
  const open = levels.filter((l) => l < 4);
  const worst = open.length ? Math.max(...open) : 4;
  const warning = warnings.find((w) => w.nodeId === nodeId) ?? null;
  let state;
  if (open.length === 0) state = 'closed';
  else if (warning?.risk >= 3) state = 'packed';
  else if (warning?.risk >= 2) state = 'filling';
  else if (worst >= 3) state = 'heavy';
  else if (worst >= 2) state = 'busy';
  else state = 'clear';
  const level = { clear: 1, busy: 2, heavy: 3, filling: 3, packed: 4, closed: 4 }[state];
  return { state, level, closed, total: edges.length, minutesToCritical: warning?.minutesToCritical ?? null, risk: warning?.risk ?? 0 };
}

function whenText(startsAt, lang, now) {
  const L = P[lang] ?? P.hi;
  const mins = Math.round((new Date(startsAt).getTime() - now) / 60_000);
  if (mins <= 0) return L.happening;
  if (mins < 60) return L.inMin(mins);
  return L.inHours(Math.round(mins / 60));
}

function routeAnswer(target, ctx, { slot = null, intro = null } = {}) {
  const { lang, you, flags } = ctx;
  const L = P[lang] ?? P.hi;
  if (target.id === you) {
    return { text: L.here(nameOf(target, lang)), to: target.id, here: true, actions: [{ type: 'map', to: target.id }] };
  }
  const r = walk(you, target.id, flags);
  if (!r.ok) {
    return { text: L.allClosed(nameOf(target, lang)), to: target.id, actions: [{ type: 'map', to: target.id }] };
  }
  const head = slot
    ? L.nearest(TYPE_WORD[slot][lang] ?? TYPE_WORD[slot].en, nameOf(target, lang), r.metres, r.minutes)
    : L.routeTo(nameOf(target, lang), r.metres, r.minutes);
  const crowd = crowdAt(target.id, ctx);
  const warn = crowd.state === 'packed' || crowd.state === 'filling'
    ? ` ${L.crowd[crowd.state](nameOf(target, lang), crowd.minutesToCritical)}` : '';
  return {
    text: `${intro ? `${intro} ` : ''}${head}${r.worst >= 3 ? ` ${L.alsoCrowded}` : ''}${warn}`,
    to: target.id,
    steps: directions(r, lang),
    metres: r.metres,
    minutes: r.minutes,
    crowd,
    actions: [{ type: 'navigate', to: target.id }, { type: 'map', to: target.id }],
  };
}

/** Facilities of a type, best first, by crowd-aware walking time. */
function ranked(type, ctx) {
  return NODES.filter((n) => n.type === type)
    .map((node) => ({ node, r: walk(ctx.you, node.id, ctx.flags) }))
    .filter((x) => x.r.ok)
    .sort((a, b) => a.r.minutes - b.r.minutes);
}

function agoText(iso, lang, now) {
  if (!iso) return '';
  return (P[lang] ?? P.hi).agoMin(Math.round((now - new Date(iso).getTime()) / 60_000));
}

/**
 * Answer a message.
 *
 * @param {string} text
 * @param {{lang?: string, you: string, flags?: object, warnings?: object[], schedule?: object[],
 *          notices?: object[], members?: object[], hasGroup?: boolean, gps?: boolean,
 *          memory?: object, now?: number}} ctx
 * @param {{force?: {intent: string, place?: string, slot?: string}}} [options]
 *   `force` lets the server's language model choose an intent from the known
 *   list for wording the rules did not catch. It can only pick — never write.
 * @returns {{text: string, intent: string, actions: object[], followups: object[], memory: object,
 *            to?: string, steps?: object[], urgent?: boolean, kind?: string, crowd?: object, calls?: object[]}}
 */
export function respond(text, ctx, { force = null } = {}) {
  const lang = P[ctx.lang] ? ctx.lang : 'hi';
  const L = P[lang];
  const now = ctx.now ?? Date.now();
  const c = { flags: {}, warnings: [], schedule: [], notices: [], members: [], ...ctx, lang, now };
  const memory = { ...(ctx.memory ?? {}) };

  let u = understand(text, c);
  if (force?.intent && u.intent === 'unknown') {
    u = {
      intent: force.intent,
      place: force.place && NODE_BY_ID[force.place] ? NODE_BY_ID[force.place] : null,
      slot: TYPE_WORD[force.slot] ? force.slot : null,
      kind: force.kind,
    };
    if (u.intent === 'route_to' && !u.place) u.intent = 'unknown';
    if (u.intent === 'nearest' && !u.slot) u.intent = 'unknown';
    if (u.intent === 'crowd_at' && !u.place) u.intent = 'crowd_overall';
  }

  const done = (answer) => {
    const out = { intent: u.intent, actions: [], followups: [], ...answer };
    if (out.to) memory.lastPlace = out.to;
    out.memory = memory;
    return out;
  };

  switch (u.intent) {
    case 'sos': {
      const kind = u.kind ?? 'other';
      return done({
        urgent: true,
        kind,
        text: L.sos[kind] ?? L.sos.other,
        actions: [
          { type: 'sos', kind },
          { type: 'call', number: kind === 'medical' || kind === 'crowd_crush' ? '108' : '112' },
        ],
      });
    }

    case 'nearest': {
      const list = ranked(u.slot, c);
      if (!list.length) return done({ text: L.allClosed(TYPE_WORD[u.slot][lang]) });
      memory.lastSlot = u.slot;
      memory.tried = [list[0].node.id];
      const a = routeAnswer(list[0].node, c, { slot: u.slot });
      if (u.slot === 'medical') {
        a.text += ` ${L.medicalSafety}`;
        a.actions.push({ type: 'sos', kind: 'medical' }, { type: 'call', number: '108' });
      }
      a.followups = [chip(lang, 'crowdThere'), ...(list.length > 1 ? [chip(lang, 'another')] : []), chip(lang, 'go')];
      return done(a);
    }

    case 'another': {
      const type = memory.lastSlot ?? (memory.lastPlace ? NODE_BY_ID[memory.lastPlace]?.type : null);
      if (!type || type === 'junction') return done({ text: L.unknown, followups: suggestions(lang), intent: 'unknown' });
      const tried = new Set(memory.tried ?? (memory.lastPlace ? [memory.lastPlace] : []));
      const next = ranked(type, c).find((x) => !tried.has(x.node.id));
      if (!next) return done({ text: L.noneLeft(TYPE_WORD[type]?.[lang] ?? type) });
      memory.lastSlot = type;
      memory.tried = [...tried, next.node.id];
      const a = routeAnswer(next.node, c, { slot: type });
      a.followups = [chip(lang, 'crowdThere'), chip(lang, 'another'), chip(lang, 'go')];
      return done(a);
    }

    case 'route_to':
    case 'go': {
      memory.lastSlot = u.place.type === 'junction' ? null : u.place.type;
      memory.tried = [u.place.id];
      const a = routeAnswer(u.place, c);
      // "Let's go" starts walking straight away; the app reads `autostart`.
      if (u.intent === 'go') a.autostart = true;
      a.followups = [chip(lang, 'crowdThere'), chip(lang, 'far')];
      return done(a);
    }

    case 'distance': {
      const r = walk(c.you, u.place.id, c.flags);
      if (!r.ok) return done({ text: L.allClosed(nameOf(u.place, lang)), to: u.place.id });
      return done({
        text: L.far(nameOf(u.place, lang), r.metres, r.minutes),
        to: u.place.id,
        actions: [{ type: 'navigate', to: u.place.id }, { type: 'map', to: u.place.id }],
        followups: [chip(lang, 'crowdThere'), chip(lang, 'go')],
      });
    }

    case 'crowd_at': {
      const target = u.place;
      const crowd = crowdAt(target.id, c);
      let text = L.crowd[crowd.state](nameOf(target, lang), crowd.minutesToCritical);
      if (crowd.closed && crowd.state !== 'closed') text += L.crowd.partClosed(crowd.closed);
      const actions = [];
      let alternative = null;
      if (crowd.level >= 3 && target.type !== 'junction') {
        alternative = NODES
          .filter((n) => n.type === target.type && n.id !== target.id)
          .map((n) => ({ n, crowd: crowdAt(n.id, c), r: walk(c.you, n.id, c.flags) }))
          .filter((x) => x.r.ok && x.crowd.level < crowd.level)
          .sort((a, b) => a.crowd.level - b.crowd.level || a.r.minutes - b.r.minutes)[0] ?? null;
        if (alternative) {
          text += ` ${L.tryInstead(nameOf(alternative.n, lang), alternative.r.minutes)}`;
          actions.push({ type: 'navigate', to: alternative.n.id });
        }
      }
      actions.push({ type: 'map', to: target.id });
      memory.lastSlot = target.type === 'junction' ? null : target.type;
      return done({
        text,
        crowd,
        to: alternative ? alternative.n.id : target.id,
        crowdOf: target.id,
        actions,
        followups: alternative ? [chip(lang, 'go'), chip(lang, 'bestGhat')] : [chip(lang, 'go'), chip(lang, 'far')],
      });
    }

    case 'crowd_overall': {
      const hot = (c.warnings ?? []).filter((w) => w.risk >= 2 && NODE_BY_ID[w.nodeId]);
      const closed = Object.values(c.flags ?? {}).filter((f) => f.level >= 4).length;
      let text = hot.length
        ? L.overall(hot.map((w) => nameOf(NODE_BY_ID[w.nodeId], lang)).join(', '))
        : L.overallCalm;
      if (closed) text += L.closedPaths(closed);
      return done({ text, followups: [chip(lang, 'bestGhat'), chip(lang, 'crowdSangam')] });
    }

    case 'best_ghat': {
      const ghats = NODES.filter((n) => n.type === 'ghat')
        .map((n) => ({ n, crowd: crowdAt(n.id, c), r: walk(c.you, n.id, c.flags) }))
        .filter((x) => x.r.ok && x.crowd.state !== 'closed');
      if (!ghats.length) return done({ text: L.allClosed(TYPE_WORD.ghat[lang]) });
      // Crowd first, then walking time: a calm ghat 15 minutes away beats a
      // packed one 5 minutes away.
      ghats.sort((a, b) => a.crowd.level - b.crowd.level || a.r.minutes - b.r.minutes);
      const best = ghats[0];
      const avoid = ghats.filter((x) => x.crowd.level >= 3).map((x) => nameOf(x.n, lang));
      memory.lastSlot = 'ghat';
      memory.tried = [best.n.id];
      return done({
        text: L.bestGhat(nameOf(best.n, lang), best.r.minutes, L.calmWord[Math.min(best.crowd.level, 4)]) + (avoid.length ? L.avoid(avoid.join(', ')) : ''),
        to: best.n.id,
        crowd: best.crowd,
        steps: directions(best.r, lang),
        actions: [{ type: 'navigate', to: best.n.id }, { type: 'map', to: best.n.id }],
        followups: [chip(lang, 'go'), chip(lang, 'another'), chip(lang, 'aarti')],
      });
    }

    case 'where_am_i': {
      const here = NODE_BY_ID[c.you];
      const near = ['toilet', 'water', 'medical']
        .map((type) => ({ type, best: nearest(c.you, type, { flags: c.flags }) }))
        .filter((x) => x.best)
        .map((x) => `${TYPE_WORD[x.type][lang]} ${x.best.result.minutes} ${lang === 'en' ? 'min' : lang === 'mr' ? 'मि.' : 'मि.'}`);
      return done({
        text: L.youAre(nameOf(here, lang), c.gps) + (near.length ? L.nearby(near.join(', ')) : ''),
        actions: [{ type: 'map', to: c.you }],
        followups: [chip(lang, 'toilet'), chip(lang, 'water')],
      });
    }

    case 'family': {
      if (!c.hasGroup) return done({ text: L.noGroup, actions: [{ type: 'group' }] });
      const others = c.members ?? [];
      const describe = (m) => {
        if (!m.sharing) return L.memberHidden(m.label);
        const node = NODE_BY_ID[m.nodeId];
        if (!node) return L.memberUnknown(m.label);
        return L.member(m.label, nameOf(node, lang), agoText(m.updatedAt, lang, now));
      };
      if (u.member) {
        const node = u.member.sharing ? NODE_BY_ID[u.member.nodeId] : null;
        return done({
          text: describe(u.member),
          to: node?.id,
          actions: node ? [{ type: 'navigate', to: node.id }, { type: 'map', to: node.id }] : [{ type: 'group' }],
          followups: node ? [chip(lang, 'go'), chip(lang, 'far')] : [],
        });
      }
      const sharing = others.filter((m) => m.sharing && NODE_BY_ID[m.nodeId]);
      if (!sharing.length) return done({ text: L.nobodyShared, actions: [{ type: 'group' }] });
      const one = sharing.length === 1 ? sharing[0] : null;
      return done({
        text: others.map(describe).join(' '),
        to: one?.nodeId,
        actions: [...(one ? [{ type: 'navigate', to: one.nodeId }] : []), { type: 'group' }],
        followups: one ? [chip(lang, 'go')] : [],
      });
    }

    case 'schedule': {
      const upcoming = (c.schedule ?? [])
        .filter((e) => new Date(e.endsAt).getTime() > now)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const list = u.event ? [u.event] : upcoming.slice(0, 3);
      if (!list.length) return done({ text: L.noEvents });
      const title = (e) => e.title[lang] ?? e.title.hi ?? e.title.en;
      const text = list.map((e) => L.event(title(e), whenText(e.startsAt, lang, now), e.nodeId ? nameOf(NODE_BY_ID[e.nodeId], lang) : '')).join(' ');
      const first = list[0];
      return done({
        text,
        to: first.nodeId ?? undefined,
        actions: first.nodeId ? [{ type: 'navigate', to: first.nodeId }, { type: 'map', to: first.nodeId }] : [],
        followups: first.nodeId ? [chip(lang, 'crowdThere'), chip(lang, 'go')] : [],
      });
    }

    case 'notices': {
      const warnings = (c.warnings ?? []).filter((w) => w.risk >= 2 && NODE_BY_ID[w.nodeId]);
      const lines = [
        ...warnings.map((w) => L.crowd[w.risk >= 3 ? 'packed' : 'filling'](nameOf(NODE_BY_ID[w.nodeId], lang), w.minutesToCritical)),
        ...(c.notices ?? []).slice(0, 3).map((n) => n.body?.[lang] || n.body?.hi || n.body?.en).filter(Boolean),
      ];
      return done({ text: lines.length ? lines.join(' · ') : L.noNotices, followups: [chip(lang, 'bestGhat')] });
    }

    case 'helplines':
      return done({
        text: L.helplines,
        calls: HELPLINES.map((h) => ({ number: h.number, label: h.label[lang] ?? h.label.en })),
        actions: [
          ...HELPLINES.map((h) => ({ type: 'call', number: h.number })),
          { type: 'map', to: 'police_1' },
        ],
      });

    case 'lost_item': {
      const r = walk(c.you, 'police_1', c.flags);
      return done({
        text: L.lostItem(nameOf(NODE_BY_ID.police_1, lang), r.minutes),
        to: 'police_1',
        steps: r.ok ? directions(r, lang) : [],
        actions: [{ type: 'navigate', to: 'police_1' }, { type: 'map', to: 'police_1' }],
      });
    }

    case 'greet':
      return done({ text: L.greet, followups: suggestions(lang).slice(0, 4) });
    case 'thanks':
      return done({ text: L.thanks });
    case 'capabilities':
      return done({ text: L.capabilities, followups: suggestions(lang) });

    default:
      return done({ intent: 'unknown', text: L.unknown, followups: suggestions(lang) });
  }
}

/** The intents and places a language model may choose between (server). */
export const CHOOSABLE = {
  intents: ['nearest', 'route_to', 'crowd_at', 'crowd_overall', 'best_ghat', 'schedule', 'family', 'where_am_i', 'notices', 'helplines', 'lost_item', 'capabilities', 'sos'],
  slots: Object.keys(TYPE_WORD),
  places: NODES.filter((n) => n.type !== 'junction').map((n) => ({ id: n.id, name: n.name.en })),
};
