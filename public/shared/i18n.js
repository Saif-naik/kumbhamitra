/**
 * Strings.
 *
 * Every user-facing key has all three languages. A missing translation falls
 * back to Hindi, not English — the default user here reads Devanagari before
 * Latin, and an English fallback is the wrong failure.
 *
 * Copy rules followed here: name things by what the user does, not by how the
 * system works ("Tell my group where I am", not "Enable location sharing").
 * Buttons keep the same words through the whole flow.
 */

export const LANGS = [
  { code: 'hi', label: 'हिंदी' },
  { code: 'mr', label: 'मराठी' },
  { code: 'en', label: 'English' },
];

const S = {
  appName:        { hi: 'कुंभ-अ-मित्र', mr: 'कुंभ-अ-मित्र', en: 'Kumbh-a-Mitra' },

  tabHome:        { hi: 'घर',      mr: 'घर',      en: 'Home' },
  tabMap:         { hi: 'नक्शा',   mr: 'नकाशा',   en: 'Map' },
  tabGroup:       { hi: 'परिवार',  mr: 'कुटुंब',  en: 'Family' },
  tabMitra:       { hi: 'मित्र',   mr: 'मित्र',   en: 'Mitra' },

  sos:            { hi: 'मदद चाहिए', mr: 'मदत हवी', en: 'I need help' },
  sosSub:         { hi: 'दबाकर रखें', mr: 'दाबून ठेवा', en: 'Press and hold' },

  sosPick:        { hi: 'क्या हुआ है?', mr: 'काय झाले?', en: 'What has happened?' },
  sosLostPerson:  { hi: 'कोई खो गया है', mr: 'कोणी हरवले आहे', en: 'Someone is missing' },
  sosLostSelf:    { hi: 'मैं खो गया हूँ', mr: 'मी हरवलो आहे', en: 'I am lost' },
  sosMedical:     { hi: 'तबीयत खराब है', mr: 'तब्येत बिघडली आहे', en: 'Someone is unwell' },
  sosCrowd:       { hi: 'बहुत भीड़ है',  mr: 'खूप गर्दी आहे',   en: 'Dangerous crowd' },
  sosOther:       { hi: 'कुछ और',        mr: 'इतर',             en: 'Something else' },

  sosSending:     { hi: 'भेजा जा रहा है…', mr: 'पाठवत आहे…', en: 'Sending…' },
  sosQueued:      { hi: 'नेटवर्क का इंतज़ार — भेजा जाएगा', mr: 'नेटवर्कची वाट — पाठवले जाईल', en: 'Waiting for network — it will send' },
  sosSent:        { hi: 'स्वयंसेवक को भेज दिया गया', mr: 'स्वयंसेवकाला पाठवले', en: 'Sent to a volunteer' },
  sosClaimed:     { hi: 'स्वयंसेवक आ रहा है', mr: 'स्वयंसेवक येत आहे', en: 'A volunteer is coming' },
  sosResolved:    { hi: 'हल हो गया', mr: 'सुटले', en: 'Resolved' },
  sosCancel:      { hi: 'रद्द करें', mr: 'रद्द करा', en: 'Cancel this' },
  sosWho:         { hi: 'कौन खो गया है? (नाम, उम्र, कपड़े)', mr: 'कोण हरवले? (नाव, वय, कपडे)', en: 'Who is missing? (name, age, clothes)' },

  whereAmI:       { hi: 'मैं अभी कहाँ हूँ?', mr: 'मी आता कुठे आहे?', en: 'Where am I now?' },
  setPlace:       { hi: 'जगह चुनें', mr: 'ठिकाण निवडा', en: 'Set your place' },
  takeMeTo:       { hi: 'मुझे ले चलो', mr: 'मला घेऊन चला', en: 'Take me to' },

  nearestToilet:  { hi: 'नज़दीकी शौचालय', mr: 'जवळचे स्वच्छतागृह', en: 'Nearest toilet' },
  nearestWater:   { hi: 'नज़दीकी पानी',   mr: 'जवळचे पाणी',       en: 'Nearest water' },
  nearestMedical: { hi: 'नज़दीकी चिकित्सा', mr: 'जवळचे वैद्यकीय',  en: 'Nearest medical post' },
  nearestPolice:  { hi: 'खोया-पाया चौकी', mr: 'हरवले-सापडले चौकी', en: 'Lost & found' },

  groupTitle:     { hi: 'मेरा परिवार', mr: 'माझे कुटुंब', en: 'My family group' },
  groupMake:      { hi: 'नया समूह बनाएँ', mr: 'नवा गट बनवा', en: 'Make a new group' },
  groupJoin:      { hi: 'कोड से जुड़ें', mr: 'कोडने सामील व्हा', en: 'Join with a code' },
  groupCode:      { hi: 'यह कोड सबको बताएँ', mr: 'हा कोड सर्वांना सांगा', en: 'Share this code with everyone' },
  groupEmpty:     { hi: 'अभी कोई समूह नहीं', mr: 'अजून गट नाही', en: 'No group yet' },
  groupEmptyHelp: { hi: 'समूह बनाइए ताकि बिछड़ने पर एक-दूसरे को ढूँढ सकें।', mr: 'गट बनवा म्हणजे हरवल्यास एकमेकांना शोधता येईल.', en: 'Make a group so you can find each other if you get separated.' },
  sharingOn:      { hi: 'परिवार को मेरी जगह दिख रही है', mr: 'कुटुंबाला माझे ठिकाण दिसत आहे', en: 'Your family can see where you are' },
  sharingOff:     { hi: 'आपकी जगह छिपी है', mr: 'तुमचे ठिकाण लपलेले आहे', en: 'Your place is hidden' },
  stopSharing:    { hi: 'छिपाएँ', mr: 'लपवा', en: 'Hide me' },
  startSharing:   { hi: 'दिखाएँ', mr: 'दाखवा', en: 'Show me' },
  meetingPoint:   { hi: 'बिछड़ने पर यहाँ मिलें', mr: 'हरवल्यास इथे भेटा', en: 'If you get separated, meet here' },
  lastSeen:       { hi: 'आखिरी बार', mr: 'शेवटचे', en: 'Last seen' },
  notSharing:     { hi: 'जगह नहीं दिखा रहे', mr: 'ठिकाण दाखवत नाही', en: 'Not sharing' },

  mitraHello:     { hi: 'नमस्ते! मैं मित्र हूँ। पूछिए — शौचालय कहाँ है, कौन सा घाट खाली है, आरती कब है, या मेरा परिवार कहाँ है। बोलकर भी पूछ सकते हैं।', mr: 'नमस्कार! मी मित्र. विचारा — स्वच्छतागृह कुठे, कोणता घाट मोकळा, आरती कधी, किंवा माझे कुटुंब कुठे. बोलूनही विचारू शकता.', en: 'Namaste! I am Mitra. Ask me where things are, which ghat is least crowded, when the aarti is, or where your family is. You can speak too.' },
  mitraPlaceholder:{ hi: 'यहाँ लिखिए या बोलिए', mr: 'इथे लिहा किंवा बोला', en: 'Type or speak here' },
  mitraSend:      { hi: 'पूछें', mr: 'विचारा', en: 'Ask' },
  mitraListen:    { hi: 'बोलिए', mr: 'बोला', en: 'Speak' },
  mitraOffline:   { hi: 'इसी फ़ोन पर जवाब', mr: 'याच फोनवर उत्तर', en: 'Answered on this phone' },

  schedule:       { hi: 'कार्यक्रम', mr: 'कार्यक्रम', en: 'Schedule' },
  minutesWalk:    { hi: 'मिनट पैदल', mr: 'मिनिटे चालत', en: 'min walk' },
  metres:         { hi: 'मीटर', mr: 'मीटर', en: 'm' },

  offlineBanner:  { hi: 'नेटवर्क नहीं — ऐप चल रहा है', mr: 'नेटवर्क नाही — ॲप चालू आहे', en: 'No network — the app still works' },
  queuedBanner:   { hi: 'भेजने के लिए इंतज़ार में', mr: 'पाठवण्याच्या प्रतीक्षेत', en: 'waiting to send' },

  liveMap:        { hi: 'लाइव नक्शा', mr: 'लाइव्ह नकाशा', en: 'Live map' },
  simpleMap:      { hi: 'सादा नक्शा', mr: 'साधा नकाशा', en: 'Simple map' },
  street:         { hi: 'सड़क', mr: 'रस्ता', en: 'Street' },
  satellite:      { hi: 'उपग्रह', mr: 'उपग्रह', en: 'Satellite' },
  locateMe:       { hi: 'मेरी जगह', mr: 'माझे ठिकाण', en: 'My location' },
  navStart:       { hi: 'चलना शुरू करें', mr: 'चालायला सुरू करा', en: 'Start' },
  navEnd:         { hi: 'बंद करें', mr: 'थांबवा', en: 'End' },
  openGoogle:     { hi: 'Google Maps में खोलें', mr: 'Google Maps मध्ये उघडा', en: 'Open in Google Maps' },
  googleWarn:     { hi: 'Google Maps को यहाँ के बंद रास्तों और भीड़ का पता नहीं है।', mr: 'Google Maps ला इथले बंद मार्ग आणि गर्दी माहीत नाही.', en: 'Google Maps does not know about closed paths or crowds here.' },
  gpsLocating:    { hi: 'आपकी जगह ढूँढ रहे हैं…', mr: 'तुमचे ठिकाण शोधत आहे…', en: 'Finding your location…' },
  gpsOn:          { hi: 'जगह मिल गई', mr: 'ठिकाण मिळाले', en: 'Location found' },
  gpsDenied:      { hi: 'जगह की अनुमति बंद है। नीचे अपनी जगह चुनें।', mr: 'ठिकाणाची परवानगी बंद आहे. खाली ठिकाण निवडा.', en: 'Location permission is off. Choose your place below.' },
  gpsUnavailable: { hi: 'जगह नहीं मिली। नीचे अपनी जगह चुनें।', mr: 'ठिकाण मिळाले नाही. खाली ठिकाण निवडा.', en: 'Could not find your location. Choose your place below.' },
  gpsOutside:     { hi: 'आप मेला क्षेत्र में नहीं हैं। चलने पर डेमो दिखेगा।', mr: 'तुम्ही मेळा क्षेत्रात नाही. चालताना डेमो दिसेल.', en: 'You are not at the mela ground. Navigation will show a demo walk.' },
  demoWalk:       { hi: 'डेमो — नकली चाल', mr: 'डेमो — कृत्रिम चाल', en: 'Demo walk — simulated position' },
  navRerouted:    { hi: 'नया रास्ता — आगे का रास्ता बदल गया', mr: 'नवा मार्ग — पुढचा मार्ग बदलला', en: 'New route — the way ahead changed' },
  navOffRoute:    { hi: 'आप रास्ते से हट गए — नया रास्ता', mr: 'तुम्ही मार्ग सोडला — नवा मार्ग', en: 'Off the route — finding a new way' },
  tilesOffline:   { hi: 'नक्शे की तस्वीरों को इंटरनेट चाहिए। रास्ते और दिशा फिर भी चलेंगे।', mr: 'नकाशाच्या चित्रांना इंटरनेट लागते. मार्ग आणि दिशा तरीही चालतील.', en: 'Map pictures need internet. Paths and directions still work.' },
  voice:          { hi: 'आवाज़', mr: 'आवाज', en: 'Voice' },
  recenter:       { hi: 'मेरे पास लाएँ', mr: 'माझ्याकडे आणा', en: 'Back to me' },
  arrivedTitle:   { hi: 'आप पहुँच गए', mr: 'तुम्ही पोहोचलात', en: 'You have arrived' },

  nameAsk:        { hi: 'आपका नाम', mr: 'तुमचे नाव', en: 'Your name' },
  start:          { hi: 'शुरू करें', mr: 'सुरू करा', en: 'Start' },
  back:           { hi: 'वापस', mr: 'मागे', en: 'Back' },
  close:          { hi: 'बंद करें', mr: 'बंद करा', en: 'Close' },
  yes:            { hi: 'हाँ', mr: 'होय', en: 'Yes' },
};

let current = localStorage.getItem('km.lang') || 'hi';

export function lang() { return current; }

export function setLang(code) {
  current = code;
  localStorage.setItem('km.lang', code);
  document.documentElement.lang = code;
  window.dispatchEvent(new CustomEvent('km:lang', { detail: code }));
}

export function t(key, code = current) {
  const entry = S[key];
  if (!entry) return key;
  return entry[code] ?? entry.hi;
}

/** The bilingual signage pair used on every control. */
export function sign(key) {
  const primary = t(key);
  const secondary = current === 'en' ? t(key, 'hi') : t(key, 'en');
  return `<span class="sign"><span class="sign-primary">${primary}</span><span class="sign-secondary">${secondary}</span></span>`;
}

export function placeName(node, code = current) {
  if (!node) return '';
  return node.name?.[code] ?? node.name?.hi ?? node.name?.en ?? '';
}

export function relativeTime(iso, code = current) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return { hi: 'अभी', mr: 'आत्ता', en: 'just now' }[code];
  if (mins < 60) return { hi: `${mins} मिनट पहले`, mr: `${mins} मिनिटांपूर्वी`, en: `${mins} min ago` }[code];
  const hrs = Math.round(mins / 60);
  return { hi: `${hrs} घंटे पहले`, mr: `${hrs} तासांपूर्वी`, en: `${hrs} h ago` }[code];
}

document.documentElement.lang = current;
