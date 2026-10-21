/**
 * Bill Sorter (Google Apps Script)
 *
 * Files property bills from Gmail into Google Drive:
 *
 *   Property Bills / <Property> / <Utility> / FY 2026-27 / 2026-04 April 2026 Electricity Bill.pdf
 *
 * The list of properties lives in the "Bill Sorter Settings" spreadsheet inside the
 * Property Bills folder, so adding or renaming a property never needs a code change.
 * A bill for an account number the sheet doesn't know yet gets a property row and a
 * folder of its own, which you can then rename or merge into an existing property.
 * Every attachment it looks at is written to the Log tab of the same spreadsheet.
 *
 * Each run stops well inside Apps Script's six-minute limit and the next run carries on
 * where it left off, so a big backlog takes a few hourly runs instead of one that times out.
 *
 * Setup: paste this file into an Apps Script project, add the Drive API service,
 * choose setup in the function list and press Run. See README.md for the details.
 */

// ─── Settings ────────────────────────────────────────────────────────────────

const CONFIG = {
  BASE_FOLDER: 'Property Bills',         // top-level folder in My Drive
  SETTINGS_FILE: 'Bill Sorter Settings', // spreadsheet with the Properties and Log tabs
  LABEL: 'Bill Records',                 // put on each Gmail thread once it has been handled
  NEEDS_REVIEW: '_Needs Review',         // bills whose property couldn't be worked out
  TIME_ZONE: 'Asia/Kolkata',
  SEARCH_SINCE: '',                      // e.g. '2024/04/01' to leave older mail alone; '' = all of it
  // Mail with a PDF or photo and one of these words is looked at, and so is mail showing one of
  // your account numbers and anything you sent or forwarded yourself that mentions a bill.
  SEARCH_TERMS: [
    'electricity', 'adani', 'tata power', 'mahavitaran', 'msedcl', 'best undertaking', 'mahanagar gas',
    'mgl', 'gas bill', 'water bill', 'water charges', 'property tax', 'municipal', 'mcgm', 'maintenance',
    'society', 'chs', 'sinking fund', 'broadband', 'fibernet', 'airtel', 'jio', 'rent', 'lease',
    'leave and licence', 'tenant', 'home insurance', 'fire insurance', 'householder', 'repair', 'plumbing',
    'pest control', 'termite',
  ],
  // Opening an attachment (Drive's OCR) is the slow part: seconds to a minute each.
  // 'when-needed' opens one only when the email alone can't say whose bill it is, which is fast;
  // 'always' opens every one, which is slower but takes the bill month from the bill itself.
  READ_ATTACHMENTS: 'when-needed',
  READ_MAX_MB: 5,                        // bigger files are sorted from the email without opening them
  READ_MAX_PAGES: 10,                    // and so are long PDFs; bills are a page or two
  RUN_MINUTES: 3.5,                      // no new email is started after this long...
  READ_CUTOFF_MINUTES: 3.75,             // ...and no attachment opened; Apps Script stops a run at 6
  DAILY_MINUTES: 80,                     // scheduled runs stop for the day here (Google allows 90)
  MAX_ATTEMPTS: 3,                       // a thread that errors this many runs in a row is labelled anyway
  OCR_LANGUAGE: 'en',
  // A subject or attachment name with one of these is a payment receipt, not a bill: skipped.
  PAYMENTS: ['payment received', 'payment successful', 'payment is successful', 'payment confirmation',
    'payment confirmed', 'thank you for your payment', 'thank you for the payment', 'thank you for paying',
    'payment receipt', 'payment acknowledgement', 'payment acknowledgment', 'transaction successful',
    'paid successfully', 'cashback'],
  // One with these is a reminder or a notice: skipped too, unless the subject also calls it a bill
  // ("Reminder: maintenance bill for May", "Maintenance bill and AGM notice"). Then each attachment
  // is judged on its own, so the bill is filed and the AGM notice isn't.
  NOTICES: ['reminder', 'overdue', 'past due', 'disconnection notice', 'final notice', 'newsletter', 'tariff',
    'brochure', 'terms and conditions', 'outage', 'shutdown', 'circular', 'agm', 'annual general meeting',
    'notice of meeting', 'offer', 'kyc'],
  // An attachment with one of these is never a property bill, whatever address is on it: bank and
  // card statements, online orders, car service bills.
  NOT_PROPERTY: ['statement of account', 'account statement', 'credit card statement', 'card statement',
    'minimum amount due', 'credit limit', 'order id', 'sold by', 'ship to', 'shipping address', 'chassis',
    'odometer'],
  SAME_BILL_DAYS: 7,                     // two copies of one account's bill this close together are one bill
  // Gmail gives a conversation's label to emails that arrive in it later, so an email from this far
  // back that isn't in the Log is sorted even though it already has the Bill Records label.
  LOOK_BACK_DAYS: 365,
  // What checkEmails looks at: a Gmail search for emails you expected to see filed.
  CHECK_SEARCH: 'from:mahanagargas.com',
};

// Used once, to fill the Properties tab the first time the script runs. After that the
// spreadsheet is the list: add, rename and merge properties there, not here.
const STARTING_PROPERTIES = [
  {
    name: "2, Mother's Love, (Malad West)",
    accounts: ['102401902', '210000800764'],
    keywords: ['mothers love', "mother's love", 'pankaj chs', 'evershine ngr'],
  },
  {
    name: 'F-34, Sej Plaza, (Malad West)',
    accounts: ['153541273'],
    keywords: ['sej plaza', 'sejal plaza', 'marve road', 'f-34'],
  },
  {
    name: '202, B-Wing, Sai Dam Towers, (Kandivali West)',
    accounts: ['151759775', '149209100000059'],
    keywords: ['b0202', 'b-0202', 'flat b0202', 'saidham', 'sai dham', 'sai dam', 'lalji pada'],
  },
];

// The bill types: the Drive folder, the wording used in file names, and the evidence for each.
// The type with the most evidence wins; a tie goes to the one listed first. Keywords match whole
// words only, so "lease" never matches "please" and "rent" never matches "current". Senders match
// anywhere in the From line.
// inArrears: the bill charges for usage before it was issued, so one dated in April (or one that
// arrives in April without saying which month it is for) is filed as March's bill.
// newProperty: an unknown account on this kind of bill starts a new property. Phone, insurance,
// rent and repair bills don't, since plenty of those (your own mobile, your car) aren't about a property.
// recurring: one bill per account per period, so a second copy of it is a duplicate. Repair
// invoices, policies and receipts can legitimately come several to a month.
// needsAccount: your address is on your own mobile bill too, so a phone bill is filed only when
// its account number is in the sheet. Broadband and landline bills (fixedLine: words in the
// subject, file name or bill; fixedLineSenders: broadband-only companies) go by address as usual.
// Anything that is none of these types isn't filed at all.
const UTILITIES = [
  {
    folder: 'Electricity Bills', label: 'Electricity Bill', short: 'Electricity', inArrears: true, newProperty: true,
    recurring: true,
    senders: ['adani', 'tatapower', 'bestundertaking', 'mahadiscom', 'mahavitaran', 'torrentpower'],
    keywords: ['electricity', 'adani electricity', 'tata power', 'best undertaking', 'mahavitaran', 'msedcl',
      'torrent power', 'energy charges', 'units consumed', 'kwh', 'meter reading', 'sanctioned load'],
  },
  {
    folder: 'Gas Bills', label: 'Gas Bill', short: 'Gas', inArrears: true, newProperty: true,
    recurring: true,
    senders: ['mahanagargas'],
    keywords: ['mahanagar gas', 'mgl', 'piped natural gas', 'png bill', 'gas bill', 'gas consumption', 'scm',
      'gas meter', 'adani total gas', 'gujarat gas', 'indraprastha gas'],
  },
  {
    folder: 'Water Bills', label: 'Water Bill', short: 'Water', inArrears: true, newProperty: true,
    recurring: true,
    senders: [],
    keywords: ['water bill', 'water charges', 'water supply', 'water connection', 'water meter',
      'water consumption', 'sewerage charges', 'hydraulic engineer'],
  },
  {
    folder: 'Internet & Telecom', label: 'Internet & Phone Bill', short: 'Internet', inArrears: true, newProperty: false,
    recurring: true, needsAccount: true,
    fixedLine: ['broadband', 'fibernet', 'fiber', 'fibre', 'jiofiber', 'airfiber', 'landline', 'ftth',
      'internet bill', 'internet plan', 'internet service'],
    fixedLineSenders: ['actcorp', 'hathway', 'excitel'],
    senders: ['airtel.in', 'airtel.com', 'jio.com', 'mtnl', 'bsnl', 'actcorp', 'hathway', 'tataplay', 'excitel'],
    keywords: ['broadband', 'fibernet', 'jiofiber', 'jio', 'airtel', 'xstream', 'postpaid', 'landline', 'mtnl',
      'bsnl', 'hathway', 'internet bill', 'internet plan', 'internet service', 'data usage', 'wifi',
      'telephone bill', 'mobile bill'],
  },
  {
    folder: 'Property Taxes', label: 'Property Tax', short: 'Property Tax', inArrears: false, newProperty: true,
    recurring: true,
    senders: ['ptax'],
    keywords: ['property tax', 'municipal tax', 'capital value', 'general tax', 'assessment', 'tax bill',
      'education cess', 'tree cess', 'street tax', 'property account'],
  },
  {
    folder: 'Property Insurance', label: 'Insurance', short: 'Insurance', inArrears: false, newProperty: false,
    recurring: false,
    senders: [],
    keywords: ['home insurance', 'fire insurance', 'householder', 'householders', 'property insurance',
      'building insurance', 'house insurance', 'home package', 'home protect', 'griha raksha', 'home shield',
      'dwelling', 'standard fire', 'special perils', 'home contents'],
  },
  {
    folder: 'Lease & Rent Agreements', label: 'Rent', short: 'Rent', inArrears: false, newProperty: false,
    recurring: false,
    senders: [],
    keywords: ['rent receipt', 'rent agreement', 'rental agreement', 'monthly rent', 'rent for the month',
      'house rent', 'rent paid', 'leave and licence', 'leave and license', 'leave & licence', 'leave & license',
      'licensee', 'licensor', 'lease', 'tenant', 'tenancy'],
  },
  {
    folder: 'Repairs & Maintenance', label: 'Repairs', short: 'Repairs', inArrears: false, newProperty: false,
    recurring: false,
    senders: [],
    keywords: ['repair work', 'repairs', 'repairing', 'plumbing', 'plumber', 'electrician', 'electrical work',
      'carpentry', 'carpenter', 'painting', 'waterproofing', 'civil work', 'labour charges'],
  },
  {
    folder: 'Pest Control', label: 'Pest Control', short: 'Pest Control', inArrears: false, newProperty: false,
    recurring: false,
    senders: [],
    keywords: ['pest control', 'pest management', 'termite', 'fumigation', 'cockroach', 'rodent', 'bed bug'],
  },
  {
    folder: 'Society Maintenance', label: 'Maintenance Bill', short: 'Society', inArrears: false, newProperty: true,
    recurring: true,
    senders: ['mygate', 'nobrokerhood', 'apnacomplex', 'adda.io', 'chsone'],
    keywords: ['maintenance', 'maintenance bill', 'maintenance charges', 'society maintenance', 'housing society',
      'co operative housing', 'sinking fund', 'repair fund', 'service charges', 'non occupancy',
      'parking charges', 'society charges'],
  },
];

// Anything that isn't one of the types above.
const OTHER = {
  folder: 'Miscellaneous Bills', label: 'Bill', short: 'Other', inArrears: false, newProperty: false,
  recurring: false, senders: [], keywords: [],
};

// Changed when a new version sorts differently: the first run after you paste it in looks again
// at everything that was skipped or left in _Needs Review, as retrySkipped does.
const RULES = '2026-10-21';

// ─── Run these ───────────────────────────────────────────────────────────────

/**
 * Run once by hand. Creates the Drive folder and the settings spreadsheet, schedules an
 * hourly run (replacing any earlier schedule for this script) and sorts the first batch.
 */
function setup() {
  const ownClock = startClock_();
  try {
    const ctx = openContext_();
    ScriptApp.getProjectTriggers()
      .filter((t) => ['processBills', 'automateBillSorting'].indexOf(t.getHandlerFunction()) !== -1)
      .forEach((t) => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('processBills').timeBased().everyHours(1).create();
    console.log('Settings and log: ' + ctx.settings.getUrl());
    console.log('Bills folder: ' + ctx.base.getUrl());
    processBills();
  } finally {
    if (ownClock) clock_.started = null;
  }
}

/**
 * The scheduled job, and safe to run by hand at any time: each run stops in good time and
 * the next one carries on. Running it by hand a few times gets through a backlog faster.
 */
function processBills(e) {
  const ownClock = startClock_();
  const scheduled = Boolean(e && e.triggerUid);
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(10 * 1000)) {
      console.log('Another run is still going; skipping this one.');
      return;
    }
    try {
      if (scheduled && minutesUsedToday_() >= CONFIG.DAILY_MINUTES) {
        console.log("Today's scheduled time is used up; carrying on tomorrow. Running processBills by hand still works.");
        return;
      }
      runBatch_();
    } finally {
      lock.releaseLock();
      if (scheduled) addMinutesToday_(elapsedMs_());
    }
  } finally {
    if (ownClock) clock_.started = null;
  }
}

/**
 * Run by hand once to clear out duplicates left by earlier versions. Moves every bill this
 * script filed to the Drive trash (restorable there for 30 days), empties the Log tab and takes
 * the Bill Records label off the emails it handled, so the next runs sort them all again, once.
 * Emails the old script labelled, and files you put in the folders yourself, are left alone.
 * If it runs out of time it says so: run it again to finish.
 */
function startOver() {
  const ownClock = startClock_();
  try {
    const ctx = openContext_();
    if (trashFiled_(ctx.base, ctx.settings.getId(), 0)) {
      console.log('Not finished yet: run startOver again.');
      return;
    }
    const forgot = forgetRows_(ctx, () => true);
    if (forgot.unfinished) {
      console.log('Not finished yet: run startOver again.');
      return;
    }
    const props = PropertiesService.getScriptProperties();
    props.getKeys().forEach((k) => {
      if (/^(attempts:|recheck:|sweep)/.test(k) || k === 'sweptTo') props.deleteProperty(k);
    });
    console.log('Cleared. ' + forgot.threads + ' emails will be sorted again, starting with the next run ' +
      '(or run processBills now).');
  } finally {
    if (ownClock) clock_.started = null;
  }
}

/**
 * Run by hand to have everything the Log shows as Skipped or Needs review looked at again, for
 * instance after adding an account number or keyword to a property. A bill in _Needs Review that
 * can now be placed is moved to its property. Bills already filed stay where they are. If it runs
 * out of time it says so: run it again to finish.
 */
function retrySkipped() {
  const ownClock = startClock_();
  try {
    const ctx = openContext_();
    const forgot = forgetRows_(ctx, unplaced_(new Date().getTime()));
    console.log(forgot.rows + ' skipped or unplaced attachments in ' + forgot.threads + ' emails will be looked ' +
      'at again, starting with the next run (or run processBills now).' +
      (forgot.unfinished ? ' Not finished yet: run retrySkipped again for the rest.' : ''));
  } finally {
    if (ownClock) clock_.started = null;
  }
}

// Log rows written by the given time that were skipped or left in _Needs Review.
function unplaced_(before) {
  const result = LOG_HEADERS.indexOf('Result');
  const processed = LOG_HEADERS.indexOf('Processed');
  return (row) => (String(row[result]) === 'Skipped' || String(row[result]) === 'Needs review') &&
    new Date(row[processed]).getTime() <= before;
}

// Once per change of RULES, what the old rules skipped or couldn't place goes back to be sorted
// again. If that takes longer than one run, the next run carries on.
function resortAfterUpdate_(ctx) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('rules') === RULES) return;
  const before = Number(props.getProperty('resortBefore')) || new Date().getTime();
  props.setProperty('resortBefore', String(before));
  const forgot = forgetRows_(ctx, unplaced_(before));
  if (forgot.rows) {
    console.log('New version: ' + forgot.rows + ' attachments that were skipped or left for review are looked at again.');
    remember_(ctx);
  }
  if (forgot.unfinished) return;
  props.setProperty('rules', RULES);
  props.deleteProperty('resortBefore');
}

/**
 * Run by hand to see why some emails are or aren't being filed. Set CHECK_SEARCH in CONFIG to a
 * Gmail search that finds them (it starts as MGL's gas bills), run checkEmails, and read the
 * Execution log. For the latest few it says whether the hourly search finds them, what the Log
 * tab says about them, whether each attachment can be read, and what would be done with it now.
 * It files, labels and logs nothing.
 */
function checkEmails() {
  const ownClock = startClock_();
  try {
    const ctx = openContext_();
    const messages = [];
    GmailApp.search(CONFIG.CHECK_SEARCH + ' has:attachment', 0, 5).forEach((thread) => {
      thread.getMessages().forEach((message) => messages.push({ thread: thread, message: message }));
    });
    if (!messages.length) {
      console.log('No email with an attachment matches ' + CONFIG.CHECK_SEARCH + '. Change CHECK_SEARCH in CONFIG.');
      return;
    }
    const searched = {};
    GmailApp.search(buildQuery_(ctx.properties, true) + ' ' + CONFIG.CHECK_SEARCH, 0, 100).forEach((t) => {
      searched[t.getId()] = true;
    });
    const logged = logRows_(ctx);
    messages.sort((a, b) => b.message.getDate() - a.message.getDate());
    try {
      messages.slice(0, 5).forEach((m) => {
        if (!past_(CONFIG.RUN_MINUTES)) checkMessage_(m.thread, m.message, ctx, searched, logged);
      });
    } finally {
      flush_(ctx); // what it read is kept, so the next run doesn't read it again
    }
  } finally {
    if (ownClock) clock_.started = null;
  }
}

function checkMessage_(thread, message, ctx, searched, logged) {
  const lines = [Utilities.formatDate(message.getDate(), CONFIG.TIME_ZONE, 'd MMM yyyy') + ', ' + message.getFrom() +
    ', "' + message.getSubject() + '"'];
  const labelled = thread.getLabels().some((l) => l.getName() === CONFIG.LABEL);
  const inLog = Object.keys(logged).some((key) => key.indexOf(message.getId() + ':') === 0);
  const recent = message.getDate().getTime() >= today_().getTime() - CONFIG.LOOK_BACK_DAYS * DAY;
  lines.push('  Found by the hourly search: ' + (searched[thread.getId()] ? 'yes.' : 'NO. Nothing in it matches ' +
    'SEARCH_TERMS or your account numbers; add a word from the email to SEARCH_TERMS.'));
  let label = labelled ? 'yes.' : 'no.';
  if (labelled && !inLog) {
    label = recent ? 'yes, but it is not in the Log yet, so the next run sorts it anyway.'
      : 'yes, and it is older than LOOK_BACK_DAYS, so it is left alone. Remove the label to have it sorted.';
  }
  lines.push('  Bill Records label: ' + label);
  const items = billAttachments_(message);
  const email = emailTexts_(message);
  items.forEach((item) => {
    item.count = items.length;
    lines.push('  ' + item.name + ' (' + item.type + ', ' + Math.round(item.size / 1024) + ' KB)');
    const row = logged[message.getId() + ':' + item.hash];
    lines.push('    In the Log: ' + (row ? row.result + '.' + (row.notes ? ' ' + row.notes : '') : 'not there.'));
    const j = judge_(email, item, ctx);
    if (!j) {
      lines.push('    Out of time before opening it; run checkEmails again.');
      return;
    }
    lines.push('    Opened: ' + (j.texts.doc ? 'yes, ' + j.texts.doc.length + ' characters read: "' +
      j.texts.doc.slice(0, 300) + '…"' : j.note || 'no, the email was enough.'));
    const v = j.v;
    const where = (top) => top + ' / ' + v.utility.folder + ' / ' + v.fy + ' as "' + v.fileBase + '"';
    let now = 'skipped. ' + v.notes;
    if (v.action === 'file') now = 'filed in ' + where(v.match.property.name) + ', matched by ' + v.match.why + '.';
    if (v.action === 'new') now = 'filed as a new property for account ' + v.account + '.';
    if (v.action === 'review') now = 'put in ' + where(CONFIG.NEEDS_REVIEW) + '. ' + v.notes;
    lines.push('    Now it would be ' + now);
  });
  if (!items.length) lines.push('  No PDF or photo attachment big enough to be a bill.');
  console.log(lines.join('\n'));
}

// The Log tab's rows by key (message id : file fingerprint), with their result and notes.
function logRows_(ctx) {
  const rows = {};
  const last = ctx.logSheet.getLastRow();
  if (last < 2) return rows;
  const col = (name) => LOG_HEADERS.indexOf(name);
  ctx.logSheet.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues().forEach((row) => {
    const key = String(row[col('Key')] || '').replace(/:error$/, '');
    rows[key] = { result: String(row[col('Result')]), notes: String(row[col('Notes')] || '') };
  });
  return rows;
}

// Takes the log rows that pass the test out of the Log tab and the Bill Records label off their
// emails, so the next runs sort those attachments again. An email that keeps other rows (a bill
// filed beside a skipped leaflet) is marked to be looked at again, or it would count as finished.
// Stops when time runs short and leaves the rest for another go.
function forgetRows_(ctx, test) {
  const out = { threads: 0, rows: 0, unfinished: false };
  const sheet = ctx.logSheet;
  const last = sheet.getLastRow();
  if (last < 2) return out;
  const col = (name) => LOG_HEADERS.indexOf(name);
  const rows = sheet.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues();
  const threadOf = (row) => {
    const m = /\/([^\/#?]+)\s*$/.exec(String(row[col('Email')]));
    return m ? m[1] : '';
  };
  const ids = [];
  const seen = {};
  rows.forEach((row) => {
    const id = threadOf(row);
    if (id && test(row) && !seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
  });
  const unlabelled = {};
  let batch = [];
  for (let i = 0; i < ids.length; i++) {
    if (past_(CONFIG.RUN_MINUTES)) {
      out.unfinished = true;
      break;
    }
    const thread = threadById_(ids[i]);
    if (thread) batch.push(thread);
    unlabelled[ids[i]] = true;
    if (batch.length === 100) {
      ctx.label.removeFromThreads(batch);
      batch = [];
    }
  }
  if (batch.length) ctx.label.removeFromThreads(batch);
  out.threads = Object.keys(unlabelled).length;

  const forget = (row) => test(row) && (unlabelled[threadOf(row)] || !threadOf(row));
  const messageOf = (row) => String(row[col('Key')]).split(':')[0];
  const forgotten = {};
  rows.filter(forget).forEach((row) => {
    forgotten[messageOf(row)] = true;
  });
  const keep = rows.filter((row) => !forget(row));
  out.rows = rows.length - keep.length;
  const recheck = {};
  keep.forEach((row) => {
    if (forgotten[messageOf(row)]) recheck['recheck:' + messageOf(row)] = '1';
  });
  if (Object.keys(recheck).length) PropertiesService.getScriptProperties().setProperties(recheck);
  sheet.getRange(2, 1, last - 1, LOG_HEADERS.length).clearContent();
  // Read back, text that looks like a formula has lost its protecting apostrophe.
  const values = keep.map((row) => row.map((v) => (typeof v === 'string' ? cell_(v) : v)));
  if (values.length) sheet.getRange(2, 1, values.length, LOG_HEADERS.length).setValues(values);
  return out;
}

function threadById_(id) {
  try {
    return GmailApp.getThreadById(id);
  } catch (e) {
    return null;
  }
}

// Trashes every file this script filed under the folder, then the utility and year folders left
// empty; property folders and the settings spreadsheet stay. True if it ran out of time.
function trashFiled_(folder, keepId, depth) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    if (past_(CONFIG.RUN_MINUTES)) return true;
    const file = files.next();
    if (file.getId() === keepId || file.isTrashed()) continue;
    if (String(file.getDescription() || '').indexOf('Filed by Bill Sorter') === 0) file.setTrashed(true);
  }
  const folders = folder.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    if (sub.isTrashed()) continue;
    if (trashFiled_(sub, keepId, depth + 1)) return true;
    if (depth >= 1 && isEmpty_(sub)) sub.setTrashed(true);
  }
  return false;
}

function isEmpty_(folder) {
  const files = folder.getFiles();
  while (files.hasNext()) if (!files.next().isTrashed()) return false;
  const folders = folder.getFolders();
  while (folders.hasNext()) if (!folders.next().isTrashed()) return false;
  return true;
}

/** The old script's name, so a trigger that was set up for it keeps working. */
function automateBillSorting(e) {
  processBills(e);
}

// ─── Keeping inside Apps Script's limits ─────────────────────────────────────

// When this execution started. setup() starts it before calling processBills(), so the time
// setup spends counts against the same six minutes.
const clock_ = { started: null };

function startClock_() {
  if (clock_.started !== null) return false;
  clock_.started = Date.now();
  return true;
}

function elapsedMs_() {
  return clock_.started === null ? 0 : Date.now() - clock_.started;
}

function past_(minutes) {
  return elapsedMs_() >= minutes * 60 * 1000;
}

// Scheduled runs share 90 minutes a day on a personal Google account; past that, Google fails
// every run and emails about it. Counting our own minutes lets the script stop first.
function minutesUsedToday_() {
  return Number(PropertiesService.getScriptProperties().getProperty(todayKey_()) || 0);
}

function addMinutesToday_(ms) {
  const props = PropertiesService.getScriptProperties();
  const key = todayKey_();
  props.getKeys().forEach((k) => {
    if (k.indexOf('minutes:') === 0 && k !== key) props.deleteProperty(k);
  });
  props.setProperty(key, String(minutesUsedToday_() + ms / 60000));
}

function todayKey_() {
  return 'minutes:' + Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

// ─── One run ─────────────────────────────────────────────────────────────────

// Works through the search 50 threads at a time until the time is up or nothing is left, then
// through conversations that already have the label, for emails Gmail labelled on arrival.
function runBatch_() {
  const ctx = openContext_();
  const tally = {};
  let finished = false;
  try {
    resortAfterUpdate_(ctx);
    const query = buildQuery_(ctx.properties);
    const tried = {};
    let start = 0;
    while (!finished && !past_(CONFIG.RUN_MINUTES)) {
      const page = GmailApp.search(query, start, PAGE);
      if (!page.length) {
        finished = true;
        break;
      }
      const fresh = page.filter((t) => !tried[t.getId()]);
      if (!fresh.length) {
        start += page.length; // threads tried this run that couldn't be labelled: look past them
        continue;
      }
      for (let i = 0; i < fresh.length && !past_(CONFIG.RUN_MINUTES); i++) {
        tried[fresh[i].getId()] = true;
        if (processThread_(fresh[i], ctx, tally) === 'done') fresh[i].addLabel(ctx.label);
      }
    }
    if (!finished) finished = !GmailApp.search(query, 0, 1).length;
    if (finished) finished = sweepLabelled_(ctx, tried, tally);
  } finally {
    flush_(ctx);
  }
  const counts = Object.keys(tally).map((result) => tally[result] + ' ' + result.toLowerCase()).join(', ');
  console.log((counts || 'Nothing new') + ' in ' + Math.round(elapsedMs_() / 1000) + 's. ' +
    (finished ? 'All caught up.' : 'More to do; the next run carries on from here.'));
}

// The hourly search; labelledToo leaves out "not already handled", for checkEmails.
function buildQuery_(properties, labelledToo) {
  const terms = CONFIG.SEARCH_TERMS.map((term) => (/\s/.test(term) ? '"' + term + '"' : term));
  properties.forEach((p) => p.accounts.forEach((account) => terms.push(account)));
  terms.push('(from:me bill)');
  // Gmail's search spells a label with spaces as hyphens: "Bill Records" → label:bill-records
  const label = CONFIG.LABEL.toLowerCase().replace(/\s+/g, '-');
  return 'has:attachment' + (labelledToo ? '' : ' -label:' + label) +
    ' (filename:pdf OR filename:jpg OR filename:jpeg OR filename:png)' +
    ' (' + terms.join(' OR ') + ')' +
    (CONFIG.SEARCH_SINCE ? ' after:' + CONFIG.SEARCH_SINCE : '');
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAGE = 100; // threads per Gmail search call

// Today's date. Its own function so the tests can fix it.
function today_() {
  return new Date();
}

// Gmail gives a conversation's labels to emails that arrive in it later, and MGL, for one, sends
// every bill under the same subject, so each new bill lands in an old conversation already
// labelled and the search above never sees it. So conversations with the label are looked
// through as well, for emails the Log doesn't have: from the last LOOK_BACK_DAYS the first time,
// and after that from a few hours before the previous look (mail can arrive late). Where it got
// to is kept, so a long first look is spread over several runs. True when it got to the end.
function sweepLabelled_(ctx, tried, tally) {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('sweepFrom')) {
    const last = Number(props.getProperty('sweptTo') || 0);
    props.setProperties({
      sweepFrom: String(last ? last - 6 * HOUR : today_().getTime() - CONFIG.LOOK_BACK_DAYS * DAY),
      sweepStarted: String(today_().getTime()),
      sweepAt: '0',
      sweepRetry: 'no',
    });
  }
  const from = Number(props.getProperty('sweepFrom'));
  let at = Number(props.getProperty('sweepAt') || 0);
  let retry = props.getProperty('sweepRetry') === 'yes';
  // Gmail's after: takes a whole day in its own time zone, so ask from the day before; the exact
  // time is applied to each email below.
  const query = buildQuery_(ctx.properties, true) + ' after:' +
    Utilities.formatDate(new Date(from - DAY), CONFIG.TIME_ZONE, 'yyyy/MM/dd');
  let finished = false;
  let stopped = false;
  while (!finished && !stopped && !past_(CONFIG.RUN_MINUTES)) {
    const page = GmailApp.search(query, at, PAGE);
    for (let i = 0; i < page.length; i++) {
      if (past_(CONFIG.RUN_MINUTES)) {
        stopped = true;
        break;
      }
      if (!tried[page[i].getId()]) {
        tried[page[i].getId()] = true;
        const state = processThread_(page[i], ctx, tally, from);
        if (state === 'later') {
          stopped = true;
          break;
        }
        if (state === 'retry') retry = true;
        if (state === 'done') page[i].addLabel(ctx.label);
      }
      at++;
    }
    if (page.length < PAGE && !stopped) finished = true;
  }
  if (!finished) {
    props.setProperties({ sweepAt: String(at), sweepRetry: retry ? 'yes' : 'no' });
    return false;
  }
  // After an error the next look starts from the same place, so that email is tried again.
  props.setProperty('sweptTo', String(retry ? from + 6 * HOUR : Number(props.getProperty('sweepStarted'))));
  ['sweepFrom', 'sweepStarted', 'sweepAt', 'sweepRetry'].forEach((k) => props.deleteProperty(k));
  return true;
}

// Returns 'done' when every email in the thread is handled and it can be labelled, 'retry'
// after an error worth trying again, and 'later' when time ran out part way through. Emails from
// before since (a time) are left alone.
function processThread_(thread, ctx, tally, since) {
  let failed = false;
  const messages = thread.getMessages();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (ctx.doneMessages.has(message.getId())) continue; // handled on an earlier run
    if (since && message.getDate().getTime() < since) continue;
    if (past_(CONFIG.RUN_MINUTES)) return 'later';
    const state = processMessage_(message, thread, ctx, tally);
    if (state === 'later') return 'later';
    if (state === 'failed') failed = true;
  }
  if (failed) return giveUp_(thread, ctx) ? 'done' : 'retry';
  clearAttempts_(thread, ctx);
  return 'done';
}

// One email, all or nothing: its log rows are kept together until it is finished, so if time runs
// out part way the whole email is done again next run. Files it saved are recognised then.
function processMessage_(message, thread, ctx, tally) {
  const items = billAttachments_(message);
  const rows = [];
  const results = [];
  let failed = false;
  let email = null;
  for (let j = 0; j < items.length; j++) {
    const item = items[j];
    const key = message.getId() + ':' + item.hash;
    if (ctx.done.has(key)) continue;
    item.count = items.length;
    let o;
    try {
      if (ctx.filed[item.hash]) {
        // the very same file came in another email and is filed already: nothing to open
        o = { result: 'Duplicate', url: ctx.filed[item.hash], notes: 'The very same file is already filed.' };
      } else {
        email = email || emailTexts_(message);
        o = handleAttachment_(message, item, ctx, email);
      }
    } catch (e) {
      console.log('Error on ' + item.name + ': ' + (e && e.stack ? e.stack : e));
      o = { result: 'Error', notes: String(e && e.message ? e.message : e) };
    }
    if (o === null) return 'later'; // no time left to open it
    if (o.result === 'Error') failed = true;
    rows.push(logValues_(thread, message, item, o, o.result === 'Error' ? key + ':error' : key));
    results.push({ key: key, result: o.result });
  }
  writeLog_(ctx, rows);
  results.forEach((r) => {
    if (r.result !== 'Error') ctx.done.add(r.key);
    tally[r.result] = (tally[r.result] || 0) + 1;
  });
  if (!failed) {
    ctx.doneMessages.add(message.getId());
    if (ctx.recheck[message.getId()]) {
      PropertiesService.getScriptProperties().deleteProperty('recheck:' + message.getId());
      delete ctx.recheck[message.getId()];
    }
  }
  return failed ? 'failed' : 'ok';
}

// Failed runs in a row for each thread are kept in the script's properties, and read once a run.
function giveUp_(thread, ctx) {
  const id = thread.getId();
  const attempts = (ctx.attempts[id] || 0) + 1;
  const props = PropertiesService.getScriptProperties();
  if (attempts >= CONFIG.MAX_ATTEMPTS) {
    props.deleteProperty('attempts:' + id);
    delete ctx.attempts[id];
    return true;
  }
  props.setProperty('attempts:' + id, String(attempts));
  ctx.attempts[id] = attempts;
  return false;
}

function clearAttempts_(thread, ctx) {
  const id = thread.getId();
  if (!ctx.attempts[id]) return;
  PropertiesService.getScriptProperties().deleteProperty('attempts:' + id);
  delete ctx.attempts[id];
}

// The PDF and image attachments worth reading. Inline images (logos, banners, signatures)
// are left out unless the message has nothing else, which is how some phones send photos.
function billAttachments_(message) {
  const pick = (attachments, smallestImage) => attachments
    .map(attachmentItem_)
    .filter((item) => item && item.size >= (item.type === 'application/pdf' ? 2 * 1024 : smallestImage));
  const items = pick(message.getAttachments({ includeInlineImages: false }), 15 * 1024);
  return items.length ? items : pick(message.getAttachments({ includeInlineImages: true }), 60 * 1024);
}

function attachmentItem_(attachment) {
  const type = billType_(attachment.getContentType(), attachment.getName());
  if (!type) return null;
  return {
    attachment: attachment,
    type: type,
    name: attachment.getName(),
    size: attachment.getSize(),
    hash: attachment.getHash(),
  };
}

// The type to hand Drive's OCR, or null for anything that can't be a bill.
function billType_(contentType, name) {
  const type = String(contentType || '').toLowerCase();
  const file = String(name || '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/.test(file)) return 'application/pdf';
  if (type === 'image/jpeg' || type === 'image/jpg' || /\.jpe?g$/.test(file)) return 'image/jpeg';
  if (type === 'image/png' || /\.png$/.test(file)) return 'image/png';
  if (type === 'image/gif') return 'image/gif';
  return null;
}

// Sorts one attachment. Returns null when it needs opening but the run is too close to its time
// limit to start, so it waits for next run.
function handleAttachment_(message, item, ctx, email) {
  const j = judge_(email, item, ctx);
  if (!j) return null;
  const v = j.v;
  const blob = j.blob;
  const outcome = {
    utility: v.utility.folder,
    fy: v.fy,
    month: MONTHS[v.month.m] + ' ' + v.month.y + ' (' + v.month.how + ')',
    notes: [v.notes, j.note].filter(Boolean).join(' '),
    account: v.accountId,
    billNo: v.billNo,
  };
  if (v.action === 'skip') return Object.assign(outcome, { result: 'Skipped' });

  const same = sameBill_(ctx, v, email.date);
  if (same) {
    return Object.assign(outcome, {
      result: 'Duplicate',
      property: same.property,
      url: same.url,
      notes: [outcome.notes, 'The same bill as one already filed (' + same.why + ').'].filter(Boolean).join(' '),
    });
  }

  placeGuess_(ctx, v, email.date);
  if (v.moved) outcome.month = MONTHS[v.month.m] + ' ' + v.month.y + ' (' + v.month.how + ', moved past another bill)';
  outcome.fy = v.fy;

  let property = null;
  if (v.action === 'file') property = v.match.property;
  if (v.action === 'new') property = addProperty_(ctx, v.utility, v.account, message.getSubject());
  const top = property ? property.folder : subfolder_(ctx, ctx.base, CONFIG.NEEDS_REVIEW);
  const target = subfolder_(ctx, subfolder_(ctx, top, v.utility.folder), v.fy);
  // Two different bills that want the same name (two meters, a levy beside the maintenance bill)
  // are told apart by account or bill number, not "(2)".
  const tag = v.utility.recurring && v.accountId ? v.accountId : v.billNo ? 'No ' + v.billNo.toUpperCase() : '';
  const altBase = tag ? v.fileBase + ' - ' + tag : '';
  const saved = saveFile_(ctx, target, blob, v.fileBase, extension_(item), item.hash, message.getId(), altBase,
    Boolean(property));
  const propertyName = property ? property.name : CONFIG.NEEDS_REVIEW;
  if (!saved.duplicate) rememberBill_(ctx, v, propertyName, email.date, saved.url);
  let result = 'Filed';
  if (v.action === 'new') result = 'Filed (new property)';
  if (v.action === 'review') result = 'Needs review';
  if (saved.duplicate) result = 'Duplicate';
  return Object.assign(outcome, {
    result: result,
    property: propertyName,
    matchedBy: v.action === 'new' ? 'new account ' + v.account : v.action === 'file' ? v.match.why : '',
    url: saved.url,
  });
}

// What to do with one attachment, opening it only if the email alone isn't enough. Returns null
// when it needs opening but the run is too close to its time limit to start.
function judge_(email, item, ctx) {
  const blob = item.attachment.copyBlob().setContentType(item.type);
  const texts = textsFor_(email, item);
  let v = classify_(texts, ctx.properties, email.date);
  let note = '';
  if (wantsReading_(v, texts, item, ctx)) {
    const tooMuch = tooMuchToRead_(blob, item);
    if (tooMuch) {
      note = 'Not opened (' + tooMuch + '), so this is based on the email.';
    } else {
      const read = readOnce_(ctx, blob, item);
      if (!read) return null;
      if (read.error) {
        note = "Couldn't read the attachment itself (" + read.error + '), so this is based on the email.';
      } else {
        texts.doc = read.text;
        if (texts.doc.length < 40) {
          note = 'Drive read almost no text from the attachment, so this is based on the email.';
        }
      }
    }
    texts.unread = texts.doc.length < 40;
    v = classify_(texts, ctx.properties, email.date);
  }
  return { blob: blob, texts: texts, v: v, note: note };
}

// Whether to open the attachment. Not when the email already names one of your account numbers
// (unless the email carries several attachments and only opening them shows which is the bill),
// and not when nothing about the email suggests a property bill at all, or it is a receipt.
function wantsReading_(v, t, item, ctx) {
  if (v.notABill) return false;
  if (CONFIG.READ_ATTACHMENTS === 'always') return true;
  const settled = v.action === 'file' && v.match.score >= 50 && v.utility !== OTHER;
  // A recurring bill whose email doesn't say the month is opened anyway: guessing the month from
  // when the email arrived is how one month's bill ends up looking like a copy of another's.
  if (settled && item.count === 1 && !(v.utility.recurring && isGuess_(v.month))) return false;
  const fromMe = Boolean(ctx.me) && t.from.indexOf(ctx.me) !== -1;
  return settled || fromMe || v.utilityScore >= 2 || Boolean(v.match.property || v.match.ambiguous) ||
    /(?:^|[^a-z])(?:e-?)?bills?(?![a-z])/.test(t.subject + ' ' + t.file);
}

// Why an attachment is too much to open, or '' if it isn't. Drive's OCR on big or long files
// is slow enough to sink a run, and bills are small.
function tooMuchToRead_(blob, item) {
  const mb = item.size / (1024 * 1024);
  if (mb > CONFIG.READ_MAX_MB) return mb.toFixed(1) + ' MB';
  if (item.type === 'application/pdf') {
    const pages = pdfPages_(blob);
    if (pages > CONFIG.READ_MAX_PAGES) return pages + ' pages';
  }
  return '';
}

// Counts "/Type /Page" entries in the raw PDF. Some PDFs pack these away where they can't be
// counted; those come out as 0 and are opened as normal.
function pdfPages_(blob) {
  const found = blob.getDataAsString('ISO-8859-1').match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return found ? found.length : 0;
}

// What the email says, read once for all of its attachments.
function emailTexts_(message) {
  return {
    date: message.getDate(),
    subject: normalize_(message.getSubject()),
    body: normalize_(String(message.getPlainBody() || '').slice(0, 20000)),
    from: normalize_(message.getFrom()),
  };
}

// The texts classify_ weighs for one attachment: the email's, its file name, and later its own.
function textsFor_(email, item) {
  return {
    doc: '',
    subject: email.subject,
    body: email.body,
    from: email.from,
    file: normalize_(item.name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_+/g, ' ')),
    photo: item.type.indexOf('image/') === 0,
    unread: false, // set when the attachment was too big to open or couldn't be read
  };
}

function extension_(item) {
  const m = /\.(pdf|jpe?g|png|gif)$/i.exec(item.name);
  if (m) return '.' + m[1].toLowerCase();
  return { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif' }[item.type];
}

// ─── Reading the attachment ──────────────────────────────────────────────────

// The attachment's text. Drive's OCR is the slow part, so each file is read once: its text is
// kept in the Read text tab under its fingerprint, and looking at the same file again (a resend,
// retrySkipped, a new version, checkEmails, a run cut off part way) takes a moment. Null when
// it hasn't been read before and the run is too near its time limit to read it now.
function readOnce_(ctx, blob, item) {
  if (ctx.newTexts[item.hash] !== undefined) return { text: ctx.newTexts[item.hash], error: '' };
  const row = textRows_(ctx)[item.hash];
  if (row) return { text: String(ctx.textSheet.getRange(row, 2).getValue()), error: '' };
  if (past_(CONFIG.READ_CUTOFF_MINUTES)) return null;
  const read = readText_(blob, item.name);
  const text = normalize_(read.text).slice(0, 30000); // a bill's details are on its first pages
  if (!read.error && text.length >= 40) ctx.newTexts[item.hash] = text;
  return { text: text, error: read.error };
}

// Where each kept text is in the Read text tab, by fingerprint; read the first time it's needed.
function textRows_(ctx) {
  if (!ctx.textRows) {
    ctx.textRows = {};
    const last = ctx.textSheet.getLastRow();
    if (last > 1) {
      ctx.textSheet.getRange(2, 1, last - 1, 1).getValues().forEach((r, i) => {
        ctx.textRows[String(r[0])] = i + 2;
      });
    }
  }
  return ctx.textRows;
}

// Drive turns the PDF or photo into a temporary Google Doc, reading the text with OCR, and
// the Doc is deleted straight after. Works for scanned bills and for PDFs with real text.
function readText_(blob, name) {
  let id = null;
  try {
    const title = 'Bill Sorter OCR - ' + String(name).replace(/[^\w. -]+/g, '');
    if (typeof Drive.Files.create === 'function') {
      // Drive API v3: asking for a Google Doc is what turns the conversion (and OCR) on.
      id = Drive.Files.create({ name: title, mimeType: MimeType.GOOGLE_DOCS }, blob,
        { ocrLanguage: CONFIG.OCR_LANGUAGE }).id;
    } else {
      // Drive API v2
      id = Drive.Files.insert({ title: title, mimeType: blob.getContentType() }, blob,
        { ocr: true, ocrLanguage: CONFIG.OCR_LANGUAGE }).id;
    }
    return { text: DocumentApp.openById(id).getBody().getText(), error: '' };
  } catch (e) {
    console.log("Couldn't read " + name + ': ' + (e && e.message ? e.message : e));
    return { text: '', error: String(e && e.message ? e.message : e) };
  } finally {
    if (id) removeQuietly_(id);
  }
}

function removeQuietly_(id) {
  try {
    Drive.Files.remove(id);
  } catch (e) {
    try {
      DriveApp.getFileById(id).setTrashed(true);
    } catch (e2) {
      console.log("Couldn't delete the temporary file " + id);
    }
  }
}

// ─── Deciding where a bill goes (pure functions: no Google services below here) ──

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

// A bill has an amount and something only bills have: a due date, a bill number or date, a
// billing period. Notices, newsletters and circulars mostly don't. The labels allow for the
// dots, colons and missing spaces of OCR ("Due Dt.", "Bill No:", "BillNo").
const MONEY = /(?:₹|\brs\.?\s*\d|\binr\b|\bamount\b|\btotal\b|\bpayable\b|\bpremium\b)/;
const BILL_LABELS = ['due date', 'due dt', 'due on', 'due by', 'pay by', 'pay before', 'payable by',
  'payable before', 'pay on or before', 'payable on or before', 'last date', 'bill date', 'bill dt', 'billing date',
  'date of bill', 'bill no', 'bill number', 'bill id', 'bill month', 'billing month', 'bill period', 'billing period',
  'billing cycle', 'bill for the period', 'bill for the month', 'bill amount', 'current bill', 'current charges',
  'invoice no', 'invoice number', 'invoice date', 'inv no', 'amount payable', 'payable amount', 'amount due',
  'total due', 'net payable', 'total payable', 'net amount', 'amount to be paid', 'receipt no', 'monthly rent',
  'rent receipt', 'licence fee', 'license fee', 'leave and licence', 'leave and license', 'policy period',
  'period of insurance', 'period of cover', 'policy no', 'policy number', 'sum insured'];
const BILLNESS = new RegExp('(?:^|[^a-z])(?:' +
  BILL_LABELS.map((label) => label.split(' ').join('[\\s.:/-]*')).join('|') + ')(?![a-z])');
const BILL_WORD = /(?:^|[^a-z])(?:e-?)?(?:bill|invoice)s?(?![a-z])/;
// The heading of a bill: "Maintenance Bill", "Tax Invoice", "e-Bill". Not "your next bill".
const BILL_HEADING = new RegExp('(?:^|[^a-z])(?:(?:maintenance|electricity|energy|gas|water|tax|society|' +
  'telephone|broadband|internet|e-?)\\s*bill|(?:tax\\s*)?invoice|bill of supply|rent receipt)(?![a-z])');
const NOTICE_WORD = /(?:^|[^a-z])(?:notice|circular|reminder|newsletter|statement|minutes|agenda)(?![a-z])/;

// How far it reads like a bill:
//   'bill'   the attachment has an amount and a due date, bill number, bill date or billing period,
//            or an amount under a heading like "Maintenance Bill" or "Tax Invoice"
//   'amount' the attachment has an amount and nothing else of a bill
//   'email'  the attachment wasn't read (or couldn't be), and the email calls it a bill or invoice
//   'sender' it couldn't be read, and it came from the utility itself
//   ''       nothing says it is a bill
function billEvidence_(t, found) {
  if (t.doc.length >= 40) {
    if (!MONEY.test(t.doc)) return '';
    if (BILLNESS.test(t.doc)) return 'bill';
    // A heading is at the top; OCR reads a photo in no particular order, so anywhere in one.
    const head = t.photo ? t.doc : t.doc.slice(0, 300);
    if (BILL_HEADING.test(head) && !NOTICE_WORD.test(head)) return 'bill';
    return 'amount';
  }
  if (BILL_WORD.test(t.subject + ' ' + t.file)) return 'email';
  if (t.unread && found.sender) return 'sender';
  return '';
}

// t holds the lower-cased text of the attachment (doc), subject, body, from line and file name.
// Returns what to do with the bill, and the utility, month, financial year and file name.
function classify_(t, properties, arrived) {
  const match = matchProperty_(t, properties);
  const found = detectUtility_(t);
  // One of your account numbers says whose bill it is, so a faint sign of its type will do
  // (the word "electricity" in the email, say).
  const utility = found.utility === OTHER && match.accounts.length && found.weak ? found.weak : found.utility;
  const month = detectBillMonth_(t, utility, arrived);
  const evidence = billEvidence_(t, found);
  const not = notABill_(t);
  const v = {
    utility: utility, utilityScore: found.score, month: month, fy: financialYear_(month),
    fileBase: fileBase_(month, utility), match: match, account: '', action: '', notes: '',
    billNo: extractBillNo_(t), accountId: '', notABill: Boolean(not),
  };
  const named = match.property ? match.property.name : '';
  const skip = (notes) => {
    v.action = 'skip';
    v.notes = notes;
  };
  if (not === 'payment') {
    skip('A payment receipt or confirmation, not a bill.');
  } else if (not) {
    skip('A reminder or notice, not a bill.');
  } else if (utility === OTHER) {
    skip('Not one of the bill types it files.');
  } else if (notProperty_(t)) {
    skip('A bank or card statement, an online order or a vehicle bill, not a property bill.');
  } else if (!evidence) {
    skip("Doesn't read like a bill: no amount, or nothing a bill has (a due date, bill number, bill date or " +
      'billing period).');
  } else if (match.ambiguous) {
    v.action = 'review';
    v.notes = 'Matches ' + match.ambiguous.join(' and ') + ' equally.';
  } else if (match.property && match.accounts.length && evidence === 'amount' &&
      !BILL_WORD.test(t.subject + ' ' + t.file)) {
    skip('Has an account number of ' + named + ' and an amount, but neither it nor the email says bill: no ' +
      'due date, bill number, bill date or billing period.');
  } else if (match.property && match.accounts.length) {
    v.action = 'file';
  } else if (match.property && (evidence === 'amount' || evidence === 'sender')) {
    skip('Matches ' + named + ' only by address, and ' + (evidence === 'amount'
      ? 'has an amount but no due date, bill number, bill date or billing period.'
      : "the attachment couldn't be read.") + ' Add its account number to the sheet to file it anyway.');
  } else if (match.property && utility.needsAccount && !fixedLine_(t, utility)) {
    skip('Matches ' + named + ' only by address, and reads like a mobile phone bill. Phone bills are filed ' +
      'only when their account number is in the sheet, so your own mobile stays out; broadband and landline ' +
      'bills go by address.');
  } else if (match.property) {
    v.action = 'file';
  } else if (evidence === 'amount' || evidence === 'sender' || found.score < 4) {
    skip('Not clearly a property bill.');
  } else if (!utility.newProperty) {
    skip('A ' + utility.short.toLowerCase() + ' bill that matches none of your properties. If it is for ' +
      'one of them, add its account number to that property in the sheet.');
  } else {
    // A bill for a property the sheet doesn't have yet: its account number starts a new one.
    v.account = extractAccount_(t);
    v.action = v.account ? 'new' : 'review';
    if (!v.account) v.notes = 'No known property and no account number found.';
  }
  // The account this bill belongs to, used to recognise a second copy of it.
  v.accountId = (match.property && match.accounts[0]) || v.account;
  return v;
}

// 'payment' for a payment receipt, 'notice' for a reminder or notice, '' otherwise. The file
// name always counts; the subject only when it doesn't also call the email a bill.
function notABill_(t) {
  if (!notABill_.payments) {
    notABill_.payments = CONFIG.PAYMENTS.map(phraseRegex_).filter(Boolean);
    notABill_.notices = CONFIG.NOTICES.map(phraseRegex_).filter(Boolean);
  }
  const saysBill = BILL_WORD.test(t.subject);
  if (notABill_.payments.some((re) => re.test(t.subject) || re.test(t.file))) return 'payment';
  if (notABill_.notices.some((re) => re.test(t.file) || (!saysBill && re.test(t.subject)))) return 'notice';
  return '';
}

function notProperty_(t) {
  if (!notProperty_.patterns) notProperty_.patterns = CONFIG.NOT_PROPERTY.map(phraseRegex_).filter(Boolean);
  return notProperty_.patterns.some((re) => re.test(t.doc) || re.test(t.subject) || re.test(t.file));
}

// Whether a phone or internet bill is for a broadband or landline connection (a place) rather than
// a mobile (a person). The bill's own text counts unless it is a postpaid or prepaid mobile bill
// advertising broadband.
function fixedLine_(t, utility) {
  if (!utility.fixedLine) return false;
  if (!utility.fixedPatterns) utility.fixedPatterns = utility.fixedLine.map(phraseRegex_).filter(Boolean);
  if ((utility.fixedLineSenders || []).some((s) => t.from.indexOf(s) !== -1)) return true;
  if (utility.fixedPatterns.some((re) => re.test(t.subject) || re.test(t.file))) return true;
  return !/(?:^|[^a-z])(?:postpaid|prepaid)(?![a-z])/.test(t.doc) && utility.fixedPatterns.some((re) => re.test(t.doc));
}

const BILL_NO_RE = /(?:^|[^a-z])(?:bill|invoice)\s*(?:no\b|number\b|num\b|#)\.?\s*[:#.-]?\s*([a-z0-9][a-z0-9\/-]{0,30})/g;

// The bill's own number ("Bill No: 145"), which a re-sent copy of the same bill shares.
function extractBillNo_(t) {
  const texts = [t.doc, t.subject, t.file];
  for (let i = 0; i < texts.length; i++) {
    BILL_NO_RE.lastIndex = 0;
    let m;
    while ((m = BILL_NO_RE.exec(texts[i]))) {
      const token = m[1].replace(/[\/-]+$/, '');
      if (token.length >= 2 && /\d/.test(token) && !/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(token)) return token;
    }
  }
  return '';
}

// The bill type with the most evidence, if it has enough; weak is the leader even when it hasn't,
// and sender says whether the email came from that utility's own address.
function detectUtility_(t) {
  let best = { utility: OTHER, score: 0, sender: false };
  UTILITIES.forEach((u) => {
    const sender = u.senders.some((s) => t.from.indexOf(s) !== -1);
    let score = sender ? 5 : 0;
    patternsFor_(u).forEach((re) => {
      if (re.test(t.subject) || re.test(t.file)) score += 3;
      else if (re.test(t.doc)) score += 2;
      else if (re.test(t.body)) score += 1;
    });
    if (score > best.score) best = { utility: u, score: score, sender: sender };
  });
  if (best.score >= 2) return best;
  return { utility: OTHER, score: best.score, sender: false, weak: best.score ? best.utility : null };
}

function patternsFor_(utility) {
  if (!utility.patterns) utility.patterns = utility.keywords.map(phraseRegex_).filter(Boolean);
  return utility.patterns;
}

// An account number is the strongest evidence; a keyword (building, flat, road) counts for
// much less, and less again when it is only in the email body (which may hold your own
// address). A keyword can also be a sender, "mahanagargas.com" say, for a company whose emails
// never show the account number. Two properties scoring the same is reported as ambiguous.
function matchProperty_(t, properties) {
  const strong = t.doc + ' \n ' + t.subject + ' \n ' + t.file + ' \n ' + t.from;
  const scored = [];
  properties.forEach((p) => {
    let score = 0;
    const why = [];
    const found = [];
    const patterns = propertyPatterns_(p);
    patterns.accounts.forEach((a) => {
      const re = a.re;
      const w = re.test(t.doc) || re.test(t.file) ? 100 : re.test(t.subject) ? 80 : re.test(t.body) ? 50 : 0;
      if (w) {
        score += w;
        why.push('account ' + a.account);
        found.push({ account: a.account, w: w });
      }
    });
    const seen = {};
    patterns.keywords.forEach((k) => {
      if (seen[k.key]) return;
      const w = k.re.test(strong) ? 10 : k.re.test(t.body) ? 5 : 0;
      if (w) {
        seen[k.key] = true;
        score += w;
        why.push('"' + k.keyword + '"');
      }
    });
    const accounts = found.sort((a, b) => b.w - a.w).map((x) => x.account);
    if (score) scored.push({ property: p, score: score, why: why.join(', '), accounts: accounts });
  });
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { property: null, score: 0, accounts: [] };
  if (scored.length > 1 && scored[1].score === scored[0].score) {
    return { property: null, score: 0, accounts: [], ambiguous: [scored[0].property.name, scored[1].property.name] };
  }
  return scored[0];
}

// A property's account numbers and keywords as patterns, made once and kept on the property.
function propertyPatterns_(p) {
  if (!p.patterns) {
    p.patterns = {
      accounts: p.accounts.map((account) => ({ account: account, re: numberRegex_(account) })),
      keywords: p.keywords.map((keyword) => ({
        keyword: keyword, key: keyword.toLowerCase().replace(/[^a-z0-9]/g, ''), re: phraseRegex_(keyword),
      })).filter((k) => k.re),
    };
  }
  return p.patterns;
}

// "Mother's Love" matches "mothers love", "MOTHER S LOVE" and "Mother’s-Love", but a phrase never
// matches part of a longer word or number: "f-34" matches "F-34, Sej Plaza" and not "a bill of 3,450".
function phraseRegex_(phrase) {
  const parts = String(phrase).toLowerCase().match(/[a-z]+|\d+/g);
  if (!parts) return null;
  const edge = (part) => (/\d/.test(part) ? '0-9' : 'a-z');
  return new RegExp('(?:^|[^' + edge(parts[0]) + '])' + parts.join('[^a-z0-9]{0,3}') +
    '(?![' + edge(parts[parts.length - 1]) + '])');
}

// An account number on its own, allowing spaces or hyphens inside it and leading zeros
// before it, but never as part of a longer number.
function numberRegex_(account) {
  const digits = String(account).replace(/^0+/, '');
  if (!digits) return /(?!)/; // all zeros: matches nothing
  return new RegExp('(?:^|\\D)0*' + digits.split('').join('[ -]?') + '(?!\\d)');
}

const ACCOUNT_LABELS = ['ca no', 'ca number', 'contract account', 'consumer no', 'consumer number', 'consumer id',
  'account no', 'account number', 'account id', 'a/c no', 'acct no', 'bp no', 'bp number', 'business partner',
  'customer no', 'customer number', 'customer id', 'connection no', 'connection number', 'property account',
  'property no', 'property id', 'relationship no', 'relationship number'];
const ACCOUNT_RE = new RegExp('(?:^|[^a-z])(?:' +
  ACCOUNT_LABELS.map((label) => label.replace('/', '\\/').split(' ').join('[\\s.:]*')).join('|') +
  ')[^\\d]{0,25}?(\\d{6,16})(?!\\d)', 'g');

// The account number printed next to a label like "CA No." or "Consumer No.", for naming a
// new property. Bill and invoice numbers change every month, so they are never used.
function extractAccount_(t) {
  const texts = [t.doc, t.subject, t.file, t.body];
  for (let i = 0; i < texts.length; i++) {
    ACCOUNT_RE.lastIndex = 0;
    let m;
    while ((m = ACCOUNT_RE.exec(texts[i]))) {
      if (!looksLikeDate_(m[1])) return m[1];
    }
  }
  return '';
}

function looksLikeDate_(digits) {
  if (digits.length !== 8) return false;
  const d = Number(digits.slice(0, 2));
  const m = Number(digits.slice(2, 4));
  const y = Number(digits.slice(4));
  return d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1990 && y <= 2099;
}

function financialYear_(ym) {
  const start = ym.m >= 3 ? ym.y : ym.y - 1; // April starts the year
  return 'FY ' + start + '-' + String(start + 1).slice(-2);
}

// "2026-04 April 2026 Electricity Bill": the number first so a year's bills sort in order.
function fileBase_(ym, utility) {
  return ym.y + '-' + ('0' + (ym.m + 1)).slice(-2) + ' ' + MONTHS[ym.m] + ' ' + ym.y + ' ' + utility.label;
}

function normalize_(text) {
  return String(text || '').toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Which month a bill is for ───────────────────────────────────────────────

const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|' +
  'sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])';

// Every pattern starts with a one-character guard in group 1, so a match never begins in the
// middle of a word or number. Earlier patterns win where two overlap.
const DATE_PATTERNS = [
  // 05-04-2026, 5/4/26, 05.04.2026 (day first, as on Indian bills)
  { kind: 'date', re: /(^|[^\d])(\d{1,2})([/.-])(\d{1,2})\3(\d{4}|\d{2})(?!\d)/g, read: (x) => [x[5], x[4] - 1, x[2]] },
  // 2026-04-05
  { kind: 'date', re: /(^|[^\d])(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, read: (x) => [x[2], x[3] - 1, x[4]] },
  // 5 April 2026, 05-Apr-2026, 05-Apr-26, 5th Apr, 2026
  {
    kind: 'date',
    re: new RegExp('(^|[^a-z\\d])(\\d{1,2})(?:st|nd|rd|th)?[\\s/.,-]*' + MON +
      "(?:[\\s/.,'-]*(\\d{4})|\\s*[/.'-]\\s*(\\d{2}))(?!\\d)", 'g'),
    read: (x) => [x[4] || x[5], monthIndex_(x[3]), x[2]],
  },
  // April 5, 2026
  {
    kind: 'date',
    re: new RegExp('(^|[^a-z])' + MON + '[\\s/.-]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s/.-]*(\\d{4})(?!\\d)', 'g'),
    read: (x) => [x[4], monthIndex_(x[2]), x[3]],
  },
  // Apr-Jun 2026, April to June 2026
  {
    kind: 'range',
    re: new RegExp('(^|[^a-z])' + MON + '\\s*(?:-|to|till)\\s*' + MON + "[\\s/.,'-]*(\\d{4}|\\d{2})(?!\\d)", 'g'),
  },
  // April 2026, APR-2026, Apr'26, apr-26
  {
    kind: 'month',
    re: new RegExp('(^|[^a-z])' + MON + "(?:[\\s/.,-]*(\\d{4})|\\s*['/-]\\s*(\\d{2}))(?!\\d)", 'g'),
    read: (x) => [x[3] || x[4], monthIndex_(x[2]), null],
  },
  // 04/2026
  { kind: 'month', re: /(^|[^\d/.-])(\d{1,2})[/-](\d{4})(?![\d/-])/g, read: (x) => [x[3], x[2] - 1, null] },
];

const MONTH_LABEL = /(?:bill(?:ing)?\s*month|month\s*of\s*(?:the\s*)?bill|statement\s*month|for\s*the\s*month(?:\s*of)?)\b/g;
const PERIOD_LABEL = /(?:bill(?:ing)?\s*period|bill(?:ing)?\s*cycle|service\s*period|consumption\s*period|for\s*the\s*period|policy\s*period|period\s*of\s*(?:bill|service|insurance|cover)|\bperiod)\b/g;
const DATE_LABEL = /(?:bill(?:ing)?\s*date|date\s*of\s*(?:the\s*)?bill|bill\s*(?:issue|generation)\s*date|invoice\s*date|date\s*of\s*invoice|statement\s*date|receipt\s*date|date\s*of\s*issue|issue\s*date|bill\s*dt)\b/g;
const CONNECTOR = /^\s*(?:-|to|till|until|upto|up to|through)\s*$/;

// Looks, in this order, for: the "Bill Month" printed on the bill; its billing period; a month
// in the email subject; the same two labels in the email body; any from-to period on the bill;
// the bill date; and last of all the date the email arrived. Anything more than two years
// before the email, or six months after it, is ignored as a misread.
function detectBillMonth_(t, utility, arrived) {
  const now = ymOf_(arrived);
  const plausible = (c) => {
    const diff = (c.y * 12 + c.m) - (now.y * 12 + now.m);
    return diff >= -24 && diff <= 6;
  };
  const choose = (start, end) => (utility.inArrears ? end : start);
  const shifted = (d) => (utility.inArrears ? addMonths_(d, -1) : { y: d.y, m: d.m });

  const labelMonth = (w) => {
    const first = w.tokens[0];
    if (!first || first.index > 25) return null;
    const period = periodAt_(w.tokens, 0, w.text);
    if (period) return choose(period.start, period.end);
    if (first.kind === 'month' || (first.kind === 'date' && first.index <= 3)) return first;
    return null;
  };
  const labelPeriod = (w) => {
    const period = firstPeriod_(w.tokens, w.text);
    return period ? choose(period.start, period.end) : null;
  };
  const labelDate = (w) => {
    const first = w.tokens[0];
    return first && first.kind === 'date' && first.index <= 25 ? shifted(first) : null;
  };
  const fromSubject = (text) => {
    const tokens = scanDates_(text);
    const period = firstPeriod_(tokens, text);
    if (period) return choose(period.start, period.end);
    const month = tokens.filter((x) => x.kind === 'month')[0];
    if (month) return month;
    const date = tokens.filter((x) => x.kind === 'date')[0];
    return date ? shifted(date) : null;
  };
  const anyPeriod = (text) => {
    const period = firstPeriod_(scanDates_(text), text);
    return period ? choose(period.start, period.end) : null;
  };

  const steps = [
    ['Bill Month on the bill', () => afterLabel_(t.doc, MONTH_LABEL, 40).map(labelMonth)],
    ['billing period on the bill', () => afterLabel_(t.doc, PERIOD_LABEL, 80).map(labelPeriod)],
    ['email subject', () => [fromSubject(t.subject)]],
    ['Bill Month in the email', () => afterLabel_(t.body, MONTH_LABEL, 40).map(labelMonth)],
    ['billing period in the email', () => afterLabel_(t.body, PERIOD_LABEL, 80).map(labelPeriod)],
    ['period on the bill', () => [anyPeriod(t.doc)]],
    ['bill date', () => afterLabel_(t.doc, DATE_LABEL, 40).map(labelDate)],
    ['bill date in the email', () => afterLabel_(t.body, DATE_LABEL, 40).map(labelDate)],
  ];
  for (let i = 0; i < steps.length; i++) {
    const found = steps[i][1]().filter((c) => c && plausible(c))[0];
    if (found) return { y: found.y, m: found.m, how: steps[i][0] };
  }
  const fallback = utility.inArrears ? addMonths_(now, -1) : now;
  return {
    y: fallback.y,
    m: fallback.m,
    how: utility.inArrears ? 'month before the email arrived' : 'month the email arrived',
  };
}

// The text just after each place a label appears, and the dates in it.
function afterLabel_(text, labelRe, width) {
  const windows = [];
  labelRe.lastIndex = 0;
  let x;
  while ((x = labelRe.exec(text))) {
    const from = x.index + x[0].length;
    windows.push(text.slice(from, from + width));
  }
  return windows.map((w) => ({ text: w, tokens: scanDates_(w) }));
}

// Every date ("05-04-2026"), month ("APR-2026") and month range ("Apr-Jun 2026") in the text,
// in reading order, each with where it starts and ends.
function scanDates_(text) {
  const tokens = [];
  DATE_PATTERNS.forEach((p) => {
    p.re.lastIndex = 0;
    let x;
    while ((x = p.re.exec(text))) {
      const index = x.index + x[1].length;
      const end = x.index + x[0].length;
      if (tokens.some((tok) => index < tok.end && end > tok.index)) continue;
      const token = p.kind === 'range' ? rangeToken_(x) : dateToken_(p.kind, p.read(x));
      if (token) tokens.push(Object.assign(token, { index: index, end: end }));
    }
  });
  return tokens.sort((a, b) => a.index - b.index);
}

function dateToken_(kind, parts) {
  const y = fullYear_(parts[0]);
  const m = Number(parts[1]);
  const d = parts[2] === null ? null : Number(parts[2]);
  if (!(m >= 0 && m <= 11) || y < 2000 || y > 2099) return null;
  if (d !== null && !(d >= 1 && d <= 31)) return null;
  return { kind: kind, y: y, m: m, d: d };
}

function rangeToken_(x) {
  const year = fullYear_(x[4]);
  const from = monthIndex_(x[2]);
  const to = monthIndex_(x[3]);
  if (year < 2000 || year > 2099) return null;
  return { kind: 'range', start: { y: from > to ? year - 1 : year, m: from }, end: { y: year, m: to } };
}

// A range token, or two dates (or two months) joined by "to", "-", "till" and so on.
function periodAt_(tokens, i, text) {
  const a = tokens[i];
  const b = tokens[i + 1];
  if (!a) return null;
  if (a.kind === 'range') return { start: a.start, end: a.end };
  if (b && b.kind === a.kind && CONNECTOR.test(text.slice(a.end, b.index))) return { start: a, end: b };
  return null;
}

function firstPeriod_(tokens, text) {
  for (let i = 0; i < tokens.length; i++) {
    const period = periodAt_(tokens, i, text);
    if (period) return period;
  }
  return null;
}

function monthIndex_(word) {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(String(word).slice(0, 3));
}

function fullYear_(y) {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

// Month arithmetic on {y, m} pairs, so 31 May minus a month is April, not 1 May.
function addMonths_(ym, count) {
  const total = ym.y * 12 + ym.m + count;
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
}

function ymOf_(date) {
  const s = Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM');
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) - 1 };
}

// ─── Drive, the settings spreadsheet and the log ─────────────────────────────

const PROPERTY_HEADERS = ['Property', 'Account numbers', 'Keywords', 'Folder ID', 'Notes'];
const PROPERTY_HELP = [
  'The folder name in Drive. Rename it here or in Drive and the other one follows.',
  'Separate with commas. A bill showing any of these numbers goes to this property.',
  'Building names, flat numbers, roads: words on a bill that point to this property. Separate with commas. ' +
    'An account number always counts for more.',
  'Filled in by the script. Leave it alone.',
  '',
];
const LOG_HEADERS = ['Processed', 'Email date', 'From', 'Subject', 'Attachment', 'Result', 'Property', 'Utility',
  'Financial year', 'Bill month', 'Matched by', 'Drive file', 'Email', 'Notes', 'Key', 'Account', 'Bill no'];

function openContext_() {
  if (typeof Drive === 'undefined') {
    throw new Error('Add the Drive API service first: in the Apps Script editor, click + next to Services, ' +
      'choose Drive API, then Add.');
  }
  const props = PropertiesService.getScriptProperties();
  const base = baseFolder_(props);
  const settings = settingsSpreadsheet_(props, base);
  const ctx = {
    base: base,
    settings: settings,
    propertySheet: propertiesTab_(settings),
    logSheet: logTab_(settings),
    textSheet: textTab_(settings),
    pending: [], // Log rows not written yet
    newTexts: {}, // attachment texts not kept yet, by fingerprint
    label: GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL),
    me: myAddress_(),
    folders: {},
  };
  ctx.properties = loadProperties_(ctx, props);
  remember_(ctx);
  return ctx;
}

// What earlier runs did, from the Log, and the emails retrySkipped wants looked at again though
// the Log shows a bill filed from them.
function remember_(ctx) {
  Object.assign(ctx, loadMemory_(ctx.logSheet));
  ctx.recheck = {};
  ctx.attempts = {};
  const saved = PropertiesService.getScriptProperties().getProperties();
  Object.keys(saved).forEach((k) => {
    if (k.indexOf('attempts:') === 0) ctx.attempts[k.slice(9)] = Number(saved[k]);
    if (k.indexOf('recheck:') !== 0) return;
    ctx.recheck[k.slice(8)] = true;
    ctx.doneMessages.delete(k.slice(8));
  });
}

// Your own address, so bills you forward to yourself are always looked at properly.
function myAddress_() {
  try {
    return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

function baseFolder_(props) {
  const id = props.getProperty('BASE_FOLDER_ID');
  if (id) {
    try {
      const folder = DriveApp.getFolderById(id);
      if (!folder.isTrashed()) return folder;
    } catch (e) {
      // gone: find or make it again below
    }
  }
  const found = DriveApp.getRootFolder().getFoldersByName(CONFIG.BASE_FOLDER);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(CONFIG.BASE_FOLDER);
  props.setProperty('BASE_FOLDER_ID', folder.getId());
  return folder;
}

function settingsSpreadsheet_(props, base) {
  const id = props.getProperty('SETTINGS_ID');
  if (id) {
    try {
      if (!DriveApp.getFileById(id).isTrashed()) return SpreadsheetApp.openById(id);
    } catch (e) {
      // gone: make a new one below
    }
  }
  const ss = SpreadsheetApp.create(CONFIG.SETTINGS_FILE);
  const blank = ss.getSheets()[0];
  propertiesTab_(ss);
  logTab_(ss);
  textTab_(ss);
  ss.deleteSheet(blank);
  DriveApp.getFileById(ss.getId()).moveTo(base);
  props.setProperty('SETTINGS_ID', ss.getId());
  return ss;
}

function propertiesTab_(ss) {
  let sheet = ss.getSheetByName('Properties');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Properties', 0);
  sheet.getRange('B:B').setNumberFormat('@'); // keep account numbers as text, leading zeros and all
  sheet.getRange('D:D').setNumberFormat('@');
  sheet.getRange(1, 1, 1, PROPERTY_HEADERS.length).setValues([PROPERTY_HEADERS]).setFontWeight('bold');
  PROPERTY_HELP.forEach((help, i) => {
    if (help) sheet.getRange(1, i + 1).setNote(help);
  });
  const rows = STARTING_PROPERTIES.map((p) => [p.name, p.accounts.join(', '), p.keywords.join(', '), '', '']);
  if (rows.length) sheet.getRange(2, 1, rows.length, PROPERTY_HEADERS.length).setValues(rows);
  sheet.setFrozenRows(1);
  [300, 220, 380, 120, 380].forEach((width, i) => sheet.setColumnWidth(i + 1, width));
  return sheet;
}

function logTab_(ss) {
  let sheet = ss.getSheetByName('Log');
  if (!sheet) {
    sheet = ss.insertSheet('Log');
    sheet.setFrozenRows(1);
  }
  // A log made by an earlier version gets the columns added since.
  const header = sheet.getRange(1, 1, 1, LOG_HEADERS.length);
  if (header.getValues()[0].join('|') !== LOG_HEADERS.join('|')) {
    header.setValues([LOG_HEADERS]).setFontWeight('bold');
    const letter = (name) => String.fromCharCode(65 + LOG_HEADERS.indexOf(name));
    sheet.getRange(letter('Account') + ':' + letter('Bill no')).setNumberFormat('@');
  }
  return sheet;
}

// What Drive's OCR read from each attachment, kept so no file is read twice. Clearing it does no
// harm: files are then read again when they are next looked at.
function textTab_(ss) {
  let sheet = ss.getSheetByName('Read text');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Read text');
  sheet.getRange(1, 1, 1, 2).setValues([['Fingerprint', 'Text read from the attachment']]).setFontWeight('bold');
  sheet.getRange('B:B').setNumberFormat('@');
  sheet.setFrozenRows(1);
  return sheet;
}

function loadProperties_(ctx, props) {
  const values = ctx.propertySheet.getDataRange().getValues();
  const list = [];
  for (let r = 1; r < values.length; r++) {
    const name = String(values[r][0] || '').trim();
    if (!name) continue;
    list.push({
      row: r + 1,
      name: name,
      accounts: splitAccounts_(values[r][1]),
      keywords: splitKeywords_(values[r][2]),
      folderId: String(values[r][3] || '').trim(),
    });
  }
  list.forEach((p) => {
    p.folder = syncFolder_(p, ctx, props);
  });
  return list;
}

// Account numbers separated by commas, semicolons, new lines or spaces. One printed in groups,
// like "2100 0080 0764", is one number: groups shorter than six digits are joined up.
function splitAccounts_(cell) {
  const accounts = [];
  String(cell || '').split(/[,;\n]+/).forEach((part) => {
    let run = '';
    part.split(/\s+/).map((group) => group.replace(/\D/g, '')).filter(Boolean).forEach((group) => {
      if (group.length < 6) {
        run += group;
        return;
      }
      if (run) accounts.push(run);
      run = '';
      accounts.push(group);
    });
    if (run) accounts.push(run);
  });
  return accounts.filter((digits) => digits.length >= 6);
}

function splitKeywords_(cell) {
  return String(cell || '').split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

// Finds the property's folder by its ID (made if missing) and keeps its name in step with the
// sheet: rename either one and the other follows. If both changed, the sheet wins.
function syncFolder_(p, ctx, props) {
  let folder = null;
  if (p.folderId) {
    try {
      folder = DriveApp.getFolderById(p.folderId);
      if (folder.isTrashed()) folder = null;
    } catch (e) {
      folder = null;
    }
  }
  if (!folder) {
    folder = childFolder_(ctx.base, p.name);
    ctx.propertySheet.getRange(p.row, 4).setValue(folder.getId());
  } else {
    const lastName = props.getProperty('name:' + folder.getId());
    const driveName = folder.getName();
    if (driveName !== p.name) {
      if (lastName && p.name === lastName) {
        ctx.propertySheet.getRange(p.row, 1).setValue(driveName); // renamed in Drive
        p.name = driveName;
      } else {
        folder.setName(p.name); // renamed in the sheet
      }
    }
  }
  p.folderId = folder.getId();
  if (props.getProperty('name:' + p.folderId) !== p.name) props.setProperty('name:' + p.folderId, p.name);
  return folder;
}

function addProperty_(ctx, utility, account, subject) {
  const name = 'New property - ' + utility.short + ' ' + account;
  const folder = childFolder_(ctx.base, name);
  const note = 'Added automatically on ' + Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'd MMM yyyy') +
    ' from "' + subject + '". Rename it, add keywords, or move the account number into the right property\'s row.';
  ctx.propertySheet.appendRow([name, account, '', folder.getId(), cell_(note)]);
  const property = {
    row: ctx.propertySheet.getLastRow(),
    name: name,
    accounts: [account],
    keywords: [],
    folderId: folder.getId(),
    folder: folder,
  };
  PropertiesService.getScriptProperties().setProperty('name:' + folder.getId(), name);
  ctx.properties.push(property);
  return property;
}

function subfolder_(ctx, parent, name) {
  const key = parent.getId() + '/' + name;
  if (!ctx.folders[key]) ctx.folders[key] = childFolder_(parent, name);
  return ctx.folders[key];
}

function childFolder_(parent, name) {
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

// Saves the bill unless the very same file has been filed before, anywhere under the bills
// folder: the log knows most of them, Drive's search finds the rest by the fingerprint in their
// description, and a file a cut-off run saved moments ago is found by its name. A different bill
// that wants a taken name gets altBase (the name with its account number) or " (2)", " (3)".
// placed: it goes to a property, so a copy this same email left in _Needs Review moves there.
function saveFile_(ctx, folder, blob, base, ext, hash, messageId, altBase, placed) {
  if (ctx.filed[hash]) return { url: ctx.filed[hash], duplicate: true };
  const elsewhere = filedCopy_(hash);
  if (elsewhere) {
    const same = sameFile_(ctx, elsewhere, hash, messageId);
    if (!same.duplicate && placed && !inFolder_(elsewhere, folder)) {
      const spot = freeName_(folder, base, ext, altBase, hash);
      if (spot.name) elsewhere.setName(spot.name);
      elsewhere.moveTo(folder);
    }
    return same;
  }
  const spot = freeName_(folder, base, ext, altBase, hash);
  if (spot.file) return sameFile_(ctx, spot.file, hash, messageId);
  const file = folder.createFile(blob.setName(spot.name));
  file.setDescription('Filed by Bill Sorter from Gmail message ' + messageId + '. sha1=' + hash);
  ctx.filed[hash] = file.getUrl();
  return { url: ctx.filed[hash], duplicate: false };
}

// The first of base, altBase, altBase (2)… (or base (2), base (3)…) free in the folder, or the
// file already there under one of them with this fingerprint.
function freeName_(folder, base, ext, altBase, hash) {
  const nameAt = (i) => {
    if (i === 0) return base + ext;
    if (altBase) return (i === 1 ? altBase : altBase + ' (' + i + ')') + ext;
    return base + ' (' + (i + 1) + ')' + ext;
  };
  for (let i = 0; ; i++) {
    const sameName = folder.getFilesByName(nameAt(i));
    let taken = false;
    while (sameName.hasNext()) {
      const file = sameName.next();
      if (file.isTrashed()) continue;
      if (String(file.getDescription() || '').indexOf('sha1=' + hash) !== -1) return { file: file };
      taken = true;
    }
    if (!taken) return { name: nameAt(i) };
  }
}

function inFolder_(file, folder) {
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folder.getId()) return true;
  return false;
}

// An existing copy of the file. If it was saved for this same email by a run that ran out of
// time, that is this filing, not a duplicate.
function sameFile_(ctx, file, hash, messageId) {
  ctx.filed[hash] = file.getUrl();
  return { url: ctx.filed[hash], duplicate: String(file.getDescription() || '').indexOf(messageId) === -1 };
}

function filedCopy_(hash) {
  try {
    const found = DriveApp.searchFiles("fullText contains '" + hash + "' and trashed = false");
    while (found.hasNext()) {
      const file = found.next();
      if (String(file.getDescription() || '').indexOf('sha1=' + hash) !== -1) return file;
    }
  } catch (e) {
    console.log("Couldn't search Drive for an earlier copy: " + (e && e.message ? e.message : e));
  }
  return null;
}

// Whether this bill was already filed from another email, even as a different file: the same
// bill number; or, for a bill tied to an account, a copy that arrived within SAME_BILL_DAYS of it
// or one for the same month (when both months come from the bills, not from arrival dates).
// Recurring bills only: repair invoices and the like can come several to a month.
function sameBill_(ctx, v, arrived) {
  const who = billOwner_(v);
  if (!who || !v.utility.recurring) return null;
  const mine = ctx.bills.filter((b) => b.who === who && b.utility === v.utility.folder);
  const t = arrived.getTime();
  const day = 24 * 60 * 60 * 1000;
  let hit = v.billNo && mine.filter((b) => b.billNo === v.billNo && Math.abs(b.arrived - t) <= 180 * day)[0];
  if (hit) return { url: hit.url, property: hit.property, why: 'bill no. ' + v.billNo };
  if (who.indexOf('a:') !== 0) return null;
  hit = mine.filter((b) => Math.abs(b.arrived - t) <= CONFIG.SAME_BILL_DAYS * day)[0];
  if (hit) return { url: hit.url, property: hit.property, why: 'same account, arrived within ' + CONFIG.SAME_BILL_DAYS + ' days' };
  if (!isGuess_(v.month)) {
    hit = mine.filter((b) => !b.guess && b.ym === ymKey_(v.month))[0];
    if (hit) return { url: hit.url, property: hit.property, why: 'same account and month' };
  }
  return null;
}

// A month guessed from the arrival date can land on a month whose bill (from the same account,
// arriving well apart) is already filed; then this bill is that month's neighbour.
function placeGuess_(ctx, v, arrived) {
  const who = billOwner_(v);
  if (who.indexOf('a:') !== 0 || !v.utility.recurring || !isGuess_(v.month)) return;
  const mine = ctx.bills.filter((b) => b.who === who && b.utility === v.utility.folder);
  const t = arrived.getTime();
  for (let step = 0; step < 3; step++) {
    const taken = mine.filter((b) => b.ym === ymKey_(v.month))[0];
    if (!taken) break;
    const next = addMonths_(v.month, t > taken.arrived ? 1 : -1);
    v.month = { y: next.y, m: next.m, how: v.month.how };
    v.moved = true;
  }
  v.fy = financialYear_(v.month);
  v.fileBase = fileBase_(v.month, v.utility);
}

function billOwner_(v) {
  if (v.accountId) return 'a:' + v.accountId;
  if (v.action === 'file') return 'p:' + v.match.property.name;
  return '';
}

function rememberBill_(ctx, v, property, arrived, url) {
  const who = billOwner_(v);
  if (!who || !v.utility.recurring) return;
  ctx.bills.push({
    who: who, utility: v.utility.folder, billNo: v.billNo, ym: ymKey_(v.month), guess: isGuess_(v.month),
    arrived: arrived.getTime(), property: property, url: url,
  });
}

const GUESSED_MONTHS = ['month before the email arrived', 'month the email arrived'];

function isGuess_(month) {
  return GUESSED_MONTHS.some((guess) => String(month.how).indexOf(guess) === 0);
}

function ymKey_(month) {
  return month.y + '-' + month.m;
}

// What earlier runs did, from the Log tab: the attachments handled (never looked at again), the
// emails finished with (their attachments aren't even downloaded again), the files filed, and the
// bills filed (to recognise another copy of one).
function loadMemory_(logSheet) {
  const memory = { done: new Set(), doneMessages: new Set(), filed: {}, bills: [] };
  const last = logSheet.getLastRow();
  if (last < 2) return memory;
  const col = (name) => LOG_HEADERS.indexOf(name);
  const failed = {};
  logSheet.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues().forEach((row) => {
    const parts = String(row[col('Key')] || '').split(':'); // message id : file fingerprint [: error]
    if (parts.length < 2) return;
    if (parts[2] === 'error') {
      failed[parts[0]] = true;
      return;
    }
    memory.done.add(parts[0] + ':' + parts[1]);
    memory.doneMessages.add(parts[0]);
    const result = String(row[col('Result')]);
    const url = String(row[col('Drive file')] || '');
    if (url && result !== 'Skipped') memory.filed[parts[1]] = url;
    if (result === 'Filed' || result === 'Filed (new property)') {
      const bill = loggedBill_(row, col, url);
      if (bill) memory.bills.push(bill);
    }
  });
  Object.keys(failed).forEach((id) => memory.doneMessages.delete(id));
  return memory;
}

// A filed bill, as remembered from its log row (rows from earlier versions included).
function loggedBill_(row, col, url) {
  const utility = UTILITIES.filter((u) => u.folder === String(row[col('Utility')]))[0];
  const month = /^([A-Za-z]+) (\d{4}) \((.+)\)$/.exec(String(row[col('Bill month')] || ''));
  if (!utility || !utility.recurring || !month || MONTHS.indexOf(month[1]) === -1) return null;
  const matched = /account (\d{6,16})/.exec(String(row[col('Matched by')] || ''));
  const account = String(row[col('Account')] || '') || (matched ? matched[1] : '');
  const property = String(row[col('Property')] || '');
  const who = account ? 'a:' + account : property && property !== CONFIG.NEEDS_REVIEW ? 'p:' + property : '';
  if (!who) return null;
  const ym = { y: Number(month[2]), m: MONTHS.indexOf(month[1]), how: month[3] };
  return {
    who: who, utility: utility.folder, billNo: String(row[col('Bill no')] || ''), ym: ymKey_(ym),
    guess: isGuess_(ym), arrived: new Date(row[col('Email date')]).getTime(), property: property, url: url,
  };
}

function logValues_(thread, message, item, o, key) {
  return [
    new Date(), message.getDate(), cell_(message.getFrom()), cell_(message.getSubject()), cell_(item.name),
    o.result, cell_(o.property || ''), o.utility || '', o.fy || '', o.month || '', cell_(o.matchedBy || ''),
    o.url || '', thread.getPermalink(), cell_(o.notes || ''), key, o.account || '', cell_(o.billNo || ''),
  ];
}

// An email's Log rows wait to be written with the rest of the run's, in one go.
function writeLog_(ctx, rows) {
  rows.forEach((row) => ctx.pending.push(row));
  if (ctx.pending.length >= 50) flush_(ctx);
}

// Writes the Log rows and read texts that are waiting.
function flush_(ctx) {
  if (ctx.pending.length) {
    appendRows_(ctx.logSheet, ctx.pending, LOG_HEADERS.length);
    ctx.pending = [];
  }
  const hashes = Object.keys(ctx.newTexts);
  if (hashes.length) {
    const rows = textRows_(ctx);
    const first = ctx.textSheet.getLastRow() + 1;
    appendRows_(ctx.textSheet, hashes.map((hash) => [hash, cell_(ctx.newTexts[hash])]), 2);
    hashes.forEach((hash, i) => {
      rows[hash] = first + i;
    });
    ctx.newTexts = {};
  }
}

function appendRows_(sheet, rows, width) {
  const first = sheet.getLastRow() + 1;
  // A new tab has 1000 rows and writing past the last one fails, so room is added first.
  const short = first + rows.length - 1 - sheet.getMaxRows();
  if (short > 0) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(short, 500));
  sheet.getRange(first, 1, rows.length, width).setValues(rows);
}

// Sheets would run text that starts like a formula; an apostrophe in front keeps it as text.
function cell_(text) {
  const s = String(text);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
