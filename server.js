const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Инициализация SQLite базы данных
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
    process.exit(1);
  } else {
    console.log('✅ Connected to SQLite database');
  }
});

// Создание таблиц с улучшенной обработкой ошибок
const initializeDatabase = () => {
  return new Promise((resolve, reject) => {
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
          console.error('❌ Error creating drawings table:', err);
          reject(err);
        } else {
          console.log('✅ Drawings table ready');
        }
      });

      // Таблица для пользовательских сессий
      db.run(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          role TEXT NOT NULL,
          socket_id TEXT UNIQUE,
          connected_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('❌ Error creating user_sessions table:', err);
          reject(err);
        } else {
          console.log('✅ User sessions table ready');
          resolve();
        }
      });
    });
  });
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Базовые middleware для безопасности
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Маршруты
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/main.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// Получение всех элементов с пагинацией
app.get('/api/drawings', (req, res) => {
  const limit = parseInt(req.query.limit) || 1000;
  const offset = parseInt(req.query.offset) || 0;
  
  db.all(
    'SELECT * FROM drawings ORDER BY created_at ASC LIMIT ? OFFSET ?', 
    [limit, offset], 
    (err, rows) => {
      if (err) {
        console.error('❌ Fetch error:', err);
        return res.status(500).json({ error: 'Failed to fetch drawings' });
      }
      
      try {
        const drawings = rows.map(row => ({
          id: row.id,
          type: row.type,
          data: JSON.parse(row.data),
          user_id: row.user_id,
          created_at: row.created_at
        }));
        res.json(drawings);
      } catch (parseError) {
        console.error('❌ JSON parse error:', parseError);
        res.status(500).json({ error: 'Failed to parse drawings data' });
      }
    }
  );
});

// Сохранение элемента в БД
app.post('/api/save', (req, res) => {
  const { type, data, userId } = req.body;
  
  if (!type || !data) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  try {
    const dataString = JSON.stringify(data);
    
    db.run(
      'INSERT INTO drawings (type, data, user_id) VALUES (?, ?, ?)',
      [type, dataString, userId || 'unknown'],
      function(err) {
        if (err) {
          console.error('❌ Save error:', err);
          return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true, id: this.lastID });
      }
    );
  } catch (stringifyError) {
    console.error('❌ JSON stringify error:', stringifyError);
    res.status(400).json({ success: false, error: 'Invalid data format' });
  }
});

// Очистка всех элементов (только для админа)
app.delete('/api/clear', (req, res) => {
  const { userId, role } = req.body;
  
  if (role !== 'Администратор') {
    return res.status(403).json({ success: false, error: 'Только учитель может очистить доску' });
  }

  db.run('DELETE FROM drawings', (err) => {
    if (err) {
      console.error('❌ Clear error:', err);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    
    // Оповещаем всех через WebSocket
    io.emit('clear');
    res.json({ success: true });
  });
});

// Удаление конкретного элемента
app.delete('/api/drawing/:id', (req, res) => {
  const { id } = req.params;
  const { userId, role, owner } = req.body;

  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing drawing ID' });
  }

  // Проверка прав: админ или владелец
  if (role !== 'Администратор' && userId !== owner) {
    return res.status(403).json({ success: false, error: 'Нет прав для удаления' });
  }

  db.run('DELETE FROM drawings WHERE id = ?', [id], function(err) {
    if (err) {
      console.error('❌ Delete error:', err);
      return res.status(500).json({ success: false, error: 'Database error' });
    }
    
    if (this.changes === 0) {
      return res.status(404).json({ success: false, error: 'Drawing not found' });
    }
    
    // Оповещаем всех через WebSocket
    io.emit('textDelete', id);
    res.json({ success: true });
  });
});

// Получение информации о подключенных пользователях
app.get('/api/users', (req, res) => {
  db.all(
    'SELECT username, role, connected_at FROM user_sessions ORDER BY connected_at DESC', 
    (err, rows) => {
      if (err) {
        console.error('❌ Users fetch error:', err);
        return res.status(500).json({ error: 'Failed to fetch users' });
      }
      res.json(rows);
    }
  );
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM drawings', (err, row) => {
    if (err) {
      return res.status(500).json({ status: 'error', error: 'Database error' });
    }
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      drawingsCount: row.count
    });
  });
});

// Real-time синхронизация через Socket.io
io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);

  // Обработка подключения пользователя
  socket.on('user_join', (userData) => {
    if (!userData || !userData.username) {
      console.log('❌ Invalid user data received');
      return;
    }

    socket.userData = {
      ...userData,
      socketId: socket.id,
      joinedAt: new Date().toISOString()
    };
    
    console.log(`✅ User ${userData.username} (${userData.role}) joined`);

    // Сохраняем/обновляем информацию о пользователе в БД
    db.run(
      `INSERT OR REPLACE INTO user_sessions (username, role, socket_id) 
       VALUES (?, ?, ?)`,
      [userData.username, userData.role, socket.id],
      (err) => {
        if (err) {
          console.error('❌ Error saving user session:', err);
        } else {
          console.log(`✅ User session saved for ${userData.username}`);
        }
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
    if (!socket.userData) {
      console.log('❌ Drawing from unauthorized user');
      return;
    }

    if (!data || !data.from || !data.to) {
      console.log('❌ Invalid drawing data');
      return;
    }

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
        if (err) {
          console.error('❌ DB save error:', err);
        }
      }
    );
    
    // Отправляем рисунок всем другим пользователям
    socket.broadcast.emit('drawing', drawingData);
  });

  // Обработка создания текста
  socket.on('text', (data) => {
    if (!socket.userData) {
      console.log('❌ Text creation from unauthorized user');
      return;
    }

    if (!data || !data.text || !data.id) {
      console.log('❌ Invalid text data');
      return;
    }

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
        if (err) {
          console.error('❌ DB save error:', err);
        }
      }
    );
    
    // Отправляем текст всем другим пользователям
    socket.broadcast.emit('text', textData);
  });

  // Обработка обновления текста
  socket.on('textUpdate', (data) => {
    if (!socket.userData) {
      console.log('❌ Text update from unauthorized user');
      return;
    }

    if (!data || !data.id) {
      console.log('❌ Invalid text update data');
      return;
    }

    // Проверяем права на редактирование
    const canEdit = socket.userData.role === 'Администратор' || 
                   socket.userData.username === data.owner;

    if (!canEdit) {
      console.log(`❌ User ${socket.userData.username} tried to edit text without permission`);
      socket.emit('error', { message: 'Нет прав для редактирования этого текста' });
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
        if (err) {
          console.error('❌ DB update error:', err);
          socket.emit('error', { message: 'Ошибка при обновлении текста' });
        }
      }
    );
    
    // Отправляем обновление всем пользователям
    socket.broadcast.emit('textUpdate', updateData);
  });

  // Обработка перемещения/изменения размера текста
  socket.on('textMove', (data) => {
    if (!socket.userData) {
      console.log('❌ Text move from unauthorized user');
      return;
    }

    if (!data || !data.id) {
      console.log('❌ Invalid text move data');
      return;
    }

    // Проверяем права на перемещение
    const canMove = socket.userData.role === 'Администратор' || 
                   socket.userData.username === data.owner;

    if (!canMove) {
      console.log(`❌ User ${socket.userData.username} tried to move text without permission`);
      socket.emit('error', { message: 'Нет прав для перемещения этого текста' });
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
        if (err) {
          console.error('❌ DB update error:', err);
          socket.emit('error', { message: 'Ошибка при перемещении текста' });
        }
      }
    );
    
    // Отправляем новое положение всем пользователям
    socket.broadcast.emit('textMove', moveData);
  });

  // Обработка удаления текста
  socket.on('textDelete', (data) => {
    if (!socket.userData) {
      console.log('❌ Text delete from unauthorized user');
      return;
    }

    if (!data || !data.id) {
      console.log('❌ Invalid text delete data');
      return;
    }

    // Проверяем права на удаление
    const canDelete = socket.userData.role === 'Администратор' || 
                     socket.userData.username === data.owner;

    if (!canDelete) {
      console.log(`❌ User ${socket.userData.username} tried to delete text without permission`);
      socket.emit('error', { message: 'Нет прав для удаления этого текста' });
      return;
    }

    // Удаляем текст из БД
    db.run('DELETE FROM drawings WHERE id = ?', [data.id], (err) => {
      if (err) {
        console.error('❌ DB delete error:', err);
        socket.emit('error', { message: 'Ошибка при удалении текста' });
      }
    });
    
    // Удаляем текст у всех пользователей
    socket.broadcast.emit('textDelete', data.id);
  });

  // Обработка очистки доски
  socket.on('clear', (userData) => {
    if (!socket.userData) {
      console.log('❌ Clear request from unauthorized user');
      return;
    }

    // Проверяем права на очистку (только админ)
    if (socket.userData.role !== 'Администратор') {
      console.log(`❌ User ${socket.userData.username} tried to clear board without permission`);
      socket.emit('clear_error', { message: 'Только учитель может очистить доску' });
      return;
    }

    // Очищаем базу данных
    db.run('DELETE FROM drawings', (err) => {
      if (err) {
        console.error('❌ DB clear error:', err);
        socket.emit('clear_error', { message: 'Ошибка при очистке доски' });
      } else {
        console.log(`✅ Board cleared by ${socket.userData.username}`);
        
        // Очищаем доску у всех пользователей
        io.emit('clear');
        
        // Отправляем уведомление о очистке
        io.emit('notification', {
          message: `${socket.userData.username} очистил доску`,
          type: 'info',
          timestamp: new Date().toISOString()
        });
      }
    });
  });

  // Обработка ping/pong для проверки соединения
  socket.on('ping', (data) => {
    socket.emit('pong', { ...data, serverTime: new Date().toISOString() });
  });

  // Обработка отключения пользователя
  socket.on('disconnect', (reason) => {
    console.log(`👤 User disconnected: ${socket.id}, reason: ${reason}`);
    
    if (socket.userData) {
      console.log(`📤 User ${socket.userData.username} disconnected`);

      // Удаляем пользователя из БД
      db.run('DELETE FROM user_sessions WHERE socket_id = ?', [socket.id], (err) => {
        if (err) {
          console.error('❌ Error removing user session:', err);
        } else {
          console.log(`✅ User session removed for ${socket.userData.username}`);
        }
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
    console.error('❌ Socket error:', error);
  });
});

// Функция для обновления списка онлайн-пользователей
function updateOnlineUsers() {
  db.all(
    'SELECT username, role, connected_at FROM user_sessions ORDER BY connected_at DESC', 
    (err, rows) => {
      if (err) {
        console.error('❌ Error fetching online users:', err);
      } else {
        io.emit('online_users_update', rows);
        console.log(`📊 Online users updated: ${rows.length} users`);
      }
    }
  );
}

// Функция для периодической очистки старых сессий
setInterval(() => {
  const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 часа назад
  db.run(
    'DELETE FROM user_sessions WHERE connected_at < ?', 
    [cutoffTime.toISOString()], 
    function(err) {
      if (err) {
        console.error('❌ Error cleaning old sessions:', err);
      } else if (this.changes > 0) {
        console.log(`✅ Old sessions cleaned: ${this.changes} removed`);
        updateOnlineUsers();
      }
    }
  );
}, 60 * 60 * 1000); // Каждый час

// Функция для проверки состояния базы данных
setInterval(() => {
  db.get('SELECT COUNT(*) as count FROM drawings', (err, row) => {
    if (err) {
      console.error('❌ Database health check failed:', err);
    } else {
      console.log(`💾 Database health: ${row.count} drawings in storage`);
    }
  });
}, 5 * 60 * 1000); // Каждые 5 минут

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('\n🔄 Shutting down server gracefully...');
  
  // Отключаем новых пользователей
  server.close((err) => {
    if (err) {
      console.error('❌ Error during server close:', err);
      process.exit(1);
    }
    
    console.log('✅ HTTP server closed');
    
    // Отключаем все socket соединения
    io.close(() => {
      console.log('✅ Socket.IO server closed');
      
      // Закрываем базу данных
      db.close((err) => {
        if (err) {
          console.error('❌ Error closing database:', err);
          process.exit(1);
        }
        console.log('✅ Database connection closed');
        process.exit(0);
      });
    });
  });
  
  // Принудительное завершение через 10 секунд
  setTimeout(() => {
    console.log('❌ Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Инициализация и запуск сервера
const startServer = async () => {
  try {
    await initializeDatabase();
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`\n🚀 Server running on port ${PORT}`);
      console.log(`📱 Open http://localhost:${PORT} in your browser`);
      console.log(`⚡ Socket.IO server ready for real-time communication`);
      console.log(`💾 SQLite database connected and ready`);
      console.log(`⏰ Server started at: ${new Date().toISOString()}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = { app, server, io, db };
