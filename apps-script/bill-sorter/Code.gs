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
    'leave and licence', 'tenant', 'insurance', 'repair', 'plumbing', 'pest control', 'termite',
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
  // A subject or attachment name with one of these is a payment receipt or a reminder, not a new
  // bill, so it is skipped instead of being filed next to the bill it is about.
  NOT_A_BILL: ['payment received', 'payment successful', 'payment confirmation', 'payment confirmed',
    'thank you for your payment', 'thank you for the payment', 'payment receipt', 'transaction successful',
    'paid successfully', 'reminder', 'overdue', 'past due', 'disconnection notice', 'final notice'],
  SAME_BILL_DAYS: 7,                     // two copies of one account's bill this close together are one bill
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
const UTILITIES = [
  {
    folder: 'Electricity Bills', label: 'Electricity Bill', short: 'Electricity', inArrears: true, newProperty: true,
    recurring: true,
    senders: ['adani', 'tatapower', 'bestundertaking', 'mahadiscom', 'mahavitaran', 'torrentpower'],
    keywords: ['electricity', 'adani electricity', 'tata power', 'best undertaking', 'mahavitaran', 'msedcl',
      'torrent power', 'energy charges', 'units consumed', 'kwh', 'meter reading', 'sanctioned load', 'ebill'],
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
    recurring: true,
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
    keywords: ['insurance', 'policy schedule', 'policy no', 'policy number', 'sum insured', 'premium',
      'home insurance', 'fire insurance', 'insured', 'insurer'],
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
      'co operative housing', 'chs', 'sinking fund', 'repair fund', 'service charges', 'non occupancy',
      'parking charges', 'society'],
  },
];

// Anything that isn't one of the types above.
const OTHER = {
  folder: 'Miscellaneous Bills', label: 'Bill', short: 'Other', inArrears: false, newProperty: false,
  recurring: false, senders: [], keywords: [],
};

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
    const rows = ctx.logSheet.getLastRow() - 1;
    let unlabelled = 0;
    if (rows > 0) {
      const ids = {};
      ctx.logSheet.getRange(2, LOG_HEADERS.indexOf('Email') + 1, rows, 1).getValues().forEach((r) => {
        const m = /\/([^\/#?]+)\s*$/.exec(String(r[0]));
        if (m) ids[m[1]] = true;
      });
      const threads = Object.keys(ids).map(threadById_).filter(Boolean);
      for (let i = 0; i < threads.length; i += 100) ctx.label.removeFromThreads(threads.slice(i, i + 100));
      unlabelled = threads.length;
      ctx.logSheet.deleteRows(2, rows);
    }
    const props = PropertiesService.getScriptProperties();
    props.getKeys().forEach((k) => {
      if (k.indexOf('attempts:') === 0) props.deleteProperty(k);
    });
    console.log('Cleared. ' + unlabelled + ' emails will be sorted again, starting with the next run ' +
      '(or run processBills now).');
  } finally {
    if (ownClock) clock_.started = null;
  }
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

// Works through the search 50 threads at a time until the time is up or nothing is left.
function runBatch_() {
  const ctx = openContext_();
  const query = buildQuery_(ctx.properties);
  const tried = {};
  const tally = {};
  let start = 0;
  let finished = false;
  while (!finished && !past_(CONFIG.RUN_MINUTES)) {
    const page = GmailApp.search(query, start, 50);
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
  const counts = Object.keys(tally).map((result) => tally[result] + ' ' + result.toLowerCase()).join(', ');
  console.log((counts || 'Nothing new') + ' in ' + Math.round(elapsedMs_() / 1000) + 's. ' +
    (finished ? 'All caught up.' : 'More to do; the next run carries on from here.'));
}

function buildQuery_(properties) {
  const terms = CONFIG.SEARCH_TERMS.map((term) => (/\s/.test(term) ? '"' + term + '"' : term));
  properties.forEach((p) => p.accounts.forEach((account) => terms.push(account)));
  terms.push('(from:me bill)');
  // Gmail's search spells a label with spaces as hyphens: "Bill Records" → label:bill-records
  const label = CONFIG.LABEL.toLowerCase().replace(/\s+/g, '-');
  return 'has:attachment -label:' + label +
    ' (filename:pdf OR filename:jpg OR filename:jpeg OR filename:png)' +
    ' (' + terms.join(' OR ') + ')' +
    (CONFIG.SEARCH_SINCE ? ' after:' + CONFIG.SEARCH_SINCE : '');
}

// Returns 'done' when every email in the thread is handled and it can be labelled, 'retry'
// after an error worth trying again, and 'later' when time ran out part way through.
function processThread_(thread, ctx, tally) {
  let failed = false;
  const messages = thread.getMessages();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (ctx.doneMessages.has(message.getId())) continue; // handled on an earlier run
    if (past_(CONFIG.RUN_MINUTES)) return 'later';
    const state = processMessage_(message, thread, ctx, tally);
    if (state === 'later') return 'later';
    if (state === 'failed') failed = true;
  }
  if (failed) return giveUp_(thread) ? 'done' : 'retry';
  clearAttempts_(thread);
  return 'done';
}

// One email, all or nothing: its log rows are written together at the end, so if time runs
// out part way the whole email is done again next run. Files it saved are recognised then.
function processMessage_(message, thread, ctx, tally) {
  const items = billAttachments_(message);
  const rows = [];
  const results = [];
  let failed = false;
  for (let j = 0; j < items.length; j++) {
    const item = items[j];
    const key = message.getId() + ':' + item.hash;
    if (ctx.done.has(key)) continue;
    item.count = items.length;
    let o;
    try {
      o = handleAttachment_(message, item, ctx);
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
  if (!failed) ctx.doneMessages.add(message.getId());
  return failed ? 'failed' : 'ok';
}

function giveUp_(thread) {
  const props = PropertiesService.getScriptProperties();
  const key = 'attempts:' + thread.getId();
  const attempts = Number(props.getProperty(key) || 0) + 1;
  if (attempts >= CONFIG.MAX_ATTEMPTS) {
    props.deleteProperty(key);
    return true;
  }
  props.setProperty(key, String(attempts));
  return false;
}

function clearAttempts_(thread) {
  const props = PropertiesService.getScriptProperties();
  const key = 'attempts:' + thread.getId();
  if (props.getProperty(key)) props.deleteProperty(key);
  return true;
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

// Sorts one attachment, opening it only if the email alone isn't enough. Returns null when it
// needs opening but the run is too close to its time limit to start, so it waits for next run.
function handleAttachment_(message, item, ctx) {
  const blob = item.attachment.copyBlob().setContentType(item.type);
  const texts = textsFor_(message, item, '');
  let v = classify_(texts, ctx.properties, message.getDate());
  let note = '';
  if (wantsReading_(v, texts, item, ctx)) {
    const tooMuch = tooMuchToRead_(blob, item);
    if (tooMuch) {
      note = 'Not opened (' + tooMuch + '), so this is based on the email.';
    } else if (past_(CONFIG.READ_CUTOFF_MINUTES)) {
      return null;
    } else {
      const read = readText_(blob, item.name);
      if (read.error) {
        note = "Couldn't read the attachment itself (" + read.error + '), so this is based on the email.';
      } else {
        texts.doc = normalize_(read.text).slice(0, 30000); // a bill's details are on its first pages
        v = classify_(texts, ctx.properties, message.getDate());
      }
    }
  }
  const outcome = {
    utility: v.utility.folder,
    fy: v.fy,
    month: MONTHS[v.month.m] + ' ' + v.month.y + ' (' + v.month.how + ')',
    notes: [v.notes, note].filter(Boolean).join(' '),
    account: v.accountId,
    billNo: v.billNo,
  };
  if (v.action === 'skip') return Object.assign(outcome, { result: 'Skipped' });

  const same = sameBill_(ctx, v, message.getDate());
  if (same) {
    return Object.assign(outcome, {
      result: 'Duplicate',
      property: same.property,
      url: same.url,
      notes: [outcome.notes, 'The same bill as one already filed (' + same.why + ').'].filter(Boolean).join(' '),
    });
  }

  placeGuess_(ctx, v, message.getDate());
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
  const saved = saveFile_(ctx, target, blob, v.fileBase, extension_(item), item.hash, message.getId(), altBase);
  const propertyName = property ? property.name : CONFIG.NEEDS_REVIEW;
  if (!saved.duplicate) rememberBill_(ctx, v, propertyName, message.getDate(), saved.url);
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

function textsFor_(message, item, docText) {
  return {
    doc: normalize_(docText),
    subject: normalize_(message.getSubject()),
    body: normalize_(String(message.getPlainBody() || '').slice(0, 20000)),
    from: normalize_(message.getFrom()),
    file: normalize_(item.name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_+/g, ' ')),
  };
}

function extension_(item) {
  const m = /\.(pdf|jpe?g|png|gif)$/i.exec(item.name);
  if (m) return '.' + m[1].toLowerCase();
  return { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif' }[item.type];
}

// ─── Reading the attachment ──────────────────────────────────────────────────

// Drive turns the PDF or photo into a temporary Google Doc, reading the text with OCR, and
// the Doc is deleted straight after. Works for scanned bills and for PDFs with real text.
function readText_(blob, name) {
  let id = null;
  try {
    const title = 'Bill Sorter OCR - ' + name;
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

const BILL_WORDS = /\b(?:bill|invoice|receipt|amount|total|payable|due|balance|charges?|premium|rent|tax|paid|consumption)\b/;

// t holds the lower-cased text of the attachment (doc), subject, body, from line and file name.
// Returns what to do with the bill, and the utility, month, financial year and file name.
function classify_(t, properties, arrived) {
  const found = detectUtility_(t);
  const utility = found.utility;
  const month = detectBillMonth_(t, utility, arrived);
  const match = matchProperty_(t, properties);
  const v = {
    utility: utility, utilityScore: found.score, month: month, fy: financialYear_(month),
    fileBase: fileBase_(month, utility), match: match, account: '', action: '', notes: '',
    billNo: extractBillNo_(t), accountId: '', notABill: notABill_(t),
  };
  if (v.notABill) {
    v.action = 'skip';
    v.notes = 'A payment receipt or reminder, not a new bill.';
  } else if (t.doc.length >= 40 && !BILL_WORDS.test(t.doc)) {
    v.action = 'skip';
    v.notes = 'No bill wording in the attachment.';
  } else if (match.ambiguous) {
    v.action = 'review';
    v.notes = 'Matches ' + match.ambiguous.join(' and ') + ' equally.';
  } else if (match.property && (utility !== OTHER || match.score >= 20)) {
    v.action = 'file';
  } else if (match.property) {
    v.action = 'skip';
    v.notes = 'Not a recognised bill type, and only a weak match to ' + match.property.name + '.';
  } else if (found.score < 4) {
    v.action = 'skip';
    v.notes = 'Not clearly a property bill.';
  } else if (!utility.newProperty) {
    v.action = 'skip';
    v.notes = 'A ' + utility.short.toLowerCase() + ' bill that matches none of your properties. If it is for ' +
      'one of them, add its account number to that property in the sheet.';
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

function notABill_(t) {
  if (!notABill_.patterns) notABill_.patterns = CONFIG.NOT_A_BILL.map(phraseRegex_).filter(Boolean);
  return notABill_.patterns.some((re) => re.test(t.subject) || re.test(t.file));
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

function detectUtility_(t) {
  let best = { utility: OTHER, score: 0 };
  UTILITIES.forEach((u) => {
    let score = u.senders.some((s) => t.from.indexOf(s) !== -1) ? 5 : 0;
    patternsFor_(u).forEach((re) => {
      if (re.test(t.subject) || re.test(t.file)) score += 3;
      else if (re.test(t.doc)) score += 2;
      else if (re.test(t.body)) score += 1;
    });
    if (score > best.score) best = { utility: u, score: score };
  });
  return best.score >= 2 ? best : { utility: OTHER, score: best.score };
}

function patternsFor_(utility) {
  if (!utility.patterns) utility.patterns = utility.keywords.map(phraseRegex_).filter(Boolean);
  return utility.patterns;
}

// An account number is the strongest evidence; a keyword (building, flat, road) counts for
// much less, and less again when it is only in the email body (which may hold your own
// address). Two properties scoring the same is reported as ambiguous instead of guessed.
function matchProperty_(t, properties) {
  const strong = t.doc + ' \n ' + t.subject + ' \n ' + t.file;
  const scored = [];
  properties.forEach((p) => {
    let score = 0;
    const why = [];
    const found = [];
    p.accounts.forEach((account) => {
      const re = numberRegex_(account);
      const w = re.test(t.doc) || re.test(t.file) ? 100 : re.test(t.subject) ? 80 : re.test(t.body) ? 50 : 0;
      if (w) {
        score += w;
        why.push('account ' + account);
        found.push({ account: account, w: w });
      }
    });
    const seen = {};
    p.keywords.forEach((keyword) => {
      const key = keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
      const re = phraseRegex_(keyword);
      if (!re || seen[key]) return;
      const w = re.test(strong) ? 10 : re.test(t.body) ? 5 : 0;
      if (w) {
        seen[key] = true;
        score += w;
        why.push('"' + keyword + '"');
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
    label: GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL),
    me: myAddress_(),
    folders: {},
  };
  ctx.properties = loadProperties_(ctx, props);
  Object.assign(ctx, loadMemory_(ctx.logSheet));
  return ctx;
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

function splitAccounts_(cell) {
  return String(cell || '').split(/[,;\s]+/)
    .map((part) => part.replace(/\D/g, ''))
    .filter((digits) => digits.length >= 6);
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
function saveFile_(ctx, folder, blob, base, ext, hash, messageId, altBase) {
  if (ctx.filed[hash]) return { url: ctx.filed[hash], duplicate: true };
  const elsewhere = filedCopy_(hash);
  if (elsewhere) return sameFile_(ctx, elsewhere, hash, messageId);
  const nameAt = (i) => {
    if (i === 0) return base + ext;
    if (altBase) return (i === 1 ? altBase : altBase + ' (' + i + ')') + ext;
    return base + ' (' + (i + 1) + ')' + ext;
  };
  let finalName = nameAt(0);
  for (let i = 1; ; i++) {
    const sameName = folder.getFilesByName(finalName);
    let taken = false;
    while (sameName.hasNext()) {
      const file = sameName.next();
      if (file.isTrashed()) continue;
      taken = true;
      if (String(file.getDescription() || '').indexOf('sha1=' + hash) !== -1) {
        return sameFile_(ctx, file, hash, messageId);
      }
    }
    if (!taken) break;
    finalName = nameAt(i);
  }
  const file = folder.createFile(blob.setName(finalName));
  file.setDescription('Filed by Bill Sorter from Gmail message ' + messageId + '. sha1=' + hash);
  ctx.filed[hash] = file.getUrl();
  return { url: ctx.filed[hash], duplicate: false };
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

function writeLog_(ctx, rows) {
  if (!rows.length) return;
  const sheet = ctx.logSheet;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LOG_HEADERS.length).setValues(rows);
}

// Sheets would run text that starts like a formula; an apostrophe in front keeps it as text.
function cell_(text) {
  const s = String(text);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
