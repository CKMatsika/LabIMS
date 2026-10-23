# LabIMS

LabIMS is a web-based laboratory information management system prototype for Hwange Power Station. It includes a React/Vite client, a Node API, and a PostgreSQL relational database.

## Local development

Requirements: Node.js 20.19+ and Docker Desktop with Compose.

1. Copy `.env.example` to `.env`. Its PostgreSQL password is for local development only; change it before any shared deployment.
2. Start PostgreSQL with `docker compose up -d db`.
3. Install packages with `npm install`.
4. In one terminal run `npm run dev:api`.
5. In another terminal run `npm run dev` and open `http://127.0.0.1:5173`.

On first launch, create the initial Station Chemist administrator from the sign-in screen. Use a unique password of at least 12 characters. The one-time setup endpoint is disabled after the first user is created.

For a single-process production-style preview, build with `npm run build` and run `npm start`; configure `DATABASE_URL`, `JWT_SECRET`, and `NODE_ENV=production`. The API serves the built client when `dist` exists.

## Included workflows

- Sample registration, barcode/sample ID lookup, custody history, status tracking, and method templates.
- Configurable test methods and parameters with numerical limits and precision.
- Result entry, limit flags, supervisor/chemist electronic sign-off, and signed sample history.
- Dashboard aggregates, compliance exceptions, parameter histories, and a CSV report export.
- User provisioning for Lab Technician, Lab Supervisor, Station Chemist, and Plant Management roles.
- Instrument/device records, manual readings, and configurable DCS/Historian and ERP connector endpoints/tag mappings.
- Append-only sample/audit histories, a SHA-256 audit hash chain, and an audit integrity verification endpoint.

## Deployment and integration notes

This prototype uses PostgreSQL as its relational database. It provides the API configuration and recording points for instrument protocols and plant integrations, but it does not ship vendor-specific RS232/USB/TCP drivers, DCS credentials/tag definitions, or an ERP connector. Those require the actual instrument models, station network endpoints, security approvals, and interface specifications. The interface reports configured connectors as configured; it does not claim that a plant system is connected until an adapter is implemented and verified.

Before operational use, deploy behind HTTPS on the approved intranet, change all development credentials, set a high-entropy `JWT_SECRET`, restrict database access and privileges, configure tested backups/restore, validate site-specific methods/limits/calculations, and complete FAT/SAT and regulatory validation. Electronic signatures and audit controls here are implementation foundations, not a claim of validated 21 CFR Part 11 or ISO 17025 compliance.
