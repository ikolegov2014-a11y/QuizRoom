const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// State
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function getRoom(code) {
  return rooms[code];
}

io.on('connection', (socket) => {

  // Host creates a room
  socket.on('create_room', ({ quiz, hostName }, cb) => {
    const code = generateCode();
    rooms[code] = {
      code,
      host: socket.id,
      hostName,
      quiz,
      players: {},
      state: 'lobby',   // lobby | question | answer | results
      currentQ: 0,
      timer: null,
      answers: {},      // questionIndex -> { socketId: { answer, time } }
    };
    socket.join(code);
    rooms[code].players[socket.id] = { name: hostName, score: 0, isHost: true };
    cb({ code });
    io.to(code).emit('room_update', sanitizeRoom(rooms[code]));
  });

  // Player joins a room
  socket.on('join_room', ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ error: 'Комната не найдена' });
    if (room.state !== 'lobby') return cb({ error: 'Игра уже началась' });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;
    room.players[socket.id] = { name, score: 0, isHost: false };
    cb({ ok: true, quiz: { title: room.quiz.title, questionCount: room.quiz.questions.length } });
    io.to(code).emit('room_update', sanitizeRoom(room));
  });

  // Host starts game
  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.state = 'question';
    room.currentQ = 0;
    room.answers = {};
    sendQuestion(room);
  });

  // Player submits answer
  socket.on('submit_answer', ({ code, answer }) => {
    const room = getRoom(code);
    if (!room || room.state !== 'question') return;
    const qi = room.currentQ;
    if (!room.answers[qi]) room.answers[qi] = {};
    if (room.answers[qi][socket.id]) return; // already answered
    room.answers[qi][socket.id] = { answer, time: Date.now() };

    // Check if all non-host players answered
    const playerIds = Object.keys(room.players).filter(id => !room.players[id].isHost);
    const answered = Object.keys(room.answers[qi]).length;
    io.to(code).emit('answer_count', { answered, total: playerIds.length });

    if (answered >= playerIds.length) {
      revealAnswer(room);
    }
  });

  // Host advances to next question
  socket.on('next_question', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    room.currentQ++;
    if (room.currentQ >= room.quiz.questions.length) {
      endGame(room);
    } else {
      sendQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    // Remove player from all rooms they were in
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.host === socket.id) {
          io.to(code).emit('host_left');
          clearInterval(room.timer);
          delete rooms[code];
        } else {
          io.to(code).emit('room_update', sanitizeRoom(room));
        }
      }
    }
  });
});

function sendQuestion(room) {
  const q = room.quiz.questions[room.currentQ];
  room.state = 'question';
  const timeLimit = room.quiz.timeLimit || 30;
  room.questionStartTime = Date.now();

  io.to(room.code).emit('question', {
    index: room.currentQ,
    total: room.quiz.questions.length,
    text: q.text,
    options: q.options,
    timeLimit,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => revealAnswer(room), timeLimit * 1000);
}

function revealAnswer(room) {
  clearTimeout(room.timer);
  if (room.state !== 'question') return;
  room.state = 'answer';

  const qi = room.currentQ;
  const q = room.quiz.questions[qi];
  const timeLimit = (room.quiz.timeLimit || 30) * 1000;

  // Score players
  const answerMap = room.answers[qi] || {};
  for (const [sid, { answer, time }] of Object.entries(answerMap)) {
    if (answer === q.correct) {
      const elapsed = time - room.questionStartTime;
      const speedBonus = Math.max(0, Math.floor((1 - elapsed / timeLimit) * 500));
      room.players[sid].score += 500 + speedBonus;
    }
  }

  // Build per-player result
  const playerResults = {};
  for (const sid of Object.keys(room.players)) {
    const given = answerMap[sid];
    playerResults[sid] = {
      answer: given ? given.answer : null,
      correct: given ? given.answer === q.correct : false,
    };
  }

  io.to(room.code).emit('answer_reveal', {
    correctAnswer: q.correct,
    explanation: q.explanation || null,
    playerResults,
    scores: getScores(room),
  });
}

function endGame(room) {
  room.state = 'results';
  io.to(room.code).emit('game_over', { scores: getScores(room) });
}

function getScores(room) {
  return Object.entries(room.players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score, isHost: p.isHost }))
    .sort((a, b) => b.score - a.score);
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    state: room.state,
    players: Object.values(room.players),
    quizTitle: room.quiz.title,
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`QuizRoom server running on http://localhost:${PORT}`));
