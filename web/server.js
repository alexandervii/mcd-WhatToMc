// 「今天吃了唛~」推荐服务后端
// 直接调用麦当劳 MCP (mcd-mcp) 实时数据，无第三方依赖，仅用 Node 内置模块
// 启动：node server.js  (默认端口 8787)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const MCP_URL = 'https://mcp.mcd.cn';

// Token 读取优先级：环境变量 MCD_MCP_TOKEN > ~/.workbuddy/mcp.json（mcd-mcp 连接器配置）
// 代码中不保存任何真实 Token，避免泄露。
function loadToken() {
  if (process.env.MCD_MCP_TOKEN) return process.env.MCD_MCP_TOKEN;
  try {
    const cfgPath = path.join(require('os').homedir(), '.workbuddy', 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const auth = cfg.mcpServers && cfg.mcpServers['mcd-mcp'] && cfg.mcpServers['mcd-mcp'].headers && cfg.mcpServers['mcd-mcp'].headers.Authorization;
    if (auth) return auth.replace(/^Bearer\s+/i, '');
  } catch (e) {
    // 配置文件不存在或格式错误，继续尝试其他来源
  }
  return null;
}
const MCP_TOKEN = loadToken();
if (!MCP_TOKEN) {
  console.error('[错误] 未找到麦当劳 MCP Token。请设置环境变量 MCD_MCP_TOKEN，或在 ~/.workbuddy/mcp.json 中配置 mcd-mcp 连接器。');
  process.exit(1);
}

// 默认门店（北京东华门大街，用户未指定位置时兜底）
const DEFAULT_STORE = { storeCode: '1951020', storeName: '麦当劳北京东华门大街(景泰蓝)餐厅' };

// ============ MCP 客户端 ============
function mcpCall(name, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args || {} },
  });
  return new Promise((resolve, reject) => {
    const u = new URL(MCP_URL);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + MCP_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || 'MCP error'));
          // content[0].text 里包含 "## Original Response\n\n{...}" 真实数据
          const content = json.result && json.result.content;
          if (!content) return resolve(null);
          let text = '';
          for (const c of content) if (c.type === 'text') text += c.text;
          const m = text.match(/## Original Response\s*\n+\s*(\{[\s\S]*\})/);
          if (m) {
            resolve(JSON.parse(m[1]));
          } else {
            // 部分工具可能直接返回 JSON
            resolve({ raw: text });
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============ 解析 list-nutrition-foods 的非标准文本 ============
// data 形如 "[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  猪柳麦满分,null,1288,308,16,16,24,781,213\n  ..."
function parseNutrition(rawData) {
  const map = {};
  if (!rawData || typeof rawData !== 'string') return map;
  const lines = rawData.split('\n');
  let started = false;
  for (let line of lines) {
    line = line.trim();
    if (!started) {
      if (line.includes('{')) started = true;
      continue;
    }
    if (!line) continue;
    // 跳过表头
    if (line.includes('productName')) continue;
    const cols = line.split(',');
    // productName, nutritionDescription, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium
    if (cols.length < 8) continue;
    const name = cols[0].trim();
    const kcal = parseFloat(cols[3]);
    const protein = parseFloat(cols[4]);
    const fat = parseFloat(cols[5]);
    const carb = parseFloat(cols[6]);
    if (!name || isNaN(kcal)) continue;
    map[name] = { kcal, protein, fat, carb };
  }
  return map;
}

// ============ 定位门店 ============
async function locateStore(city, keyword) {
  try {
    const res = await mcpCall('query-nearby-stores', {
      beType: 1, searchType: 2, city: city || '北京', keyword: keyword || '王府井',
    });
    if (res && res.data && res.data.length) {
      const s = res.data[0];
      return { storeCode: s.storeCode, storeName: s.storeName };
    }
  } catch (e) { /* 忽略，回退默认门店 */ }
  return DEFAULT_STORE;
}

// ============ 获取菜单 + 营养 ============
async function fetchMenu(storeCode) {
  const res = await mcpCall('query-meals', { storeCode, orderType: 1, beType: 1 });
  if (!res || !res.data || !res.data.meals) return [];
  const meals = [];
  const catMap = {};
  (res.data.categories || []).forEach((cat) => {
    (cat.meals || []).forEach((m) => { catMap[m.code] = cat.name; });
  });
  for (const code in res.data.meals) {
    const m = res.data.meals[code];
    meals.push({
      code,
      name: m.name,
      price: parseFloat(m.currentPrice),
      image: m.image,
      tags: [],
      cat: catMap[code] || '',
    });
  }
  // 补充 tags：从 categories 里反向查
  (res.data.categories || []).forEach((cat) => {
    (cat.meals || []).forEach((m) => {
      const item = meals.find((x) => x.code === m.code);
      if (item && m.tags) item.tags = m.tags;
    });
  });
  return meals;
}

async function fetchNutrition() {
  const res = await mcpCall('list-nutrition-foods', {});
  return parseNutrition(res && res.data);
}

// 套餐组成缓存（动态拆包时用 query-meal-detail）
const compositionCache = {};

async function getMealComposition(storeCode, code) {
  if (compositionCache[code]) return compositionCache[code];
  try {
    const res = await mcpCall('query-meal-detail', { storeCode, orderType: 1, beType: 1, code });
    const items = [];
    (res.data.rounds || []).forEach((round) => {
      (round.choices || []).forEach((c) => {
        if (c.isDefault === 1) items.push({ name: c.name, quantity: c.quantity || 1 });
      });
    });
    compositionCache[code] = items;
    return items;
  } catch (e) {
    return null;
  }
}

// 套餐营养求和（返回 {kcal,protein,fat,carb,estimated} 或 null）
function sumNutrition(items, nutrMap) {
  let kcal = 0, protein = 0, fat = 0, carb = 0;
  let estimated = false;
  for (const it of items) {
    const r = resolveNutrition(nutrMap, it.name);
    if (!r) return null;
    if (r.estimated) estimated = true;
    kcal += r.kcal * it.quantity;
    protein += r.protein * it.quantity;
    fat += r.fat * it.quantity;
    carb += r.carb * it.quantity;
  }
  return { kcal: Math.round(kcal), protein: Math.round(protein), fat: Math.round(fat), carb: Math.round(carb), estimated };
}

// 品类近似匹配：名称精确/模糊匹配不到时，按品类找同类已知单品的营养均值估算
function normalizeName(s) {
  return s.replace(/中杯|大杯|小杯|加冰|少冰|去冰|冰|热/g, '')
    .replace(/[（(]/g, '').replace(/[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function findFuzzy(map, name) {
  if (map[name]) return map[name];
  const base = normalizeName(name);
  if (!base) return null;
  // 精确归一化匹配
  for (const k in map) {
    if (normalizeName(k) === base) return map[k];
  }
  // 包含匹配
  for (const k in map) {
    const nk = normalizeName(k);
    if (nk && (nk.includes(base) || base.includes(nk))) return map[k];
  }
  return null;
}

// 品类关键词 -> 营养表里该类已知餐品的名称列表（用于估算）
const CATEGORY_KEYS = [
  { re: /鸡腿堡|麦辣|龙焰/, keys: ['麦辣鸡腿汉堡', '板烧鸡腿堡'] },
  { re: /鸡翅|V翅|脆汁鸡|蘸酱炸鸡|炸鸡/, keys: ['麦辣鸡翅-2块', '麦麦脆汁鸡-琵琶腿', '薄皮焦香V翅'] },
  { re: /牛堡|巨无霸|吉士|安格斯|汉堡包|猪猪堡/, keys: ['巨无霸', '双层吉士汉堡', '吉士汉堡包', '不素之霸双层牛堡'] },
  { re: /鱼堡|鳕鱼|麦香鱼/, keys: ['麦香鱼', '双层深海鳕鱼堡'] },
  { re: /鸡块|麦乐鸡|鸡球/, keys: ['麦乐鸡5块', '麦乐鸡4块', '麦麦趣鸡球'] },
  { re: /薯条|薯饼|扭扭薯/, keys: ['中薯条', '大薯条', '小薯条'] },
  { re: /卷|多笋/, keys: ['酥酥多笋卷', '火腿扒早安营养卷', '鲜蔬蛋沙拉叠叠卷', '鸡肉蛋沙拉叠叠卷'] },
  { re: /可乐/, keys: ['可乐中杯', '可乐大杯'] },
  { re: /雪碧/, keys: ['雪碧中杯', '雪碧大杯'] },
  { re: /咖啡|奶铁|美式|玛奇朵|卡布奇诺|阿芙佳朵/, keys: ['浓缩咖啡', '鲜萃咖啡', '卡布奇诺中杯'] },
  { re: /鸡排|那么大/, keys: ['那么大鸡排'] },
  { re: /玉米/, keys: ['大杯玉米杯', '小杯玉米杯'] },
  { re: /苹果/, keys: ['苹果片', '100%苹果汁'] },
  { re: /新地|麦旋风|圆筒|雪冰|阿芙佳朵/, keys: ['草莓新地', '朱古力新地', '奥利奥麦旋风', '草莓麦旋风'] },
  { re: /派/, keys: ['香芋派', '菠萝派'] },
  { re: /拼盘|四宫格|随心拼|双人餐|四件套|多人餐|鸡薯双全/, keys: ['中薯条', '麦乐鸡5块', '麦辣鸡翅-2块', '脆脆薯条'] },
  { re: /乐园餐|亲子餐/, keys: ['汉堡包', '小薯条', '苹果片'] },
  { re: /牛奶|豆浆/, keys: ['纯牛奶（盒装）', '优品豆浆中杯'] },
  { re: /柠檬红茶|怡泉|苹果汁|橙/, keys: ['阳光柠檬红茶中杯', '100%苹果汁'] },
];

function estimateByCategory(map, name) {
  for (const cat of CATEGORY_KEYS) {
    if (cat.re.test(name)) {
      let kcal = 0, protein = 0, fat = 0, carb = 0, cnt = 0;
      for (const k of cat.keys) {
        const n = map[k];
        if (n) { kcal += n.kcal; protein += n.protein; fat += n.fat; carb += n.carb; cnt++; }
      }
      if (cnt > 0) {
        return { kcal: Math.round(kcal / cnt), protein: Math.round(protein / cnt), fat: Math.round(fat / cnt), carb: Math.round(carb / cnt), estimated: true };
      }
    }
  }
  return null;
}

// 统一营养解析：精确 -> 模糊 -> 品类估算
function resolveNutrition(map, name) {
  let n = findFuzzy(map, name);
  if (n) return { kcal: n.kcal, protein: n.protein, fat: n.fat, carb: n.carb, estimated: false };
  n = estimateByCategory(map, name);
  return n; // 可能为 null
}

// ============ 决策引擎 ============
function parseIntent(text) {
  const cond = { priceMax: null, priceMin: null, kcalMax: null, taste: null, goal: null, mealType: null, isKids: false };
  let m = text.match(/(\d+)\s*[-~到至]?\s*(\d+)?\s*元/);
  if (m) {
    if (m[2]) { cond.priceMin = +m[1]; cond.priceMax = +m[2]; }
    else {
      const v = +m[1];
      if (/以内|以下|不到|不超过/.test(text)) cond.priceMax = v;
      else if (/左右|上下|约/.test(text)) { cond.priceMin = v - 5; cond.priceMax = v + 5; }
      else cond.priceMax = v;
    }
  }
  m = text.match(/(\d+)\s*(大卡|千卡|kcal|卡路里)/i);
  if (m) cond.kcalMax = +m[1];
  if (/牛|巨无霸|吉士|安格斯/.test(text)) cond.taste = '牛肉';
  else if (/鸡/.test(text)) cond.taste = '鸡肉';
  else if (/鱼|鳕鱼/.test(text)) cond.taste = '鱼';
  else if (/辣/.test(text) && !/不辣/.test(text)) cond.taste = '辣';
  if (/高蛋白|增肌|蛋白/.test(text)) cond.goal = '高蛋白';
  else if (/低脂|减脂|低脂肪/.test(text)) cond.goal = '低脂';
  else if (/低卡|低热量|轻食|减肥|控制热量/.test(text)) cond.goal = '低卡';
  if (/套餐|三件套|组合|配一套/.test(text)) cond.mealType = '套餐';
  else if (/单品|单个/.test(text)) cond.mealType = '单品';
  if (/乐园|孩子|儿童|亲子|小朋友/.test(text)) cond.isKids = true;
  return cond;
}

async function recommend(text) {
  const cond = parseIntent(text);
  // 定位门店
  let city = '北京', keyword = '王府井';
  const cm = text.match(/(?:在|去|附近)([\u4e00-\u9fa5]{2,6})/);
  if (cm) keyword = cm[1];
  const store = await locateStore(city, keyword);

  // 并行拉取菜单 + 营养
  const [meals, nutrMap] = await Promise.all([fetchMenu(store.storeCode), fetchNutrition()]);

  // 筛选 + 打分
  const results = [];
  for (const item of meals) {
    const { name, price, tags, cat } = item;
    if (cond.priceMax != null && price > cond.priceMax) continue;
    if (cond.priceMin != null && price < cond.priceMin) continue;

    // 营养解析：套餐优先拆包求和（不能用单品模糊匹配值），其次精确/模糊/品类估算
    const isCombo = /套餐|三件套|套/.test(name);
    let nutr = isCombo ? null : resolveNutrition(nutrMap, name);
    if (isCombo) {
      const comp = await getMealComposition(store.storeCode, item.code);
      if (comp && comp.length) {
        nutr = sumNutrition(comp, nutrMap);
        item.composition = comp;
      }
      if (!nutr) nutr = resolveNutrition(nutrMap, name);
    }
    if (cond.kcalMax != null && nutr && nutr.kcal > cond.kcalMax) continue;

    // 口味
    if (cond.taste) {
      const t = cond.taste, tagstr = (tags || []).join(' ');
      let nameHit = false, tagHit = false;
      if (t === '牛肉') { nameHit = /牛肉|牛|巨无霸|吉士|安格斯/.test(name); tagHit = /牛肉|安格斯/.test(tagstr); }
      else if (t === '鸡肉') { nameHit = /鸡/.test(name); tagHit = /鸡/.test(tagstr); }
      else if (t === '鱼') { nameHit = /鱼|鳕鱼/.test(name); tagHit = /鱼/.test(tagstr); }
      else if (t === '辣') { nameHit = /辣/.test(name); tagHit = /辣/.test(tagstr); }
      if (!(nameHit || tagHit)) continue;
    }
    if (cond.mealType === '套餐' && !/套餐|三件套/.test(name)) continue;
    if (cond.mealType === '单品' && /套餐|三件套/.test(name)) continue;
    if (cond.isKids && cat !== '开心乐园') continue;

    let score = 0;
    if (/堡|套餐|三件套|卷|鸡|鱼|饭/.test(name)) score += 100;
    if (cond.goal === '高蛋白' && nutr) score += nutr.protein * 3;
    if (cond.goal === '低脂' && nutr) score += (50 - nutr.fat) * 2;
    if (cond.goal === '低卡' && nutr) score += (1000 - nutr.kcal) / 10;

    results.push({
      name, price, tags: tags || [], cat,
      kcal: nutr ? nutr.kcal : null,
      protein: nutr ? nutr.protein : null,
      fat: nutr ? nutr.fat : null,
      carb: nutr ? nutr.carb : null,
      estimated: nutr ? !!nutr.estimated : false,
      composition: item.composition || null,
      score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { cond, store, items: results };
}

// ============ HTTP 服务 ============
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const fp = path.join(__dirname, 'index.html');
    const html = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'POST' && u.pathname === '/api/recommend') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text) throw new Error('缺少 text 参数');
        const result = await recommend(text);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`今天吃了唛~ 推荐服务已启动：http://localhost:${PORT}`);
  console.log(`MCP: ${MCP_URL}（实时数据）`);
});
