# MedRoster — Backend API

**Blaze Studios** · MedRoster API

Standalone Express API for MedRoster. Authenticates requests with **Firebase Auth** ID tokens and stores hospital data in **Cloud Firestore**.

Consumed by the [web frontend](https://github.com/blaze308/medroster-web-app) and [Flutter app](https://github.com/blaze308/medroster-mobile-app).

---

## Stack

- **Node.js** + Express 4
- **Firebase Admin** (Auth + Firestore)
- Helmet, CORS, rate limiting

---

## Getting started

> **Firebase first:** Follow [FIREBASE_SETUP.md](../FIREBASE_SETUP.md) to create the Firebase project, enable Email/Password auth, and add the service account to `.env`.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` in this folder:

   ```env
   PORT=4000
   ALLOWED_ORIGINS=http://localhost:3000

   FIREBASE_ADMIN_PROJECT_ID=
   FIREBASE_ADMIN_CLIENT_EMAIL=
   FIREBASE_ADMIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

   Use a Firebase service-account key. Escape newlines in `FIREBASE_ADMIN_PRIVATE_KEY` as `\n`.

3. Run:

   ```bash
   npm run dev    # watch mode
   npm start      # production
   ```

4. Health check: [http://localhost:4000/health](http://localhost:4000/health)

---

## Auth model

- `POST /api/auth/register` — creates a Firebase Auth user, hospital doc, and `users/{uid}` profile (role `admin`).
- All other `/api/*` routes require `Authorization: Bearer <Firebase ID token>`.
- Middleware resolves the caller's `hospitalId` from Firestore and scopes data access to that hospital.

---

## API surface

```
POST   /api/auth/register

GET    /api/hospitals
GET    /api/hospitals/:id
PATCH  /api/hospitals/:id
DELETE /api/hospitals/:id

GET    /api/hospitals/:id/departments
POST   /api/hospitals/:id/departments
PATCH  /api/hospitals/:id/departments/:depId
DELETE /api/hospitals/:id/departments/:depId

GET    /api/hospitals/:id/wards
POST   /api/hospitals/:id/wards
PATCH  /api/hospitals/:id/wards/:wardId
DELETE /api/hospitals/:id/wards/:wardId

GET    /api/hospitals/:id/staff
POST   /api/hospitals/:id/staff
GET    /api/hospitals/:id/staff/:staffId
PATCH  /api/hospitals/:id/staff/:staffId
DELETE /api/hospitals/:id/staff/:staffId
GET    /api/hospitals/:id/staff/:staffId/leave
POST   /api/hospitals/:id/staff/:staffId/leave
DELETE /api/hospitals/:id/staff/:staffId/leave?leaveId=

GET    /api/hospitals/:id/schedules
POST   /api/hospitals/:id/schedules
GET    /api/hospitals/:id/schedules/:schedId
PATCH  /api/hospitals/:id/schedules/:schedId
DELETE /api/hospitals/:id/schedules/:schedId
POST   /api/hospitals/:id/schedules/:schedId/assignments
DELETE /api/hospitals/:id/schedules/:schedId/assignments?clearAll=true
POST   /api/hospitals/:id/schedules/:schedId/validate
POST   /api/hospitals/:id/schedules/:schedId/generate
```

---

## Firestore layout

```
hospitals/{hospitalId}
  departments/{depId}
  wards/{wardId}
  staff/{staffId}
  schedules/{schedId}
    assignments/{assignmentId}

users/{uid}   → { email, name, hospitalId, role }
```

---

## Project structure

```
src/
├── index.js              # App entry, CORS, rate limits
├── config/firebase.js    # Admin SDK + helpers
├── middleware/auth.js    # requireAuth, requireHospital
├── routes/               # REST handlers
└── lib/
    ├── validation.js     # Scheduling rules
    ├── staff-utils.js
    └── logger.js
```

---

## Related repos

| Repo | Role |
|------|------|
| [medroster-web-app](https://github.com/blaze308/medroster-web-app) | Next.js web client |
| [medroster-mobile-app](https://github.com/blaze308/medroster-mobile-app) | Flutter mobile client |

---

*Built for Ghanaian healthcare excellence.*
