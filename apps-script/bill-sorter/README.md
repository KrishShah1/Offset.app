# Bill Sorter (Google Apps Script)

Reads property bills in Gmail and files them in Google Drive by property, then utility, then
financial year:

```
Property Bills/
├── Bill Sorter Settings                       ← spreadsheet: Properties tab + Log tab
├── 2, Mother's Love, (Malad West)/
│   ├── Electricity Bills/
│   │   └── FY 2026-27/
│   │       ├── 2026-04 April 2026 Electricity Bill.pdf
│   │       └── 2026-05 May 2026 Electricity Bill.pdf
│   └── Property Taxes/…
├── New property - Electricity 900012345678/   ← an account the sheet didn't know yet
└── _Needs Review/                             ← bills it couldn't place
```

This is a standalone Google Apps Script. It runs in your Google account, not in the Offset app.

## Setting it up

Do this on a computer; the Apps Script editor is hard to use on a phone.

1. Open your project at [script.google.com](https://script.google.com), or click **New project**.
2. Replace everything in `Code.gs` with [`Code.gs`](./Code.gs) from this folder, and save.
3. Next to **Services**, click **+**, choose **Drive API**, and click **Add**. Skip this if it's
   already listed.
4. **Project Settings** (the gear) → **Time zone** → *(GMT+05:30) India Standard Time*.
5. Choose **setup** in the function list at the top and click **Run**. Approve the permissions it
   asks for: Gmail, Drive, Docs, Sheets, and running on a schedule.

`setup` creates the **Property Bills** folder and the **Bill Sorter Settings** spreadsheet,
schedules a run every hour (replacing the old script's schedule) and sorts the first batch.
To stop it going back through old mail, set `SEARCH_SINCE` in `CONFIG`, e.g. `'2024/04/01'`.

## How long it takes

Apps Script stops any run at six minutes, so this one never tries to do everything at once.
Each run stops starting new work after about 3½ minutes, saves what it did, and the next hourly
run carries on from there. Nothing is lost or filed twice when a run stops part way. The last
line of each run's log says either `All caught up.` or `More to do`.

- **Opening an attachment is the slow part:** Drive's OCR takes seconds to a minute per file.
  So it only opens one when the email alone can't place it. A bill whose email shows one of your
  account numbers is filed straight away, and an email with nothing to suggest a property bill
  (a shopping invoice, say) is skipped without opening. Set `READ_ATTACHMENTS` to `'always'` to
  open every one: slower, but the bill month then always comes from the bill itself.
- Files over 5 MB and PDFs over 10 pages are never opened; they're sorted from their email.
- To clear a big backlog faster, run **processBills** by hand a few times. Each run takes up to
  about four minutes.
- Google gives scheduled runs 90 minutes a day on a personal account. The script stops its
  scheduled runs for the day at 80, rather than letting Google fail them and email you about it,
  and carries on the next day. Runs you start by hand don't count.

## Using it

**Properties tab.** One row per property: its name (also its folder name), its account numbers,
and keywords that appear on its bills (building, flat number, road). Change it any time; the
next run picks it up.

- **Rename a property** in the sheet or in Drive. The other one follows.
- **New properties appear by themselves.** A bill with an account number the sheet doesn't know
  gets a row like `New property - Electricity 123456789` and a folder of its own. Rename it. Or,
  if that account belongs to a property you already have, move the number into that row, delete
  the new row, and move its files across in Drive.
- An account number always beats a keyword. Keywords match whole words only, so `f-34` matches
  "F-34, Sej Plaza" but not "a bill of 3,450".

**Log tab.** Every attachment it looked at, with a link to the file and the email, the month and
financial year it chose and why, and what it matched on. The results:

| Result | Meaning |
|---|---|
| Filed | In its property's folder |
| Filed (new property) | Started a new property row and folder |
| Needs review | In `_Needs Review`: no known account or keyword, or two properties matched equally |
| Duplicate | Already filed: the same file, or the same bill sent again (same bill number, or same account and month) |
| Skipped | Not a property bill: see below |
| Error | Something failed; it tries again next run, up to three times |

**_Needs Review.** Move the file by hand, then add the account number or a keyword to the right
property so the next one goes straight there.

## What gets filed, and what doesn't

Only property bills. An attachment is filed when all of these hold:

- it is one of the bill types in `UTILITIES` (electricity, gas, water, internet and phone, property
  tax, home or fire insurance, rent, repairs, pest control, society maintenance). Nothing else is
  filed; there is no "miscellaneous" folder;
- it reads like a bill: an amount, and a due date, bill number, bill date or billing period;
- it isn't a receipt, reminder or notice (`NOT_A_BILL`: payment confirmations, outage notices,
  newsletters, tariff sheets, AGM notices, circulars, offers);
- it belongs to one of your properties. Your property keywords are your address, which is on
  everything sent to you, so a match on address alone also needs clear signs of the bill type;
  and phone and internet bills are filed only when their account number is in the sheet, so your
  own mobile bill stays out.

So bank and card statements, car and health insurance, shopping invoices, promotions and society
circulars are skipped and logged with the reason, not filed.

## Duplicates

Each bill is filed once. A second copy is logged as `Duplicate` with a link to the one already
filed, and not saved, when it is:

- the very same file, wherever it was filed;
- a bill with the same bill number as one already filed;
- for a bill with an account number (electricity, gas, water, internet, property tax, society):
  another one that arrived within 7 days of it, or one for the same account and month.

Payment receipts and reminders (`NOT_A_BILL` in `CONFIG`) are skipped. Two genuinely different
bills that land on the same name, like two meters at one property, are named by account or bill
number (`… Electricity Bill - 102401902.pdf`) rather than `(2)`.

**To clear out duplicates from earlier versions**, run **startOver** once. It moves every file
the script filed to the Drive trash (restorable there for 30 days), empties the Log tab and takes
the `Bill Records` label off the emails it handled; the next runs sort them all again. Emails the
old script labelled, and files you added yourself, are left alone.

**To sort an email again**, delete its rows in the Log tab and remove the `Bill Records` label from
it in Gmail. If its earlier copy is in the wrong folder, delete that.

## How it decides

- **Reading the bill.** When it needs to, it turns the PDF or photo into a temporary Google Doc
  with Drive's OCR, reads it, and deletes it. If that fails, or the file is too big to open, it
  sorts from the email alone and the log's Notes say so.
- **Utility.** The sender, subject, bill and email are checked against the keywords for each type
  in `UTILITIES` at the top of `Code.gs`; the strongest evidence wins.
- **Month.** The "Bill Month" printed on the bill, else its billing period, a month in the subject,
  the bill date, and finally the date the email arrived. Electricity, gas, water and phone bills
  charge for the month before, so one dated in April that doesn't say which month it covers is
  filed as March's. Society, rent, tax and insurance bills go under the month their period starts.
- **Financial year.** April to March: March 2026 is `FY 2025-26`, April 2026 is `FY 2026-27`.
- **File name.** `2026-04 April 2026 Electricity Bill.pdf`, month number first so a year lists in
  order. A different bill for the same month gets ` (2)`; the same file twice is saved once.

## Coming from the old script

The old script wrote to `Sorted_Bills` and labelled threads `Bill Records`. This one keeps the
`Bill Records` label, so mail the old script already labelled is left alone, and new bills go to
**Property Bills**. To have old mail sorted again, remove its `Bill Records` label: in Gmail on a
computer, search `label:bill-records`, select all conversations, and remove the label. Your three
properties start in the sheet with the same names, account numbers and keywords as before.

## Tests

`node tests/logic/billsorter.test.mjs` runs `Code.gs` against stand-ins for Gmail, Drive, Docs and
Sheets. It can't prove Google's own services behave as described; it proves the script's
decisions, file names, retries and bookkeeping do.
