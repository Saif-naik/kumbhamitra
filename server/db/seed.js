import { raw, insert, flush, all } from './store.js';

const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * Volunteers are not interchangeable.
 *
 * A collapsed diabetic needs someone with medical training, a frightened
 * eight-year-old needs someone trained in child protection, and a Tamil-speaking
 * family at a north Indian mela needs someone who can actually talk to them.
 * Dispatching purely by distance sends a first-aid volunteer to a cardiac case
 * while a trained nurse walks past the other way.
 *
 * So every volunteer carries skills and languages, and the queue ranks on skill
 * match first and distance second. Language matters more than people expect: a
 * lost child usually cannot give an address, only a description, and that only
 * works in their own language.
 */
const VOLUNTEERS = [
  ['vol_sunita',   'Sunita Devi',       ['medical', 'women_safety'],    ['hi', 'bho'],      'j_c',      'Nurse, District Hospital'],
  ['vol_imran',    'Imran Sheikh',      ['first_aid', 'general'],       ['hi', 'ur', 'en'], 'camp_c',   'St John Ambulance'],
  ['vol_lata',     'Lata Pawar',        ['child_care', 'women_safety'], ['mr', 'hi'],       'police_1', 'Childline volunteer'],
  ['vol_ramesh',   'Ramesh Yadav',      ['general'],                    ['hi', 'bho'],      'ghat_ram', 'Akhara seva group'],
  ['vol_fatima',   'Dr Fatima Qureshi', ['medical'],                    ['hi', 'en', 'ur'], 'med_1',    'Physician, mela medical post'],
  ['vol_arjun',    'Arjun Nair',        ['first_aid', 'general'],       ['en', 'ta', 'hi'], 'gate_2',   'NSS college unit'],
  ['vol_kavita',   'Kavita Sharma',     ['women_safety', 'child_care'], ['hi', 'mr'],       'camp_b',   'Mahila Suraksha Dal'],
  ['vol_gurpreet', 'Gurpreet Singh',    ['general', 'first_aid'],       ['pa', 'hi', 'en'], 'gate_3',   'Khalsa Aid seva'],
];

/**
 * The demo schedule is seeded relative to "now". Without this, a database
 * seeded yesterday shows an empty schedule at today's demo. Shifts every
 * demo event by whole days until something is upcoming again.
 */
function rollDemoScheduleForward() {
  const events = all('schedule');
  if (!events.length) return;
  const now = Date.now();
  if (events.some((e) => new Date(e.endsAt).getTime() > now)) return;
  const latestEnd = Math.max(...events.map((e) => new Date(e.endsAt).getTime()));
  const days = Math.ceil((now - latestEnd) / 86_400_000) || 1;
  const shift = days * 86_400_000;
  for (const e of events) {
    e.startsAt = new Date(new Date(e.startsAt).getTime() + shift).toISOString();
    e.endsAt = new Date(new Date(e.endsAt).getTime() + shift).toISOString();
  }
  flush();
  console.log(`  Demo schedule moved forward ${days} day(s).`);
}

export function seedIfEmpty() {
  const db = raw();
  if (db.users.length) {
    rollDemoScheduleForward();
    return;
  }

  for (const [id, displayName, skills, languages, nodeId, org] of VOLUNTEERS) {
    insert('users', {
      id,
      displayName,
      role: 'volunteer',
      language: languages[0],
      skills,
      languages,
      org,
      nodeId,
      onDuty: true,
      createdAt: new Date().toISOString(),
    });
  }

  insert('users', {
    id: 'admin_demo',
    displayName: 'Control Room',
    role: 'admin',
    language: 'en',
    skills: [],
    languages: ['hi', 'en'],
    createdAt: new Date().toISOString(),
  });

  const schedule = [
    ['Shahi Snan — main bathing', 'शाही स्नान', 'शाही स्नान', 'ghat_sangam', 5, 4],
    ['Ganga Aarti', 'गंगा आरती', 'गंगा आरती', 'ghat_ram', 9, 3],
    ['Bhandara — free meal', 'भंडारा — निःशुल्क भोजन', 'भंडारा — मोफत जेवण', 'food_1', 3, 2],
    ['Pravachan at Sector B', 'प्रवचन — सेक्टर B', 'प्रवचन — सेक्टर B', 'camp_b', 26, 2],
    ['Morning Snan', 'प्रातः स्नान', 'प्रातः स्नान', 'ghat_hanuman', 20, 3],
  ];

  for (const [en, hi, mr, nodeId, inHours, crowd] of schedule) {
    insert('schedule', {
      id: `sch_${nodeId}_${inHours}`,
      title: { en, hi, mr },
      nodeId,
      startsAt: hoursFromNow(inHours),
      endsAt: hoursFromNow(inHours + 2),
      crowdHint: crowd,
    });
  }

  insert('notices', {
    id: 'notice_welcome',
    severity: 'info',
    body: {
      en: 'Sangam Ghat is very crowded until 9am. Ram Ghat is open and quieter.',
      hi: 'संगम घाट सुबह 9 बजे तक बहुत भीड़ भरा है। राम घाट खुला और शांत है।',
      mr: 'संगम घाट सकाळी ९ पर्यंत खूप गर्दीचा आहे. राम घाट मोकळा आहे.',
    },
    startsAt: new Date().toISOString(),
    endsAt: hoursFromNow(12),
  });

  flush();
  console.log(`  Seeded ${VOLUNTEERS.length} volunteers and ${all('schedule').length} events.`);
}
