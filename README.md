<div align="center">

<img src="web/gms-banner.svg" alt="GMS Complaint Portal" width="100%" />

# GMS Complaint Portal

**Students file a complaint once. Staff resolve it. Admins see every case in real time.**

A complaint portal for colleges and universities, built on Node.js, Express 5 and PostgreSQL. Each complaint can be analysed by AI, which splits it into separate issues and gives a verdict for each one.

[![Version](https://img.shields.io/badge/version-1.0.0-2563eb?style=for-the-badge)](package.json)
[![License](https://img.shields.io/badge/license-ISC-0ea5e9?style=for-the-badge)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-16a34a?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Stars](https://img.shields.io/github/stars/flawsom/GMS?style=for-the-badge&color=f59e0b)](https://github.com/flawsom/GMS/stargazers)
[![Forks](https://img.shields.io/github/forks/flawsom/GMS?style=for-the-badge&color=8b5cf6)](https://github.com/flawsom/GMS/network/members)
[![Issues](https://img.shields.io/github/issues/flawsom/GMS?style=for-the-badge&color=ef4444)](https://github.com/flawsom/GMS/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/flawsom/GMS?style=for-the-badge&color=06b6d4)](https://github.com/flawsom/GMS/pulls)
[![Last Commit](https://img.shields.io/github/last-commit/flawsom/GMS?style=for-the-badge&color=64748b)](https://github.com/flawsom/GMS/commits/main)

[**Live Demo**](#-deployment) · [**Documentation**](#-api-documentation) · [**Installation**](#-quick-start) · [**GitHub Repository**](https://github.com/flawsom/GMS)

</div>

---

## Contents

[Features](#-features) · [Architecture](#-architecture) · [Tech Stack](#-tech-stack) · [Quick Start](#-quick-start) · [Project Structure](#-project-structure) · [Environment Variables](#-environment-variables) · [API](#-api-documentation) · [Usage](#-usage-examples) · [Deployment](#-deployment) · [Contributing](#-contributing) · [Roadmap](#-roadmap) · [FAQ](#-faq) · [Support](#-support)

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🧾 Filing and tracking
Students file complaints by category, attach a description, and follow each case from **Pending** to **Resolved** on their own dashboard.

</td>
<td width="50%" valign="top">

### 🤖 AI segmentation and verdicts
Each complaint is split into its separate issues. Every issue gets a category, a priority and a verdict, shown as a tooltip on the complaint.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔁 Live dashboards
Student, staff and admin dashboards reload every 15 seconds, so status changes appear without a page refresh.

</td>
<td width="50%" valign="top">

### 👥 Role-based access
Three roles (student, staff, admin) with separate sign-in, sessions and routes. Every API route checks the role on the server.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🛡️ Secure accounts
Passwords are hashed with bcrypt. Sessions live in PostgreSQL. Password recovery uses a security question and locks out after repeated wrong answers.

</td>
<td width="50%" valign="top">

### 📤 CSV export
Admins download every complaint as a spreadsheet-safe CSV file from the complaints page.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧭 Assignment workflow
Admins assign complaints to staff by department and workload. Staff accounts are approved by an admin before they can sign in.

</td>
<td width="50%" valign="top">

### ☁️ Serverless ready
Runs as a long-lived Node server locally and as a Vercel function in production, with sessions stored in the database.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ⏱️ SLA deadlines
Every complaint gets a due date from its priority: High in 24 hours, Medium in 3 days, Low in 7 days. Open complaints past their due date show an **Overdue** flag for students, staff and admins.

</td>
<td width="50%" valign="top">

### 🗂️ Case timeline
Each complaint keeps a record of when it was raised, assigned, moved to a new status and resolved. Students, staff and admins can open it from the complaint ID.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📧 Status emails
When staff move a complaint to In Progress or Resolved, the student gets an email. Emails are sent through Resend and are skipped when no key is set.

</td>
<td width="50%" valign="top">

### ✅ Tests, lint and CI
`npm test` and `npm run lint` run locally and in GitHub Actions. The Dockerfile builds the production image on every push to `main`.

</td>
</tr>
</table>

<div align="center">
<img src="https://capsule-render.vercel.app/api?type=rect&height=2&color=gradient&section=header" width="100%" alt="" />
</div>

---

## 🏗 Architecture

```mermaid
flowchart LR
    subgraph Client["Frontend (web/)"]
        A[Student pages]
        B[Staff pages]
        C[Admin pages]
    end

    subgraph Backend["Backend (server/)"]
        D[Express 5 app]
        E[Role middleware]
        F[Route modules]
        G[AI analysis]
    end

    subgraph Data["Database"]
        H[(PostgreSQL / Neon)]
        I[(Session store)]
    end

    subgraph External["External services"]
        J[Google Gemini API]
    end

    A -->|fetch /api| D
    B -->|fetch /api| D
    C -->|fetch /api| D
    D --> E --> F
    F --> H
    D --> I
    F --> G --> J
```

| Layer | Responsibility |
| --- | --- |
| **Frontend** | Static HTML, CSS and vanilla JavaScript served from `web/`. Pages call the JSON API with `fetch`. |
| **Backend** | Express 5 app in `server/app.js`. Routes are split by role: `auth`, `student`, `staff`, `admin`. |
| **APIs** | JSON under `/api/*`. Session cookie authentication. |
| **Database** | PostgreSQL through `pg`, with a connection pool and SSL. Schema in `server/schema.sql`. |
| **Authentication** | `express-session` with a PostgreSQL store (`connect-pg-simple`) and bcrypt password hashes. |
| **External services** | Google Gemini for complaint analysis. Optional, disabled when no key is set. |

---

## 🛠 Tech Stack

**Frontend**
![HTML5](https://img.shields.io/badge/HTML5-e34f26?style=flat-square&logo=html5&logoColor=white) ![CSS3](https://img.shields.io/badge/CSS3-1572b6?style=flat-square&logo=css3&logoColor=white) ![JavaScript](https://img.shields.io/badge/JavaScript-f7df1e?style=flat-square&logo=javascript&logoColor=black) ![Font Awesome](https://img.shields.io/badge/Font_Awesome-528dd7?style=flat-square&logo=fontawesome&logoColor=white)

**Backend**
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white) ![Express](https://img.shields.io/badge/Express_5-000000?style=flat-square&logo=express&logoColor=white) ![bcrypt](https://img.shields.io/badge/bcryptjs-64748b?style=flat-square)

**Database**
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169e1?style=flat-square&logo=postgresql&logoColor=white) ![Neon](https://img.shields.io/badge/Neon-00e599?style=flat-square&logo=neon&logoColor=black)

**Cloud**
![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white)

**AI/ML**
![Gemini](https://img.shields.io/badge/Google_Gemini-8e75b2?style=flat-square&logo=googlegemini&logoColor=white)

**Tools**
![npm](https://img.shields.io/badge/npm-cb3837?style=flat-square&logo=npm&logoColor=white) ![Git](https://img.shields.io/badge/Git-f05032?style=flat-square&logo=git&logoColor=white) ![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)

---

## ⚡ Quick Start

### Prerequisites

- Node.js 18 or newer
- A PostgreSQL database with SSL (a free [Neon](https://neon.tech) project works well)
- Optional: a Google Gemini API key for complaint analysis

### Installation

```bash
git clone https://github.com/flawsom/GMS.git
cd GMS
npm install
```

### Environment variables

```bash
cp .env.example .env
```

Fill in `DATABASE_URL` and `SESSION_SECRET`. See [Environment Variables](#-environment-variables) for every key.

### Run locally

```bash
npm run setup-db   # creates the tables and prints a one-time admin signup code
npm start          # http://localhost:3000
```

> [!NOTE]
> `setup-db` is safe to run more than once. It only creates what is missing.

### Docker

The included `Dockerfile` builds a production image on `node:22-alpine`. It installs only production dependencies, runs as the non-root `node` user and listens on `PORT` (default 3000).

```bash
docker build -t gms-complaint-portal .
docker run --rm -p 3000:3000 --env-file .env gms-complaint-portal
```

The image does not contain `.env`. Pass the variables at run time with `--env-file`. Run `npm run setup-db` once against the database before the first start.

### Production deployment

See [Deployment](#-deployment) for Vercel and other hosts.

---

## 📁 Project Structure

```text
GMS/
├── api/
│   └── index.js            # Vercel serverless entry, re-exports the Express app
├── server/
│   ├── app.js              # Express setup, sessions, static files, routing
│   ├── db.js               # PostgreSQL connection pool (SSL)
│   ├── middleware.js       # requireRole() and async error wrapper
│   ├── ai.js               # Complaint segmentation and verdicts (Gemini)
│   ├── schema.sql          # Database schema, safe to re-run
│   ├── setup-db.js         # Applies the schema and prints the admin code
│   └── routes/
│       ├── auth.js         # Login, signup, password reset
│       ├── student.js      # Student profile, complaints, feedback
│       ├── staff.js        # Assigned complaints and status updates
│       └── admin.js        # Dashboards, assignment, approvals, CSV export
├── web/
│   ├── Home.html           # Landing page
│   ├── gms-api.js          # Shared fetch helper for the pages
│   ├── CSS/                # Stylesheets per role
│   └── HTML/               # STUDENTS, STAFF and ADMIN pages
├── .env.example            # Variable names with placeholder values
├── package.json
└── vercel.json             # Routes every request to the Express app
```

---

## 🔐 Environment Variables

| Variable | Required | Example | Description |
| --- | :---: | --- | --- |
| `DATABASE_URL` | Yes | `postgres://user:pass@host/db?sslmode=require` | PostgreSQL connection string. SSL is required. |
| `SESSION_SECRET` | Yes | 96 hex characters | Signs the session cookie. Keep it private and different per environment. |
| `AI_PROVIDER` | No | `gemini` | AI provider for complaint analysis. |
| `AI_MODEL` | No | `gemini-3.5-flash-lite` | Model name for the provider. |
| `AI_API_KEY` | No | `AIza...` | API key. Leave empty to turn AI analysis off. |
| `RESEND_API_KEY` | No | `re_...` | Resend API key for status-change emails to students. Leave empty to skip email. A failed send never blocks a status change. |
| `NOTIFY_FROM` | No | `GMS <complaints@example.edu>` | Sender for status emails. Must be a sender verified in Resend. |
| `PORT` | No | `3000` | Local port. Defaults to 3000. |

> [!WARNING]
> Never commit `.env`. It is already listed in `.gitignore`.

---

## 📖 API Documentation

**Base URL:** `http://localhost:3000/api` locally, or `https://<your-domain>/api` in production.

**Authentication:** session cookie set by the login endpoint (`HttpOnly`). Send requests from the same origin, and include the cookie when calling from another client.

### Endpoints

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/student/login` | student | Sign in as a student |
| `POST` | `/api/auth/staff/login` | staff | Sign in as staff |
| `POST` | `/api/auth/admin/login` | admin | Sign in as an admin |
| `POST` | `/api/auth/:role/signup` | any | Create an account (staff need admin approval) |
| `POST` | `/api/auth/:role/reset-password` | any | Recover a password with the security answer |
| `GET` | `/api/student/dashboard` | student | Counts and recent complaints |
| `POST` | `/api/student/analyze` | student | Run AI analysis on a draft complaint |
| `GET` | `/api/student/complaints` | student | The student's complaints with verdicts, due date and overdue flag |
| `GET` | `/api/student/complaints/:id/timeline` | student | Activity timeline for one of the student's own complaints |
| `GET` | `/api/staff/complaints` | staff | Complaints assigned to the signed-in staff member, with due date and overdue flag |
| `POST` | `/api/staff/complaints/:id/status` | staff | Update the status of an assigned complaint. Emails the student when `RESEND_API_KEY` is set |
| `GET` | `/api/staff/complaints/:id/timeline` | staff | Activity timeline for an assigned complaint |
| `GET` | `/api/admin/dashboard` | admin | Platform totals and recent activity |
| `GET` | `/api/admin/complaints` | admin | Every complaint with verdicts |
| `GET` | `/api/admin/complaints.csv` | admin | Every complaint as a CSV download |
| `GET` | `/api/admin/complaints/:id/timeline` | admin | Activity timeline for any complaint |
| `POST` | `/api/admin/complaints/assign` | admin | Assign a complaint to a staff member |

### Example request

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/student/login \
  -H "Content-Type: application/json" \
  -d '{"email":"student@example.edu","password":"your-password"}'

curl -b cookies.txt http://localhost:3000/api/student/complaints
```

### Example response

```json
{
  "complaints": [
    {
      "complaintId": "CMP1042",
      "category": "Infrastructure",
      "status": "In Progress",
      "complaintDate": "2026-11-02",
      "aiAnalysis": {
        "spam": false,
        "verdict": "Two separate problems: a broken streetlight and a blocked drain.",
        "issues": [
          { "text": "streetlight", "category": "Infrastructure", "priority": "High" },
          { "text": "drain", "category": "Sanitation", "priority": "Medium" }
        ]
      }
    }
  ]
}
```

Errors return a JSON body with an `error` message that names the problem and the next step.

---

## 📸 Screenshots

Screenshots are added after the first production deploy. Replace each path with a file under `docs/screenshots/`.

| Desktop | Mobile | Dashboard |
| :---: | :---: | :---: |
| `docs/screenshots/desktop.png` _(pending)_ | `docs/screenshots/mobile.png` _(pending)_ | `docs/screenshots/dashboard.png` _(pending)_ |

| Authentication | Settings | Analytics |
| :---: | :---: | :---: |
| `docs/screenshots/auth.png` _(pending)_ | `docs/screenshots/settings.png` _(pending)_ | `docs/screenshots/analytics.png` _(pending)_ |

---

## 🎥 Demo

| Format | Status |
| --- | --- |
| GIF walkthrough | Pending. Save as `docs/demo/walkthrough.gif` |
| MP4 preview | Pending. Save as `docs/demo/walkthrough.mp4` |
| YouTube video | Pending. Add the link when published |
| Live deployment | Pending. Shown here once the Vercel project is live |

---

## 🎯 Usage Examples

**Analyse a complaint before filing it**

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/student/analyze \
  -H "Content-Type: application/json" \
  -d '{"description":"The streetlight outside block C is broken and the drain next to it is blocked."}'
```

**Download every complaint as a spreadsheet**

```bash
curl -b admin-cookies.txt -o complaints.csv http://localhost:3000/api/admin/complaints.csv
```

The same file is available from **Admin → All Complaints → Export CSV**.

---

## 📊 Performance

No benchmark has been published yet. Measured numbers will replace these placeholders once they are run.

| Metric | Result | Method |
| --- | --- | --- |
| Lighthouse performance (student login) | _to be measured_ | Chrome DevTools, mobile profile |
| Time to first byte (`/api/student/dashboard`) | _to be measured_ | `curl -w "%{time_starttransfer}"` |
| Frontend payload | _to be measured_ | `du -sh web/` |
| Concurrent sessions per instance | _to be measured_ | `autocannon` against the dashboard |

---

## 🧪 Testing

```bash
npm test        # node:test suite in test/: SLA rules, status emails, route smoke tests
npm run lint    # ESLint flat config (eslint.config.js)
```

The test suite runs without a database. Schema checks still need a real database: `npm run setup-db` verifies it applies cleanly.

CI (`.github/workflows/ci.yml`) runs lint and tests on every push and pull request to `main`, then builds the Docker image. Coverage reporting is not configured yet. See the [Roadmap](#-roadmap).

---

## 🚀 Deployment

### Vercel (recommended)

1. Import `flawsom/GMS` in the Vercel dashboard. No build command is needed.
2. Add `DATABASE_URL`, `SESSION_SECRET`, `AI_PROVIDER`, `AI_MODEL` and `AI_API_KEY` under **Settings → Environment Variables**.
3. Run `npm run setup-db` once against the production database.
4. Deploy. `vercel.json` routes every request to `api/index.js`.

### Netlify, Railway, DigitalOcean, AWS

The app is a standard Node server. Set the same variables, use `npm install` as the install step and `npm start` as the start command, and run `npm run setup-db` once against the database.

### Docker

See the Docker section under [Quick Start](#-quick-start).

---

## 🤝 Contributing

1. Fork the repository and create a branch from `main`.
2. Name branches by intent: `feat/csv-export`, `fix/reset-lockout`, `docs/readme`.
3. Write commits in the Conventional Commits style: `feat: add CSV export for admins`.
4. Run the syntax checks above before you open a pull request.
5. Open a pull request that explains what changed and how you tested it. Link the issue it closes.

---

## 🗣️ Roadmap

- [x] Student, staff and admin sign-in with role-based routes
- [x] AI segmentation and verdicts per complaint
- [x] Live dashboards with a 15-second refresh
- [x] Password reset with a security question and lockout
- [x] PostgreSQL sessions that work on serverless hosts
- [x] CSV export for admins
- [x] SLA deadlines with overdue flags
- [x] Case activity timeline
- [x] Email notifications on status change
- [x] Automated test suite and linting
- [x] Dockerfile and CI workflow

---

## ❓ FAQ

<details>
<summary><strong>Do I need an AI key to use the portal?</strong></summary>

No. Leave `AI_API_KEY` empty and complaints are filed and tracked normally. Only the AI verdict is turned off.

</details>

<details>
<summary><strong>Why are sessions stored in the database?</strong></summary>

Serverless hosts such as Vercel start a new process for each request, so in-memory sessions are lost. Storing them in PostgreSQL keeps sign-in working on every instance.

</details>

<details>
<summary><strong>How does password recovery stay safe?</strong></summary>

Recovery needs the email, the security question and the answer. After five wrong answers for the same account in 15 minutes, further attempts return HTTP 429 until the window passes.

</details>

<details>
<summary><strong>How do I create the first admin?</strong></summary>

Run `npm run setup-db`. If no admin exists, it prints a one-time signup code. Use it on the admin signup page.

</details>

---

## 🙌 Acknowledgements

Thanks to the open-source projects that informed the design of complaint and ticketing workflows, including osTicket and OpenEduCat, and to everyone who reported issues during development.

---

## 📜 License

This project is licensed under the ISC License. See `package.json` for the license field. A standalone `LICENSE` file has not been added yet.

---

## ❤️ Support

- ⭐ **Star the repository** if this project helps you. It takes one click and it helps others find it.
- 🐛 **Report a bug or request a feature** in [Issues](https://github.com/flawsom/GMS/issues).
- 🤝 **Sponsor or buy a coffee** to fund the roadmap. Add your sponsor link here once it exists.
- ✉️ **Contact:** open an issue on the repository.

<div align="center">

[⬆ Back to top](#gms-complaint-portal)

</div>
