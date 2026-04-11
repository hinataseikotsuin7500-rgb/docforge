// ファイルベースの簡易DB (本番移行前の開発用)
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const defaultData = { users: [], usage: [] };

function read() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = {
  // ユーザー
  findUserByEmail(email) {
    return read().users.find(u => u.email === email) || null;
  },
  findUserById(id) {
    return read().users.find(u => u.id === id) || null;
  },
  createUser(user) {
    const db = read();
    db.users.push(user);
    write(db);
    return user;
  },
  updateUser(id, fields) {
    const db = read();
    const idx = db.users.findIndex(u => u.id === id);
    if (idx !== -1) {
      db.users[idx] = { ...db.users[idx], ...fields };
      write(db);
      return db.users[idx];
    }
    return null;
  },

  // 利用回数
  getMonthlyUsage(userId) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const db = read();
    const record = db.usage.find(u => u.userId === userId && u.month === ym);
    return record ? record.count : 0;
  },
  incrementUsage(userId) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const db = read();
    const idx = db.usage.findIndex(u => u.userId === userId && u.month === ym);
    if (idx !== -1) {
      db.usage[idx].count += 1;
    } else {
      db.usage.push({ userId, month: ym, count: 1 });
    }
    write(db);
  },
};
