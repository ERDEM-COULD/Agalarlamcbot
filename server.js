// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let bot = null;
let botStatus = 'offline';
let connectionStartTime = null;
let moveInterval = null;
let moveTimeout1 = null;
let moveTimeout2 = null;
let reconnectTimeout = null;
let manualStop = false;
let autoReconnectEnabled = true; // 🆕 Otomatik yeniden bağlanma aç/kapa
let currentConfig = { host: '', port: 25565, username: 'Bot', version: false };

let logHistory = [];
const MAX_LOGS = 500;

const CHAT_LOG_FILE = path.join(__dirname, 'chat_logs.json');
let chatLogs = [];

try {
    if (fs.existsSync(CHAT_LOG_FILE)) {
        const data = fs.readFileSync(CHAT_LOG_FILE, 'utf8');
        chatLogs = JSON.parse(data);
        if (!Array.isArray(chatLogs)) chatLogs = [];
    }
} catch (err) {
    console.error('Sohbet kayıtları yüklenirken hata:', err.message);
    chatLogs = [];
}

function addLog(message) {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = `[${timestamp}] ${message}`;
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOGS) logHistory.shift();
    io.emit('terminal-log', logEntry);
    console.log(logEntry);
}

function saveChatToFile(username, message, type = 'public') {
    const chatEntry = {
        timestamp: new Date().toISOString(),
        time: new Date().toLocaleString('tr-TR'),
        username, message, type
    };
    chatLogs.push(chatEntry);
    fs.writeFile(CHAT_LOG_FILE, JSON.stringify(chatLogs, null, 2), 'utf8', (err) => {
        if (err) addLog('Sohbet kaydedilirken hata: ' + err.message);
    });
}

function clearMovement() {
    if (moveInterval) { clearInterval(moveInterval); moveInterval = null; }
    if (moveTimeout1) { clearTimeout(moveTimeout1); moveTimeout1 = null; }
    if (moveTimeout2) { clearTimeout(moveTimeout2); moveTimeout2 = null; }
    if (bot) { try { bot.clearControlStates(); } catch (e) {} }
}

function startMovement() {
    clearMovement();
    const FORWARD_MS = 1500, BACK_MS = 1500, PAUSE_MS = 500, CYCLE_MS = 4000;

    moveInterval = setInterval(() => {
        if (!bot || botStatus !== 'online' || !bot.entity) return;
        try {
            bot.setControlState('forward', true);
            bot.setControlState('back', false);
        } catch (e) { addLog('Hareket hatası (ileri): ' + e.message); return; }

        moveTimeout1 = setTimeout(() => {
            if (!bot) return;
            try { bot.clearControlStates(); } catch (e) {}
            moveTimeout2 = setTimeout(() => {
                if (!bot || botStatus !== 'online') return;
                try {
                    bot.setControlState('back', true);
                    bot.setControlState('forward', false);
                } catch (e) { addLog('Hareket hatası (geri): ' + e.message); return; }
                setTimeout(() => { if (bot) { try { bot.clearControlStates(); } catch (e) {} } }, BACK_MS);
            }, PAUSE_MS);
        }, FORWARD_MS);
    }, CYCLE_MS);

    addLog('Hareket döngüsü başlatıldı (yavaş tempoda ileri-geri).');
}

function clearReconnectTimer() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
}

function startBot(config) {
    if (bot) { addLog('Bot zaten çalışıyor, tekrar başlatma iptal edildi.'); return; }

    manualStop = false;
    clearReconnectTimer();

    currentConfig = config;
    botStatus = 'starting';
    io.emit('bot-status', botStatus);
    addLog(`Bot başlatılıyor... Sunucu: ${config.host}:${config.port} | Kullanıcı: ${config.username} | Sürüm: ${config.version || 'otomatik'}`);

    try {
        bot = mineflayer.createBot({
            host: config.host,
            port: parseInt(config.port) || 25565,
            username: config.username,
            version: config.version || false,
            auth: 'offline',
            physicsEnabled: false,
            checkTimeoutInterval: 60 * 1000
        });

        bot.once('spawn', () => {
            botStatus = 'online';
            connectionStartTime = Date.now();
            io.emit('bot-status', botStatus);
            io.emit('connection-time', connectionStartTime);
            addLog(`Bot sunucuya katıldı! Konum: ${bot.entity.position.toString()}`);

            setTimeout(() => {
                if (!bot || botStatus !== 'online') return;
                try { bot.physicsEnabled = true; addLog('Fizik motoru etkinleştirildi.'); }
                catch (e) { addLog('Fizik motoru etkinleştirme hatası: ' + e.message); }
                startMovement();
            }, 3000);
        });

        bot.on('end', (reason) => {
            addLog(`Bot oyundan ayrıldı. Sebep: ${reason || 'Bilinmiyor'}`);
            clearMovement();
            bot = null;
            botStatus = 'offline';
            connectionStartTime = null;
            io.emit('bot-status', botStatus);
            io.emit('connection-time', null);

            // 🆕 Otomatik yeniden bağlanma kontrolü
            if (manualStop) {
                addLog('Otomatik yeniden bağlanma devre dışı (manuel durdurma).');
                return;
            }
            if (!autoReconnectEnabled) {
                addLog('Otomatik yeniden bağlanma kapalı (panelden kapatıldı).');
                return;
            }
            if (currentConfig.host && currentConfig.username) {
                addLog('5 saniye içinde otomatik yeniden bağlanılacak...');
                clearReconnectTimer();
                reconnectTimeout = setTimeout(() => {
                    reconnectTimeout = null;
                    if (!manualStop && autoReconnectEnabled && !bot) {
                        addLog('Otomatik yeniden bağlanma başlatılıyor...');
                        startBot(currentConfig);
                    }
                }, 5000);
            }
        });

        bot.on('kicked', (reason) => {
            addLog(`Bot sunucudan atıldı: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
        });

        bot.on('error', (err) => {
            addLog(`Bot Hatası: ${err.message}`);
        });

        bot.on('chat', (username, message) => {
            if (username === bot.username) return;
            addLog(`[Sohbet] <${username}> ${message}`);
            saveChatToFile(username, message, 'public');
        });

        bot.on('whisper', (username, message) => {
            if (username === bot.username) return;
            addLog(`[Özel] <${username}> ${message}`);
            saveChatToFile(username, message, 'whisper');
        });

    } catch (err) {
        addLog(`Bot oluşturulurken hata: ${err.message}`);
        botStatus = 'offline';
        io.emit('bot-status', botStatus);
        bot = null;

        if (!manualStop && autoReconnectEnabled && currentConfig.host && currentConfig.username) {
            addLog('Bot oluşturulamadı, 5 saniye sonra yeniden denenecek...');
            clearReconnectTimer();
            reconnectTimeout = setTimeout(() => {
                reconnectTimeout = null;
                if (!manualStop && autoReconnectEnabled && !bot) {
                    startBot(currentConfig);
                }
            }, 5000);
        }
    }
}

function stopBot(manual = true) {
    clearMovement();
    clearReconnectTimer();

    if (manual) {
        manualStop = true;
        addLog('Bot durduruluyor... (otomatik yeniden bağlanma devre dışı)');
    }

    if (bot) {
        try { bot.quit(); } catch (e) {}
        bot = null;
    }
    botStatus = 'offline';
    connectionStartTime = null;
    io.emit('bot-status', botStatus);
    io.emit('connection-time', null);
    if (manual) addLog('Bot durduruldu.');
}

// --- Yardımcı Fonksiyonlar ---
async function openInventoryWindow(command, timeoutMs = 5000) {
    if (!bot || botStatus !== 'online') throw new Error('Bot çevrimiçi değil.');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            bot.removeListener('windowOpen', onOpen);
            reject(new Error('Pencere açılma zaman aşımı (komut çalışmıyor olabilir)'));
        }, timeoutMs);
        const onOpen = (win) => {
            clearTimeout(timeout);
            bot.removeListener('windowOpen', onOpen);
            resolve(win);
        };
        bot.once('windowOpen', onOpen);
        bot.chat(command);
    });
}

function isFillerItem(item) {
    if (!item || !item.name) return true;
    if (item.name.includes('stained_glass_pane')) return true;
    if (item.name === 'barrier') return true;
    return false;
}

function extractWindowItems(window) {
    const items = [];
    window.slots.forEach((item, index) => {
        if (item && !isFillerItem(item)) {
            items.push({
                slot: index, name: item.name, count: item.count,
                displayName: item.displayName || item.name
            });
        }
    });
    return items;
}

function extractContainerContents(item) {
    if (!item || !item.nbt) return null;
    try {
        const nbtData = item.nbt.value || item.nbt;
        let itemsList = null;

        if (nbtData.BlockEntityTag && nbtData.BlockEntityTag.value && nbtData.BlockEntityTag.value.Items) {
            itemsList = nbtData.BlockEntityTag.value.Items.value ? nbtData.BlockEntityTag.value.Items.value.value : null;
        } else if (nbtData.Items) {
            itemsList = nbtData.Items.value ? nbtData.Items.value.value : null;
        }

        if (!itemsList || !Array.isArray(itemsList)) return null;

        const contents = [];
        itemsList.forEach(entry => {
            const v = entry.value || entry;
            let id = null, count = 0, slot = 0;
            if (Array.isArray(v)) {
                v.forEach(field => {
                    const key = field.name;
                    const val = field.value;
                    if (key === 'id') id = typeof val === 'string' ? val : (val.value || null);
                    if (key === 'Count') count = typeof val === 'number' ? val : (val.value || 0);
                    if (key === 'Slot') slot = typeof val === 'number' ? val : (val.value || 0);
                });
            }
            if (id) {
                contents.push({
                    slot,
                    name: id.replace('minecraft:', ''),
                    displayName: id.replace('minecraft:', ''),
                    count
                });
            }
        });
        return contents.length > 0 ? contents : null;
    } catch (e) {
        return null;
    }
}

// --- API Rotaları ---

app.get('/api/state', (req, res) => {
    res.json({
        status: botStatus,
        startTime: connectionStartTime,
        logs: logHistory,
        config: currentConfig,
        autoReconnectEnabled: autoReconnectEnabled // 🆕 Durumu frontend'e bildir
    });
});

// 🆕 Otomatik yeniden bağlanma aç/kapa
app.post('/api/auto-reconnect', (req, res) => {
    const { enabled } = req.body;
    autoReconnectEnabled = !!enabled;
    addLog(`Otomatik yeniden bağlanma ${autoReconnectEnabled ? 'AÇILDI' : 'KAPATILDI'}.`);
    if (!autoReconnectEnabled) {
        clearReconnectTimer();
        addLog('Bekleyen yeniden bağlanma zamanlayıcısı iptal edildi.');
    }
    io.emit('auto-reconnect-status', autoReconnectEnabled);
    res.json({ autoReconnectEnabled });
});

// Terminal TXT indir
app.get('/api/terminal/download', (req, res) => {
    try {
        let txt = '==================================================\n';
        txt += '       TERMINAL ÇIKTI GEÇMİŞİ\n';
        txt += '==================================================\n';
        txt += `Oluşturulma: ${new Date().toLocaleString('tr-TR')}\n`;
        txt += `Toplam Satır: ${logHistory.length}\n`;
        txt += '==================================================\n\n';
        logHistory.forEach(line => { txt += line + '\n'; });
        txt += '\n==================================================\n';
        txt += '              SON\n';
        txt += '==================================================\n';

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const timeStr = `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
        const filename = `terminal_${dateStr}_${timeStr}.txt`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + txt);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/players', (req, res) => {
    if (!bot || botStatus !== 'online') return res.json([]);
    const players = Object.keys(bot.players).filter(name => name !== bot.username);
    res.json(players);
});

app.post('/api/invsee', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Oyuncu adı gerekli.' });
    try {
        const win = await openInventoryWindow(`/invsee ${username}`);
        const items = [];
        win.slots.forEach((item, index) => {
            if (item && !isFillerItem(item)) {
                const entry = {
                    slot: index, name: item.name, count: item.count,
                    displayName: item.displayName || item.name
                };
                if (item.name.includes('shulker_box') || item.name === 'bundle') {
                    const contents = extractContainerContents(item);
                    if (contents) entry.contents = contents;
                }
                items.push(entry);
            }
        });
        try { win.close(); } catch (e) {}
        res.json({ username, inventory: items });
    } catch (err) {
        addLog(`Envanter okuma hatası (${username}): ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/invsee/download', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Oyuncu adı gerekli.' });
    try {
        const win = await openInventoryWindow(`/invsee ${username}`);
        const items = [];
        win.slots.forEach((item, index) => {
            if (item && !isFillerItem(item)) {
                const entry = {
                    slot: index, name: item.name, count: item.count,
                    displayName: item.displayName || item.name
                };
                if (item.name.includes('shulker_box') || item.name === 'bundle') {
                    const contents = extractContainerContents(item);
                    if (contents) entry.contents = contents;
                }
                items.push(entry);
            }
        });
        try { win.close(); } catch (e) {}

        let txt = '==================================================\n';
        txt += `       ${username} - ENVANTER\n`;
        txt += '==================================================\n';
        txt += `Oluşturulma: ${new Date().toLocaleString('tr-TR')}\n`;
        txt += `Toplam Eşya: ${items.length}\n`;
        txt += '==================================================\n\n';

        if (items.length === 0) {
            txt += '(Envanter boş)\n';
        } else {
            items.forEach(item => {
                txt += `[Slot ${item.slot}] ${item.displayName} x${item.count}\n`;
                if (item.contents && item.contents.length > 0) {
                    txt += `  └─ İçerik:\n`;
                    item.contents.forEach(c => {
                        txt += `      [Slot ${c.slot}] ${c.displayName} x${c.count}\n`;
                    });
                }
            });
        }

        txt += '\n==================================================\n';
        txt += '              SON\n';
        txt += '==================================================\n';

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const timeStr = `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
        const filename = `envanter_${username}_${dateStr}_${timeStr}.txt`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + txt);
    } catch (err) {
        addLog(`Envanter indirme hatası (${username}): ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/endersee', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Oyuncu adı gerekli.' });
    try {
        const win = await openInventoryWindow(`/endersee ${username}`);
        const items = [];
        win.slots.forEach((item, index) => {
            if (item && !isFillerItem(item)) {
                const entry = {
                    slot: index, name: item.name, count: item.count,
                    displayName: item.displayName || item.name
                };
                if (item.name.includes('shulker_box') || item.name === 'bundle') {
                    const contents = extractContainerContents(item);
                    if (contents) entry.contents = contents;
                }
                items.push(entry);
            }
        });
        try { win.close(); } catch (e) {}
        res.json({ username, inventory: items });
    } catch (err) {
        addLog(`Ender sandığı okuma hatası (${username}): ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/give', async (req, res) => {
    const { username, item, amount, target } = req.body;
    if (!username || !item) return res.status(400).json({ error: 'Oyuncu adı ve eşya zorunlu.' });
    if (!bot || botStatus !== 'online') return res.status(400).json({ error: 'Bot çevrimiçi değil.' });
    try {
        const amountVal = parseInt(amount) || 1;
        const command = target === 'enderchest'
            ? `/endergive ${username} ${item} ${amountVal}`
            : `/invgive ${username} ${item} ${amountVal}`;
        bot.chat(command);
        addLog(`Eşya verme komutu: ${command}`);
        res.json({ message: `Komut gönderildi: ${command}` });
    } catch (err) {
        addLog('Eşya verme hatası: ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clear', async (req, res) => {
    const { username, target } = req.body;
    if (!username) return res.status(400).json({ error: 'Oyuncu adı gerekli.' });
    if (!bot || botStatus !== 'online') return res.status(400).json({ error: 'Bot çevrimiçi değil.' });
    try {
        const command = target === 'enderchest'
            ? `/enderclear ${username}`
            : `/invclear ${username}`;
        bot.chat(command);
        addLog(`Temizleme komutu: ${command}`);
        res.json({ message: `Komut gönderildi: ${command}` });
    } catch (err) {
        addLog('Temizleme hatası: ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat-logs', (req, res) => {
    const sorted = [...chatLogs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(sorted);
});

app.get('/api/chat-logs/:username', (req, res) => {
    const { username } = req.params;
    const filtered = chatLogs.filter(log => log.username === username);
    const sorted = [...filtered].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(sorted);
});

app.get('/api/chat-logs/:username/download', (req, res) => {
    const { username } = req.params;
    try {
        const filtered = chatLogs.filter(log => log.username === username);
        const sorted = [...filtered].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        let txt = '==================================================\n';
        txt += `       ${username} - MESAJ GEÇMİŞİ\n`;
        txt += '==================================================\n';
        txt += `Oluşturulma: ${new Date().toLocaleString('tr-TR')}\n`;
        txt += `Toplam Mesaj: ${sorted.length}\n`;
        txt += '==================================================\n\n';

        if (sorted.length === 0) {
            txt += '(Bu oyuncunun mesajı yok)\n';
        } else {
            sorted.forEach(entry => {
                const tag = entry.type === 'whisper' ? '[ÖZEL] ' : '';
                txt += `[${entry.time || ''}] ${tag}${entry.message || ''}\n`;
            });
        }

        txt += '\n==================================================\n';
        txt += '              SON\n';
        txt += '==================================================\n';

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const timeStr = `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
        const filename = `mesajlar_${username}_${dateStr}_${timeStr}.txt`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + txt);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat-logs/download', (req, res) => {
    try {
        const sorted = [...chatLogs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        let txt = '==================================================\n';
        txt += '       MINECRAFT SOHBET KAYITLARI\n';
        txt += '==================================================\n';
        txt += `Oluşturulma: ${new Date().toLocaleString('tr-TR')}\n`;
        txt += `Toplam Mesaj: ${sorted.length}\n`;
        txt += '==================================================\n\n';

        if (sorted.length === 0) {
            txt += '(Kayıt bulunmuyor)\n';
        } else {
            const maxNameLen = Math.max(...sorted.map(e => (e.username || '').length), 4);
            sorted.forEach(entry => {
                const name = (entry.username || 'Bilinmiyor').padEnd(maxNameLen, ' ');
                const tag = entry.type === 'whisper' ? '[ÖZEL] ' : '';
                txt += `[${entry.time || ''}] ${tag}<${name}> ${entry.message || ''}\n`;
            });
        }

        txt += '\n==================================================\n';
        txt += '              SON\n';
        txt += '==================================================\n';

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const timeStr = `${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
        const filename = `sohbet_${dateStr}_${timeStr}.txt`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + txt);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clear-chat-logs', (req, res) => {
    chatLogs = [];
    fs.writeFile(CHAT_LOG_FILE, '[]', 'utf8', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        addLog('Sohbet kayıtları temizlendi.');
        res.json({ message: 'Sohbet kayıtları temizlendi.' });
    });
});

app.post('/api/start', (req, res) => {
    const { host, port, username, version } = req.body;
    if (!host || !username) return res.status(400).json({ error: 'Sunucu adresi ve bot adı zorunludur.' });
    if (botStatus === 'online' || botStatus === 'starting') return res.status(400).json({ error: 'Bot zaten çalışıyor.' });
    startBot({ host, port: port || 25565, username, version });
    res.json({ message: 'Başlatma komutu alındı.' });
});

app.post('/api/stop', (req, res) => {
    if (!bot) return res.status(400).json({ error: 'Bot zaten çevrimdışı.' });
    stopBot(true);
    res.json({ message: 'Durdurma komutu alındı.' });
});

app.post('/api/reboot', (req, res) => {
    addLog('Yeniden başlatma komutu alındı...');
    const configToUse = { ...currentConfig };

    manualStop = true;
    clearReconnectTimer();
    clearMovement();

    if (bot) { try { bot.quit(); } catch (e) {} bot = null; }
    botStatus = 'starting';
    io.emit('bot-status', botStatus);
    addLog('Bot kapatıldı, 2 saniye sonra yeniden başlatılacak...');

    setTimeout(() => {
        if (configToUse.host && configToUse.username) {
            startBot(configToUse);
        } else {
            addLog('Hata: Yeniden başlatma için geçerli konfigürasyon bulunamadı.');
            botStatus = 'offline';
            io.emit('bot-status', botStatus);
        }
    }, 2000);

    res.json({ message: 'Yeniden başlatma komutu alındı.' });
});

io.on('connection', (socket) => {
    addLog('Web paneli bağlandı.');
    socket.emit('bot-status', botStatus);
    socket.emit('connection-time', connectionStartTime);
    socket.emit('auto-reconnect-status', autoReconnectEnabled);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Web paneli http://localhost:${PORT} adresinde çalışıyor.`);
    addLog(`Sunucu başlatıldı. Bot henüz çevrimdışı. (Port: ${PORT})`);
});
