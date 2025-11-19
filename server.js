const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Инициализация SQLite базы данных
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Создание таблиц
db.serialize(() => {
  // Таблица для рисунков и текстов
  db.run(`
    CREATE TABLE IF NOT EXISTS drawings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('Error creating drawings table:', err);
    } else {
      console.log('Drawings table ready');
    }
  });

  // Таблица для пользовательских сессий (опционально)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      socket_id TEXT,
      connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('Error creating user_sessions table:', err);
    } else {
      console.log('User sessions table ready');
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Маршруты
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/main.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// Сохранение элемента в БД
app.post('/api/save', (req, res) => {
  const { type, data, userId } = req.body;
  
  db.run(
    'INSERT INTO drawings (type, data, user_id) VALUES (?, ?, ?)',
    [type, JSON.stringify(data), userId],
    function(err) {
      if (err) {
        console.error('Save error:', err);
        res.status(500).json({ success: false, error: err.message });
      } else {
        res.json({ success: true, id: this.lastID });
      }
    }
  );
});

// Получение всех элементов
app.get('/api/drawings', (req, res) => {
  db.all('SELECT * FROM drawings ORDER BY created_at ASC', (err, rows) => {
    if (err) {
      console.error('Fetch error:', err);
      res.status(500).json({ error: err.message });
    } else {
      const drawings = rows.map(row => ({
        ...row,
        data: JSON.parse(row.data)
      }));
      res.json(drawings);
    }
  });
});

// Очистка всех элементов (только для админа)
app.delete('/api/clear', (req, res) => {
  const { userId, role } = req.body;
  
  if (role !== 'Администратор') {
    return res.status(403).json({ success: false, error: 'Только учитель может очистить доску' });
  }

  db.run('DELETE FROM drawings', (err) => {
    if (err) {
      console.error('Clear error:', err);
      res.status(500).json({ success: false, error: err.message });
    } else {
      res.json({ success: true });
    }
  });
});

// Удаление конкретного элемента
app.delete('/api/drawing/:id', (req, res) => {
  const { id } = req.params;
  const { userId, role, owner } = req.body;

  // Проверка прав: админ или владелец
  if (role !== 'Администратор' && userId !== owner) {
    return res.status(403).json({ success: false, error: 'Нет прав для удаления' });
  }

  db.run('DELETE FROM drawings WHERE id = ?', [id], (err) => {
    if (err) {
      console.error('Delete error:', err);
      res.status(500).json({ success: false, error: err.message });
    } else {
      res.json({ success: true });
    }
  });
});

// Получение информации о подключенных пользователях
app.get('/api/users', (req, res) => {
  db.all('SELECT username, role, connected_at FROM user_sessions ORDER BY connected_at DESC', (err, rows) => {
    if (err) {
      console.error('Users fetch error:', err);
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

// Real-time синхронизация через Socket.io
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Обработка подключения пользователя
  socket.on('user_join', (userData) => {
    socket.userData = userData;
    socket.userData.socketId = socket.id;
    
    console.log(`User ${userData.username} (${userData.role}) joined`);

    // Сохраняем информацию о пользователе в БД
    db.run(
      'INSERT INTO user_sessions (username, role, socket_id) VALUES (?, ?, ?)',
      [userData.username, userData.role, socket.id],
      (err) => {
        if (err) console.error('Error saving user session:', err);
      }
    );

    // Оповещаем всех о новом пользователе
    socket.broadcast.emit('user_joined', {
      username: userData.username,
      role: userData.role,
      message: `${userData.username} присоединился к доске`,
      timestamp: new Date().toISOString()
    });

    // Отправляем текущий список пользователей
    updateOnlineUsers();
  });

  // Обработка рисования
  socket.on('drawing', (data) => {
    if (!socket.userData) return;

    const drawingData = {
      ...data,
      timestamp: new Date().toISOString(),
      userId: socket.userData.username
    };

    // Сохраняем в БД
    db.run(
      'INSERT INTO drawings (type, data, user_id) VALUES (?, ?, ?)',
      ['drawing', JSON.stringify(drawingData), socket.userData.username],
      (err) => {
        if (err) console.error('DB save error:', err);
      }
    );
    
    // Отправляем рисунок всем другим пользователям
    socket.broadcast.emit('drawing', drawingData);
  });

  // Обработка создания текста
  socket.on('text', (data) => {
    if (!socket.userData) return;

    const textData = {
      ...data,
      timestamp: new Date().toISOString(),
      userId: socket.userData.username
    };

    // Сохраняем в БД
    db.run(
      'INSERT INTO drawings (type, data, user_id) VALUES (?, ?, ?)',
      ['text', JSON.stringify(textData), socket.userData.username],
      (err) => {
        if (err) console.error('DB save error:', err);
      }
    );
    
    // Отправляем текст всем другим пользователям
    socket.broadcast.emit('text', textData);
  });

  // Обработка обновления текста
  socket.on('textUpdate', (data) => {
    if (!socket.userData) return;

    // Проверяем права на редактирование
    const canEdit = socket.userData.role === 'Администратор' || 
                   socket.userData.username === data.owner;

    if (!canEdit) {
      console.log(`User ${socket.userData.username} tried to edit text without permission`);
      return;
    }

    const updateData = {
      ...data,
      timestamp: new Date().toISOString(),
      userId: socket.userData.username
    };

    // Обновляем текст в БД
    db.run(
      'UPDATE drawings SET data = ? WHERE id = ?',
      [JSON.stringify(updateData), data.id],
      (err) => {
        if (err) console.error('DB update error:', err);
      }
    );
    
    // Отправляем обновление всем пользователям
    socket.broadcast.emit('textUpdate', updateData);
  });

  // Обработка перемещения/изменения размера текста
  socket.on('textMove', (data) => {
    if (!socket.userData) return;

    // Проверяем права на перемещение
    const canMove = socket.userData.role === 'Администратор' || 
                   socket.userData.username === data.owner;

    if (!canMove) {
      console.log(`User ${socket.userData.username} tried to move text without permission`);
      return;
    }

    const moveData = {
      ...data,
      timestamp: new Date().toISOString(),
      userId: socket.userData.username
    };

    // Сохраняем новое положение текста в БД
    db.run(
      'UPDATE drawings SET data = ? WHERE id = ?',
      [JSON.stringify(moveData), data.id],
      (err) => {
        if (err) console.error('DB update error:', err);
      }
    );
    
    // Отправляем новое положение всем пользователям
    socket.broadcast.emit('textMove', moveData);
  });

  // Обработка удаления текста
  socket.on('textDelete', (data) => {
    if (!socket.userData) return;

    // Проверяем права на удаление
    const canDelete = socket.userData.role === 'Администратор' || 
                     socket.userData.username === data.owner;

    if (!canDelete) {
      console.log(`User ${socket.userData.username} tried to delete text without permission`);
      return;
    }

    // Удаляем текст из БД
    db.run('DELETE FROM drawings WHERE id = ?', [data.id], (err) => {
      if (err) console.error('DB delete error:', err);
    });
    
    // Удаляем текст у всех пользователей
    socket.broadcast.emit('textDelete', data.id);
  });

  // Обработка очистки доски
  socket.on('clear', (userData) => {
    if (!socket.userData) return;

    // Проверяем права на очистку (только админ)
    if (socket.userData.role !== 'Администратор') {
      console.log(`User ${socket.userData.username} tried to clear board without permission`);
      socket.emit('clear_error', { message: 'Только учитель может очистить доску' });
      return;
    }

    // Очищаем базу данных
    db.run('DELETE FROM drawings', (err) => {
      if (err) {
        console.error('DB clear error:', err);
        socket.emit('clear_error', { message: 'Ошибка при очистке доски' });
      } else {
        console.log(`Board cleared by ${socket.userData.username}`);
        
        // Очищаем доску у всех пользователей
        io.emit('clear');
        
        // Отправляем уведомление о очистке
        socket.broadcast.emit('notification', {
          message: `${socket.userData.username} очистил доску`,
          type: 'info',
          timestamp: new Date().toISOString()
        });
      }
    });
  });

  // Обработка отключения пользователя
  socket.on('disconnect', () => {
    if (socket.userData) {
      console.log(`User ${socket.userData.username} disconnected`);

      // Удаляем пользователя из БД
      db.run('DELETE FROM user_sessions WHERE socket_id = ?', [socket.id], (err) => {
        if (err) console.error('Error removing user session:', err);
      });

      // Оповещаем об отключении
      socket.broadcast.emit('user_left', {
        username: socket.userData.username,
        role: socket.userData.role,
        message: `${socket.userData.username} покинул доску`,
        timestamp: new Date().toISOString()
      });

      // Обновляем список пользователей
      updateOnlineUsers();
    }
  });

  // Обработка ошибок
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Функция для обновления списка онлайн-пользователей
function updateOnlineUsers() {
  db.all('SELECT username, role, connected_at FROM user_sessions ORDER BY connected_at DESC', (err, rows) => {
    if (err) {
      console.error('Error fetching online users:', err);
    } else {
      io.emit('online_users_update', rows);
    }
  });
}

// Функция для периодической очистки старых сессий
setInterval(() => {
  const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 часа назад
  db.run('DELETE FROM user_sessions WHERE connected_at < ?', [cutoffTime.toISOString()], (err) => {
    if (err) {
      console.error('Error cleaning old sessions:', err);
    } else {
      console.log('Old sessions cleaned');
    }
  });
}, 60 * 60 * 1000); // Каждый час

// Обработка graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  
  // Закрываем соединения
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('Database connection closed');
    }
  });
  
  server.close(() => {
    console.log('Server shut down');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Open http://localhost:${PORT} in your browser`);
  console.log(`⚡ Socket.IO server ready for real-time communication`);
});

module.exports = { app, server, io, db };