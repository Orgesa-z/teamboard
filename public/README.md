# Teamboard

A real-time collaborative task board. Create an account, add notes, drag them between columns, and watch changes appear instantly for everyone who is online.

**Live demo:** https://teamboard-tlw7.onrender.com
(The free hosting plan sleeps when idle, so the first load can take about 50 seconds.)

![Teamboard screenshot](Screenshot 2026-11-18 081935)

## Features
- Sign up and log in with a username and password
- Add, move (drag and drop) and delete notes
- Live updates for all connected users with WebSockets
- See who is online
- Permissions: you can only delete your own notes
- Data is stored in PostgreSQL, so it survives server restarts

## Tech stack
- **Backend:** Node.js, Express, Socket.io
- **Database:** PostgreSQL (Neon)
- **Auth:** bcrypt password hashing, JSON Web Tokens
- **Frontend:** vanilla JavaScript, HTML, CSS
- **Hosting:** Render

## How it works
- The browser logs in over a REST API (`/api/signup`, `/api/login`) and receives a JWT.
- That token is sent when the WebSocket connects. The server rejects connections without a valid token.
- When someone adds, moves or deletes a note, the server updates the database and broadcasts the new board to every client.
- The server checks permissions itself. Hiding the delete button in the UI is only cosmetic.

## Database
- `users` (id, username, hash, created_at)
- `cards` (id, text, col, author_id → users.id, created_at)

## Run locally
1. Create a free PostgreSQL database (for example on neon.tech).
2. Create a `.env` file in the project folder:
   ```
   DATABASE_URL="your-connection-string"
   JWT_SECRET="any-long-random-text"
   ```
3. Install and start:
   ```
   npm install
   npm start
   ```
4. Open http://localhost:3000