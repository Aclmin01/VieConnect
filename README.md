# VieConnect — Anonymous Stranger Chat

**Real-time website-based chat app** for randomly connecting with strangers.

- Choose your gender and who you want to talk to (Male / Female / Anyone)
- Get matched randomly based on **mutual gender preference**
- Full Messenger-style chat experience
- "Next" and "Leave" buttons to find new people instantly
- Admin monitoring dashboard

**App name:** VieConnect

## How to Run (Ready for Immediate Use)

**Easiest way (Windows):**
1. Double-click `start.bat` in the `D:\VieConnect` folder.

**Manual way:**
1. Open PowerShell or terminal
2. Run:
   ```powershell
   cd D:\VieConnect
   npm install     # only needed the first time
   npm start
   ```
3. Open your browser and go to:
   ```
   http://localhost:3000
   ```

### Access from other devices (multiple networks)
- On another computer/phone on the **same Wi-Fi**, use your PC's local IP:
  - Find your IP (in PowerShell: `ipconfig`)
  - Example: `http://192.168.1.42:3000`
- For internet access from anywhere: use a tool like ngrok (`ngrok http 3000`)

The server uses **WebSocket private rooms**, so real-time chat works reliably across devices and networks.

**Admin dashboard** (for testing/monitoring):
- Visit `http://localhost:3000?admin`
- Password: `Hthh770716@@`

## Matching Mechanism (Clearly Defined)

### User Preferences
When a user joins, they send:
```js
{
  gender: 'male' | 'female',
  lookingFor: 'male' | 'female' | 'both',
  interests: string[]   // optional
}
```

### Server Matching Logic

The server keeps a **waiting pool**.

**Valid match between User A and User B** requires **mutual acceptance**:

- A accepts B's gender  
  → (A.lookingFor === 'both' || A.lookingFor === B.gender)
- B accepts A's gender  
  → (B.lookingFor === 'both' || B.lookingFor === A.gender)

Only when **both conditions** are true is a match created.

This prevents one-sided gender preference violations.

### Smart Matching (for higher quality conversations)
The server now selects the **best** compatible partner by combining:
- Interest overlap (higher = better vibe match)
- Fair wait time bonus (people waiting longer get priority)

You may see a "% vibe match" indicator when connected.

### Message Delivery
Messages use `socket.to(room)` for the other participant + direct emit to sender. Client also has message ID deduplication to prevent any accidental duplicates.

### Flow
1. User clicks "Find a Stranger"
2. Server checks waiting pool for compatible partner
3. If found → instantly creates private room + notifies both
4. If not found → user added to waiting pool
5. Messages are sent only inside private Socket.IO rooms (isolated)

### Leaving / Re-matching
- "Leave" button → ends current room + notifies partner
- "Next" button → ends room + immediately puts user back in queue with same preferences
- Disconnect → automatic cleanup

This mechanism works across **multiple networks** because all matching and messaging is handled server-side using **WebSockets (Socket.IO)**.

## Features Included

**Core**
- Gender + preference selection
- Real random matching (server-side)
- Private one-on-one chat rooms
- Typing indicators
- "Next" & "Leave" buttons
- Clean Messenger-style UI

**Interesting Extra Features**
- Optional interest tags (shown to partner)
- Smart matching: Interest overlap + wait-time priority for better vibe matches
- "X% vibe match" indicator on match
- Quick Icebreaker button (random conversation starters)
- Instant emoji reactions
- Soft message notification sound (no files needed)
- Anonymous generated usernames
- Live stats (people online, active chats)
- Report button + admin-visible safety reports
- Post-chat feedback prompt
- Smooth transitions, typing indicators, reconnect handling
- Safety messaging
- High-stability design (isolated rooms, cleanup, graceful disconnects)

**Admin Mode**
Access link: `http://localhost:3000?admin`

Password: `Hthh770716@@`

Admin dashboard shows:
- Live online / waiting / active chat counts
- List of people currently waiting
- List of active chats (with duration)
- Force-end any chat room
- Broadcast message to all connected users

## Stability & Reliability

- Proper disconnect + cleanup handling on server
- Stale waiting users automatically removed after 5 minutes
- All rooms are isolated (Socket.IO rooms)
- Client handles partner leaving gracefully
- Reconnection supported via Socket.IO
- No data stored after session ends

Target stability: **>= 95%** (server manages all state, clients are stateless)

## Multiple Networks / Scale Notes

- Works across different computers, phones, networks as long as they reach the server.
- For public internet use: run the server on a VPS or use ngrok / cloud deployment.
- Current implementation is great for dozens of concurrent users.

## Tech Stack (Simple & Stable)

- Backend: Node.js + Express + Socket.IO
- Frontend: Single HTML file (Tailwind + vanilla JS + Socket.IO client CDN)
- Zero database (in-memory state only)
- Easy to run locally

## Folder Structure

```
D:\VieConnect\
├── server.js          # Core server + matching logic
├── package.json
├── public/
│   └── index.html     # Full client UI
└── README.md
```

## Development / Testing Tips

- Open two browser tabs (or two different browsers) to simulate two users
- Use `http://localhost:3000?admin` for admin panel
- Open browser console and check `window.VieConnect`

## Future Enhancements (if needed)

- Video chat (WebRTC)
- Better interest-based matching algorithm
- Moderation queue
- Language filter

---

**VieConnect** — Real people. Real moments. Right now.
