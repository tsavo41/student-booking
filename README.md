# AttachFlow

AttachFlow is a Node.js and SQLite hospital-allocation application that keeps the existing AttachFlow interface and the supplied 15-hospital list.

## Requirements

- Node.js 22.13 or newer
- npm

## Start the application

```powershell
npm install
npm start
```

The SQLite database is created at `data/attachflow.sqlite`. Set `ATTACHFLOW_DB` to store it elsewhere. The seeded hospital records are inserted only when the database has no hospitals; subsequent startups do not replace hospital changes or bookings.

To create the first administrator securely from the VS Code terminal:

1. Run `npm start` once to initialize the application database and hospital records. You can leave the server running.
2. Open a second VS Code terminal in the project folder and run `npm run admin:create`.
3. Enter your full name and chosen username. Password input is hidden, and the password is stored as a bcrypt hash. Because this command runs directly on the trusted server, it activates the first account without requiring SMTP or email verification.
4. Sign in through the AttachFlow administrator sign-in button.

The command uses the same database path as the application, including `ATTACHFLOW_DB` if configured. It refuses to create another administrator if any administrator account already exists. This local activation is available only through the terminal command; accounts created through invitations must still verify their email. Configure SMTP to send invitations, verify email changes, and use password recovery. Additional account creation is invitation-only: a Super Administrator sends an invitation, and the recipient must use its single-use email link to create their password. Public registration without an invitation is rejected.

The sign-in screen’s **Create Account** link is for invitees and will not create accounts without a valid Super Administrator invitation. **Forgot Password** sends a one-time recovery link to the registered, verified address; the initial Super Administrator address is `juki13305@gmail.com`. Password reset links expire after one hour, and invitation and verification links expire after 48 and 24 hours respectively.

## Deploy to Render

The `render.yaml` Blueprint runs the Node.js server on Render and mounts a persistent disk at `/var/data` for SQLite. The disk is required to retain hospital changes, administrator accounts, and bookings across deploys. The Starter web service and its persistent disk may incur charges; review Render's current pricing before deployment. Keep a single service instance because SQLite and its persistent disk are not shared across instances.

1. Push the project to GitHub, then in Render choose **New > Blueprint** and select the repository containing `render.yaml`.
2. Create the web service and persistent disk from the Blueprint. Render provides `RENDER_EXTERNAL_URL`; the app uses it for production HTTPS validation and links in email. You may instead set `ATTACHFLOW_PUBLIC_ORIGIN` to the exact public HTTPS origin.
3. After the first successful deploy, open the service's Shell and run `npm run admin:create` once. Use the prompts to create the production Super Administrator; this creates the account in Render's database, not the local development database.
4. Configure SMTP environment variables in Render if administrator invitations, email verification, and password recovery should send mail. Do not copy `.env` to GitHub or put secrets in `render.yaml`.

The local `data/attachflow.sqlite` file is intentionally ignored and is not uploaded. Existing local bookings and accounts are not automatically copied to Render. Back up the persistent disk separately and do not scale this SQLite deployment beyond one instance.

Super Administrators can update their username from **Admin Dashboard > Settings > Administrator Profile**. Administrator passwords can be changed from the same page after confirming the current password and entering the new password twice. Changing a username or password signs that administrator out of all active sessions; sign in again with the updated credentials. Passwords are stored as bcrypt hashes and are never included in the page source.

## Student bookings

Students enter only their full name and admission number. Course, campus, and year are assigned on the server as `OCCUPATIONAL THERAPY`, `KMTC NAIROBI CAMPUS`, and `3.2`. Students can check a booking by admission number; that lookup returns only the hospital and booking status. Booking cancellation is available from the browser that submitted the booking using its private cancellation token. Administrators can remove any booking.

## Security and deployment

- Administrator passwords use bcrypt with a per-password salt. Existing scrypt-based admin hashes are upgraded to bcrypt after successful login when the password is within bcrypt's 72-byte limit; longer legacy passwords remain verifiable with scrypt.
- Administrator sessions use HttpOnly, SameSite cookies and per-session CSRF tokens.
- Student booking, admission-number uniqueness, capacity checks, and admin permissions are enforced server-side.
- SQLite transactions and database triggers prevent capacity overbooking.
- Student pages do not receive the admin booking list. Do not expose the database file or `data/` directory through a web server.
- For deployment, use HTTPS behind a trusted reverse proxy, set `NODE_ENV=production` and `ATTACHFLOW_PUBLIC_ORIGIN` to the exact HTTPS origin, restrict access to the host and database backups, and configure regular encrypted backups. Do not expose the development server directly to the public internet.
- The administrator login is not multi-factor authenticated. For an internet-facing production deployment, add MFA, account recovery and rotation procedures, centralized session storage, and monitoring.

## Reports

Administrators can export booking records as Excel (`.xlsx`), PDF, or CSV files.

## Tests

```powershell
npm test
```

The integration test uses a temporary SQLite database and removes it when finished.
