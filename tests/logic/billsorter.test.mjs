// The Gmail → Drive bill sorter, apps-script/bill-sorter/Code.gs. Apps Script can't run here,
// so the script is loaded unchanged into a node vm next to in-memory stand-ins for Gmail, Drive
// (and its OCR), Docs, Sheets, script properties, locks, triggers and the clock. Plain node:
//   node tests/logic/billsorter.test.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'

const CODE = fs.readFileSync(new URL('../../apps-script/bill-sorter/Code.gs', import.meta.url), 'utf8')

let pass = 0, fail = 0
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : '**FAIL**'}  ${n}${c ? '' : '  — ' + e}`) }
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
const has = (n, list, item) => ok(n, list.includes(item), `${JSON.stringify(item)} not among ${JSON.stringify(list, null, 1)}`)

const GOOGLE_DOCS = 'application/vnd.google-apps.document'
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MB = 1024 * 1024

// One Google account: Gmail, Drive and the rest, empty until a test fills it. The clock only
// moves when a test gives Gmail and Drive calls a cost, so timing is exact and repeatable.
function makeWorld({ driveVersion = 3, withDrive = true } = {}) {
  const w = {
    queries: [], logs: [], ocrCalls: 0, read: [], failCreateFile: false, searches: 0,
    now: 0, costs: { read: 0, save: 0, fetch: 0 },
  }
  let seq = 0
  const nextId = (p) => `${p}${++seq}`
  const iter = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] } }

  // ── Drive ──
  const items = new Map()
  const kids = (parent) => [...items.values()].filter((x) => x.parent === parent && !x.deleted)
  const node = (kind, name, parent, extra = {}) => {
    const n = { id: nextId(kind === 'folder' ? 'folder' : 'file'), kind, name, parent, trashed: false, deleted: false, description: '', ...extra }
    Object.assign(n, {
      getId: () => n.id, getName: () => n.name, setName: (v) => { n.name = v; return n },
      getUrl: () => `https://drive.google.com/${n.id}`, isTrashed: () => n.trashed,
      setTrashed: (v) => { n.trashed = v; return n },
      getDescription: () => n.description, setDescription: (v) => { n.description = v; return n },
      moveTo: (folder) => { n.parent = folder; return n },
    })
    if (kind === 'folder') Object.assign(n, {
      getFoldersByName: (v) => iter(kids(n).filter((x) => x.kind === 'folder' && x.name === v && !x.trashed)),
      createFolder: (v) => node('folder', v, n),
      getFiles: () => iter(kids(n).filter((x) => x.kind === 'file')),
      getFolders: () => iter(kids(n).filter((x) => x.kind === 'folder')),
      getFilesByName: (v) => iter(kids(n).filter((x) => x.kind === 'file' && x.name === v)),
      createFile: (blob) => {
        w.now += w.costs.save
        if (w.failCreateFile) throw new Error('Drive is having a moment')
        return node('file', blob.getName(), n, { mime: blob.getContentType(), text: blob.text })
      },
    })
    items.set(n.id, n)
    return n
  }
  const root = node('folder', 'My Drive', null)
  const DriveApp = {
    getRootFolder: () => root,
    createFolder: (name) => root.createFolder(name),
    getFolderById: (id) => {
      const n = items.get(id)
      if (!n || n.deleted || n.kind !== 'folder') throw new Error('No item with the given ID could be found')
      return n
    },
    getFileById: (id) => {
      const n = items.get(id)
      if (!n || n.deleted) throw new Error('No item with the given ID could be found')
      return n
    },
    // Only the one query the script makes: fullText contains '<word>' and trashed = false.
    searchFiles: (q) => {
      w.searches++
      const word = /fullText contains '([^']+)'/.exec(q)[1]
      return iter([...items.values()].filter((x) => x.kind === 'file' && !x.deleted && !x.trashed &&
        ((x.description || '').includes(word) || x.name.includes(word))))
    },
  }
  // Drive's conversion: only a Google Doc target is converted (and OCR'd); v2 converts on ocr: true.
  const docs = new Map()
  const convert = (name, blob) => {
    w.ocrCalls++
    w.read.push(blob.name)
    w.now += w.costs.read
    if (blob.unreadable) throw new Error('Unable to convert the file')
    const f = node('file', name, root, { mime: GOOGLE_DOCS })
    docs.set(f.id, blob.text)
    return { id: f.id }
  }
  const Drive = { Files: { remove: (id) => { const n = items.get(id); if (n) n.deleted = true; docs.delete(id) } } }
  if (driveVersion === 3) Drive.Files.create = (meta, blob) => {
    if (meta.mimeType === GOOGLE_DOCS) return convert(meta.name, blob)
    return { id: node('file', meta.name, root, { mime: meta.mimeType }).id }
  }
  if (driveVersion === 2) Drive.Files.insert = (meta, blob, opts) => {
    if (opts && opts.ocr) return convert(meta.title, blob)
    return { id: node('file', meta.title, root, { mime: meta.mimeType }).id }
  }
  const DocumentApp = {
    openById: (id) => {
      if (!docs.has(id)) throw new Error('Document is missing (perhaps it was deleted, or you do not have read access?)')
      return { getBody: () => ({ getText: () => docs.get(id) }) }
    },
  }
  const blob = (a) => {
    const b = { name: a.name, type: a.type, text: a.text ?? '', unreadable: !!a.unreadable }
    return Object.assign(b, {
      getName: () => b.name, setName: (v) => { b.name = v; return b },
      getContentType: () => b.type, setContentType: (v) => { b.type = v; return b },
      // What a PDF's raw bytes look like to the page counter: one "/Type /Page" per page.
      getDataAsString: () => '%PDF-1.4\n<< /Type /Pages /Count 9 >>\n' + '<< /Type /Page >>\n'.repeat(a.pages ?? 1),
    })
  }

  // ── Gmail ──
  const labels = new Map()
  const threads = []
  const GmailApp = {
    getUserLabelByName: (name) => labels.get(name) || null,
    createLabel: (name) => {
      const l = {
        getName: () => name,
        removeFromThreads: (ts) => {
          if (ts.length > 100) throw new Error('At most 100 threads at a time')
          ts.forEach((t) => t.messages.forEach((m) => m.labels.delete(name)))
          return l
        },
      }
      labels.set(name, l)
      return l
    },
    getThreadById: (id) => threads.find((t) => t.id === id) || null,
    // Gmail matches messages, so a thread comes back while any message in it lacks the label.
    search: (query, start, max) => {
      w.queries.push(query)
      return threads.filter((t) => t.messages.some((m) => !m.labels.has(w.label))).slice(start, start + max)
    },
  }
  const attachment = (a) => ({
    getName: () => a.name,
    getContentType: () => a.type,
    getSize: () => a.size ?? 80 * 1024,
    getHash: () => crypto.createHash('sha1').update(a.name + '\n' + (a.text ?? '')).digest('hex'),
    copyBlob: () => blob(a),
  })
  const message = (m) => {
    const msg = { id: nextId('msg'), labels: new Set(), fetched: 0, ...m }
    return Object.assign(msg, {
      getId: () => msg.id, getDate: () => new Date(msg.date), getFrom: () => msg.from,
      getSubject: () => msg.subject, getPlainBody: () => msg.body ?? '',
      getAttachments: (opts = {}) => {
        msg.fetched++
        w.now += w.costs.fetch
        return msg.attachments.filter((a) => opts.includeInlineImages !== false || !a.inline).map(attachment)
      },
    })
  }
  w.thread = (...msgs) => {
    const t = { id: nextId('thread'), messages: msgs.map(message) }
    Object.assign(t, {
      getId: () => t.id, getMessages: () => t.messages,
      getPermalink: () => `https://mail.google.com/mail/#all/${t.id}`,
      addLabel: (l) => { t.messages.forEach((m) => m.labels.add(l.getName())); return t },
      receive: (m) => { t.messages.push(message(m)); return t },
    })
    threads.push(t)
    return t
  }

  // ── Sheets ──
  const books = new Map()
  const makeSheet = (name) => {
    const s = { name, rows: [], notes: {} }
    const range = (r, c, nr = 1, nc = 1) => {
      const rg = {
        getValues: () => Array.from({ length: nr }, (_, i) =>
          Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j] ?? '')),
        setValues: (vals) => {
          vals.forEach((row, i) => {
            const target = s.rows[r - 1 + i] || (s.rows[r - 1 + i] = [])
            row.forEach((v, j) => { target[c - 1 + j] = v })
          })
          return rg
        },
        setValue: (v) => rg.setValues([[v]]),
        setFontWeight: () => rg, setNumberFormat: () => rg,
        setNote: (note) => { s.notes[`${r},${c}`] = note; return rg },
      }
      return rg
    }
    return Object.assign(s, {
      getName: () => s.name, setName: (v) => { s.name = v; return s },
      getLastRow: () => s.rows.length,
      appendRow: (row) => { s.rows.push([...row]); return s },
      deleteRows: (at, n) => { s.rows.splice(at - 1, n); return s },
      getRange: (a, b, c, d) => (typeof a === 'string' ? range(1, 1) : range(a, b, c, d)),
      getDataRange: () => range(1, 1, Math.max(1, s.rows.length), Math.max(1, ...s.rows.map((x) => x.length))),
      setFrozenRows: () => s, setColumnWidth: () => s,
    })
  }
  const SpreadsheetApp = {
    create: (name) => {
      const file = node('file', name, root, { mime: 'application/vnd.google-apps.spreadsheet' })
      const book = { id: file.id, sheets: [makeSheet('Sheet1')] }
      Object.assign(book, {
        getId: () => book.id, getUrl: () => `https://docs.google.com/spreadsheets/d/${book.id}`,
        getSheets: () => [...book.sheets],
        getSheetByName: (n) => book.sheets.find((x) => x.name === n) || null,
        insertSheet: (n, index) => {
          const sh = makeSheet(n)
          index === undefined ? book.sheets.push(sh) : book.sheets.splice(index, 0, sh)
          return sh
        },
        deleteSheet: (sh) => { book.sheets = book.sheets.filter((x) => x !== sh) },
      })
      books.set(book.id, book)
      return book
    },
    openById: (id) => { const b = books.get(id); if (!b) throw new Error('Not found'); return b },
  }

  // ── The rest ──
  const store = new Map()
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (store.has(k) ? store.get(k) : null),
      setProperty: (k, v) => { store.set(k, String(v)) },
      deleteProperty: (k) => { store.delete(k) },
      getKeys: () => [...store.keys()],
    }),
  }
  const triggers = []
  const ScriptApp = {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1) },
    newTrigger: (fn) => ({
      timeBased: () => ({
        everyHours: (hours) => ({
          create: () => { const t = { fn, hours, getHandlerFunction: () => fn }; triggers.push(t); return t },
        }),
      }),
    }),
  }
  const Utilities = {
    formatDate: (date, tz, fmt) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(date).map((x) => [x.type, x.value]))
      if (fmt === 'yyyy-MM') return `${p.year}-${p.month}`
      if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`
      if (fmt === 'd MMM yyyy') return `${Number(p.day)} ${MON3[Number(p.month) - 1]} ${p.year}`
      throw new Error('Utilities.formatDate not mocked for ' + fmt)
    },
  }

  const sandbox = {
    GmailApp, DriveApp, DocumentApp, SpreadsheetApp, PropertiesService, ScriptApp, Utilities,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'Me@Example.com' }) },
    MimeType: { GOOGLE_DOCS },
    console: { log: (...a) => w.logs.push(a.join(' ')) },
    __now: () => w.now,
  }
  if (withDrive) sandbox.Drive = Drive
  const ctx = vm.createContext(sandbox)
  vm.runInContext('Date.now = function () { return __now(); };', ctx)
  vm.runInContext(CODE, ctx)
  w.label = vm.runInContext('CONFIG.LABEL', ctx)

  Object.assign(w, {
    ctx, store, triggers, threads,
    run: (expr) => vm.runInContext(expr, ctx),
    paths: () => {
      const out = []
      const walk = (folder, prefix) => kids(folder).filter((x) => !x.trashed).forEach((x) => {
        const p = prefix ? `${prefix}/${x.name}` : x.name
        if (x.kind === 'folder') walk(x, p)
        else out.push(p)
      })
      walk(root, '')
      return out.sort()
    },
    folderNamed: (name) => [...items.values()].find((x) => x.kind === 'folder' && x.name === name && !x.deleted),
    book: () => [...books.values()][0],
    tab: (name) => [...books.values()][0].getSheetByName(name),
    log: () => {
      const headers = vm.runInContext('LOG_HEADERS', ctx)
      return w.tab('Log').rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])))
    },
    leftoverOcrDocs: () => [...items.values()].filter((x) => !x.deleted && /^Bill Sorter OCR/.test(x.name)).length,
    pending: () => threads.filter((t) => t.messages.some((m) => !m.labels.has(w.label))).length,
  })
  return w
}

// ── The mail used across the tests ──
const ADANI = 'Adani Electricity <ebill@adanielectricity.com>'
const pdf = (name, text, extra = {}) => ({ name, type: 'application/pdf', text, ...extra })
const BASE = 'Property Bills'
const ML = "2, Mother's Love, (Malad West)"
const SP = 'F-34, Sej Plaza, (Malad West)'
const SD = '202, B-Wing, Sai Dam Towers, (Kandivali West)'
const P = (...parts) => [BASE, ...parts].join('/')

function fillMailbox(w) {
  const t = {}
  t.adaniApril = w.thread({
    from: ADANI, subject: 'Adani Electricity Bill for CA No. 151759775', date: '2026-05-31T10:00:00+05:30',
    body: 'Dear Customer, please find attached your electricity bill. Pay via internet banking. Privacy Policy',
    attachments: [pdf('Bill_151759775.pdf', `Adani Electricity Mumbai Limited
ELECTRICITY BILL
CA No: 151759775
Address: FLAT B-0202, SAI DHAM TOWERS, LALJI PADA, KANDIVALI WEST, MUMBAI 400067
Bill Month: APR-2026   Bill Date: 30-04-2026   Due Date: 20-05-2026
Units consumed 312 kWh   Energy charges 2,140.00
Consumption history: Jan-26 210 Feb-26 190 Mar-26 250 Apr-26 312
Amount payable Rs. 2,140.00`)],
  })
  t.society = w.thread({
    from: 'Sai Dham CHS <secretary.saidham@example.com>', subject: 'Maintenance bill - Flat B-0202', date: '2026-04-02T09:00:00+05:30',
    body: 'Dear Member, Please find attached the maintenance bill for the current quarter. Kindly pay via internet banking.',
    attachments: [pdf('Maintenance_Q1.pdf', `SAI DHAM CO-OPERATIVE HOUSING SOCIETY LTD.
Lalji Pada, Kandivali West
MAINTENANCE BILL   Bill No: 145
Flat No: B-0202   Bill for the period Apr-Jun 2026
Service charges 3,000.00  Sinking fund 500.00  Repair fund 400.00
Water charges 300.00  Property tax 900.00  Common electricity 200.00
Total payable 5,300.00  Due date: 15-04-2026`)],
  })
  t.propertyTax = w.thread({
    from: 'MCGM Property Tax <ptax.billing@mcgm.example>', subject: 'Property Tax Bill 2026-27', date: '2026-04-20T09:00:00+05:30',
    body: 'Brihanmumbai Mahanagarpalika. Please find attached your property tax bill.',
    attachments: [pdf('PTax_Bill.pdf', `MUNICIPAL CORPORATION OF GREATER MUMBAI
PROPERTY TAX BILL
Property Account No: 789456123
Property address: 2, MOTHER'S LOVE, PANKAJ CHS, EVERSHINE NAGAR, MALAD WEST
Capital Value 1,20,00,000  General Tax 6,000  Water Benefit Tax 1,200  Sewerage Tax 1,100
Period: 01-04-2026 to 30-09-2026   Bill Date: 15-04-2026
Total payable 12,345.00`)],
  })
  t.billOf3450 = w.thread({
    from: ADANI, subject: 'Your Adani Electricity bill', date: '2026-06-08T09:00:00+05:30',
    body: 'Dear Customer, A bill of 3,450.00 has been generated for CA No 151759775.',
    attachments: [pdf('Bill.pdf', 'Adani Electricity\nCA No: 151759775\nBill Month: MAY-2026\nAmount payable 3,450.00')],
  })
  t.mailingAddress = w.thread({
    from: ADANI, subject: 'Adani Electricity Bill for CA No. 151759775', date: '2026-07-06T09:00:00+05:30',
    body: "Bill for CA No 151759775. Communication address: 2, Mother's Love, Pankaj CHS, Evershine Ngr.",
    attachments: [pdf('Bill_June.pdf', `Adani Electricity  CA No: 151759775  Bill Month: JUN-2026
Communication address: 2, MOTHER'S LOVE, PANKAJ CHS, EVERSHINE NGR
Supply address: B-0202, SAI DHAM TOWERS
Amount payable 1,700.00`)],
  })
  t.photo = w.thread({
    from: 'Me <me@example.com>', subject: 'Fwd:', date: '2026-06-10T09:00:00+05:30', body: 'sending the photo',
    attachments: [{ name: 'IMG_20260610_101500.jpg', type: 'image/jpeg', size: 2.1 * MB,
      text: 'ADANI ELECTRICITY\nCA NO 102401902\nBill Date 05/06/2026\nAmount payable 1,800.00' }],
  })
  t.signed = w.thread({
    from: ADANI, subject: 'Adani Electricity Bill for CA No. 102401902', date: '2026-07-04T09:00:00+05:30',
    body: 'Please find attached your bill.',
    attachments: [pdf('eBill_Signed.pdf', 'Adani Electricity\nCA No: 102401902\nBill Month: JUN-2026\nAmount payable 1,950.00')],
  })
  t.newMay = w.thread({
    from: 'Tata Power <bills@tatapower.com>', subject: 'Your Tata Power bill', date: '2026-06-03T09:00:00+05:30',
    body: 'Your bill is attached.',
    attachments: [pdf('TPC_Bill.pdf', `The Tata Power Company Ltd
ELECTRICITY BILL
Consumer No: 900012345678
Bill Month: MAY-2026
Address: 7, Sunrise Apartments, Andheri East
Amount payable 2,500.00`)],
  })
  t.newJune = w.thread({
    from: 'Tata Power <bills@tatapower.com>', subject: 'Your Tata Power bill', date: '2026-07-03T09:00:00+05:30',
    body: 'Your bill is attached.',
    attachments: [pdf('TPC_Bill_June.pdf', 'The Tata Power Company Ltd\nELECTRICITY BILL\nConsumer No: 900012345678\nBill Month: JUN-2026\nAmount payable 2,650.00')],
  })
  t.gasNoAccount = w.thread({
    from: 'Mahanagar Gas <bills@mahanagargas.com>', subject: 'Your MGL gas bill', date: '2026-06-04T09:00:00+05:30',
    body: 'Please find your bill attached.',
    attachments: [pdf('MGL.pdf', 'Mahanagar Gas Limited\nGAS BILL\nBill Period: 01/04/2026 to 31/05/2026\nConsumption 12 SCM\nAmount payable 640.00')],
  })
  t.amazon = w.thread({
    from: 'Amazon.in <auto-confirm@amazon.in>', subject: 'Your Amazon.in order invoice', date: '2026-06-03T09:00:00+05:30',
    body: 'Please find attached the invoice for your order.',
    attachments: [pdf('Invoice_402.pdf', 'Tax Invoice\nSold by XYZ Retail\nOrder Number 402-1234567\nInvoice Date 03-06-2026\nTotal 1,299.00')],
  })
  t.restaurant = w.thread({
    from: 'Hotel Sunshine <billing@sunshine.example>', subject: 'Your bill', date: '2026-06-05T09:00:00+05:30',
    body: 'Thank you for dining with us.',
    attachments: [pdf('Bill_77.pdf', 'Hotel Sunshine, Marve Road, Malad West\nBill No 77\nTotal 1,250.00')],
  })
  t.unreadable = w.thread({
    from: ADANI, subject: 'Your Adani Electricity bill', date: '2026-06-06T09:00:00+05:30',
    body: 'Please find attached your bill.',
    attachments: [pdf('Scan.pdf', '', { unreadable: true })],
  })
  t.withBanner = w.thread({
    from: ADANI, subject: 'Adani Electricity Bill for CA No. 102401902', date: '2026-08-05T09:00:00+05:30',
    body: 'Please find attached your bill.',
    attachments: [
      pdf('Bill_July.pdf', 'Adani Electricity\nCA No: 102401902\nBill Month: JUL-2026\nAmount payable 2,010.00'),
      pdf('Terms.pdf', 'Terms and conditions apply. Visit our website for more information about our services.'),
      { name: 'banner.png', type: 'image/png', size: 120 * 1024, inline: true, text: 'Pay your bill on the Adani app' },
    ],
  })
  t.ambiguous = w.thread({
    from: 'Ravi Plumbing <ravi@plumbing.example>', subject: 'Invoice for plumbing work', date: '2026-06-15T09:00:00+05:30',
    body: 'Invoice attached.',
    attachments: [pdf('Invoice_88.pdf', 'Ravi Plumbing Services\nPlumbing work at Sej Plaza and Sai Dham\nInvoice Date: 12-06-2026\nTotal 4,000.00')],
  })
  t.logoOnly = w.thread({
    from: 'Someone <someone@example.com>', subject: 'bill', date: '2026-06-16T09:00:00+05:30', body: 'hi',
    attachments: [{ name: 'logo.png', type: 'image/png', size: 4 * 1024, text: 'logo' }],
  })
  // Already handled by the old script, which used the same label.
  t.oldScript = w.thread({
    from: ADANI, subject: 'Adani Electricity Bill for CA No. 102401902', date: '2026-03-04T09:00:00+05:30',
    body: 'Please find attached your bill.',
    attachments: [pdf('Old_Bill.pdf', 'Adani Electricity\nCA No: 102401902\nBill Month: FEB-2026\nAmount payable 1,500.00')],
  })
  t.oldScript.addLabel({ getName: () => 'Bill Records' })
  return t
}

// ───────────────────────────────────────────────────────────────────────────────

const w = makeWorld()
const fn = (name) => w.ctx[name]
const T = (o) => {
  const n = fn('normalize_')
  return { doc: n(o.doc), subject: n(o.subject), body: n(o.body), from: n(o.from), file: n(o.file) }
}
const U = (folder) => w.run('UTILITIES').find((u) => u.folder === folder) || w.run('OTHER')
const props = () => w.run('STARTING_PROPERTIES').map((p) => ({ ...p, accounts: [...p.accounts], keywords: [...p.keywords] }))

console.log('\n── WHOLE WORDS, NOT PIECES OF WORDS ──')
const phrase = (p, text) => fn('phraseRegex_')(p).test(fn('normalize_')(text))
ok('"lease" is not found in "please find attached"', !phrase('lease', 'Please find attached'))
ok('but is found in "lease deed"', phrase('lease', 'Lease deed'))
ok('"rent receipt" is not found in "current receipt"', !phrase('rent receipt', 'current receipt'))
ok('"f-34" is not found in "a bill of 3,450.00"', !phrase('f-34', 'A bill of 3,450.00'))
ok('but is found in "Shop F-34, Sej Plaza"', phrase('f-34', 'Shop F-34, Sej Plaza'))
ok('"f-34" is not found in "F-345"', !phrase('f-34', 'F-345'))
ok('"mother\'s love" finds "MOTHERS LOVE"', phrase("mother's love", 'MOTHERS LOVE'))
ok('and "Mother’s Love" with a curly apostrophe', phrase("mother's love", 'Mother’s Love'))
ok('"b0202" finds "Flat No. B-0202"', phrase('b0202', 'Flat No. B-0202'))
ok('"mgl" is not found in "smgl"', !phrase('mgl', 'smgl'))
const num = (a, text) => fn('numberRegex_')(a).test(text)
ok('an account number is found on its own', num('102401902', 'ca no 102401902 dated'))
ok('not inside a longer number', !num('102401902', 'ref 1102401902'))
ok('with a space inside it', num('102401902', 'ca no 1024 01902'))
ok('or a leading zero in front', num('102401902', 'ca no 0102401902'))
ok('an all-zero account matches nothing', !num('000000', 'ca no 000000'))

console.log('\n── WHAT KIND OF BILL ──')
const utility = (o) => fn('detectUtility_')(T(o)).utility.folder
eq('Adani is electricity', utility({ from: ADANI, subject: 'Adani Electricity Bill', doc: 'energy charges 312 kwh' }), 'Electricity Bills')
eq('a society bill full of "please", "current" and "internet banking" is society maintenance',
  utility({ subject: 'Maintenance bill - Flat B-0202', body: 'Please find attached the bill for the current quarter. Pay via internet banking.',
    doc: 'Sai Dham Co-operative Housing Society. Maintenance bill. Sinking fund 500. Repair fund 400. Water charges 300. Property tax 900.' }),
  'Society Maintenance')
eq('a BMC property tax bill ("Mahanagarpalika") is property tax, not gas',
  utility({ from: 'MCGM <ptax@mcgm.example>', subject: 'Property Tax Bill', body: 'Brihanmumbai Mahanagarpalika',
    doc: 'Property tax bill. Capital value. General tax. Water benefit tax.' }), 'Property Taxes')
eq('MGL is gas', utility({ from: 'Mahanagar Gas <x@mahanagargas.com>', subject: 'Your MGL bill', doc: '12 SCM' }), 'Gas Bills')
eq('Airtel is internet & telecom, "Privacy Policy" and all',
  utility({ from: 'Airtel <ebill@airtel.in>', subject: 'Your Airtel broadband bill', body: 'Privacy Policy' }), 'Internet & Telecom')
eq('an email that only says "please" and "privacy policy" is nothing in particular',
  utility({ subject: 'Hello', body: 'Please see attached. Privacy Policy. Current offers.' }), 'Miscellaneous Bills')
eq('"JioMart" is not Jio', utility({ from: 'JioMart <orders@jiomart.com>', subject: 'Your JioMart order', doc: 'Tax invoice' }), 'Miscellaneous Bills')

console.log('\n── WHICH PROPERTY ──')
const match = (o) => fn('matchProperty_')(T(o), props())
eq('an account number on the bill picks the property', match({ doc: 'CA No 151759775' }).property.name, SD)
eq('"a bill of 3,450" no longer means Sej Plaza', match({ body: 'A bill of 3,450.00 for CA No 151759775' }).property.name, SD)
eq('your mailing address on a Sai Dham bill loses to its account number',
  match({ doc: "CA No 151759775. Communication address: 2, Mother's Love, Pankaj CHS, Evershine Ngr" }).property.name, SD)
eq('keywords alone can place a bill', match({ doc: 'Sai Dham CHS, Flat B-0202, Lalji Pada' }).property.name, SD)
eq('"mothers love" and "mother\'s love" count once, not twice', match({ doc: "Mother's Love" }).score, 10)
ok('a tie between two properties is reported, not guessed',
  JSON.stringify(match({ doc: 'Plumbing work at Sej Plaza and Sai Dham' }).ambiguous) === JSON.stringify([SP, SD]),
  JSON.stringify(match({ doc: 'Plumbing work at Sej Plaza and Sai Dham' })))
eq('nothing known means no property', match({ doc: '7, Sunrise Apartments, Andheri East' }).property, null)

console.log('\n── ACCOUNT NUMBERS FOR NEW PROPERTIES ──')
const account = (doc) => fn('extractAccount_')(T({ doc }))
eq('"Consumer No:" is read', account('Consumer No: 900012345678 Bill Month MAY-2026'), '900012345678')
eq('"CA No." with the number on the next line', account('CA No.\n123456789'), '123456789')
eq('"BP Number" too', account('BP Number : 3000123456'), '3000123456')
eq('a bill number is never taken for an account', account('Bill No: 12345678 Total 500'), '')
eq('nor is a date written without separators', account('CA No 05042026'), '')

console.log('\n── WHICH MONTH A BILL IS FOR ──')
const month = (o, folder, arrived) => {
  const m = fn('detectBillMonth_')(T(o), U(folder), new Date(arrived))
  return `${MON3[m.m]} ${m.y} (${m.how})`
}
eq('"Bill Month: APR-2026" on the bill', month({ doc: 'Bill Month: APR-2026 Bill Date: 30-04-2026' }, 'Electricity Bills', '2026-05-31T10:00:00+05:30'),
  'Apr 2026 (Bill Month on the bill)')
eq('a 12-month usage history does not hijack it', month({ doc: 'Consumption history Jan-26 210 Feb-26 190 Mar-26 250 Bill Date 05-04-2026' }, 'Electricity Bills', '2026-04-08T10:00:00+05:30'),
  'Mar 2026 (bill date)')
eq('an electricity billing period counts by its end', month({ doc: 'Bill Period: 15-02-2026 to 16-03-2026' }, 'Electricity Bills', '2026-03-25T10:00:00+05:30'),
  'Mar 2026 (billing period on the bill)')
eq('a society quarter billed in advance counts by its start', month({ doc: 'Bill for the period Apr-Jun 2026' }, 'Society Maintenance', '2026-04-02T10:00:00+05:30'),
  'Apr 2026 (billing period on the bill)')
eq('a month in the subject', month({ subject: 'Your bill for March 2026' }, 'Electricity Bills', '2026-04-03T10:00:00+05:30'),
  'Mar 2026 (email subject)')
eq('an electricity bill dated 5 April is March\'s', month({ doc: 'Bill Date: 05/04/2026' }, 'Electricity Bills', '2026-04-06T10:00:00+05:30'),
  'Mar 2026 (bill date)')
eq('an insurance policy dated 12 August is August\'s', month({ doc: 'Date of issue: 12-08-2026 Premium 4,000' }, 'Property Insurance', '2026-08-14T10:00:00+05:30'),
  'Aug 2026 (bill date)')
eq('"you may…" and "Rs. 2045.00" no longer make it May 2045',
  month({ body: 'Your bill of Rs. 2045.00 for June 2026 is due on 15 Jul 2026. This e-mail may contain confidential information.' }, 'Electricity Bills', '2026-07-02T10:00:00+05:30'),
  'Jun 2026 (month before the email arrived)')
eq('and the same words in the subject find June', month({ subject: 'Your bill of Rs. 2045.00 for June 2026 is due on 15 Jul 2026' }, 'Electricity Bills', '2026-07-02T10:00:00+05:30'),
  'Jun 2026 (email subject)')
eq('a month years away is treated as a misread', month({ doc: 'Bill Month: APR-2019' }, 'Electricity Bills', '2026-05-10T10:00:00+05:30'),
  'Apr 2026 (month before the email arrived)')
eq('arriving 31 May with nothing to go on: April, not May', month({}, 'Electricity Bills', '2026-05-31T10:00:00+05:30'), 'Apr 2026 (month before the email arrived)')
eq('arriving 29 March: February', month({}, 'Electricity Bills', '2026-03-29T10:00:00+05:30'), 'Feb 2026 (month before the email arrived)')
eq('arriving 31 March: February', month({}, 'Electricity Bills', '2026-03-31T10:00:00+05:30'), 'Feb 2026 (month before the email arrived)')
eq('arriving 31 December: November', month({}, 'Electricity Bills', '2026-12-31T10:00:00+05:30'), 'Nov 2026 (month before the email arrived)')
eq('arriving 1 January: December the year before', month({}, 'Electricity Bills', '2026-01-01T10:00:00+05:30'), 'Dec 2025 (month before the email arrived)')
eq('a society bill with nothing to go on: the month it arrived', month({}, 'Society Maintenance', '2026-05-31T10:00:00+05:30'), 'May 2026 (month the email arrived)')
eq('arriving just after midnight on 1 June in Mumbai is June, not May', month({}, 'Society Maintenance', '2026-06-01T00:30:00+05:30'), 'Jun 2026 (month the email arrived)')

console.log('\n── FINANCIAL YEAR AND FILE NAME ──')
eq('March 2026 is FY 2025-26', fn('financialYear_')({ y: 2026, m: 2 }), 'FY 2025-26')
eq('April 2026 is FY 2026-27', fn('financialYear_')({ y: 2026, m: 3 }), 'FY 2026-27')
eq('January 2027 is FY 2026-27', fn('financialYear_')({ y: 2027, m: 0 }), 'FY 2026-27')
eq('files sort by month within the year', fn('fileBase_')({ y: 2026, m: 3 }, U('Electricity Bills')), '2026-04 April 2026 Electricity Bill')

console.log('\n── THE FIRST RUN ──')
const mail = fillMailbox(w)
w.run('processBills()')
const paths = w.paths()
has('the settings spreadsheet is in the bills folder', paths, P('Bill Sorter Settings'))
has('the Sai Dham April bill', paths, P(SD, 'Electricity Bills', 'FY 2026-27', '2026-04 April 2026 Electricity Bill.pdf'))
has('the society bill under Society Maintenance, not Lease & Rent', paths, P(SD, 'Society Maintenance', 'FY 2026-27', '2026-04 April 2026 Maintenance Bill.pdf'))
has('the property tax bill under Property Taxes, not Gas', paths, P(ML, 'Property Taxes', 'FY 2026-27', '2026-04 April 2026 Property Tax.pdf'))
has('"a bill of 3,450" stays with Sai Dham', paths, P(SD, 'Electricity Bills', 'FY 2026-27', '2026-05 May 2026 Electricity Bill.pdf'))
has('the bill that mentions your mailing address is filed, not dropped', paths, P(SD, 'Electricity Bills', 'FY 2026-27', '2026-06 June 2026 Electricity Bill.pdf'))
has('the photo you forwarded is read and filed with its property', paths, P(ML, 'Electricity Bills', 'FY 2026-27', '2026-05 May 2026 Electricity Bill.jpg'))
has('the signed e-bill is filed, not skipped', paths, P(ML, 'Electricity Bills', 'FY 2026-27', '2026-06 June 2026 Electricity Bill.pdf'))
has('an unknown account starts a new property', paths, P('New property - Electricity 900012345678', 'Electricity Bills', 'FY 2026-27', '2026-05 May 2026 Electricity Bill.pdf'))
has('and its next bill joins it', paths, P('New property - Electricity 900012345678', 'Electricity Bills', 'FY 2026-27', '2026-06 June 2026 Electricity Bill.pdf'))
has('a gas bill with no account goes to Needs Review', paths, P('_Needs Review', 'Gas Bills', 'FY 2026-27', '2026-05 May 2026 Gas Bill.pdf'))
has('an unreadable scan with nothing in the email to place it goes to Needs Review', paths, P('_Needs Review', 'Electricity Bills', 'FY 2026-27', '2026-05 May 2026 Electricity Bill.pdf'))
has('the July bill next to the banner', paths, P(ML, 'Electricity Bills', 'FY 2026-27', '2026-07 July 2026 Electricity Bill.pdf'))
has('a bill that matches two properties equally goes to Needs Review', paths, P('_Needs Review', 'Repairs & Maintenance', 'FY 2026-27', '2026-06 June 2026 Repairs.pdf'))
eq('and nothing else was filed (no Amazon, restaurant, terms, banner or logo)', paths.length, 14)
eq('no temporary OCR documents are left behind', w.leftoverOcrDocs(), 0)

const log = w.log()
const row = (attachment) => log.find((r) => r.Attachment === attachment) || {}
eq('every bill-shaped attachment is in the log', log.length, 16)
eq('the April bill: filed', row('Bill_151759775.pdf').Result, 'Filed')
eq('matched first on its account number', row('Bill_151759775.pdf')['Matched by'].split(',')[0], 'account 151759775')
eq('its month read off the bill, as the email doesn\'t say', row('Bill_151759775.pdf')['Bill month'], 'April 2026 (Bill Month on the bill)')
eq('and its account kept in the log', row('Bill_151759775.pdf').Account, '151759775')
eq('a bill that was opened takes its month from the bill', row('Maintenance_Q1.pdf')['Bill month'], 'April 2026 (billing period on the bill)')
eq('the Tata Power bill made a new property', row('TPC_Bill.pdf').Result, 'Filed (new property)')
eq('the next one was simply filed', row('TPC_Bill_June.pdf').Result, 'Filed')
eq('Amazon was skipped', row('Invoice_402.pdf').Result, 'Skipped')
eq('the restaurant on Marve Road was skipped', row('Bill_77.pdf').Result, 'Skipped')
eq('the terms and conditions were skipped', row('Terms.pdf').Result, 'Skipped')
eq('the gas bill needs review', row('MGL.pdf').Result, 'Needs review')
ok('the unreadable scan says so in the notes', /Couldn't read the attachment/.test(row('Scan.pdf').Notes), row('Scan.pdf').Notes)
ok('the banner never reached the log', !row('banner.png').Result)
ok('nor the logo', !row('logo.png').Result)
ok('mail the old script already labelled "Bill Records" is left alone', !row('Old_Bill.pdf').Result)
ok('each row links to its email', /^https:\/\/mail\.google\.com\//.test(row('MGL.pdf').Email))
ok('and to its file in Drive', /^https:\/\/drive\.google\.com\//.test(row('MGL.pdf')['Drive file']))

console.log('\n── OPENING ONLY WHAT NEEDS OPENING ──')
ok('Amazon\'s invoice isn\'t opened: nothing about the email says property bill', !w.read.includes('Invoice_402.pdf'))
for (const name of ['Bill_151759775.pdf', 'Bill.pdf', 'eBill_Signed.pdf']) {
  ok(`${name}: a recurring bill whose email doesn't give the month is opened for it`, w.read.includes(name), JSON.stringify(w.read))
}
for (const name of ['IMG_20260610_101500.jpg', 'Maintenance_Q1.pdf', 'PTax_Bill.pdf', 'TPC_Bill.pdf', 'MGL.pdf', 'Invoice_88.pdf']) {
  ok(`${name}: the email alone can't place it, so it is opened`, w.read.includes(name), JSON.stringify(w.read))
}
ok('an email with two PDFs has both opened, to tell the bill from the terms', w.read.includes('Bill_July.pdf') && w.read.includes('Terms.pdf'))
{
  const quick = makeWorld()
  quick.thread({ from: ADANI, subject: 'Adani Electricity Bill for April 2026, CA No. 151759775', date: '2026-05-03T09:00:00+05:30',
    body: 'Attached.', attachments: [pdf('Apr.pdf', 'CA No: 151759775 Bill Month: APR-2026 Amount payable 900.00')] })
  quick.run('processBills()')
  eq('a bill whose email gives both the account and the month is filed without opening it', quick.read.length, 0)
  has('in the right place', quick.paths(), P(SD, 'Electricity Bills', 'FY 2026-27', '2026-04 April 2026 Electricity Bill.pdf'))
}

const propsTab = w.tab('Properties').rows
eq('the properties tab starts with your three properties and gains the new one', propsTab.length, 5)
eq('the new one is named after its account', propsTab[4][0], 'New property - Electricity 900012345678')
eq('with the account number filled in', propsTab[4][1], '900012345678')
ok('and a note saying where it came from', /^Added automatically on \d+ \w+ 20\d\d from "Your Tata Power bill"/.test(propsTab[4][4]), propsTab[4][4])
ok('every property row has its folder ID', propsTab.slice(1).every((r) => /^folder\d+$/.test(r[3])), JSON.stringify(propsTab.map((r) => r[3])))
eq('the Gmail label is still "Bill Records"', w.label, 'Bill Records')
ok('every thread is labelled', w.threads.every((t) => t.messages.every((m) => m.labels.has(w.label))))
const q = w.queries[0]
ok('the search leaves labelled mail out', q.includes('-label:bill-records'), q)
ok('looks for PDFs and photos', q.includes('(filename:pdf OR filename:jpg OR filename:jpeg OR filename:png)'), q)
ok('quotes phrases', q.includes('"property tax"'), q)
ok('includes your account numbers', q.includes('102401902') && q.includes('149209100000059'), q)
ok('and bills you sent or forwarded yourself', q.includes('(from:me bill)'), q)
ok('the run ends with a summary', w.logs.some((l) => /^\d+ filed.* All caught up\.$/.test(l)), JSON.stringify(w.logs.slice(-2)))

console.log('\n── RUNNING AGAIN ──')
const ocrBefore = w.ocrCalls
w.run('processBills()')
eq('a second run files nothing new', w.paths().length, 14)
eq('reads nothing again', w.ocrCalls, ocrBefore)
eq('and logs nothing again', w.log().length, 16)

mail.adaniApril.receive({
  from: ADANI, subject: 'Adani Electricity Bill for CA No. 151759775', date: '2026-08-04T09:00:00+05:30',
  body: 'Please find attached your bill.',
  attachments: [pdf('Bill_151759775.pdf', 'Adani Electricity\nCA No: 151759775\nBill Month: JUL-2026\nAmount payable 2,300.00')],
})
const oldMessage = mail.adaniApril.messages[0]
const fetchedBefore = oldMessage.fetched
w.run('processBills()')
has('a new bill arriving in an old thread is filed', w.paths(), P(SD, 'Electricity Bills', 'FY 2026-27', '2026-07 July 2026 Electricity Bill.pdf'))
eq('the earlier email in that thread isn\'t downloaded again', oldMessage.fetched, fetchedBefore)
eq('one new log row', w.log().length, 17)

w.thread({
  from: 'Me <me@example.com>', subject: 'Fwd: Adani Electricity Bill for CA No. 102401902', date: '2026-07-05T09:00:00+05:30',
  body: 'fyi', attachments: [pdf('eBill_Signed.pdf', 'Adani Electricity\nCA No: 102401902\nBill Month: JUN-2026\nAmount payable 1,950.00')],
})
w.run('processBills()')
eq('the same bill forwarded again is logged as a duplicate', w.log().at(-1).Result, 'Duplicate')
eq('and not saved twice', w.paths().filter((p) => p.startsWith(P(ML, 'Electricity Bills', 'FY 2026-27', '2026-06'))).length, 1)

w.thread({
  from: ADANI, subject: 'Revised bill for CA No. 102401902', date: '2026-07-09T09:00:00+05:30',
  body: 'Please find attached the revised bill.',
  attachments: [pdf('Revised.pdf', 'Adani Electricity\nCA No: 102401902\nBill Month: JUN-2026\nRevised amount payable 1,890.00')],
})
w.run('processBills()')
eq('a revised bill for an account and month already filed counts as a duplicate', w.log().at(-1).Result, 'Duplicate')
ok('and says why', /same account/.test(w.log().at(-1).Notes), w.log().at(-1).Notes)
ok('so there is no "(2)" copy', !w.paths().some((p) => / \(2\)\.pdf$/.test(p)), JSON.stringify(w.paths()))

console.log('\n── CHANGING THE PROPERTIES SHEET ──')
const tab = w.tab('Properties')
tab.rows[1][0] = "2, Mother's Love (Malad W)"
w.run('processBills()')
ok('renaming a property in the sheet renames its folder', !!w.folderNamed("2, Mother's Love (Malad W)") && !w.folderNamed(ML))
has('with its bills still inside', w.paths(), P("2, Mother's Love (Malad W)", 'Electricity Bills', 'FY 2026-27', '2026-07 July 2026 Electricity Bill.pdf'))
w.folderNamed(SP).setName('F-34 Sej Plaza')
w.run('processBills()')
eq('renaming a folder in Drive updates the sheet', tab.rows[2][0], 'F-34 Sej Plaza')
ok('and leaves the folder alone', !!w.folderNamed('F-34 Sej Plaza'))

tab.rows[1][1] = '102401902, 210000800764, 900012345678'
tab.rows[4] = ['', '', '', '', '']
w.thread({
  from: 'Tata Power <bills@tatapower.com>', subject: 'Your Tata Power bill', date: '2026-08-03T09:00:00+05:30',
  body: 'Your bill is attached.',
  attachments: [pdf('TPC_Bill_July.pdf', 'The Tata Power Company Ltd\nELECTRICITY BILL\nConsumer No: 900012345678\nBill Month: JUL-2026\nAmount payable 2,700.00')],
})
w.run('processBills()')
has('moving an account number to another property sends its next bill there, named by account beside the other meter\'s bill', w.paths(),
  P("2, Mother's Love (Malad W)", 'Electricity Bills', 'FY 2026-27', '2026-07 July 2026 Electricity Bill - 900012345678.pdf'))
eq('without making another new property', w.tab('Properties').rows.filter((r) => /^New property/.test(r[0] || '')).length, 0)

console.log('\n── WHEN DRIVE FAILS ──')
w.failCreateFile = true
const flaky = w.thread({
  from: ADANI, subject: 'Adani Electricity Bill for CA No. 153541273', date: '2026-09-04T09:00:00+05:30',
  body: 'Please find attached your bill.',
  attachments: [pdf('Bill_Aug.pdf', 'Adani Electricity\nCA No: 153541273\nBill Month: AUG-2026\nAmount payable 990.00')],
})
w.run('processBills()')
eq('the error is logged', w.log().at(-1).Result, 'Error')
ok('and the thread is left unlabelled to try again', !flaky.messages[0].labels.has(w.label))
w.failCreateFile = false
w.run('processBills()')
eq('the next run files it', w.log().at(-1).Result, 'Filed')
ok('and labels the thread', flaky.messages[0].labels.has(w.label))
ok('and forgets the failed attempt', ![...w.store.keys()].some((k) => k.startsWith('attempts:')))

w.failCreateFile = true
const broken = w.thread({
  from: ADANI, subject: 'Adani Electricity Bill for CA No. 153541273', date: '2026-10-04T09:00:00+05:30',
  body: 'Please find attached your bill.',
  attachments: [pdf('Bill_Sep.pdf', 'Adani Electricity\nCA No: 153541273\nBill Month: SEP-2026\nAmount payable 1,020.00')],
})
w.run('processBills()')
w.run('processBills()')
ok('two failures in a row still leave it to retry', !broken.messages[0].labels.has(w.label))
w.run('processBills()')
ok('a third failure gives up and labels it, so it can\'t block the queue', broken.messages[0].labels.has(w.label))
eq('with three errors in the log', w.log().filter((r) => r.Attachment === 'Bill_Sep.pdf' && r.Result === 'Error').length, 3)
w.failCreateFile = false

console.log('\n── STAYING INSIDE THE SIX MINUTES ──')
// Every opened attachment costs 50 seconds, every download 1, every save 2: slow enough that a
// run can only get through a few, as on a bad day for Drive.
const slow = makeWorld()
Object.assign(slow.costs, { read: 50 * 1000, fetch: 1000, save: 2000 })
const tataBill = (n, extra = {}) => pdf(`TPC_${n}.pdf`, `The Tata Power Company Ltd\nELECTRICITY BILL\nConsumer No: ${900012345600 + n}\nBill No ${n}\nBill Month: MAY-2026\nAmount payable ${1000 + n}.00`, extra)
for (let n = 1; n <= 3; n++) {
  slow.thread({ from: 'Tata Power <bills@tatapower.com>', subject: `Tata Power bill ${n}`, date: '2026-06-03T09:00:00+05:30', body: 'Attached.', attachments: [tataBill(n)] })
}
const triple = slow.thread({
  from: 'Tata Power <bills@tatapower.com>', subject: 'Three Tata Power bills', date: '2026-06-03T09:00:00+05:30', body: 'Attached.',
  attachments: [tataBill(11), tataBill(12), tataBill(13)],
})
for (let n = 4; n <= 9; n++) {
  slow.thread({ from: 'Tata Power <bills@tatapower.com>', subject: `Tata Power bill ${n}`, date: '2026-06-03T09:00:00+05:30', body: 'Attached.', attachments: [tataBill(n)] })
}
const runs = []
for (let i = 0; i < 20 && slow.pending(); i++) {
  const before = slow.now
  slow.run('processBills()')
  runs.push((slow.now - before) / 1000)
}
ok('a slow backlog is spread over several runs', runs.length > 1, JSON.stringify(runs))
ok('and no run comes near the six-minute limit', Math.max(...runs) <= 5 * 60, JSON.stringify(runs))
eq('until every thread is done', slow.pending(), 0)
const slowFiles = slow.paths().filter((p) => p.endsWith('.pdf'))
eq('every bill is filed exactly once', slowFiles.length, 12)
eq('and logged exactly once', slow.log().length, 12)
ok('all of them as filed', slow.log().every((r) => /^Filed/.test(r.Result)), JSON.stringify(slow.log().map((r) => r.Result)))
ok('the email with three bills, stopped part way, finished as filed, not as duplicates',
  slow.log().filter((r) => /^TPC_1[123]\.pdf$/.test(r.Attachment)).every((r) => /^Filed/.test(r.Result)),
  JSON.stringify(slow.log().filter((r) => /^TPC_1[123]\.pdf$/.test(r.Attachment)).map((r) => r.Result)))
eq('and logged once each', slow.log().filter((r) => /^TPC_1[123]\.pdf$/.test(r.Attachment)).length, 3)
ok('a run that stops says there is more to do', slow.logs.some((l) => /More to do/.test(l)))
ok('and the triple email really was cut off once', triple.messages[0].fetched > 1, String(triple.messages[0].fetched))

const big = makeWorld()
big.thread({ from: 'Tata Power <bills@tatapower.com>', subject: 'Your Tata Power bill', date: '2026-06-03T09:00:00+05:30', body: 'Attached.',
  attachments: [pdf('Huge.pdf', 'Consumer No: 900012345678 Bill Month: MAY-2026', { size: 7 * MB })] })
big.thread({ from: 'Tata Power <bills@tatapower.com>', subject: 'Your Tata Power bill', date: '2026-06-04T09:00:00+05:30', body: 'Attached.',
  attachments: [pdf('Long.pdf', 'Consumer No: 900012345678 Bill Month: MAY-2026', { pages: 34 })] })
big.run('processBills()')
const bigRow = (name) => big.log().find((r) => r.Attachment === name) || {}
eq('a 7 MB file is never opened', big.read.length, 0)
ok('and the log says why', /Not opened \(7\.0 MB\)/.test(bigRow('Huge.pdf').Notes), bigRow('Huge.pdf').Notes)
ok('nor is a 34-page PDF', /Not opened \(34 pages\)/.test(bigRow('Long.pdf').Notes), bigRow('Long.pdf').Notes)
eq('both are still sorted from their emails', big.paths().filter((p) => p.endsWith('.pdf')).length, 2)

const many = makeWorld()
for (let n = 0; n < 120; n++) {
  many.thread({ from: 'Shop <orders@shop.example>', subject: `Rent a car, order ${n}`, date: '2026-06-03T09:00:00+05:30', body: 'Thanks.',
    attachments: [pdf(`order-${n}.pdf`, `Order ${n} total 500`)] })
}
many.run('processBills()')
eq('one run gets through more than one page of search results', many.pending(), 0)
eq('without opening any of them', many.read.length, 0)
ok('each skipped and logged', many.log().length === 120 && many.log().every((r) => r.Result === 'Skipped'))

console.log('\n── GOOGLE\'S DAILY ALLOWANCE ──')
const day = makeWorld()
day.thread({ from: ADANI, subject: 'Adani Electricity Bill for CA No. 102401902', date: '2026-07-04T09:00:00+05:30', body: 'Attached.',
  attachments: [pdf('Bill.pdf', 'CA No: 102401902\nBill Month: JUN-2026\nAmount payable 1,950.00')] })
const todayKey = day.run('todayKey_()')
day.store.set(todayKey, '85')
day.ctx.processBills({ triggerUid: 'hourly' })
eq('a scheduled run does nothing once today\'s 80 minutes are used', day.pending(), 1)
day.ctx.processBills()
eq('a run by hand still works', day.pending(), 0)
day.store.set(todayKey, '10')
day.costs.fetch = 30 * 1000
day.thread({ from: ADANI, subject: 'Adani Electricity Bill for CA No. 102401902', date: '2026-08-04T09:00:00+05:30', body: 'Attached.',
  attachments: [pdf('Bill2.pdf', 'CA No: 102401902\nBill Month: JUL-2026\nAmount payable 1,970.00')] })
day.ctx.processBills({ triggerUid: 'hourly' })
eq('scheduled runs count their minutes', Number(day.store.get(todayKey)), 10.5)
day.store.set('minutes:2020-01-01', '50')
day.ctx.processBills({ triggerUid: 'hourly' })
ok('and old days are forgotten', !day.store.has('minutes:2020-01-01'))

console.log('\n── NO DUPLICATE BILLS ──')
{
  const d = makeWorld()
  const adani = (subject, date, name, text, extra = {}) => d.thread({ from: ADANI, subject, date, body: 'Attached.', attachments: [pdf(name, text, extra)] })
  adani('Adani Electricity Bill for CA No. 102401902', '2026-05-02T09:00:00+05:30', 'Bill_Apr.pdf',
    'Adani Electricity\nCA No: 102401902\nBill No: 88001\nBill Month: APR-2026\nAmount payable 1,800.00')
  // the same bill, regenerated (different bytes), sent again as a reminder and then again in a week
  adani('Reminder: Adani Electricity Bill for CA No. 102401902', '2026-05-12T09:00:00+05:30', 'Bill_Apr_r.pdf',
    'Adani Electricity\nCA No: 102401902\nBill No: 88001\nBill Month: APR-2026\nAmount payable 1,800.00\nreprinted')
  adani('Adani Electricity Bill for CA No. 102401902', '2026-05-05T09:00:00+05:30', 'Bill_Apr_again.pdf',
    'Adani Electricity\nCA No: 102401902\nBill No: 88001\nBill Month: APR-2026\nAmount payable 1,800.00\ncopy')
  // May's bill, sent twice two days apart across a month end, unreadable both times, so its month
  // can only be guessed: the first guess (April) is taken by April's bill, so it moves to May
  adani('Adani Electricity Bill for CA No. 102401902', '2026-05-31T22:00:00+05:30', 'Scan_1.pdf', '', { unreadable: true })
  adani('Adani Electricity Bill for CA No. 102401902', '2026-06-02T09:00:00+05:30', 'Scan_2.pdf', 'blurred', { unreadable: true })
  // a payment receipt for it
  adani('Payment received for CA No. 102401902', '2026-05-20T09:00:00+05:30', 'Receipt.pdf',
    'Adani Electricity\nPayment receipt\nCA No: 102401902\nAmount paid 1,800.00')
  // June's bill: a different bill, kept
  adani('Adani Electricity Bill for CA No. 102401902', '2026-07-01T09:00:00+05:30', 'Bill_Jun.pdf',
    'Adani Electricity\nCA No: 102401902\nBill No: 89403\nBill Month: JUN-2026\nAmount payable 1,750.00')
  // the society: a re-sent maintenance bill is a duplicate, a separate levy the same month is not
  const society = (subject, name, text) => d.thread({ from: 'Sai Dham CHS <secretary@society.example>', subject, date: '2026-04-03T09:00:00+05:30',
    body: 'Please find attached.', attachments: [pdf(name, text)] })
  society('Maintenance bill - Flat B-0202', 'Maint.pdf', 'SAI DHAM CHS\nMaintenance bill\nBill No: 145\nFlat B-0202\nBill for the period Apr-Jun 2026\nTotal 5,300.00')
  society('Maintenance bill - Flat B-0202 (resent)', 'Maint_resent.pdf', 'SAI DHAM CHS\nMaintenance bill\nBill No: 145\nFlat B-0202\nBill for the period Apr-Jun 2026\nTotal 5,300.00\nresent')
  society('Repair levy - Flat B-0202', 'Levy.pdf', 'SAI DHAM CHS\nMaintenance bill\nBill No: 152\nFlat B-0202\nBill for the period Apr-Jun 2026\nRepair fund levy\nTotal 2,000.00')
  d.run('processBills()')
  const files = d.paths().filter((p) => !p.endsWith('Bill Sorter Settings'))
  const res = (name) => (d.log().find((r) => r.Attachment === name) || {}).Result
  eq('the April bill sent three times, as different files, is filed once', files.filter((p) => p.includes('Electricity Bills') && p.includes('2026-04')).length, 1)
  eq('the reminder is skipped', res('Bill_Apr_r.pdf'), 'Skipped')
  eq('the copy with the same bill number is a duplicate', res('Bill_Apr_again.pdf'), 'Duplicate')
  eq('a payment receipt is skipped, not filed as a bill', res('Receipt.pdf'), 'Skipped')
  ok('and it is never opened', !d.read.includes('Receipt.pdf'))
  eq('two unreadable copies two days apart, either side of a month end, are filed once', [res('Scan_1.pdf'), res('Scan_2.pdf')].sort().join(', '), 'Duplicate, Filed')
  has('under May, not as a second April', files, P(ML, 'Electricity Bills', 'FY 2026-27', '2026-05 May 2026 Electricity Bill.pdf'))
  eq('June\'s bill is its own bill', res('Bill_Jun.pdf'), 'Filed')
  eq('the re-sent maintenance bill is a duplicate', res('Maint_resent.pdf'), 'Duplicate')
  eq('the levy with its own bill number is kept', res('Levy.pdf'), 'Filed')
  has('named by its bill number, not "(2)"', files, P(SD, 'Society Maintenance', 'FY 2026-27', '2026-04 April 2026 Maintenance Bill - No 152.pdf'))
  ok('so nothing is named "(2)"', !files.some((p) => / \(\d+\)\./.test(p)), JSON.stringify(files))
  eq('one bill per month for the account', files.filter((p) => p.includes('Electricity Bills')).length, 3)

  // the very same file in an email the log doesn't know about, saved under another name by an
  // earlier version, is found by Drive search
  const bytes = 'Adani Electricity\nCA No: 102401902\nBill No: 90010\nBill Month: JUL-2026\nAmount payable 1,700.00'
  const t1 = adani('Adani Electricity Bill for CA No. 102401902', '2026-08-03T09:00:00+05:30', 'July.pdf', bytes)
  d.run('processBills()')
  d.tab('Log').rows.splice(-1, 1) // as if that run had been cut off before writing its log
  const searchesBefore = d.searches
  adani('Fwd: Adani Electricity Bill for CA No. 102401902', '2026-10-20T09:00:00+05:30', 'July.pdf', bytes)
  d.run('processBills()')
  ok('a file already in Drive but missing from the log is found by searching for its fingerprint', d.searches > searchesBefore)
  eq('and not saved again', d.paths().filter((p) => p.includes('2026-07') && p.includes('Electricity')).length, 1)
  ok('t1 is labelled', t1.messages[0].labels.has(d.label))
}

console.log('\n── NOTHING BUT BILLS ──')
{
  const n = makeWorld()
  const HOME = "Address: 2, Mother's Love, Pankaj CHS, Evershine Ngr, Malad West"
  const mail = (from, subject, name, text, body = 'Please find attached.') =>
    n.thread({ from, subject, date: '2026-06-05T09:00:00+05:30', body, attachments: [pdf(name, text)] })
  mail('HDFC Bank <alerts@hdfcbank.example>', 'Your account statement', 'Statement.pdf',
    `Statement of account\n${HOME}\nStatement date 01-06-2026\nTotal 1,20,000.00`, `Statement for ${HOME}`)
  mail('HDFC Bank <cards@hdfcbank.example>', 'Your credit card statement', 'Card.pdf',
    `Credit card statement\n${HOME}\nStatement date 01-06-2026\nPayment due date 20-06-2026\nTotal amount due Rs 18,250.00`, `Statement for ${HOME}`)
  mail('Insurer <policy@insurer.example>', 'Your motor insurance policy', 'Motor_Policy.pdf',
    `Policy schedule - motor insurance\n${HOME}\nPremium Rs 12,000\nPeriod of insurance 01-06-2026 to 31-05-2027`)
  mail(ADANI, 'Planned power outage - CA No. 102401902', 'Outage.pdf', 'Supply will be off on 10-06-2026 for maintenance.')
  mail(ADANI, 'Important information for CA No. 102401902', 'Info.pdf',
    'Dear customer, we are upgrading our network in Malad West. Electricity supply may be interrupted.')
  mail('Sai Dham CHS <secretary@society.example>', 'Notice of AGM - Sai Dham CHS', 'AGM.pdf', 'Annual general meeting on 20-06-2026')
  mail('Sai Dham CHS <secretary@society.example>', 'Water supply timings - Sai Dham', 'Water.pdf',
    'Sai Dham CHS: water supply will be from 6am to 9am from Monday.')
  mail('Airtel <ebill@airtel.in>', 'Your Airtel postpaid bill', 'Airtel.pdf',
    `Airtel postpaid bill\n${HOME}\nRelationship No 1234567890\nBill date 05-06-2026\nAmount payable Rs 599.00`)
  mail('Mahanagar Gas <bills@mahanagargas.com>', 'Save on gas with MGL Connect', 'Promo.pdf',
    'Download the MGL Connect app to pay online and track your gas consumption.')
  mail('Croma <orders@croma.example>', 'Your invoice', 'Croma.pdf',
    `Tax Invoice\nInvoice No 123\nInvoice date 03-06-2026\nTotal Rs 45,000.00\nShip to: ${HOME}`)
  n.run('processBills()')
  const filed = n.paths().filter((p) => !p.endsWith('Bill Sorter Settings'))
  eq('none of them is filed', filed.length, 0)
  ok('every one is logged as skipped', n.log().length === 10 && n.log().every((r) => r.Result === 'Skipped'),
    JSON.stringify(n.log().map((r) => [r.Attachment, r.Result, r.Notes])))
  const why = (name) => (n.log().find((r) => r.Attachment === name) || {}).Notes || ''
  ok('a bank statement with your address: not a bill type it files', /Not one of the bill types/.test(why('Statement.pdf')), why('Statement.pdf'))
  ok('a credit card statement with your address and a due date: not a bill type it files', /Not one of the bill types/.test(why('Card.pdf')), why('Card.pdf'))
  ok('a car policy with your address: not home insurance', /Not one of the bill types/.test(why('Motor_Policy.pdf')), why('Motor_Policy.pdf'))
  ok('an outage notice: a notice', /notice/.test(why('Outage.pdf')), why('Outage.pdf'))
  ok('a notice that names your account but has no amount due: not a bill', /Doesn't read like a bill/.test(why('Info.pdf')), why('Info.pdf'))
  ok('a society circular about water: not a bill', /Doesn't read like a bill/.test(why('Water.pdf')), why('Water.pdf'))
  ok('your own mobile bill, matched only by your address: kept out', /only by address/.test(why('Airtel.pdf')), why('Airtel.pdf'))
  ok('nothing lands in a Miscellaneous folder', !n.paths().some((p) => /Miscellaneous/.test(p)))
  ok('or in Needs Review', !n.paths().some((p) => /_Needs Review/.test(p)))

  // the same phone bill is filed once its account is put against a property
  n.tab('Properties').rows[1][1] = '102401902, 210000800764, 1234567890'
  n.thread({ from: 'Airtel <ebill@airtel.in>', subject: 'Your Airtel broadband bill', date: '2026-07-05T09:00:00+05:30', body: 'Attached.',
    attachments: [pdf('Airtel_Jul.pdf', `Airtel broadband bill\n${HOME}\nRelationship No 1234567890\nBill date 05-07-2026\nAmount payable Rs 999.00`)] })
  n.run('processBills()')
  has('a phone or internet bill whose account is in the sheet is filed', n.paths(), P(ML, 'Internet & Telecom', 'FY 2026-27', '2026-06 June 2026 Internet & Phone Bill.pdf'))
  const home = makeWorld()
  home.thread({ from: 'Insurer <policy@insurer.example>', subject: 'Your home insurance policy', date: '2026-06-05T09:00:00+05:30', body: 'Attached.',
    attachments: [pdf('Home_Policy.pdf', `Home insurance policy schedule\n${HOME}\nPremium Rs 4,000\nPolicy period 01-06-2026 to 31-05-2027`)] })
  home.run('processBills()')
  has('a home insurance policy for a property is filed', home.paths(), P(ML, 'Property Insurance', 'FY 2026-27', '2026-06 June 2026 Insurance.pdf'))
}

console.log('\n── STARTING OVER ──')
{
  const o = makeWorld()
  fillMailbox(o)
  o.run('processBills()')
  const filedBefore = o.paths().filter((p) => !p.endsWith('Bill Sorter Settings')).length
  // a duplicate an earlier version left behind, and a file you added yourself
  const folder = o.folderNamed('FY 2026-27')
  folder.createFile({ getName: () => '2026-04 April 2026 Electricity Bill (2).pdf', getContentType: () => 'application/pdf', text: 'x' })
    .setDescription('Filed by Bill Sorter from Gmail message old. sha1=abc')
  o.folderNamed("2, Mother's Love, (Malad West)").createFile({ getName: () => 'My notes.pdf', getContentType: () => 'application/pdf', text: 'mine' })
  o.run('startOver()')
  const left = o.paths()
  eq('every file the script filed is in the trash', left.filter((p) => !p.endsWith('Bill Sorter Settings') && !p.endsWith('My notes.pdf')).length, 0)
  has('your own file is left alone', left, P(ML, 'My notes.pdf'))
  has('the settings spreadsheet stays', left, P('Bill Sorter Settings'))
  eq('the log is emptied', o.log().length, 0)
  ok('the old script\'s email keeps its Bill Records label', o.threads.find((t) => t.messages[0].attachments[0].name === 'Old_Bill.pdf').messages[0].labels.has(o.label))
  ok('the emails it had sorted lose the label', o.pending() > 10, String(o.pending()))
  o.run('processBills()')
  eq('the next run sorts them all again, once each', o.paths().filter((p) => !p.endsWith('Bill Sorter Settings') && !p.endsWith('My notes.pdf')).length, filedBefore)
  ok('with no duplicates', !o.paths().some((p) => / \(\d+\)\./.test(p)))
}

console.log('\n── SETUP ──')
const s = makeWorld()
s.triggers.push({ getHandlerFunction: () => 'automateBillSorting' })
s.thread({
  from: ADANI, subject: 'Adani Electricity Bill for CA No. 102401902', date: '2026-07-04T09:00:00+05:30',
  body: 'Please find attached your bill.', attachments: [pdf('Bill.pdf', 'CA No: 102401902\nBill Month: JUN-2026\nAmount payable 1,950.00')],
})
s.run('setup()')
eq('setup leaves exactly one schedule', s.triggers.length, 1)
eq('an hourly processBills', `${s.triggers[0].getHandlerFunction()} every ${s.triggers[0].hours}h`, 'processBills every 1h')
has('and sorts the first batch straight away', s.paths(), P(ML, 'Electricity Bills', 'FY 2026-27', '2026-06 June 2026 Electricity Bill.pdf'))
eq('the spreadsheet has just the two tabs', s.book().getSheets().map((x) => x.getName()).join(', '), 'Properties, Log')
ok('the old function name still works for an old trigger', typeof s.ctx.automateBillSorting === 'function')

console.log('\n── "ALWAYS" OPENS EVERYTHING ──')
const always = makeWorld()
always.run("CONFIG.READ_ATTACHMENTS = 'always'")
fillMailbox(always)
always.run('processBills()')
const alwaysRow = (name) => always.log().find((r) => r.Attachment === name) || {}
eq('then the April bill\'s month comes from the bill itself', alwaysRow('Bill_151759775.pdf')['Bill month'], 'April 2026 (Bill Month on the bill)')
eq('every attachment is opened', always.ocrCalls, 16)
const usual = makeWorld()
fillMailbox(usual)
usual.run('processBills()')
eq('and the same bills land in the same places as without opening them all', always.paths().join('\n'), usual.paths().join('\n'))

console.log('\n── DRIVE API V2, OR NONE AT ALL ──')
const v2 = makeWorld({ driveVersion: 2 })
v2.thread({
  from: 'Me <me@example.com>', subject: 'Fwd: bill', date: '2026-06-10T09:00:00+05:30', body: 'photo',
  attachments: [{ name: 'photo.jpg', type: 'image/jpeg', text: 'ADANI ELECTRICITY CA NO 153541273 Bill Month: MAY-2026 Amount payable 900.00' }],
})
v2.run('processBills()')
has('with the older Drive service the photo is still read', v2.paths(), P(SP, 'Electricity Bills', 'FY 2026-27', '2026-05 May 2026 Electricity Bill.jpg'))
const none = makeWorld({ withDrive: false })
let message = ''
try { none.run('processBills()') } catch (e) { message = e.message }
ok('without the Drive service it says exactly what to switch on', /Drive API/.test(message), message)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
