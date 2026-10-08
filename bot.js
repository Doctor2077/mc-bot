// ============================================================
// Claude Minecraft Bot v5 — Voyager-inspired Architecture
// - mineflayer-collectblock: auto pathfind→tool→mine→collect
// - Skill Library: reusable code stored in skills.json
// - AI code generation: complex tasks → generate JS → execute
// - Feedback loop: fail → error feedback → retry (max 3x)
// ============================================================

const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear, GoalBlock, GoalFollow } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');
const collectblock = require('mineflayer-collectblock').plugin;
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const http = require('http');
const mcData = require('minecraft-data')('1.20.1');

// ============ Env（轻量 .env 解析，不引入 npm 依赖） ============
function loadEnv() {
  const env = {};
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return env;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k) env[k] = v;
    }
  } catch (e) { console.warn('⚠️ 读取 .env 失败: ' + e.message); }
  return env;
}
const env = loadEnv();
const KEY = env.KEY || '';
if (!KEY) console.warn('⚠️ 未在 .env 中找到 KEY，请在同目录 .env 中配置 KEY=sk-...');

const SKILLS_FILE = path.join(__dirname, 'skills.json');
const OPERATIONS_LOG = path.join(__dirname, 'operations.log'); // 持久操作日志（追加写入，重启不丢）

// ============ 进程级保护（只注册一次） ============
process.on('uncaughtException', (e) => {
  if (e.message && e.message.includes('Took to long')) {
    console.log('🔄 寻路超时');
    try { bot?.pathfinder?.setGoal(null); } catch {}
  } else {
    console.log('💥 ' + e.message);
  }
});
process.on('unhandledRejection', (reason) => {
  console.log('💥 未处理Promise: ' + (reason?.message || reason));
});

const CONFIG = {
  host: 'localhost', port: 25565,
  username: 'Claude', auth: 'offline', version: '1.20.1',
};

// Block lists
const TREE_LOGS = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];
const ORES = ['coal_ore','iron_ore','copper_ore','gold_ore','diamond_ore','redstone_ore','lapis_ore','emerald_ore',
  'deepslate_coal_ore','deepslate_iron_ore','deepslate_copper_ore','deepslate_gold_ore','deepslate_diamond_ore',
  'deepslate_redstone_ore','deepslate_lapis_ore','deepslate_emerald_ore','stone','cobblestone','deepslate'];

// ============ Skill Library ============
let skillLibrary = {};
function loadSkills() {
  try { skillLibrary = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf-8')); }
  catch(e) { skillLibrary = {}; }
}
function saveSkill(name, description, code) {
  skillLibrary[name] = { description, code, created: new Date().toISOString(), uses: (skillLibrary[name]?.uses || 0) + 1 };
  fs.writeFileSync(SKILLS_FILE, JSON.stringify(skillLibrary, null, 2));
}

// ============ State ============
let bot, owner = null, history = [], state = 'idle', idleTimer;
let reconnectTimer = null, reconnecting = false;
// pillarUp 放置过的方块坐标（用于下树时识别"自己垫的柱子"）
let placedBlocks = [];

// ============ 实时状态面板服务（node 内置 http，零依赖，端口8123，绑定127.0.0.1） ============
const status = {
  state: 'idle',
  stateText: '空闲',
  username: CONFIG.username,
  health: 20,
  position: { x: 0, y: 0, z: 0 },
  inventory: [],
  action: '',
  events: [],
};
const STATE_TEXT = {
  'chop': '正在砍树', 'idle': '空闲', 'follow': '跟随中', 'goto': '前往中',
  'fighting': '战斗中', 'mining': '挖矿中', 'place': '放置中', 'toss': '扔物品',
  'craft': '制作中', 'ai-code': '执行AI任务', 'digging': '挖掘中',
};
function updateStatus(partial) {
  Object.assign(status, partial);
  if (partial && partial.state) status.stateText = STATE_TEXT[partial.state] || partial.state;
}
function pushEvent(msg) {
  status.events.push({ t: new Date().toISOString(), msg: String(msg) });
  if (status.events.length > 30) status.events = status.events.slice(-30);
}
function refreshStatus() {
  if (!bot || !bot.entity) return;
  status.stateText = STATE_TEXT[status.state] || status.state;
  status.health = Math.round(bot.health);
  const p = bot.entity.position;
  status.position = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  status.inventory = bot.inventory.items().slice(0, 12).map(i => i.name + 'x' + i.count);
}
// 统一 state 更新（面板联动）+ 复位（不覆盖玩家新指令）
function setState(s) {
  state = s;
  updateStatus({ state: s });
  pushEvent('状态→' + (STATE_TEXT[s] || s));
}
function resetIfState(s) {
  if (state !== s) return;
  state = 'idle';
  updateStatus({ state: 'idle' });
  startIdle();
}
// ============ 持久操作日志（追加写入 operations.log + 同步状态面板 /events） ============
function logAction(category, detail) {
  try {
    let x = '-', y = '-', z = '-';
    if (bot && bot.entity && bot.entity.position) {
      x = Math.round(bot.entity.position.x);
      y = Math.round(bot.entity.position.y);
      z = Math.round(bot.entity.position.z);
    }
    fs.appendFileSync(OPERATIONS_LOG,
      '[' + new Date().toISOString() + '] [' + category + '] ' + detail + ' @ ' + x + ',' + y + ',' + z + '\n');
  } catch (e) {}
  // 复用 pushEvent，让状态面板 /events 也反映（不重复实现 events 逻辑）
  pushEvent('[' + category + '] ' + detail);
}
// 中断记录：execute 命中新动作覆盖旧 state 时记一条
function logInterrupt(oldState, newState) {
  if (oldState !== 'idle' && oldState !== newState) {
    logAction('中断', '被打断: ' + (STATE_TEXT[oldState] || oldState) + '→' + (STATE_TEXT[newState] || newState));
  }
}
const statusServer = http.createServer((req, res) => {
  refreshStatus();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.url.startsWith('/events')) res.end(JSON.stringify(status.events));
  else res.end(JSON.stringify(status));
});
statusServer.on('error', (e) => console.log('⚠️ 状态面板启动失败: ' + e.message));
statusServer.listen(8123, '127.0.0.1', () => {
  console.log('📊 状态面板: http://127.0.0.1:8123/status');
});

// ============ System Prompt ============
const SYSTEM = `你是 Claude，Minecraft 中的 AI 伙伴，通过游戏聊天交流。你有身体，可以走动、砍树、挖矿、制作物品、打怪。

诚实原则：只描述已发生的事实。你确实可以行动——砍树、挖矿、做合成台、做木剑木镐等。不要说"我无法移动"或"我做不到"——你能做这些事。
严禁幻觉：只有真正执行成功的动作（如真实放置了方块）才可以说"放好了/做好了/完成了"；未执行或未命中的指令必须如实说"我没做/做不到/请直接说清楚"，绝不能编造已完成的动作。

每条消息末尾【世界】标签包含真实状态。25字内，中文，轻松有趣。`;

// ============ Reconnect（去重） ============
function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  console.log('🔌 连接断开，5秒后重连...');
  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    createBot();
  }, 5000);
}

// ============ Create Bot ============
function createBot() {
  const instance = mineflayer.createBot(CONFIG);
  bot = instance;
  instance.loadPlugin(pathfinder);
  instance.loadPlugin(collectblock);
  loadSkills();

  instance.on('spawn', async () => {
    console.log('✅ Claude 上线 (Voyager模式)');
    setupPath();
    await sleep(1000);
    instance.chat('Claude来了！让我砍树、挖矿、跟着你都行~');
    startIdle();
    startStuckMonitor();
    autoEquip();
  });

  instance.on('chat', async (username, msg) => {
    try {
      if (username === instance.username) return;
      if (!owner) owner = username;
      msg = msg.trim();
      console.log('📩 ' + msg);
      logToFile('📩 [玩家] ' + username + ': ' + msg);
      updateStatus({ username });

      // 1. 尝试执行动作
      const result = await execute(username, msg);

      // 1.5 动作结果
      if (result) {
        const desc = result.desc || '';
        console.log('⚡ 动作: ' + result.action + (result.ok ? '✅' : '❌') + (desc ? ' (' + desc + ')' : ''));
        logToFile('⚡ [动作] ' + result.action + (result.ok ? '成功' : '失败') + (desc ? ' (' + desc + ')' : ''));
        updateStatus({ action: desc || '' });
      }

      // 2. 如果没有动作匹配，先尝试联网搜索
      if (!result) {
        const searchReply = await smartChat(username, msg);
        if (searchReply) {
          console.log('🔍 ' + searchReply);
          instance.chat(searchReply);
          logToFile('🔍 [搜索] ' + searchReply);
          return;
        }
      }

      // 2.5 动作失败时自动搜索攻略
      if (result && !result.ok) {
        autoLearn(result.action || msg, result.desc || '未知错误');
      }

      // 3. AI 对话（仅当没有动作命中时才让AI发言，避免覆盖真实动作结果/幻觉"放好了"）
      if (!result) {
        try {
          const reply = await aiChat(username, msg, null);
        console.log('🤖 ' + reply);
        instance.chat(reply);
        logToFile('🤖 [AI] ' + reply);
      } catch(e) {
        console.log('❌ AI: ' + e.message);
        logToFile('❌ [API错误] ' + e.message);
        const fallback = '我这边信号不好，稍等再试';
        try { instance.chat(fallback); } catch(_) {}
          logToFile('🤖 [兜底] ' + fallback);
        }
      }
    } catch(e) {
      console.log('❌ 消息处理失败: ' + e.message);
      logToFile('❌ [错误] ' + e.message);
      try { instance.chat('我这边信号不好，稍等再试'); } catch(_) {}
    }
  });

  // Auto-defend: mineflayer 事件签名 (entity, source)
  instance.on('entityHurt', (entity, source) => {
    if (entity === instance.entity && source) {
      fightEntity(source);
    }
  });

  instance.on('death', () => { setState('idle'); });
  instance.on('respawn', () => { instance.chat('重生了'); startIdle(); autoEquip(); });
  instance.on('kicked', () => { cleanup(instance); scheduleReconnect(); });
  instance.on('end', () => { cleanup(instance); scheduleReconnect(); });
  instance.on('error', (e) => console.log('⚠️ ' + e.message));
}

// ============ Action Execution ============
async function execute(username, msg) {
  const m = msg.toLowerCase();
  const oldState = state; // 用于中断记录

  // Follow
  if (has(m, '跟着','跟我','follow','跟我走')) {
    logInterrupt(oldState, 'follow');
    startFollow(username);
    bot.chat('好嘞，跟着你~');
    return { action: 'follow', ok: true, desc: '跟着' + username };
  }
  if (has(m, '停下','别跟','stop')) {
    stopFollow();
    bot.chat('好，不跟了');
    return { action: 'stop', ok: true, desc: '停下' };
  }

  // ---- 指定物品放地上（真实放置，防幻觉；放不了就如实告知，不编造） ----
  const pm = msg.match(/把(.{1,8})放(?:到|在)?(?:地上|下来|下|了)?/) ||
             msg.match(/放(?:个)?(.{1,8})(?:到|在)?(?:地上|下来)/) ||
             msg.match(/放(?:个)?(.{1,8})$/) ||
             msg.match(/^(.{1,8})放(?:到|在)?(?:地上|下来)/);
  if (pm) {
    if (/[?？吗]/.test(m)) return; // 疑问句式（如"放好了吗"）不触发放置，交给AI回答
    let itemName = pm[1].replace(/^(把|帮我|给我|给)/, '').replace(/^[置个了]*/, '').trim();
    const genericWords = ['方块','土','石头','泥土','地','垫','一下','个','块','什么','这里','那里','这','那','东西','下来','下'];
    if (itemName.length >= 2 && !genericWords.some(g => itemName.includes(g)) && !has(m, '垫脚','垫一下')) {
      logInterrupt(oldState, 'place');
      const placed = await placeNamedBlock(itemName, username);
      return { action: 'place', ok: placed, desc: placed ? '放了' + itemName : '放' + itemName + '没成功' };
    }
  }

  // Compound: 砍树 + 做工作台
  if (has(m, '砍树','砍木头','chop','砍到') && has(m, '合成台','工作台','做台')) {
    logInterrupt(oldState, 'chop');
    bot.chat('好，先砍树再做合成台！');
    const count = await collectTrees();
    let craftOk = false;
    if (count > 0) craftOk = await makeCraftingTable();
    // 验证是否真的有合成台了
    const hasTable = bot.inventory.items().find(i => i.name === 'crafting_table');
    return { action: 'chop+craf', ok: count > 0, desc: '砍' + count + '块木头,' + (hasTable ? '合成台已做好' : '合成台未完成') };
  }

  // Chop tree
  if (has(m, '砍树','砍木头','chop','伐木') || (has(m, '砍') && has(m, '树','木头','木'))) {
    logInterrupt(oldState, 'chop');
    const count = await collectTrees();
    // 砍完自动尝试做合成台
    const hasTable = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (!hasTable && count >= 1) {
      const planks = bot.inventory.items().filter(i => i.name.includes('planks'));
      const totalPlanks = planks.reduce((s, i) => s + i.count, 0);
      if (totalPlanks >= 4) {
        bot.chat('有木板了，帮你做合成台...');
        await makeCraftingTable();
      }
    }
    return { action: 'chop', ok: count > 0, desc: '砍了' + count + '块木头' };
  }

  // Craft tools — 精确匹配：做XX/造XX/合成XX/制作XX 或含具体物品关键词，纯聊天含"做"不触发
  const craftVerbItem = /(做|造|合成|制作)(木剑|木镐|石镐|木斧|石剑|石斧|木棍|棍子|棒|stick|工作台|合成台|火把|torch|剑|镐|斧|木板|石头)/.test(m);
  const craftItemKw = has(m, '木剑','木镐','石镐','木斧','石剑','石斧','木棍','棍子','棒','stick','火把','torch');
  if ((craftVerbItem || craftItemKw) && !has(m, '合成台','工作台','crafting')) {
    logInterrupt(oldState, 'craft');
    setState('craft');
    // 木剑
    if (has(m, '木剑') || (has(m, '剑') && has(m, '木'))) {
      const ok = await craftTool('wooden_sword', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做木剑' };
    }
    // 木镐
    if (has(m, '木镐') || (has(m, '镐') && has(m, '木')) || has(m, '稿')) {
      const ok = await craftTool('wooden_pickaxe', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做木镐' };
    }
    // 木斧
    if (has(m, '木斧') || (has(m, '斧') && has(m, '木'))) {
      const ok = await craftTool('wooden_axe', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做木斧' };
    }
    // 石镐
    if (has(m, '石镐') || (has(m, '镐') && has(m, '石'))) {
      const ok = await craftTool('stone_pickaxe', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做石镐' };
    }
    // 石剑
    if (has(m, '石剑') || (has(m, '剑') && has(m, '石'))) {
      const ok = await craftTool('stone_sword', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做石剑' };
    }
    // 棍子
    if (has(m, '棍','棒','stick','木棍')) {
      const ok = await craftTool('stick', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做木棍' };
    }
    // 火把
    if (has(m, '火把','torch')) {
      const ok = await craftTool('torch', username);
      resetIfState('craft');
      return { action: 'craft', ok, desc: '做火把' };
    }
    resetIfState('craft');
    return { action: 'craft', ok: false, desc: '不知道怎么做，试试说"做木剑"' };
  }

  // Make crafting table explicitly
  if (has(m, '合成台','工作台','做台','crafting') && !has(m, '砍')) {
    logInterrupt(oldState, 'craft');
    setState('craft');
    const ok = await makeCraftingTable();
    const hasTable = bot.inventory.items().find(i => i.name === 'crafting_table');
    resetIfState('craft');
    return { action: 'craft', ok, desc: hasTable ? '合成台已在背包' : '合成台制作失败' };
  }

  // Mine → use collectblock
  if (has(m, '挖矿','挖石头','采矿','mine','挖煤','挖铁','挖钻石','挖金子')) {
    logInterrupt(oldState, 'mining');
    const count = await collectOres();
    return { action: 'mine', ok: count > 0, desc: '挖了' + count + '块' };
  }

  // Fight
  if (has(m, '打怪','打僵尸','打骷髅','杀','干掉','attack','fight','kill','保护')) {
    logInterrupt(oldState, 'fighting');
    const r = await fightNearest();
    return { action: 'fight', ok: r, desc: r ? '击杀怪物' : '没找到怪' };
  }

  // Come to player
  if (has(m, '过来','来我这','到我身边','come','靠近')) {
    logInterrupt(oldState, 'goto');
    goTo(username);
    return { action: 'come', ok: true, desc: '走向' + username };
  }

  // MC commands
  if (has(m, '天亮','白天')) { bot.chat('/time set day'); return { action: 'time', ok: true }; }
  if (has(m, '传送到','tp到','拉我')) {
    bot.chat(m.includes('我') ? '/tp ' + username + ' Claude' : '/tp Claude ' + username);
    return { action: 'tp', ok: true };
  }

  // Crafting table
  if (has(m, '合成台','工作台','做台','crafting')) {
    setState('craft');
    await makeCraftingTable();
    resetIfState('craft');
    return { action: 'craft', ok: true, desc: '合成台' };
  }

  // Place block（放方块/垫脚）
  if (has(m, '放个方块','放一块','放块','垫一下','垫个方块','垫块','搭上去','帮我放','放土','放泥土','放石头')) {
    logInterrupt(oldState, 'place');
    const placed = await placeBlockForPlayer(username);
    return { action: 'place', ok: placed, desc: placed ? '放了个方块' : '放方块失败' };
  }

  // Drop / give items
  if (has(m, '给我','扔出来','丢出来','toss','drop') || /把.*扔/.test(m)) {
    setState('toss');
    logAction('扔物', '开始');
    const item = bot.inventory.items().find(i => i.name === 'crafting_table') ||
                 bot.inventory.items().find(i => i.name.includes('planks')) ||
                 bot.inventory.items().find(i => !i.name.includes('sword') && !i.name.includes('pickaxe'));
    if (item) {
      try {
        await bot.toss(item.type, null, 1);
        bot.chat(item.name + ' 扔地上了，快来捡！');
        logAction('扔物', '完成: 扔出' + item.name);
      } catch(e) { bot.chat('扔不出来...在背包里'); }
    } else {
      bot.chat('背包空的...');
    }
    resetIfState('toss');
    return { action: 'toss', ok: true, desc: '扔物品' };
  }

  // Pick up items
  if (has(m, '捡东西','收集','捡起来','collect')) {
    await collectDrops();
    return { action: 'collect', ok: true, desc: '拾取物品' };
  }

  // Position
  if (has(m, '你在哪','!pos','坐标','位置')) {
    const p = bot.entity.position;
    return { action: 'pos', desc: Math.round(p.x)+','+Math.round(p.y)+','+Math.round(p.z) };
  }

  // Help
  if (has(m, '!help','帮助','能干嘛','功能')) {
    return { action: 'help' };
  }

  // Scan territory
  if (has(m, '扫描','!scan','查看地形','勘测','地形')) {
    bot.chat('正在大范围扫描...');
    const map = scanTerritory(40);
    const trees = map.resources.filter(r => TREE_LOGS.includes(r.name)).length;
    const ores = map.resources.filter(r => ORES.includes(r.name)).length;
    const water = map.obstacles.filter(o => o.name === 'water').length;
    const lava = map.obstacles.filter(o => o.name === 'lava').length;
    visualizeScan(map);
    bot.chat('扫描40格: 🌲' + trees + ' ⛏️' + ores + ' 💧' + water + ' 🔥' + lava);
    // Pass to AI for richer description
    const desc = '扫描结果：' + trees + '棵树，' + ores + '处矿，' + water + '处水，' + lava + '处岩浆。玩家距离' +
      Math.round(bot.entity.position.distanceTo(bot.players[username]?.entity?.position || bot.entity.position)) + '米。';
    return { action: 'scan', ok: true, desc };
  }

  // Search / knowledge（仅显式搜索指令，去掉"哪/怎么"等过宽词）
  if (has(m, '搜索','查一下','!search')) {
    const query = msg.replace(/搜索|查一下|!search/g, '').trim() || msg;
    bot.chat('让我搜一下...');
    const searchResult = await webSearch(query);
    if (searchResult) {
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'Minecraft专家。根据搜索结果回答，30字内。' },
            { role: 'user', content: `问题: ${msg}\n\n搜索结果: ${searchResult}\n\n回答:` }
          ],
          max_tokens: 80, temperature: 0.5,
        }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      bot.chat(data.choices[0].message.content.trim());
    } else {
      bot.chat('没搜到结果...');
    }
    return { action: 'search', ok: true, desc: query };
  }

  // Status
  if (has(m, '!status','状态','血量','背包','inventory')) {
    const items = bot.inventory.items().slice(0, 8).map(i => i.name).join(', ');
    return { action: 'status', desc: 'HP:'+Math.round(bot.health)+' 物品:'+(items||'空') };
  }

  // AI 代码生成仅限显式指令前缀（如「!做」「帮我做」），日常聊天一律走 aiChat
  if (m.startsWith('!做') || m.startsWith('帮我做')) {
    // Try AI-generated code for novel tasks
    const codeResult = await aiGenerateCode(username, msg);
    if (codeResult) return codeResult;
  }

  return null;
}

// ============ Core Skills ============

// ==== Smart Tree Collection with full Y-scan and whole-tree chopping ====
async function collectTrees() {
  setState('chop');
  logAction('砍树', '开始砍树');
  bot.chat('正在全高度扫描树木...');
  let treeClusters = scanForTrees(48);

  // 多级搜索：半径逐步扩大 48 → 96 → 192
  if (treeClusters.length === 0) {
    bot.chat('48格内没树，扩大范围到96格...');
    treeClusters = scanForTrees(96);
  }
  if (treeClusters.length === 0) {
    bot.chat('96格内也没树，再扩大到192格...');
    treeClusters = scanForTrees(192);
  }
  // 192格内仍无树 → 漫游找树（随机方向走30-50格，最多3轮）
  if (treeClusters.length === 0) {
    treeClusters = await wanderSearchForTrees();
  }

  if (treeClusters.length === 0) {
    // 漫游期间若被新指令打断（state 已变），不要覆盖新状态
    if (state === 'chop') {
      bot.chat('附近没找到树！(已扫描Y轴-2到+8)');
      resetIfState('chop');
    }
    return 0;
  }

  // 按距离排序
  treeClusters.sort((a, b) => a.distance - b.distance);

  // 过滤：排除被水/岩浆包围超过一半的
  const reachable = treeClusters.filter(t => {
    const waterBlocks = t.blocks.filter(b => b.surroundedByLiquid).length;
    return waterBlocks < t.blocks.length * 0.5;
  });

  logAction('砍树', '发现' + treeClusters.length + '棵树(' + reachable.length + '棵可达)');
  bot.chat('发现' + treeClusters.length + '棵树(' + reachable.length + '棵可达)，开始砍！');
  console.log('🌲 聚类: ' + reachable.map(c =>
    c.blocks[0].name + '(' + c.blocks.length + '块,' + c.distance + 'm,' +
    'Y' + c.minY + '-' + c.maxY + ')'
  ).join(' | '));

  let treesDone = 0, totalBlocks = 0;

  for (const cluster of reachable) {
    if (state !== 'chop') break;

    try {
      // 找树根（最低 log），先走到树侧面（不站正下方），再开始砍
      const root = findTreeRoot(cluster);
      console.log('🪓 树 #' + (treesDone + 1) + ': ' + root.name + ' Y' + root.y + ' ' + root.distance + 'm');
      await goToTreeSide(root);

      // 砍掉整棵树的所有log blocks（从下往上）
      const sorted = cluster.blocks.slice().sort((a, b) => a.y - b.y);
      let treeBlocks = 0;

      for (const lb of sorted) {
        if (state !== 'chop') break;
        const block = bot.blockAt(lb.pos);
        if (!block || !TREE_LOGS.includes(block.name)) continue;

        // 微调位置：确保水平距离在 reach 内（走一步代替跳）
        await ensureReachableForBlock(lb);

        // 高度差 ≤2.5 直接跳砍/站砍（跳跃能到 Y+2）；只有更高才垫高
        const dy = lb.y - bot.entity.position.y;
        if (dy > 2.5) {
          try { await pillarUp(Math.max(1, Math.ceil(dy) - 2)); } catch(e) {
            console.log('  垫高失败: ' + (e.message || e).slice(0, 30));
          }
          await sleep(200);
        }
        try {
          await bot.collectBlock.collect(block, { timeout: 20000 });
          treeBlocks++;
          totalBlocks++;
        } catch(e) {
          console.log('  ✗ Y' + lb.y + ': ' + e.message.slice(0, 30));
          // 如果一块砍不了，尝试下一块
          continue;
        }
      }

      // 砍完一棵树 → 下树/下柱，避免困在树冠或自己垫的柱子上
      await descendIfHigh();

      if (treeBlocks > 0) {
        treesDone++;
        console.log('  ✅ 树完成: ' + treeBlocks + '块');
      }
    } catch(e) {
      console.log('  树失败: ' + e.message.slice(0, 40));
      // 树砍失败也可能被困在柱子上，先下树再处理下一棵
      try { await descendIfHigh(); } catch(e2) {}
      continue;
    }
  }

  // 兜底：整个砍树流程结束前再检查一次，确保不在高处（树冠/柱子）
  await descendIfHigh();

  logAction('砍树', '砍完: ' + treesDone + '棵树共' + totalBlocks + '块');
  bot.chat('砍完了！' + treesDone + '棵树，共' + totalBlocks + '块木头');
  // 自动确保有基础工具
  if (totalBlocks >= 1) {
    const hasPickaxe = bot.inventory.items().some(i => i.name.includes('pickaxe'));
    const hasTable = bot.inventory.items().some(i => i.name === 'crafting_table');
    if (!hasPickaxe && hasTable) {
      console.log('🔧 自动做木镐...');
      await craftTool('wooden_pickaxe');
    }
  }
  // 若期间被新指令打断（state 已变），不要覆盖新状态
  resetIfState('chop');
  return totalBlocks;
}

// ==== 全高度树木扫描 + 聚类 ====
function scanForTrees(radius) {
  const pos = bot.entity.position;

  // 使用 bot.findBlocks 进行全Y轴搜索
  const allLogs = bot.findBlocks({
    matching: b => TREE_LOGS.includes(b.name),
    maxDistance: radius,
    count: 200,
  });

  if (allLogs.length === 0) return [];

  // 按位置聚类：同一个 XZ 坐标上下的log属于同一棵树
  const clusterMap = new Map();

  for (const logPos of allLogs) {
    const dist = Math.round(pos.distanceTo(logPos));
    const block = bot.blockAt(logPos);
    if (!block || !TREE_LOGS.includes(block.name)) continue;

    // 聚类key: XZ坐标（同一列=同一棵树）
    const key = logPos.x + ',' + logPos.z;

    if (!clusterMap.has(key)) {
      clusterMap.set(key, {
        blocks: [],
        distance: dist,
        minY: logPos.y,
        maxY: logPos.y,
      });
    }

    const cluster = clusterMap.get(key);
    // 检查周围是否有水/岩浆
    let surroundedByLiquid = false;
    for (const [sx, sz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const sb = bot.blockAt(logPos.offset(sx, 1, sz));
      if (sb && (sb.name === 'water' || sb.name === 'lava')) {
        surroundedByLiquid = true;
        break;
      }
    }

    cluster.blocks.push({
      pos: logPos,
      name: block.name,
      x: logPos.x, y: logPos.y, z: logPos.z,
      distance: dist,
      surroundedByLiquid,
    });

    if (logPos.y < cluster.minY) cluster.minY = logPos.y;
    if (logPos.y > cluster.maxY) cluster.maxY = logPos.y;
    if (dist < cluster.distance) cluster.distance = dist;
  }

  return Array.from(clusterMap.values());
}

// ==== 找树根：聚类中最低的 log ====
function findTreeRoot(cluster) {
  let root = cluster.blocks[0];
  for (const b of cluster.blocks) {
    if (b.y < root.y) root = b;
  }
  return root;
}

// ==== 走到树侧面（不站正下方，水平偏移1-2格）====
async function goToTreeSide(root) {
  const bp = bot.entity.position;
  const groundY = root.y - 1; // 树根底下的地面方块层
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let best = null, bestDist = Infinity;

  for (const [dx, dz] of dirs) {
    const sx = root.x + dx, sz = root.z + dz;
    const standBlock = bot.blockAt(new Vec3(sx, groundY, sz));
    if (!standBlock) continue;
    const sn = standBlock.name;
    if (sn === 'air' || sn === 'cave_air' || sn === 'water' || sn === 'lava') continue;
    // 站上去后 bot 身体占 groundY+1，头顶占 groundY+2 → 这两层都要空
    const bodyBlock = bot.blockAt(new Vec3(sx, groundY + 1, sz));
    if (bodyBlock && bodyBlock.name !== 'air' && bodyBlock.name !== 'cave_air') continue;
    const headBlock = bot.blockAt(new Vec3(sx, groundY + 2, sz));
    if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air') continue;
    const targetFeet = groundY + 1;
    const d = Math.hypot(sx + 0.5 - bp.x, targetFeet - bp.y, sz + 0.5 - bp.z);
    if (d < bestDist) { bestDist = d; best = { x: sx + 0.5, y: targetFeet, z: sz + 0.5 }; }
  }

  if (!best) {
    // 全被挡（如丛林树根部被树叶包围）→ 退而求其次，站到树根侧面的地面
    best = { x: root.x + 1.5, y: root.y, z: root.z + 0.5 };
  }

  try {
    await bot.pathfinder.goto(new GoalNear(best.x, best.y, best.z, 1));
    await sleep(300);
  } catch(e) {
    console.log('  到树侧失败: ' + (e.message || e).slice(0, 30));
  }
}

// ==== 砍方块前微调：确保水平距离在 reach 内（走一步代替跳）====
async function ensureReachableForBlock(lb) {
  const p = bot.entity.position;
  const hDist = Math.hypot(lb.x + 0.5 - p.x, lb.z + 0.5 - p.z);
  if (hDist <= 2.5) return;
  try {
    await bot.pathfinder.goto(new GoalNear(lb.x, Math.floor(p.y), lb.z, 1.2));
    await sleep(200);
  } catch(e) {}
}

// ==== 周围地面高度（中位数，返回"脚底高度"）====
function surroundingGroundLevel(bx, bz, feetY) {
  const levels = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (dx * dx + dz * dz > 9) continue;
      for (let y = feetY + 1; y >= -64; y--) {
        const b = bot.blockAt(new Vec3(bx + dx, y, bz + dz));
        if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'water' || b.name === 'lava') continue;
        // 树叶/原木/木板 → 不是地面，继续往下找
        if (b.name.includes('leaves') || TREE_LOGS.includes(b.name) || b.name.includes('planks')) continue;
        levels.push(y + 1);
        break;
      }
    }
  }
  if (levels.length < 3) return null;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length / 2)];
}

// ==== 在 (x,z) 列，从 startY 往下找最近支撑块的"脚底高度" ====
function findNextSupportFeetY(x, z, startY) {
  for (let y = startY; y >= -64; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water' && b.name !== 'lava') {
      return y + 1;
    }
  }
  return -64;
}

// ==== 找脚下同层的侧边树叶（用于在树冠里开路）====
function findSideLeaf(bx, bz, feetY) {
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const b = bot.blockAt(new Vec3(bx + dx, feetY - 1, bz + dz));
    if (b && b.name.includes('leaves')) return b;
  }
  return null;
}

// ==== 找附近可走的地面并走过去（下树用）====
async function walkToNearbyGround(currentFeetY) {
  const p = bot.entity.position;
  const bx = Math.floor(p.x), bz = Math.floor(p.z);
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (dx * dx + dz * dz > 20) continue;
      const support = findNextSupportFeetY(bx + dx, bz + dz, currentFeetY - 1);
      if (support < -60) continue;
      const drop = currentFeetY - support;
      if (drop >= 0 && drop <= 2) {
        try {
          await bot.pathfinder.goto(new GoalNear(bx + dx + 0.5, support, bz + dz + 0.5, 1));
          await sleep(300);
          return true;
        } catch(e) {}
      }
    }
  }
  return false;
}

// ==== 下树/下柱：砍完树后若站在高处（树冠/自己垫的柱子），挖脚下回到地面 ====
async function descendIfHigh() {
  const pos = bot.entity.position;
  const feetY0 = Math.floor(pos.y);
  const targetGround = surroundingGroundLevel(Math.floor(pos.x), Math.floor(pos.z), feetY0);
  if (targetGround === null) return;
  if (feetY0 <= targetGround + 1) return; // 不在高处

  console.log('⬇️ 下树/下柱: 当前Y' + feetY0 + ' 地面Y≈' + targetGround + '（差' + (feetY0 - targetGround) + '格）');
  logAction('下树', '当前Y' + feetY0 + ' 地面Y≈' + targetGround + ' 差' + (feetY0 - targetGround) + '格');

  let lastY = feetY0, stuck = 0;
  for (let step = 0; step < 40; step++) {
    const p = bot.entity.position;
    const bx = Math.floor(p.x), bz = Math.floor(p.z);
    const feetY = Math.floor(p.y);
    if (feetY <= targetGround) { console.log('⬇️ 已回到地面'); bot.chat('下树了！'); return; }

    const below = bot.blockAt(new Vec3(bx, feetY - 1, bz));
    if (!below || below.name === 'air' || below.name === 'cave_air' || below.name === 'water' || below.name === 'lava' || below.name === 'bedrock') {
      console.log('⬇️ 脚下无法挖掘，停止'); return;
    }

    const isPlaced = placedBlocks.some(bp => bp.equals(below.position));
    const isRemovable = isPlaced || TREE_LOGS.includes(below.name) || below.name.includes('leaves');

    if (!isRemovable) {
      console.log('⬇️ 脚下是自然方块(' + below.name + ')，视为回到地面'); return;
    }

    // 挖掉脚下后的下落距离（>3 有摔落风险）
    const nextSupport = findNextSupportFeetY(bx, bz, feetY - 2);
    const fall = feetY - nextSupport;

    if (fall > 3) {
      // 摔落危险 → 先清开侧边树叶（树冠里开路）
      const sideLeaf = findSideLeaf(bx, bz, feetY);
      if (sideLeaf) {
        try { await equipBestToolFor('leaves'); } catch(e) {}
        try { await bot.dig(sideLeaf); await sleep(200); } catch(e) {}
        continue;
      }
      // 或找附近可走的地面走过去
      const moved = await walkToNearbyGround(feetY - 1);
      if (moved) { lastY = Math.floor(bot.entity.position.y); continue; }
      console.log('  ⚠️ 无安全下法，硬挖（掉' + fall + '格）');
    }

    if (!canMine(below)) { console.log('⬇️ 脚下挖不动(' + below.name + ')，停止'); return; }
    try { await equipBestToolFor(below.name); } catch(e) {}
    try {
      await bot.dig(below);
      if (isPlaced) placedBlocks = placedBlocks.filter(bp => !bp.equals(below.position));
      await sleep(500);
    } catch(e) {
      console.log('⬇️ 挖脚下方块失败: ' + (e.message || e).slice(0, 30));
      return;
    }

    // 连续几轮没下降 → 防止死循环
    const ny = Math.floor(bot.entity.position.y);
    if (ny >= lastY) { if (++stuck > 4) { console.log('⬇️ 无法继续下降，停止'); return; } }
    else stuck = 0;
    lastY = ny;
  }
  console.log('⬇️ 下树循环结束');
}

// ==== 漫游找树：随机方向走30-50格，最多3轮 ====
async function wanderSearchForTrees() {
  for (let round = 1; round <= 3; round++) {
    // 漫游期间收到新指令（state 被改变）→ 中断漫游
    if (state !== 'chop') { bot.pathfinder?.setGoal(null); return []; }
    bot.chat('这边没树，我去别处找找(' + round + '/3)');
    let moved = false;
    // 随机方向最多试3次，目标不可达就换方向
    for (let attempt = 0; attempt < 3 && !moved; attempt++) {
      if (state !== 'chop') { bot.pathfinder?.setGoal(null); return []; }
      const p = bot.entity.position;
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.floor(Math.random() * 21); // 30-50格
      // 目标点 = 当前位置 + 随机水平向量，Y 保持当前
      const target = p.offset(Math.round(Math.sin(angle) * dist), 0, Math.round(Math.cos(angle) * dist));
      try {
        await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 2));
        moved = true;
      } catch(e) {
        console.log('漫游方向不可达，换方向重试: ' + (e.message || e).slice(0, 30));
      }
    }
    if (!moved) continue; // 这轮没走动，直接下一轮
    // 走完重新扫描
    const clusters = scanForTrees(192);
    if (clusters.length > 0) return clusters;
  }
  return [];
}

// ==== 地形扫描（保留用作可视化） ====
function scanTerritory(radius) {
  const pos = bot.entity.position;
  const resources = [];
  const obstacles = [];

  // 全Y轴扫描
  for (let dx = -radius; dx <= radius; dx += 3) {
    for (let dz = -radius; dz <= radius; dz += 3) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) continue;

      // 扫描多个Y层
      for (let dy = -2; dy <= 6; dy++) {
        const checkPos = pos.floored().offset(dx, dy, dz);
        const block = bot.blockAt(checkPos);
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;

        const name = block.name;
        const entry = {
          name, relX: dx, relZ: dz, relY: dy,
          distance: Math.round(dist), pos: checkPos,
          surrounding: [],
        };

        if (TREE_LOGS.includes(name) || ORES.includes(name)) {
          resources.push(entry);
        }
        if (name === 'water' || name === 'lava') {
          obstacles.push(entry);
        }
      }
    }
  }

  return { resources, obstacles, radius, center: pos };
}

// ==== 可视化扫描结果 ====
function visualizeScan(map) {
  const grid = [];
  const size = map.radius * 2 + 1;
  for (let i = 0; i < size; i++) {
    grid[i] = new Array(size).fill('.');
  }

  const cx = map.radius, cz = map.radius;
  grid[cx][cz] = 'B'; // Bot position

  for (const r of map.resources) {
    const x = cx + r.relX, z = cz + r.relZ;
    if (x >= 0 && x < size && z >= 0 && z < size) {
      grid[z][x] = TREE_LOGS.includes(r.name) ? 'T' : 'O'; // Tree or Ore
    }
  }
  for (const o of map.obstacles) {
    const x = cx + o.relX, z = cz + o.relZ;
    if (x >= 0 && x < size && z >= 0 && z < size) {
      grid[z][x] = o.name === 'water' ? 'W' : 'L'; // Water or Lava
    }
  }

  // Print to console (scaled down)
  const scale = Math.max(1, Math.floor(size / 40));
  let output = '地形图(B=我 T=树 O=矿 W=水):\n';
  for (let z = 0; z < size; z += scale) {
    let line = '';
    for (let x = 0; x < size; x += scale) {
      line += grid[z][x];
    }
    output += line + '\n';
  }
  console.log(output);
  return output;
}

async function collectOres() {
  setState('mining');
  logAction('挖矿', '开始挖矿');
  bot.chat('扫描矿脉（全高度）...');

  // 全Y轴搜索矿石
  const allOres = bot.findBlocks({
    matching: b => ORES.includes(b.name),
    maxDistance: 32,
    count: 50,
  });

  if (allOres.length === 0) {
    bot.chat('附近32格内没矿...');
    resetIfState('mining'); return 0;
  }

  // 按距离排序
  const sorted = allOres
    .map(p => ({ pos: p, dist: Math.round(bot.entity.position.distanceTo(p)) }))
    .sort((a, b) => a.dist - b.dist);

  const uniqueOres = [];
  const seen = new Set();
  for (const o of sorted) {
    const k = o.pos.x+','+o.pos.y+','+o.pos.z;
    if (!seen.has(k)) { seen.add(k); uniqueOres.push(o); }
  }

  bot.chat('发现' + uniqueOres.length + '处矿！开挖');
  console.log('⛏️ 矿石: ' + uniqueOres.slice(0,10).map(o =>
    bot.blockAt(o.pos)?.name + '(' + o.dist + 'm,Y' + o.pos.y + ')'
  ).join(', '));

  let count = 0, skipped = 0;

  for (const ore of uniqueOres.slice(0, 20)) {
    if (state !== 'mining') break;
    const block = bot.blockAt(ore.pos);
    if (!block || !ORES.includes(block.name)) { skipped++; continue; }

    try {
      await bot.collectBlock.collect(block, { timeout: 25000 });
      count++;
    } catch(e) {
      console.log('✗ ' + block.name + ': ' + e.message.slice(0, 30));
      skipped++;
      continue;
    }
  }

  logAction('挖矿', '完成: ' + count + '块，跳过' + skipped);
  bot.chat('挖完！' + count + '块，跳过' + skipped);
  resetIfState('mining');
  return count;
}

// ============ Combat ============
async function fightNearest() {
  const mobs = Object.values(bot.entities).filter(e =>
    (e.type === 'mob' || e.type === 'hostile') &&
    e.position.distanceTo(bot.entity.position) < 20
  );
  if (mobs.length === 0) return false;
  mobs.sort((a,b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  return fightEntity(mobs[0]);
}

async function fightEntity(mob) {
  if (state === 'fighting') return true;
  setState('fighting');
  logAction('战斗', '开始战斗: ' + (mob.displayName || mob.name || mob.type));
  await autoEquip();

  try {
    await bot.pathfinder.goto(new GoalNear(mob.position.x, mob.position.y, mob.position.z, 2));
    for (let i = 0; i < 20 && state === 'fighting'; i++) {
      const m = bot.entities[mob.id];
      if (!m || !m.isValid) { bot.chat('解决了！'); break; }
      await bot.lookAt(m.position.offset(0, 1.5, 0));
      await bot.attack(m);
      await sleep(400);
    }
  } catch(e) { console.log('战斗失败: ' + e.message); }
  resetIfState('fighting');
  return true;
}

// ============ General Crafting ============
const TOOL_RECIPES = {
  'wooden_sword': { needs: ['stick:1', 'planks:2'], table: true },
  'wooden_pickaxe': { needs: ['stick:2', 'planks:3'], table: true },
  'wooden_axe': { needs: ['stick:2', 'planks:3'], table: true },
  'wooden_shovel': { needs: ['stick:2', 'planks:1'], table: true },
  'wooden_hoe': { needs: ['stick:2', 'planks:2'], table: true },
  'stone_sword': { needs: ['stick:1', 'cobblestone:2'], table: true },
  'stone_pickaxe': { needs: ['stick:2', 'cobblestone:3'], table: true },
  'stone_axe': { needs: ['stick:2', 'cobblestone:3'], table: true },
  'stick': { needs: ['planks:2'], table: false },
};

async function craftTool(toolName, username) {
  logAction('制作', '开始 ' + toolName);
  bot.chat('做' + toolName + '...');
  const itemInfo = mcData.itemsByName[toolName];
  if (!itemInfo) {
    // Try to find by partial match
    const match = Object.entries(mcData.itemsByName).find(([k, v]) =>
      k.includes(toolName) || k.includes(toolName.replace('wooden_', '').replace('stone_', '')));
    if (!match) { bot.chat('不知道' + toolName + '怎么做'); return false; }
    toolName = match[0];
  }

  // 检查是否已经有了
  const existing = bot.inventory.items().find(i => i.name === toolName);
  if (existing) {
    bot.chat(toolName + '已经有了！扔给你~');
    try { await bot.toss(existing.type, null, 1); } catch(e) {}
    return true;
  }

  // 查找配方
  const itemId = mcData.itemsByName[toolName]?.id;
  if (!itemId) { bot.chat('找不到' + toolName + '的物品ID'); return false; }

  const recipe = bot.recipesFor(itemId, null, 1, true)?.[0];
  if (!recipe) {
    // 尝试不用crafting table
    const recipe2 = bot.recipesFor(itemId, null, 1, false)?.[0];
    if (!recipe2) {
      bot.chat('找不到' + toolName + '的配方...手动做吧');
      return false;
    }
  }

  // 检查是否需要crafting table
  const needsTable = recipe?.requiresTable ?? true;

  // 确保有crafting table
  if (needsTable) {
    const hasTable = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (!hasTable) {
      bot.chat('先做合成台...');
      const ok = await makeCraftingTable();
      if (!ok) return false;
    }
  }

  // 确保有原料：先检查并补充
  // 简化：检查总木板数和总木棍数
  let planks = bot.inventory.items().filter(i => i.name.includes('planks'));
  let totalPlanks = planks.reduce((s, i) => s + i.count, 0);

  // 如果不够，从木头做木板
  if (totalPlanks < 4) {
    const logs = bot.inventory.items().filter(i => TREE_LOGS.includes(i.name));
    if (logs.length > 0) {
      const plankName = logs[0].name.replace('_log', '_planks').replace('_wood', '_planks');
      const plankItem = mcData.itemsByName[plankName] || mcData.itemsByName['oak_planks'];
      if (plankItem) {
        const pr = bot.recipesFor(plankItem.id, null, 1, true)?.[0];
        if (pr) {
          try { await bot.craft(pr, Math.min(logs[0].count, 4)); } catch(e) {}
        }
      }
    }
  }

  // 确保有木棍
  let sticks = bot.inventory.items().find(i => i.name === 'stick');
  if (!sticks || sticks.count < 2) {
    const stickItem = mcData.itemsByName['stick'];
    if (stickItem) {
      const sr = bot.recipesFor(stickItem.id, null, 1, true)?.[0];
      if (sr) {
        try { await bot.craft(sr, 1); } catch(e) {}
      }
    }
  }

  // 重新查配方并合成
  const finalRecipe = bot.recipesFor(itemId, null, 1, true)?.[0] || bot.recipesFor(itemId, null, 1, false)?.[0];
  if (!finalRecipe) {
    bot.chat('还是找不到配方...');
    return false;
  }

  try {
    await bot.craft(finalRecipe, 1);
    const done = bot.inventory.items().find(i => i.name === toolName);
    if (done) {
      bot.chat(toolName + '做好了！扔给你~');
      logAction('制作', '完成 ' + toolName);
      try { await bot.toss(done.type, null, 1); } catch(e) {}
      return true;
    }
    logAction('制作', '失败 ' + toolName + '(合成执行但未成功)');
    bot.chat('合成执行了但没成功...');
    return false;
  } catch(e) {
    console.log('❌ 合成' + toolName + ': ' + e.message);
    logAction('制作', '失败 ' + toolName + ': ' + e.message.slice(0, 30));
    bot.chat('合成失败: ' + e.message.slice(0, 30));
    return false;
  }
}

// ============ Crafting Table ============
async function makeCraftingTable() {
  // Already have one?
  const existingTable = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (existingTable) {
    console.log('✅ 已有合成台x' + existingTable.count);
    return true;
  }
  logAction('制作', '开始 合成台');

  // Step 1: Count planks
  const planks = bot.inventory.items().filter(i => i.name.includes('planks'));
  const totalPlanks = planks.reduce((sum, i) => sum + i.count, 0);
  console.log('📋 木板: ' + totalPlanks + '块 (' + planks.map(i=>i.name+'x'+i.count).join(',') + ')');

  // Step 2: If not enough planks, need to craft planks from logs
  if (totalPlanks < 4) {
    const logs = bot.inventory.items().filter(i => TREE_LOGS.includes(i.name));
    const totalLogs = logs.reduce((sum, i) => sum + i.count, 0);
    console.log('🪵 木头: ' + totalLogs + '块');

    if (totalLogs < 1) {
      console.log('❌ 没有木头，砍树先');
      bot.chat('先砍树...');
      // Chop one tree
      const log = bot.findBlock({ matching: b => TREE_LOGS.includes(b.name), maxDistance: 16 });
      if (!log) { bot.chat('附近没树'); return false; }
      try {
        await bot.collectBlock.collect(log, { timeout: 20000 });
      } catch(e) {
        bot.chat('砍树失败: ' + e.message.slice(0, 20));
        return false;
      }
    }

    // Re-check logs
    const logs2 = bot.inventory.items().filter(i => TREE_LOGS.includes(i.name));
    if (logs2.length > 0) {
      // Craft planks from first available log
      const logType = logs2[0].name; // e.g. "oak_log"
      const plankName = logType.replace('_log', '_planks').replace('_wood', '_planks');
      const plankItem = mcData.itemsByName[plankName] || mcData.itemsByName['oak_planks'];

      if (plankItem) {
        const plankRecipe = bot.recipesFor(plankItem.id, null, 1, true)?.[0];
        console.log('🔨 木板配方: ' + (plankRecipe ? '找到' : '未找到') + ' 目标:' + plankName + ' id:' + plankItem.id);
        if (plankRecipe) {
          try {
            await bot.craft(plankRecipe, Math.ceil(4 / 4)); // 1 log = 4 planks
            console.log('✅ 木板已制作');
          } catch(e) {
            console.log('❌ 木板合成失败: ' + e.message);
            // Try crafting with count 1
            try {
              await bot.craft(plankRecipe, 1);
              console.log('✅ 木板已制作(1次)');
            } catch(e2) {
              console.log('❌ 再次失败: ' + e2.message);
              bot.chat('木板做不了...手动做吧');
              return false;
            }
          }
        }
      }
    }
  }

  // Step 3: Re-check planks
  const planks3 = bot.inventory.items().filter(i => i.name.includes('planks'));
  const total3 = planks3.reduce((sum, i) => sum + i.count, 0);
  console.log('📋 木板(重新检查): ' + total3 + '块');

  if (total3 < 4) {
    console.log('❌ 木板不足4块: ' + total3);
    logAction('制作', '失败 合成台: 木板不足(' + total3 + '/4)');
    bot.chat('木板不够(' + total3 + '/4块)，还需要砍树');
    return false;
  }

  // Step 4: Craft crafting table
  const tableItem = mcData.itemsByName['crafting_table'];
  console.log('🔨 合成台物品ID: ' + (tableItem?.id || '未找到'));

  if (!tableItem) {
    bot.chat('找不到合成台配方ID');
    return false;
  }

  const tableRecipe = bot.recipesFor(tableItem.id, null, 1, true)?.[0];
  console.log('🔨 合成台配方: ' + (tableRecipe ? '找到' : '未找到'));

  if (tableRecipe) {
    try {
      await bot.craft(tableRecipe, 1);
      // Verify
      const verify = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (verify) {
        console.log('✅ 合成台制作成功！');
        logAction('制作', '完成 合成台');
        bot.chat('合成台做好了！扔地上了，快捡~'); try { await bot.toss(verify.type, null, 1); } catch(e) {}
        return true;
      } else {
        console.log('❌ 合成后仍未找到合成台');
        bot.chat('合成执行了但没看到合成台...');
        return false;
      }
    } catch(e) {
      console.log('❌ 合成台制作失败: ' + e.message);
      logAction('制作', '失败 合成台: ' + e.message.slice(0, 30));
      bot.chat('合成失败: ' + e.message.slice(0, 30));
      return false;
    }
  } else {
    console.log('❌ 找不到合成台配方');
    logAction('制作', '失败 合成台: 找不到配方');
    bot.chat('找不到合成台配方...手动做吧4块木板');
    return false;
  }
}

// ============ Collect Drops ============
async function collectDrops(silent) {
  const items = Object.values(bot.entities).filter(e => e.name === 'item' || e.objectType === 'Item');
  if (items.length === 0) { if (!silent) bot.chat('附近没有掉落物'); return; }
  for (const item of items.slice(0, 10)) {
    try {
      await bot.collectBlock.collect(item);
    } catch(e) {}
  }
  if (!silent) bot.chat('捡完了！');
}

// ============ AI Code Generation (Voyager-style) ============
async function aiGenerateCode(username, task) {
  setState('ai-code');
  logAction('AI代码', '开始: ' + task);
  const prompt = `Minecraft bot task: "${task}"

Available variables:
- bot: Mineflayer bot (DO NOT call bot.end(), bot.quit(), process.exit())
- mcData: minecraft-data for 1.20.1
- TREE_LOGS = [${TREE_LOGS.slice(0,6).join(',')}]
- ORES = [${ORES.slice(0,6).join(',')}]
- GoalNear, GoalBlock, GoalFollow: from mineflayer-pathfinder goals
- Vec3: from vec3 library
- sleep(ms): promise-based delay

Key APIs:
- bot.chat(msg), bot.findBlock({matching,m maxDistance}), bot.findBlocks({matching,maxDistance,count})
- bot.collectBlock.collect(block, {timeout}), bot.blockAt(pos)
- bot.inventory.items(), bot.equip(item,'hand'), bot.attack(entity)
- bot.pathfinder.goto(goal), bot.lookAt(pos)
- Bot position: bot.entity.position

Output ONLY JavaScript code (no markdown, no explanation). Max 10 lines. No require(). No infinite loops (while(true) will timeout and be abandoned).`;

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Output only raw JavaScript code. No explanation, no markdown fences. Never call process.exit or bot.end.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200, temperature: 0.3,
      }),
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    let code = data.choices[0].message.content.trim();
    code = code.replace(/```js\n?|```javascript\n?|```\n?/g, '').trim();
    // Block dangerous calls（第二道防线）
    if (code.includes('bot.end(') || code.includes('process.exit') || code.includes('bot.quit(') || code.includes('require(') || code.includes('global.')) {
      bot.chat('那个操作不安全，我不能做');
      logAction('AI代码', '失败: 含危险调用被拦截');
      resetIfState('ai-code');
      return null;
    }

    console.log('📝 代码: ' + code.slice(0, 120));

    // Execute with retries — vm 沙箱同步超时 + 异步 30s 看门狗
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 白名单 context：仅暴露 bot/mcData/TREE_LOGS/ORES/GoalNear/GoalBlock/GoalFollow/Vec3/sleep，不暴露 process/require/global
        const sandbox = { bot, mcData, TREE_LOGS, ORES, GoalNear, GoalBlock, GoalFollow, Vec3, sleep };
        let execPromise;
        try {
          execPromise = vm.runInNewContext('(async () => {' + code + '})()', sandbox, { timeout: 10000 });
        } catch (e) {
          if (e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timeout/i.test(e.message))) {
            throw new Error('代码同步卡死(超时)');
          }
          throw e;
        }
        // 异步阶段看门狗（30s）
        await Promise.race([
          Promise.resolve(execPromise),
          new Promise((_, reject) => setTimeout(() => reject(new Error('代码执行超时(30s)')), 30000)),
        ]);
        console.log('✅ 执行成功');
        saveSkill(task.slice(0, 30), task, code);
        resetIfState('ai-code');
        return { action: 'ai-code', ok: true, desc: '完成: ' + task };
      } catch(e) {
        console.log('⚠️ #' + (attempt+1) + ': ' + e.message.slice(0,60));
        if (/超时/.test(e.message)) {
          // 超时不再重试，告知玩家并复位 state
          console.log('⚠️ 代码卡住，放弃');
          logToFile('⚠️ [超时] ' + e.message);
          logAction('AI代码', '超时放弃: ' + e.message);
          try { bot.chat('这个任务卡住了，我放弃了'); } catch(_) {}
          resetIfState('ai-code');
          return { action: 'ai-code', ok: false, desc: '代码卡住超时' };
        }
        if (attempt < 2) {
          const fixResp = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: 'Fix the error. Output only corrected code.' },
                { role: 'user', content: `Code:\n${code}\n\nError: ${e.message}\n\nFixed code:` }
              ],
              max_tokens: 200, temperature: 0.2,
            }),
          });
          const fixData = await fixResp.json();
          if (!fixData.error) {
            code = fixData.choices[0].message.content.trim();
            code = code.replace(/```js\n?|```javascript\n?|```\n?/g, '').trim();
          }
        }
      }
    }
    autoLearn(task, '代码执行3次均失败'); // 自动搜索解决方案
    logAction('AI代码', '失败: 3次执行均失败');
    resetIfState('ai-code');
    return { action: 'ai-code', ok: false, desc: '代码失败' };
  } catch(e) {
    console.log('❌ AI代码: ' + e.message);
    logToFile('❌ [API错误] ' + e.message);
    resetIfState('ai-code');
    return null;
  }
}

// ============ Web Search & Auto-Learning ============
async function webSearch(query) {
  logAction('搜索', '开始: ' + query);
  try {
    const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent('minecraft ' + query);
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const html = await resp.text();
    const snippets = [];
    const snippetPattern = /<td[^>]*class="result-snippet"[^>]*>([^<]+)/gi;
    let m;
    while ((m = snippetPattern.exec(html)) !== null) {
      snippets.push(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      if (snippets.length >= 5) break;
    }
    if (snippets.length === 0) return null;
    return snippets.join(' | ').slice(0, 800);
  } catch(e) {
    console.log('🔍 搜索失败: ' + e.message);
    logToFile('🔍 [搜索失败] ' + e.message);
    logAction('搜索', '失败: ' + e.message);
    return null;
  }
}

// Ask AI with optional search context
async function askAIWithSearch(question, systemPrompt, doSearch) {
  let context = '';
  if (doSearch !== false) {
    const sr = await webSearch(question);
    if (sr) context = '\n参考资料(搜索):\n' + sr;
  }
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt || 'Minecraft专家，回答简短实用，40字内。' },
        { role: 'user', content: question + context }
      ],
      max_tokens: 100, temperature: 0.5,
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content.trim();
}

// Auto-search on failure - bot learns from mistakes
async function autoLearn(action, error) {
  console.log('🔍 自动学习: ' + action + ' 原因: ' + error);
  try {
    const answer = await askAIWithSearch(action + ' 失败了: ' + error + ' 怎么办？', '你是Minecraft生存专家。给出1个具体解决步骤，30字内。');
    if (answer) bot.chat('查了攻略: ' + answer);
    return answer;
  } catch(e) {
    console.log('❌ 自动学习失败: ' + e.message);
    logToFile('❌ [API错误] ' + e.message);
    return null;
  }
}

// Smart chat with auto-search
async function smartChat(username, msg) {
  // 只保留明确求攻略的词，去掉"哪/什么/为什么"等过宽词，避免无谓搜索超时
  const kws = ['怎么做','怎么合成','配方','教程','攻略','wiki','材料','搜索','查一下','查查','!search','搜一下'];
  if (kws.some(k => msg.includes(k))) {
    bot.chat('查攻略中...');
    return await askAIWithSearch(msg, 'Minecraft专家，用搜索结果回答，30字内简明实用。');
  }
  return null;
}

// ============ Follow ============
let lastPillarTime = 0; // 上次搭柱时间（防止跟随中反复垫高）
function startFollow(username) {
  stopFollow();
  setState('follow');
  logAction('跟随', '开始跟随 ' + username);
  followLoop(username);
}

async function followLoop(username) {
  if (state !== 'follow' || !bot.entity) return;
  const p = bot.players[username]?.entity;
  if (!p) { setTimeout(() => followLoop(username), 500); return; }
  const dist = bot.entity.position.distanceTo(p.position);
  // 目标较高且距离近 → 垫高再靠近（3秒内不重复搭柱，配合寻路）
  if (dist < 6) {
    const h = needsPillar(p.position);
    if (h > 0 && Date.now() - lastPillarTime > 3000) {
      lastPillarTime = Date.now();
      bot.pathfinder?.setGoal(null); // 先清掉旧目标，避免边跳边走导致垫块失败
      try { await pillarUp(h); } catch(e) {}
    }
  }
  if (dist > 3) {
    // 中近距离也走 pathfinder：寻路会自然跳跃/绕开 1 格台阶，不会像手动直走那样遇坎卡住
    // （sprint 由 pathfinder 内部按 allowSprinting 控制，无需手动开）
    bot.pathfinder.setGoal(new GoalNear(p.position.x, p.position.y, p.position.z, 2));
  } else {
    bot.pathfinder.setGoal(null);
    clearControls();
    bot.lookAt(p.position.offset(0, 1.6, 0));
  }
  setTimeout(() => followLoop(username), 250);
}

function stopFollow() {
  setState('idle');
  logAction('跟随', '停止跟随');
  bot.pathfinder?.setGoal(null);
  clearControls();
  startIdle();
}

async function goTo(username) {
  const p = bot.players[username]?.entity;
  if (!p) { bot.chat('看不到你'); return; }
  setState('goto');
  logAction('前往', '开始前往 ' + username);
  bot.chat('来了！');
  try {
    // 目标比bot高≥2格 → 先垫高再过去（失败降级，继续寻路）
    const h = needsPillar(p.position);
    if (h > 0) {
      bot.pathfinder?.setGoal(null); // 清掉旧目标，避免边跳边走
      try { await pillarUp(h); } catch(e) {}
    }
    await bot.pathfinder.goto(new GoalNear(p.position.x, p.position.y, p.position.z, 2));
    bot.chat('到了~');
    logAction('前往', '到达 ' + username);
  } catch(e) { bot.chat('过不去...'); }
  resetIfState('goto');
}

// ============ Idle Behavior ============
function startIdle() {
  if (state !== 'idle') return;
  clearTimeout(idleTimer);
  idleStep();
}

function idleStep() {
  if (state !== 'idle' || !bot.entity) { clearTimeout(idleTimer); return; }
  clearTimeout(idleTimer);
  const r = Math.random();
  if (r < 0.25) {
    bot.look(Math.random()*Math.PI*2, (Math.random()-0.5)*0.6, true);
  } else if (r < 0.4 && owner) {
    const p = bot.players[owner]?.entity;
    if (p && bot.entity.position.distanceTo(p.position) < 15) {
      bot.lookAt(p.position.offset(0, 1.6, 0));
    }
  } else if (r < 0.5) {
    bot.setControlState('forward', true);
    setTimeout(() => bot.setControlState('forward', false), 1000 + Math.random()*1500);
  } else if (r < 0.55) {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 300);
  }
  idleTimer = setTimeout(idleStep, 2000 + Math.random()*4000);
}

// ============ 智能脱困系统 ============
let lastStuckPos = null;
let stuckTime = 0;
let lastEscape = 0;
let escapeFails = 0;

function startStuckMonitor() {
  setInterval(() => {
    if (!bot || !bot.entity) return;

    // 采集/战斗状态时不要误判——bot在原地工作是正常的
    if (state === 'chop' || state === 'mining' || state === 'fighting' || state === 'digging') {
      stuckTime = 0;
      lastStuckPos = null;
      return;
    }

    const pos = bot.entity.position.floored();
    if (lastStuckPos && pos.x === lastStuckPos.x && pos.y === lastStuckPos.y && pos.z === lastStuckPos.z) {
      stuckTime++;
    } else {
      stuckTime = 0;
      lastStuckPos = pos;
    }

    // 卡住超过10秒且不在采集中 → 脱困（带冷却+连败上限，避免无限垫高死循环）
    if (stuckTime > 10) {
      const now = Date.now();
      // 冷却中(30s)或已连续失败3次 → 暂时放弃脱困，等真正移动后 escapeFails 复位再试
      if (now - lastEscape < 30000 || escapeFails >= 3) {
        stuckTime = 0;
        return;
      }
      console.log('🔓 检测到卡住！尝试脱困...');
      lastEscape = now;
      escapeFails++;
      escapeStuck();
      stuckTime = 0;
    }
  }, 1000);
}

async function escapeStuck() {
  logAction('脱困', '触发脱困');
  const pos = bot.entity.position.floored();

  // 辅助函数：安全挖掘
  async function safeDig(block, desc) {
    if (!block || block.name === 'air' || block.name === 'water' || block.name === 'lava' || block.name === 'bedrock') return false;
    if (!canMine(block)) return false;
    console.log('🔨 ' + desc + ': ' + block.name);
    await equipBestToolFor(block.name);
    try { await bot.dig(block); await sleep(200); return true; } catch(e) { return false; }
  }

  // 1. 头顶
  await safeDig(bot.blockAt(pos.offset(0, 1, 0)), '挖头顶');
  await safeDig(bot.blockAt(pos.offset(0, 2, 0)), '挖头顶2');

  // 2. 前方
  const yaw = bot.entity.yaw;
  const dx = Math.round(-Math.sin(yaw));
  const dz = Math.round(Math.cos(yaw));
  await safeDig(bot.blockAt(pos.offset(dx, 1, dz)), '挖前方高');
  await safeDig(bot.blockAt(pos.offset(dx, 0, dz)), '挖前方低');

  // 3. 在坑里？
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below || below.name === 'air') {
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    setTimeout(() => clearControls(), 2000);
  }

  // 4. 8方向扫描
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1]];
  for (const [dx, dy, dz] of dirs) {
    const block = bot.blockAt(pos.offset(dx, dy, dz));
    // 优先挖软的，跳过硬的（如果没工具）
    const softBlocks = ['dirt','grass_block','sand','gravel','log','leaves','planks','wool'];
    const isSoft = softBlocks.some(n => block?.name?.includes(n));
    if (block && (isSoft || canMine(block))) {
      if (await safeDig(block, '挖障碍')) break;
    }
  }

  // 4.5 仍被困且上方无方块阻挡 → 垫高2-3格脱困
  const headClear = [1, 2, 3].every(dy => {
    const b = bot.blockAt(pos.offset(0, dy, 0));
    return !b || b.name === 'air' || b.name === 'cave_air';
  });
  if (headClear) {
    console.log('📦 尝试垫高脱困...');
    try { await pillarUp(2 + Math.floor(Math.random() * 2)); } catch(e) {}
  }

  // 5. 强制脱困
  bot.setControlState('jump', true);
  bot.setControlState('forward', true);
  setTimeout(() => clearControls(), 1500);
  console.log('🔓 脱困完成');
}

// ============ Pillar Up（垫高自己） ============
async function pillarUp(neededHeight) {
  // 找可垫脚的方块（优先土、圆石）
  const buildBlocks = ['dirt','grass_block','cobblestone','stone','sand','gravel','planks','log','netherrack'];
  const block = bot.inventory.items().find(i => buildBlocks.some(b => i.name.includes(b)));
  if (!block) {
    // 临时挖脚下的方块来用
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (below && below.name !== 'air' && below.name !== 'bedrock' && below.hardness < 50) {
      try {
        await equipBestToolFor(below.name);
        await bot.dig(below);
        await sleep(500);              // 等掉落物出现
        await collectDrops(true);      // 捡回掉落，确保有方块可放
        await sleep(200);              // 等掉落进背包
      } catch(e) {}
    }
  }

  console.log('📦 垫高' + neededHeight + '格...');
  logAction('垫高', '垫高' + neededHeight + '格');
  bot.chat('垫高' + neededHeight + '格...');
  let placed = 0;

  for (let i = 0; i < neededHeight && placed < 10; i++) {
    // 找到可放置的方块
    const buildBlock = bot.inventory.items().find(i => buildBlocks.some(b => i.name.includes(b)));
    if (!buildBlock) break;

    // 看向脚下
    const feetPos = bot.entity.position.offset(0, -1, 0);
    const refBlock = bot.blockAt(feetPos);
    if (!refBlock) break;

    try {
      await bot.equip(buildBlock, 'hand');
      // 跳起来放方块
      bot.setControlState('jump', true);
      await sleep(50);
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      bot.setControlState('jump', false);
      await sleep(200);
      placed++;
      // 记录放置位置，供下树时识别"自己垫的柱子"
      const placedPos = refBlock.position.offset(0, 1, 0).floored();
      if (!placedBlocks.some(bp => bp.equals(placedPos))) placedBlocks.push(placedPos);
      if (placedBlocks.length > 200) placedBlocks = placedBlocks.slice(-100);
    } catch(e) {
      bot.setControlState('jump', false);
      console.log('垫高失败: ' + e.message.slice(0, 30));
      logAction('垫高', '失败: ' + (e.message || '').slice(0, 30));
      break;
    }
  }

  if (placed > 0) console.log('📦 垫了' + placed + '格');
  return placed;
}

// ============ Place Block（放方块/垫脚） ============
// 中文物品名 → mcData 名称（放方块防幻觉用）
const ITEM_ALIAS = {
  '合成台':'crafting_table','工作台':'crafting_table','木板':'planks','木头':'log','原木':'log',
  '圆石':'cobblestone','石头':'stone','泥土':'dirt','土':'dirt','沙子':'sand','沙':'sand',
  '木剑':'wooden_sword','木镐':'wooden_pickaxe','木斧':'wooden_axe','石镐':'stone_pickaxe','石剑':'stone_sword',
  '木棍':'stick','棍子':'stick','火把':'torch','箱子':'chest','熔炉':'furnace','床':'bed','橡木板':'oak_planks',
};

// 背包中按中文/别名查找物品
function findInventoryItem(itemText) {
  const inv = bot.inventory.items();
  let item = inv.find(i => i.name === itemText);
  if (item) return item;
  const alias = ITEM_ALIAS[itemText];
  if (alias) {
    item = inv.find(i => i.name === alias) || inv.find(i => i.name.startsWith(alias));
    if (!item && alias === 'planks') item = inv.find(i => i.name.includes('planks'));
    if (item) return item;
  }
  // 模糊匹配：中文关键词前2字相同（容错"合成图"→"合成台"等笔误）
  for (const [zh, en] of Object.entries(ITEM_ALIAS)) {
    if (itemText.length >= 2 && zh.slice(0, 2) === itemText.slice(0, 2)) {
      const it = inv.find(i => i.name === en) || inv.find(i => i.name.includes(en));
      if (it) return it;
    }
  }
  return inv.find(i => i.name.includes(itemText)) || null;
}

// 真实放置指定物品到面前（放在 bot 脚下前方的空地，成功才说"放好了"）
async function placeBlockAtFront(item, username) {
  const here = bot.entity.position.floored();
  const yaw = bot.entity.yaw;
  const fx = Math.round(-Math.sin(yaw));
  const fz = Math.round(Math.cos(yaw));
  // 候选目标点: 面前1格、面前2格、四周1格（脚层空位）
  const cand = [
    [here.x + fx,     here.y, here.z + fz],
    [here.x + fx * 2, here.y, here.z + fz * 2],
    [here.x + 1, here.y, here.z], [here.x - 1, here.y, here.z],
    [here.x, here.y, here.z + 1], [here.x, here.y, here.z - 1],
  ];
  for (const [tx, ty, tz] of cand) {
    const cell = bot.blockAt(new Vec3(tx, ty, tz));
    if (!cell || (cell.name !== 'air' && cell.name !== 'cave_air')) continue;
    // 参考方块: 优先脚下地面，其次四周
    let ref = null, face = null;
    const below = bot.blockAt(new Vec3(tx, ty - 1, tz));
    if (below && below.name !== 'air' && below.name !== 'cave_air' && below.name !== 'water' && below.name !== 'lava') {
      ref = below; face = new Vec3(0, 1, 0);
    } else {
      for (const [ox, oy, oz] of [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]]) {
        const s = bot.blockAt(new Vec3(tx + ox, ty + oy, tz + oz));
        if (s && s.name !== 'air' && s.name !== 'cave_air' && s.name !== 'water' && s.name !== 'lava') {
          ref = s; face = new Vec3(tx - s.position.x, ty - s.position.y, tz - s.position.z); break;
        }
      }
    }
    if (!ref) continue;
    try {
      await bot.equip(item, 'hand');
      await bot.lookAt(ref.position);
      await bot.placeBlock(ref, face);
      bot.chat('放好了！');
      logToFile('✅ [放置] ' + item.name + ' @ ' + tx + ',' + ty + ',' + tz);
      logAction('放置', '成功 ' + item.name + ' @ ' + tx + ',' + ty + ',' + tz);
      return true;
    } catch(e) {
      bot.chat('放不了...' + (e.message || '').slice(0, 25));
      logAction('放置', '失败: ' + (e.message || '').slice(0, 25));
      return false;
    }
  }
  bot.chat('我面前没空地放，让开点或站平地上');
  logAction('放置', '失败: 面前没空地');
  return false;
}

async function placeBlockForPlayer(username) {
  setState('place');
  try {
    return await placeBlockForPlayerImpl(username);
  } finally {
    resetIfState('place');
  }
}

async function placeBlockForPlayerImpl(username) {
  const buildBlocks = ['dirt','grass_block','cobblestone','stone','sand','gravel','planks','log','netherrack'];
  let buildBlock = bot.inventory.items().find(i => buildBlocks.some(b => i.name.includes(b)));

  // 背包没有可放方块 → 挖脚下方块并捡回掉落
  if (!buildBlock) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.name === 'air' || below.name === 'bedrock' || below.hardness >= 50) {
      bot.chat('背包里没有可放方块，脚底下也没有土...');
      logAction('放置', '失败: 背包无可放方块且脚下无可挖');
      return false;
    }
    try {
      await equipBestToolFor(below.name);
      await bot.dig(below);
      await sleep(500);
      await collectDrops(true);
      await sleep(200);
    } catch(e) {
      bot.chat('脚下挖不动...');
      return false;
    }
    buildBlock = bot.inventory.items().find(i => buildBlocks.some(b => i.name.includes(b)));
    if (!buildBlock) {
      bot.chat('挖了脚下但还是没捡到方块...');
      return false;
    }
  }

  return await placeBlockAtFront(buildBlock, username);
}

// 指定物品放地上：背包有才放，不可放置的明确告知，绝不编造成功
async function placeNamedBlock(itemText, username) {
  setState('place');
  try {
    const item = findInventoryItem(itemText);
    if (!item) {
      bot.chat('背包里没有' + itemText + '，放不了');
      logAction('放置', '背包无该物品: ' + itemText);
      return false;
    }
    if (!mcData.blocksByName[item.name]) {
      bot.chat(itemText + ' 不是方块，放不了（要扔掉就说"扔"）');
      logAction('放置', itemText + ' 不是方块');
      return false;
    }
    return await placeBlockAtFront(item, username);
  } finally {
    resetIfState('place');
  }
}

function findRefBlockFor(target) {
  const own = bot.entity.position;
  const offsets = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of offsets) {
    const p = target.offset(dx, dy, dz);
    const b = bot.blockAt(p);
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water' && b.name !== 'lava' &&
        b.position.distanceTo(own) < 4.5) {
      return b;
    }
  }
  return null;
}

// 检查是否需要垫高才能到达目标
function needsPillar(targetPos) {
  if (!bot.entity || !targetPos) return 0;
  const dy = targetPos.y - bot.entity.position.y;
  // 目标比bot高2格以上，且bot头上没空间
  if (dy >= 2) {
    const above = bot.blockAt(bot.entity.position.offset(0, 2, 0));
    if (above && above.name !== 'air') return 0; // 头顶有方块，垫不了
    return Math.ceil(dy);
  }
  return 0;
}

// ============ Equipment ============
async function autoEquip() {
  const sword = bot.inventory.items().find(i => i.name.includes('sword'));
  const axe = bot.inventory.items().find(i => i.name.includes('axe'));
  const weapon = sword || axe;
  if (weapon) try { await bot.equip(weapon, 'hand'); } catch(e) {}
}

// 判断是否需要特定工具才能挖
const HARD_BLOCKS = ['stone','cobblestone','granite','diorite','andesite','deepslate','obsidian',
  'iron_ore','gold_ore','diamond_ore','coal_ore','copper_ore','redstone_ore','lapis_ore','emerald_ore',
  'deepslate_iron_ore','deepslate_gold_ore','deepslate_diamond_ore'];

const NEEDS_PICKAXE = (name) => HARD_BLOCKS.some(b => name.includes(b)) || name.includes('ore');
const NEEDS_AXE = (name) => TREE_LOGS.includes(name);
const NEEDS_SHOVEL = (name) => ['dirt','grass_block','sand','gravel','clay','soul_sand'].some(b => name.includes(b));

// 为特定方块装备最佳工具
async function equipBestToolFor(blockName) {
  if (NEEDS_PICKAXE(blockName)) {
    // 找最好的镐子
    const picks = bot.inventory.items().filter(i => i.name.includes('pickaxe'));
    if (picks.length > 0) {
      const best = picks.sort((a,b) => {
        const tier = {wooden:0,stone:1,iron:2,golden:2,diamond:3,netherite:4};
        return (tier[b.name.split('_')[0]]||0) - (tier[a.name.split('_')[0]]||0);
      })[0];
      try { await bot.equip(best, 'hand'); console.log('⛏️ 装备: ' + best.name); return true; } catch(e) {}
    }
    // 没有镐子→自动做木镐
    bot.chat('需要镐子！做个木镐...');
    return await craftTool('wooden_pickaxe');
  }

  if (NEEDS_AXE(blockName)) {
    const axes = bot.inventory.items().filter(i => i.name.includes('axe'));
    if (axes.length > 0) {
      try { await bot.equip(axes[0], 'hand'); return true; } catch(e) {}
    }
    return await craftTool('wooden_axe');
  }

  if (NEEDS_SHOVEL(blockName)) {
    const shovels = bot.inventory.items().filter(i => i.name.includes('shovel'));
    if (shovels.length > 0) {
      try { await bot.equip(shovels[0], 'hand'); return true; } catch(e) {}
    }
  }

  return true; // 空手也能挖
}

// 检查能否挖某方块
function canMine(block) {
  if (!block || block.name === 'air' || block.name === 'bedrock') return false;
  if (block.hardness === undefined || block.hardness > 55) return false;
  if (NEEDS_PICKAXE(block.name)) {
    return bot.inventory.items().some(i => i.name.includes('pickaxe'));
  }
  return true;
}

// ============ Pathfinding ============
function setupPath() {
  const m = new Movements(bot, mcData);
  m.canDig = true;
  m.allowParkour = true;
  m.allow1by1towers = false;
  m.canOpenDoors = true;
  m.allowEntityDetection = true;
  m.maxDropDown = 4;
  m.scafoldingBlocks = [];
  // Try to make bot swim better
  m.canSwim = true;
  bot.pathfinder.setMovements(m);
}

// ============ World Sensing ============
function senseWorld(username) {
  if (!bot.entity) return '';
  const pos = bot.entity.position;
  const p = bot.players[username]?.entity;
  const dist = p ? Math.round(bot.entity.position.distanceTo(p.position)) : '?';
  const below = bot.blockAt(pos.offset(0,-1,0));
  const hour = Math.floor((bot.time.timeOfDay / 1000 + 6) % 24);
  const weather = bot.isRaining ? (bot.thunderState > 0 ? '雷暴' : '下雨') : '晴';

  // Nearby key blocks
  let nearby = [];
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
    const b = bot.blockAt(pos.offset(dx, 0, dz));
    if (b && (TREE_LOGS.includes(b.name) || ORES.includes(b.name) || b.name === 'water' || b.name === 'lava' || b.name === 'crafting_table' || b.name === 'chest')) {
      nearby.push(b.name + '(' + dx + ',' + dz + ')');
    }
  }

  // Nearby entities
  let entities = [];
  for (const [id, e] of Object.entries(bot.entities)) {
    if (e === bot.entity) continue;
    const ed = Math.round(pos.distanceTo(e.position));
    if (ed < 20 && (e.type === 'mob' || e.type === 'hostile' || e.type === 'player')) {
      entities.push((e.username || e.name || e.displayName || '?') + '(' + ed + 'm)');
    }
  }

  // 背包关键物品
  const inv = bot.inventory.items();
  const keyItems = inv.filter(i =>
    i.name.includes('log') || i.name.includes('planks') || i.name === 'crafting_table' ||
    i.name.includes('pickaxe') || i.name.includes('sword') || i.name.includes('axe') ||
    i.name.includes('ore') || i.name.includes('diamond') || i.name === 'stick'
  );
  const invStr = keyItems.length > 0 ? ' 背包:' + keyItems.slice(0, 6).map(i => i.name+'x'+i.count).join(',') : ' 背包:空';

  return `【世界】${hour}时 ${weather} 脚下:${below?.name||'空'} 距玩家:${dist}m HP:${Math.round(bot.health)}${nearby.length?' 周围:'+[...new Set(nearby)].slice(0,6).join(','):''}${entities.length?' 生物:'+entities.slice(0,4).join(','):''}${invStr}`;
}

// ============ AI Chat ============
async function aiChat(username, msg, result) {
  let ctx = '';
  if (result) {
    if (result.ok && result.desc) ctx = '【执行：' + result.desc + '】';
    else if (!result.ok && result.desc) ctx = '【失败：' + result.desc + '】';
  } else {
    ctx = '【未执行任何动作：请如实回应，不要声称你做了什么】';
  }
  const world = senseWorld(username);

  history.push({ role: 'user', content: username + ': ' + msg + ' ' + ctx + '\n' + world });
  if (history.length > 5) history = history.slice(-5);

  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      max_tokens: 50, temperature: 0.7,
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  const reply = data.choices[0].message.content.trim();
  history.push({ role: 'assistant', content: reply });
  if (history.length > 5) history = history.slice(-5);
  return reply.length > 75 ? reply.slice(0,72) + '...' : reply;
}

// ============ Utils ============
function logToFile(line) {
  try {
    fs.appendFileSync(path.join(__dirname, 'response.txt'), '[' + new Date().toLocaleString() + '] ' + line + '\n');
  } catch (e) {}
  // 状态面板：每条日志同步更新事件与实时状态
  pushEvent(line);
  refreshStatus();
}
function has(str, ...words) { const s = str.toLowerCase(); return words.some(w => s.includes(w)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clearControls() {
  ['forward','back','left','right','jump','sprint','sneak'].forEach(c => bot.setControlState(c, false));
}
function cleanup(targetBot) {
  const b = targetBot || bot;
  setState('idle');
  clearTimeout(idleTimer);
  try { b?.pathfinder?.setGoal(null); } catch {}
  try { ['forward','back','left','right','jump','sprint','sneak'].forEach(c => b?.setControlState(c, false)); } catch {}
}

console.log('🤖 Claude v5 — Voyager架构 (collectblock + 技能库 + AI代码生成)');
createBot();
