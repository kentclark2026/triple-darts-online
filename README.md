# 🎯 TRIPLE DARTS

**A playable 3D darts game for exactly 3 people.** One friend hosts, sends a game link or 5-character code, and the other two join on their own phones or computers. Scores and turns synchronize in real time.

## What's included

- A fixed-orientation, accurately numbered 3D dartboard, so aiming is consistent.
- Responsive design for phones, laptops, and tablets.
- Private 3-player rooms with invite links and room codes.
- Live throws, dart animations, host controls, and player scoreboards.
- 301-point matches: each player gets up to 3 darts per turn, the first to hit exactly zero wins. Going below zero is a bust (the score returns to what it was at the start of that turn). **No double-out requirement** in this beginner-friendly version.
- Accuracy is best with **78% throwing power**; aiming and a little randomness influence the result.
- Player session recovery after a brief network disconnect. Host can skip a disconnected player's turn.
- Rematches after someone wins.

## Run locally on a computer

1. Install **Node.js 18 or newer** from https://nodejs.org/ if not already installed.
2. Unzip or download this project folder, then open a terminal inside the `triple-darts` folder.
3. Run:
   ```bash
   npm install
   npm start
   ```
4. Open **http://localhost:3000** in your browser.

The 3D view downloads the Three.js module and Google Fonts from their CDNs, so an internet connection is needed for the graphics on first use.

### How to play

1. Enter your name, then click **Host a new game**.
2. Click **Copy invite link** and send the link to your other **2 friends**. (If you are running only on localhost, the link will work only on your own computer. Deploy the project online to invite people on other devices.)
3. Each friend enters their name and clicks **Join Room**.
4. When all 3 appear online, the host clicks **Start the match**.
5. On your turn, **tap or drag on the 3D board to aim**, then **press and release** the throw button. Hold to adjust the power. You can also hold and release **Space** on a keyboard.
6. The first player to reach **exactly 0** wins.

## Put it online so you can invite anyone

To generate working invite links for friends in different locations, the server must run on a public URL. One approach is **Render**, using a Node web service:

1. Create a free GitHub account at https://github.com/ (or use an account you already have).
2. Create a new repository and upload **all these project files**, keeping the `public` folder inside it. Do not upload the `node_modules` folder.
3. Sign into https://render.com/ and create a **Web Service** linked to that repository.
4. Use **Node** for the runtime, **`npm install`** for the build command, and **`npm start`** for the start command. Render provides the `PORT` environment variable automatically.
5. After the service deploys, open its public **https://...onrender.com** URL. Host a game, then share the game's invite link with two friends.

**Important:** Free hosting plans may sleep after inactivity or have limitations. This project stores game rooms in server memory, so rooms reset if the server restarts. For a permanent large-scale release, add a database (for persistent game state), authentication, rate limits, and multiple-instance coordination.

## Project structure

```
triple-darts/
  package.json           Node dependencies and scripts
  server.js              Express + Socket.IO multiplayer server and rooms
  scoring.js             Dartboard scoring rules
  public/index.html      Main game and interface
  public/styles.css      Responsive visual style
  public/game.js         Three.js 3D dartboard, aiming, flight animations, UI
  test/scoring.test.js   Automated tests for scoring
```

## Credits / libraries

Created as a custom starter game. Uses Express, Socket.IO and Three.js (loaded via the jsDelivr CDN). Game graphic elements are generated procedurally in code, not copied from GamePigeon.
