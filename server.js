const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8765;

// ── Utilitaire UUID ───────────────────────────────────────────────────────────
function generateId(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ── État serveur ──────────────────────────────────────────────────────────────
const lobbies = {};

function broadcastLobby(code) {
  const lobby = lobbies[code];
  if (!lobby) return;
  for (const player of lobby.players) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({
        type: 'lobby_update',
        lobby: sanitizeLobby(lobby),
        myRole: player.role
      }));
    }
  }
}

function sanitizeLobby(lobby) {
  return {
    code: lobby.code,
    host: lobby.host,
    maxPlayers: lobby.maxPlayers,
    phase: lobby.phase,
    players: lobby.players.map(p => ({
      id: p.id,
      pseudo: p.pseudo,
      ready: p.ready,
      isHost: p.id === lobby.host,
      team: p.team,
      disconnected: p.disconnected || false
    })),
    votes: lobby.phase === 'vote' ? lobby.votes : undefined,
    result: lobby.result,
    scores: lobby.scores || {},
    matchCount: lobby.matchCount || 0
  };
}

function assignRoles(lobby) {
  const players = [...lobby.players];
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  if (lobby.maxPlayers === 10) {
    const team1 = players.slice(0, 5);
    const team2 = players.slice(5, 10);
    team1.forEach((p, i) => { p.role = i === 0 ? 'inter' : 'tryhardeur'; p.team = 1; });
    team2.forEach((p, i) => { p.role = i === 0 ? 'inter' : 'tryhardeur'; p.team = 2; });
  } else {
    players[0].role = 'inter';
    players.slice(1).forEach(p => { p.role = 'tryhardeur'; p.team = 1; });
    players[0].team = 1;
  }
}

// ── Serveur HTTP + WebSocket ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Health check pour Railway
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Who Int Us — Server OK');
});

const wsServer = new WebSocket.Server({ server: httpServer });

wsServer.on('connection', (ws) => {
  ws.playerId = generateId(8);
  ws.lobbyCode = null;

  // Ping/pong pour garder la connexion vivante
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_lobby': {
        const code = generateId(6);
        const maxPlayers = msg.maxPlayers === 10 ? 10 : 5;
        lobbies[code] = {
          code, host: ws.playerId, maxPlayers,
          phase: 'waiting',
          players: [], votes: {}, result: null,
          scores: {}, matchCount: 0, teamResults: {}
        };
        const player = { id: ws.playerId, pseudo: msg.pseudo, ready: false, role: null, ws, team: null };
        lobbies[code].players.push(player);
        ws.lobbyCode = code;
        ws.send(JSON.stringify({ type: 'created', code, playerId: ws.playerId }));
        broadcastLobby(code);
        break;
      }

      case 'join_lobby': {
        const lobby = lobbies[msg.code];
        if (!lobby) { ws.send(JSON.stringify({ type: 'error', msg: 'Lobby introuvable.' })); return; }
        if (lobby.players.length >= lobby.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Lobby complet.' })); return; }
        if (lobby.phase !== 'waiting') { ws.send(JSON.stringify({ type: 'error', msg: 'Partie déjà commencée.' })); return; }
        const player = { id: ws.playerId, pseudo: msg.pseudo, ready: false, role: null, ws, team: null };
        lobby.players.push(player);
        ws.lobbyCode = msg.code;
        ws.send(JSON.stringify({ type: 'joined', code: msg.code, playerId: ws.playerId }));
        broadcastLobby(msg.code);
        break;
      }

      case 'rejoin_lobby': {
        const lobby = lobbies[msg.code];
        if (!lobby) {
          ws.send(JSON.stringify({ type: 'error', code: 'LOBBY_NOT_FOUND', msg: 'Lobby introuvable.' }));
          return;
        }
        const player = lobby.players.find(p => p.id === msg.playerId);
        if (!player) {
          ws.send(JSON.stringify({ type: 'error', code: 'PLAYER_NOT_FOUND', msg: 'Joueur introuvable dans ce lobby.' }));
          return;
        }
        // Annuler le timer de suppression
        if (player._reconnectTimer) {
          clearTimeout(player._reconnectTimer);
          player._reconnectTimer = null;
        }
        // Rattacher la nouvelle socket au joueur existant
        player.ws = ws;
        player.disconnected = false;
        ws.playerId = msg.playerId;
        ws.lobbyCode = msg.code;
        broadcastLobby(msg.code);
        break;
      }

      case 'set_ready': {
        const lobby = lobbies[ws.lobbyCode];
        if (!lobby) return;
        const p = lobby.players.find(x => x.id === ws.playerId);
        if (p) p.ready = msg.ready;
        broadcastLobby(ws.lobbyCode);
        break;
      }

      case 'start_game': {
        const lobby = lobbies[ws.lobbyCode];
        if (!lobby || lobby.host !== ws.playerId) return;
        if (lobby.players.length !== lobby.maxPlayers) {
          ws.send(JSON.stringify({ type: 'error', msg: `Il faut ${lobby.maxPlayers} joueurs.` }));
          return;
        }
        assignRoles(lobby);
        lobby.phase = 'started';
        broadcastLobby(ws.lobbyCode);
        break;
      }

      case 'end_game': {
        const lobby = lobbies[ws.lobbyCode];
        if (!lobby || lobby.host !== ws.playerId) return;
        lobby.phase = 'vote';
        lobby.votes = {};
        lobby.teamResults = {};
        lobby.players.forEach(p => {
          if (lobby.maxPlayers === 10) {
            lobby.teamResults[p.id] = p.team === 1 ? msg.teamWon : (msg.teamWon2 !== undefined ? msg.teamWon2 : !msg.teamWon);
          } else {
            lobby.teamResults[p.id] = msg.teamWon;
          }
        });
        broadcastLobby(ws.lobbyCode);
        break;
      }

      case 'vote': {
        const lobby = lobbies[ws.lobbyCode];
        if (!lobby || lobby.phase !== 'vote') return;
        lobby.votes[ws.playerId] = msg.targetId;
        if (Object.keys(lobby.votes).length === lobby.players.length) {
          const count = {};
          for (const v of Object.values(lobby.votes)) count[v] = (count[v] || 0) + 1;
          const inters = lobby.players.filter(p => p.role === 'inter').map(p => p.id);
          const majority = Math.floor(lobby.players.length / 2) + 1;
          let interFound = false;
          for (const interId of inters) {
            if ((count[interId] || 0) >= majority) { interFound = true; break; }
          }
          lobby.matchCount = (lobby.matchCount || 0) + 1;

          const roundScores = {};
          lobby.players.forEach(p => {
            const isInter = p.role === 'inter';
            const myTeamWon = lobby.teamResults ? lobby.teamResults[p.id] : undefined;
            let pts = 0;
            const gains = [];
            if (isInter) {
              const interMadeTeamLose = myTeamWon === false;
              const interHidden = !interFound;
              if (interMadeTeamLose) { pts += 3; gains.push({ label: 'Équipe a perdu ✓', pts: 3 }); }
              if (interHidden)       { pts += 2; gains.push({ label: 'Non découvert ✓', pts: 2 }); }
              if (!interMadeTeamLose && !interHidden) gains.push({ label: 'Aucun objectif rempli', pts: 0 });
            } else {
              const teamWon = myTeamWon === true;
              const goodVote = inters.some(id => id === lobby.votes[p.id]);
              if (teamWon)  { pts += 2; gains.push({ label: 'Victoire LoL ✓', pts: 2 }); }
              if (goodVote) { pts += 1; gains.push({ label: 'Inter identifié ✓', pts: 1 }); }
              if (teamWon && goodVote) { pts += 1; gains.push({ label: 'Bonus double ✓', pts: 1 }); }
            }
            roundScores[p.id] = { pts, gains, role: p.role };
            if (!lobby.scores[p.id]) lobby.scores[p.id] = { pseudo: p.pseudo, total: 0, history: [] };
            lobby.scores[p.id].total += pts;
            lobby.scores[p.id].history.push({ match: lobby.matchCount, pts, role: p.role, gains });
          });

          lobby.phase = 'ended';
          lobby.result = {
            interFound,
            inters: inters.map(id => lobby.players.find(p => p.id === id)?.pseudo),
            votes: lobby.votes,
            voteCount: count,
            roundScores,
            matchCount: lobby.matchCount
          };
        }
        broadcastLobby(ws.lobbyCode);
        break;
      }

      case 'restart': {
        const lobby = lobbies[ws.lobbyCode];
        if (!lobby || lobby.host !== ws.playerId) return;
        lobby.phase = 'waiting';
        lobby.votes = {};
        lobby.result = null;
        lobby.teamResults = {};
        if (msg.resetScores) { lobby.scores = {}; lobby.matchCount = 0; }
        lobby.players.forEach(p => { p.ready = false; p.role = null; p.team = null; });
        broadcastLobby(ws.lobbyCode);
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws.lobbyCode;
    if (!code || !lobbies[code]) return;
    const lobby = lobbies[code];
    const player = lobby.players.find(p => p.id === ws.playerId);
    if (!player) return;

    // On marque le joueur comme déconnecté sans le supprimer tout de suite.
    // Il a 10 secondes pour se reconnecter via rejoin_lobby.
    player.disconnected = true;
    player.ws = null;

    player._reconnectTimer = setTimeout(() => {
      // Toujours déconnecté après le délai → on le retire pour de bon
      if (!lobbies[code]) return;
      lobby.players = lobby.players.filter(p => p.id !== ws.playerId);
      if (lobby.players.length === 0) {
        delete lobbies[code];
      } else {
        if (lobby.host === ws.playerId) {
          lobby.host = lobby.players[0].id;
        }
        broadcastLobby(code);
      }
    }, 30000);

    // On broadcast quand même pour signaler la déco temporaire aux autres
    broadcastLobby(code);
  });
});

// Ping toutes les 30s pour garder les connexions vivantes
const interval = setInterval(() => {
  wsServer.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wsServer.on('close', () => clearInterval(interval));

httpServer.listen(PORT, () => {
  console.log(`Who Int Us server running on port ${PORT}`);
});
