# Getting Your System Live

## What's already done, what's left, and what we need from you

Your system is already built and running on its own private server — separate database, separate file storage, separate everything. Nothing below is about building software. It's about connecting your system to *your* company: your email, your web address, your people, and your sites.

Most of this takes about 20 minutes to answer. Fill in the blanks, or just reply to our email with the answers. Anything marked **optional** can wait until after you're live.

**One rule:** never send a password by email — not to us, not to anyone. Section A explains how to hand those over safely.

**Prepared for:** ______________________________  **Date:** ______________

---

## Where things stand

| Step | Who handles it | Status |
|---|---|---|
| Your private system, database and file storage | Us | Done |
| Your login and admin account | Us | Done |
| Your company name, colors and logo in the app | Us — from your files | In progress |
| Email notifications | **Needs you — Section A** | Waiting |
| Your own web address | **Needs you — Section B** | Waiting |
| Text-message alerts (optional) | **Needs you — Section C** | Waiting |
| Push-to-talk radio | Us | In progress |
| Your sites, officers and clients loaded | **Needs you — Section D** | Waiting |
| Operating rules confirmed | **Needs you — Section E** | Waiting |
| Agreements signed | **Needs you — Section F** | Waiting |
| Walkthrough and go-live | Us, with you | Scheduled after the above |

---

## Section A — Email notifications

**What email does in your system:** staff invitations and password resets, hiring and onboarding links to applicants, invoices to your clients, and alerts to your office. Without it, you can still use the system day to day, but nobody can be invited or reset a password by email.

You have two choices. You can start with Option 2 today and move to Option 1 later.

### Option 1 — Send from your own domain (recommended)

Your staff and clients see mail from *you* (for example `no-reply@yourcompany.com`), not from us. It also keeps your invoices out of spam folders.

We need **one** of the following:

- **A mailbox on your domain we can send through.** We need its server address, port, username, the sending address — and a password, which must **not** travel by email. Options for the password, best first: whoever manages your email enters it directly while we share a screen; you send it through a password manager's secure share link; or you read it to us by phone. If you use Google Workspace or Microsoft 365, create a dedicated mailbox and an app password for it, so it can be revoked without touching anyone's real account.
- **Permission to add three DNS records to your domain.** We set up and pay for the sending service on our side, then send you the exact records to add (they authorize us to send as your domain — SPF, DKIM and DMARC). You or your web person add them; it takes about ten minutes, then up to 24 hours to verify. No password changes hands with this option, which is why we prefer it.

### Option 2 — Start on our sending address

Email goes out from our platform's sending address instead of yours. We configure it on our side, so nothing is needed from you and there's no waiting on DNS. The trade-off: your staff and clients see a sender that isn't your company, and invoices from an unfamiliar address are more likely to land in spam.

### What to tell us

- Which option you want: [  ] Option 1 (own domain)  [  ] Option 2 (start on ours)
- Address email should come **from**: ______________________________
- Address replies to **invoices** should go to: ______________________________
- Inbox that should receive **HR notices** (new applications, onboarding, profile changes): ______________________________
- Who manages your domain or website (name, email, phone): ______________________________
- Your email provider: [  ] Google Workspace  [  ] Microsoft 365  [  ] Other: ______________

---

## Section B — Your web address

Your system is already reachable at the temporary address we gave you, and it works completely — your office can use it today.

If you'd rather have your own address (for example `app.yourcompany.com`), we need:

- The exact address you want: ______________________________
- Access to add two DNS records to that domain — the same person from Section A can do it, or we can send the records to your web host.

Timing: about fifteen minutes of work, then a few hours for the internet to catch up. Your officers' phones are **not** affected either way — they connect using your company code, not a web address.

- [  ] Use the temporary address for now  [  ] Set up our own address

---

## Section C — Text-message alerts (optional)

Your officers already get **push notifications** on their phones for shift alerts and emergencies at no extra cost. Text messages are an additional layer, useful for emergency alerts to people who don't have the app open, or office staff who don't carry it.

If you want text alerts, we need to know:

- [  ] Yes, set up text alerts  [  ] No, push notifications are enough for now
- A phone number to send from — we can get you a new one, or use one you already own (we'd need access to that account): ______________________________
- Who should receive emergency texts: ______________________________

Texting costs are billed through at cost — roughly a couple of dollars a month for the number, plus about a penny per message.

---

## Section D — Your people, sites and clients

This is what turns an empty system into yours. Send it however is easiest — a spreadsheet is perfect, and we can send you a template.

**Your master admin** (full control over everything, including billing settings):

- Name: ______________________  Email: ______________________  Phone: ______________

**Other office / dispatch staff who need logins:** name, email, phone, and what they should be able to do (full admin, dispatch only, or supervisor).

**Your sites** — for each one:

- Site name and full street address
- Whether officers must be physically at the site to clock in (we default to a quarter-mile radius)
- On-site contact, if you want it in the app

**Your clients** (only if you'll invoice through the system): company name, billing contact email, and payment terms.

**Your officers** — for each one: full name, email, mobile number, license number and level, and their pay rate. If you have this in a spreadsheet already, send it as-is; we'll map it.

---

## Section E — Your operating rules

We've set sensible defaults. Tell us only the ones that are wrong for your company.

| Setting | Our default | Change to |
|---|---|---|
| Time zone | Central | ______________ |
| Officer classification | 1099 contractors — no tax withheld | ______________ |
| Payroll and invoice week | Starts Monday | ______________ |
| Clock-in distance from site | About a quarter mile | ______________ |
| Officer forgets to clock out | Closed out about 10 minutes after the shift ends, unless their phone still shows them on site; the extra time is unpaid. Adjustable per site | ______________ |
| Clock in automatically on arrival | Off — can be turned on per site | ______________ |
| Emergency call button dials | 911 | ______________ |
| Overtime | Tracked and shown; not auto-calculated into pay | ______________ |

---

## Section F — Paperwork and brand files

- **Agreements** — we'll send the Master Subscription Agreement and the User Agreement. They're signed electronically inside your portal; no printing.
- **Your company license number** as it should appear in the app and on documents: ______________________________
- **Your logo** — a PNG with a transparent background, at least 512 pixels wide. If all you have is a business card or a website image, send it and we'll clean it up.
- **Your brand colors**, if you know them (hex codes are ideal, but "navy and gold" works): ______________________________

---

## What happens once you send this back

1. **Same day** — we configure email, brand your app, and apply your settings.
2. **Within a day or two** — your sites, officers and clients are loaded, and DNS changes finish if you're using your own domain.
3. **We test everything** — send an invitation, run a clock-in at a real site, test the radio between two phones, and generate a sample invoice.
4. **Walkthrough** — 30 to 45 minutes with your admin, covering the parts you'll use daily.
5. **Your officers** install the SecureOps app — we send you the install link for iPhone and Android — and connect with your company code. No setup on their end.

---

## Questions we get asked a lot

**Do our officers need to install anything special?**
No. It's one app, the same one every company on the platform uses — we'll send you the install link for iPhone and Android. Officers type in your company code the first time and that's it.

**Can we start using it before the domain and email are finished?**
Yes. Only invitations and password reset emails depend on Section A, and nothing depends on Section B.

**Who can see our data?**
Only your users. Your system runs on its own server with its own database and its own file storage — nothing is shared with another company.

**Can we change our branding, rates or rules later?**
Yes, all of it, from your admin portal. Branding changes appear instantly.

**What if we get it wrong?**
Nothing here is permanent. Sites, rates and rules can all be edited after go-live.
