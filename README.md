# Ludo Rooms

Multiplayer Ludo for 2-4 friends. Everyone opens the same link on their own phone; no sign-in needed.

## Run on your computer
    npm install
    npm start
Open http://localhost:3000

## Put it online (free) with Render
1. Create a free account at github.com and make a new repository. Upload everything in this folder (server.js, package.json, the public folder).
2. Create a free account at render.com. Choose New > Web Service and connect that repository.
3. Settings: Runtime Node, Build Command `npm install`, Start Command `npm start`, Instance type Free.
4. When the deploy finishes, Render gives you a link like https://ludo-rooms.onrender.com. Send it to your friends.
5. On each iPhone: open the link in Safari, tap Share, then Add to Home Screen.

## Good to know
- Free Render services sleep after about 15 minutes without visitors. The first person to open the link may wait ~50 seconds. Open it a minute before game time.
- Rooms live in the server memory, so a restart or redeploy clears them.
- If someone's phone locks or loses signal, they rejoin automatically with the same seat.

## How it works
- server.js holds the rules, the board state and the dice. Phones only send: create, join, start, roll, move.
- public/index.html draws the board and sends taps.
