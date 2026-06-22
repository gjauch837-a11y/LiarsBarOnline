const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------
// Spiellogik (portiert aus Java)
// -----------------------------------------------------------------------

function randomInt(max) { return Math.floor(Math.random() * max); }

function kartenErstellen() {
  const stapel = [];
  for (let i = 0; i < 6; i++) stapel.push({ modi: 0 }); // Queen
  for (let i = 0; i < 6; i++) stapel.push({ modi: 1 }); // King
  for (let i = 0; i < 6; i++) stapel.push({ modi: 2 }); // Ace
  // Fisher-Yates shuffle
  for (let i = stapel.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [stapel[i], stapel[j]] = [stapel[j], stapel[i]];
  }
  return stapel;
}

function verteilen5(stapel) {
  const hands = [[], [], []];
  for (let i = 0; i < 5; i++) {
    hands[0].push(stapel.shift());
    hands[1].push(stapel.shift());
    hands[2].push(stapel.shift());
  }
  return hands;
}

function neuesFigur() {
  return { leben: true, anzahlLeben: randomInt(6) + 1 };
}

function schiessenVersuch(figur) {
  if (figur.anzahlLeben <= 0 || !figur.leben) return false;
  const gestorben = randomInt(figur.anzahlLeben) === 0;
  if (gestorben) {
    figur.anzahlLeben = 0;
    figur.leben = false;
  } else {
    if (figur.anzahlLeben > 1) figur.anzahlLeben--;
  }
  return gestorben;
}

function naechsterSpieler(figuren, aktueller) {
  const n = figuren.length;
  let next = (aktueller + 1) % n;
  while (!figuren[next].leben) {
    next = (next + 1) % n;
    if (next === aktueller) break;
  }
  return next;
}

function spielEnde(figuren) {
  let lebende = 0, gewinner = -1;
  for (let i = 0; i < figuren.length; i++) {
    if (figuren[i].leben) { lebende++; gewinner = i; }
  }
  return lebende === 1 ? gewinner : -1;
}

function neueRundeVerteilen(gs) {
  const stapel = kartenErstellen();
  gs.tische = [[], [], []];
  for (let i = 0; i < 3; i++) {
    if (gs.figuren[i].leben) {
      gs.haende[i] = [];
      for (let j = 0; j < 5; j++) gs.haende[i].push(stapel.shift());
    }
  }
  gs.kartenVomVorigen   = [];
  gs.kartenVomAktuellen = [];
  gs.werHatGeworfen     = -1;
  gs.spielModi          = randomInt(3);
}

// -----------------------------------------------------------------------
// Lobby-Verwaltung
// -----------------------------------------------------------------------

const lobbies = new Map(); // code -> lobby

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join(''); }
  while (lobbies.has(code));
  return code;
}

function lobbyPublic(lobby) {
  return {
    code: lobby.code,
    players: lobby.players.map(p => ({ playerIndex: p.playerIndex, ready: p.ready })),
    gameStarted: lobby.gameStarted,
  };
}

function gameStateForPlayer(lobby, playerIndex) {
  const gs = lobby.game;
  if (!gs) return null;
  return {
    currentPlayer:     gs.currentPlayer,
    spielModi:         gs.spielModi,
    figuren:           gs.figuren.map(f => ({ leben: f.leben, anzahlLeben: f.anzahlLeben })),
    haende:            gs.haende.map((h, i) => i === playerIndex ? h : h.map(() => ({ hidden: true }))),
    hatGehandelt:      gs.hatGehandelt,
    kartenVomVorigen:       gs.kartenVomVorigen.length > 0,
    anzahlVomVorigen:       gs.kartenVomVorigen.length,
    werHatGeworfen:         gs.werHatGeworfen,
    anzahlGeworfen:         gs.kartenVomAktuellen.length,
    modusWechselAnstehend: gs.modusWechselAnstehend,
    starteteOhneKarten: gs.starteteOhneKarten,
    phase:      gs.phase,
    betroffener: gs.betroffener ?? -1,
    gewinner: gs.gewinner,
    liarCards: gs.phase === 'liarReveal' ? gs.kartenVomVorigen : [],
  };
}

function startGame(lobby) {
  const stapel = kartenErstellen();
  lobby.gameStarted = true;
  lobby.game = {
    figuren:            [neuesFigur(), neuesFigur(), neuesFigur()],
    haende:             [[], [], []],
    tische:             [[], [], []],
    currentPlayer:      0,
    spielModi:          randomInt(3),
    kartenVomVorigen:   [],
    kartenVomAktuellen: [],
    werHatGeworfen:     -1,
    hatGehandelt:       false,
    starteteOhneKarten: false,
    modusWechselAnstehend: false,
    phase:              'play',
    gewinner:           -1,
  };
  for (let i = 0; i < 5; i++) {
    lobby.game.haende[0].push(stapel.shift());
    lobby.game.haende[1].push(stapel.shift());
    lobby.game.haende[2].push(stapel.shift());
  }
  broadcastGameState(lobby);
}

function broadcastGameState(lobby) {
  for (const p of lobby.players) {
    const socket = io.sockets.sockets.get(p.id);
    if (socket) socket.emit('gameState', gameStateForPlayer(lobby, p.playerIndex));
  }
}

function broadcastLobby(lobby) {
  for (const p of lobby.players) {
    io.to(p.id).emit('lobbyState', lobbyPublic(lobby));
  }
}

// -----------------------------------------------------------------------
// Socket.io Events
// -----------------------------------------------------------------------

io.on('connection', (socket) => {

  socket.on('createLobby', () => {
    const code = generateCode();
    const lobby = {
      code,
      players: [{ id: socket.id, playerIndex: 0, ready: false }],
      gameStarted: false,
      game: null,
    };
    lobbies.set(code, lobby);
    socket.data.lobbyCode    = code;
    socket.data.playerIndex  = 0;
    socket.join(code);
    socket.emit('lobbyCreated', { code });
    socket.emit('lobbyState', lobbyPublic(lobby));
  });

  socket.on('joinLobby', ({ code }) => {
    const lobby = lobbies.get(code);
    if (!lobby) { socket.emit('error', 'Lobby nicht gefunden.'); return; }
    if (lobby.gameStarted) { socket.emit('error', 'Spiel läuft bereits.'); return; }
    if (lobby.players.length >= 3) { socket.emit('error', 'Lobby ist voll.'); return; }

    const playerIndex = lobby.players.length; // 1 or 2
    lobby.players.push({ id: socket.id, playerIndex, ready: false });
    socket.data.lobbyCode   = code;
    socket.data.playerIndex = playerIndex;
    socket.join(code);
    socket.emit('joinedLobby', { code, playerIndex });
    broadcastLobby(lobby);
  });

  socket.on('setReady', () => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || lobby.gameStarted) return;
    const p = lobby.players.find(p => p.id === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastLobby(lobby);
    // Starte Spiel wenn alle 3 Spieler da und ready sind
    if (lobby.players.length === 3 && lobby.players.every(p => p.ready)) {
      // Auf 3 Spieler warten ODER sofort wenn alle ready (mind. 2)
      setTimeout(() => startGame(lobby), 500);
    }
  });

  socket.on('throwCards', ({ selectedIndices }) => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || !lobby.game) return;
    const gs = lobby.game;
    const pi = socket.data.playerIndex;
    if (gs.currentPlayer !== pi) return;
    if (gs.hatGehandelt) return;
    if (!selectedIndices || selectedIndices.length === 0) return;

    const hand = gs.haende[pi];
    const zuWerfen = selectedIndices
      .filter(i => i >= 0 && i < hand.length)
      .map(i => hand[i]);
    if (zuWerfen.length === 0) return;

    // Von Hand entfernen (rückwärts um Indizes stabil zu halten)
    const sorted = [...selectedIndices].sort((a, b) => b - a);
    for (const i of sorted) hand.splice(i, 1);
    for (const k of zuWerfen) gs.tische[pi].push(k);

    gs.kartenVomAktuellen = zuWerfen;
    gs.hatGehandelt       = true;
    broadcastGameState(lobby);
  });

  socket.on('liarCall', () => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || !lobby.game) return;
    const gs = lobby.game;
    const pi = socket.data.playerIndex;
    if (gs.currentPlayer !== pi) return;
    if (gs.kartenVomVorigen.length === 0) return;
    if (gs.hatGehandelt) return;

    gs.hatGehandelt = true;
    gs.phase        = 'liarReveal';
    broadcastGameState(lobby); // zeigt liarCards für 2 Sek auf allen Screens

    setTimeout(() => {
      // pruefe ob alle geworfenen Karten zum Modus passen
      const pruefe        = gs.kartenVomVorigen.every(k => k.modi === gs.spielModi);
      const beschuldigter = gs.werHatGeworfen;
      const betroffener   = pruefe ? pi : beschuldigter;

      gs.phase       = 'shooting';
      gs.betroffener = betroffener;
      broadcastGameState(lobby);

      setTimeout(() => {
        const gestorben = schiessenVersuch(gs.figuren[betroffener]);
        io.to(lobby.code).emit('schussSound', { gestorben });
        gs.phase = 'play';

        if (gestorben) {
          const gewinner = spielEnde(gs.figuren);
          if (gewinner !== -1) {
            gs.phase   = 'end';
            gs.gewinner = gewinner;
            broadcastGameState(lobby);
            // Reset nach 3 Sek
            setTimeout(() => {
              lobby.gameStarted = false;
              lobby.game        = null;
              lobby.players.forEach(p => p.ready = false);
              broadcastLobby(lobby);
            }, 3000);
            return;
          }
          // Neue Runde starten
          neueRundeVerteilen(gs);
          if (pruefe) {
            // Falscher Liar: Aktueller Spieler starb → nächsten Spieler finden
            gs.kartenVomVorigen   = [];
            gs.kartenVomAktuellen = [];
            gs.werHatGeworfen     = -1;
            gs.hatGehandelt       = false;
            gs.currentPlayer      = naechsterSpieler(gs.figuren, pi);
          } else {
            // Richtiger Liar: Beschuldigter starb → aktueller Spieler bleibt
            gs.hatGehandelt = false;
          }
        } else {
          // Überlebt → neuen Modus, nächsten Spieler
          neueRundeVerteilen(gs);
          gs.hatGehandelt       = false;
          gs.currentPlayer      = naechsterSpieler(gs.figuren, pi);
        }
        broadcastGameState(lobby);
      }, 1500);
    }, 2000);
  });

  socket.on('nextPlayer', () => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby || !lobby.game) return;
    const gs = lobby.game;
    const pi = socket.data.playerIndex;
    if (gs.currentPlayer !== pi) return;
    if (!gs.hatGehandelt) return;

    gs.kartenVomVorigen   = gs.kartenVomAktuellen;
    gs.kartenVomAktuellen = [];
    gs.werHatGeworfen     = pi;
    gs.hatGehandelt       = false;
    gs.currentPlayer      = naechsterSpieler(gs.figuren, pi);

    // Wenn alle Karten weg: neue Runde
    const alleKartenWeg = gs.haende.every((h, i) => !gs.figuren[i].leben || h.length === 0);
    if (alleKartenWeg) {
      gs.spielModi = randomInt(3);
      const stapel = kartenErstellen();
      gs.tische    = [[], [], []];
      for (let i = 0; i < 3; i++) {
        if (gs.figuren[i].leben) {
          gs.haende[i] = [];
          for (let j = 0; j < 5; j++) gs.haende[i].push(stapel.shift());
        }
      }
      gs.kartenVomVorigen   = [];
      gs.kartenVomAktuellen = [];
      gs.werHatGeworfen     = -1;
    }

    broadcastGameState(lobby);
  });

  socket.on('abortGame', () => {
    const lobby = lobbies.get(socket.data.lobbyCode);
    if (!lobby) return;
    io.to(lobby.code).emit('gameAborted');
    lobbies.delete(lobby.code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;
    lobby.players = lobby.players.filter(p => p.id !== socket.id);
    if (lobby.players.length === 0) {
      lobbies.delete(code);
    } else {
      if (lobby.gameStarted) {
        // Spieler als tot markieren
        const pi = socket.data.playerIndex;
        if (lobby.game && pi !== undefined) {
          lobby.game.figuren[pi].leben       = false;
          lobby.game.figuren[pi].anzahlLeben = 0;
          const gew = spielEnde(lobby.game.figuren);
          if (gew !== -1) {
            lobby.game.phase   = 'end';
            lobby.game.gewinner = gew;
          }
          broadcastGameState(lobby);
        }
      } else {
        broadcastLobby(lobby);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`LiarsBar Online läuft auf Port ${PORT}`));
