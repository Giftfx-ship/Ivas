require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS.split(',');
const MENU_IMAGE = process.env.MENU_IMAGE;

const OTP_REFRESH = 5000;
const NUMBERS_PER_PAGE = 8;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let userStates = {};
let numbersCache = {};

let browser, page;

// ---------------- INIT ----------------
async function initBrowser() {
  if (browser) return;

  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  page = await browser.newPage();

  console.log('✅ Browser initialized');
}

// ---------------- FETCH NUMBERS ----------------
async function fetchNumbers() {
  if (Object.keys(numbersCache).length > 0) return numbersCache;

  await initBrowser();

  try {
    await page.goto('http://ivas.tempnum.qzz.io/portal/numbers', {
      waitUntil: 'networkidle2'
    });

    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const result = {};

      rows.forEach(row => {
        const tds = row.querySelectorAll('td');
        const number = tds[1]?.innerText.trim();
        const country = tds[2]?.innerText.trim();

        if (number && country) {
          if (!result[country]) result[country] = [];
          result[country].push(number);
        }
      });

      return result;
    });

    numbersCache = data;
    return data;

  } catch (e) {
    console.log('❌ Error fetching numbers:', e.message);
    return {};
  }
}

// ---------------- FETCH OTP ----------------
async function fetchOtp(number) {
  await initBrowser();

  try {
    await page.goto(`http://ivas.tempnum.qzz.io/portal/sms/${number}`, {
      waitUntil: 'networkidle2'
    });

    const otp = await page.evaluate(() => {
      const cell = document.querySelector('table tbody tr td');
      if (!cell) return null;

      const match = cell.innerText.match(/\b\d{4,8}\b/);
      return match ? match[0] : null;
    });

    return otp || 'Waiting for OTP...';

  } catch (e) {
    return 'Error fetching OTP';
  }
}

// ---------------- MENU ----------------
async function sendMenu(chatId) {
  const text = `
╔══════════════╗
   🌐 NEXA OTP BOT
╚══════════════╝

⚡ Fast • Clean • Interactive

Choose an option:
`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🌍 Select Country', callback_data: 'select_country' }],
      [{ text: '🔄 Refresh Numbers', callback_data: 'refresh_numbers' }]
    ]
  };

  await bot.sendPhoto(chatId, MENU_IMAGE, {
    caption: text,
    reply_markup: keyboard
  });
}

// ---------------- CALLBACK ----------------
bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id.toString();

  if (!userStates[userId]) userStates[userId] = {};

  const state = userStates[userId];

  // -------- SELECT COUNTRY --------
  if (q.data === 'select_country') {
    const data = await fetchNumbers();
    state.data = data;

    const keyboard = Object.keys(data).map(c => [
      { text: `🌍 ${c}`, callback_data: `country_${c}_0` }
    ]);

    keyboard.push([{ text: '🔙 Back', callback_data: 'back' }]);

    return bot.editMessageText('🌍 Select Country:', {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  // -------- COUNTRY --------
  if (q.data.startsWith('country_')) {
    const [_, country, pageNum] = q.data.split('_');
    const numbers = state.data[country] || [];

    const page = parseInt(pageNum);
    const slice = numbers.slice(
      page * NUMBERS_PER_PAGE,
      (page + 1) * NUMBERS_PER_PAGE
    );

    const keyboard = slice.map(n => [
      { text: `📱 ${n}`, callback_data: `number_${n}` }
    ]);

    let nav = [];
    if (page > 0)
      nav.push({ text: '⬅️', callback_data: `country_${country}_${page - 1}` });

    if ((page + 1) * NUMBERS_PER_PAGE < numbers.length)
      nav.push({ text: '➡️', callback_data: `country_${country}_${page + 1}` });

    if (nav.length) keyboard.push(nav);

    keyboard.push([{ text: '🔙 Countries', callback_data: 'select_country' }]);

    return bot.editMessageText(`📱 ${country} Numbers:`, {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  // -------- NUMBER --------
  if (q.data.startsWith('number_')) {
    const number = q.data.split('_')[1];

    // clear previous interval
    if (state.interval) clearInterval(state.interval);

    let otp = await fetchOtp(number);

    const keyboard = [
      [{ text: '🔄 Refresh', callback_data: `number_${number}` }],
      [{ text: '🔙 Back', callback_data: 'select_country' }]
    ];

    await bot.editMessageText(
      `📱 ${number}\n🔑 OTP: ${otp}`,
      {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
      }
    );

    // -------- AUTO REFRESH --------
    state.interval = setInterval(async () => {
      const newOtp = await fetchOtp(number);

      if (newOtp !== otp) {
        otp = newOtp;

        try {
          await bot.editMessageText(
            `📱 ${number}\n🔑 OTP: ${otp}`,
            {
              chat_id: chatId,
              message_id: q.message.message_id,
              reply_markup: { inline_keyboard: keyboard }
            }
          );
        } catch {}
      }
    }, OTP_REFRESH);
  }

  // -------- REFRESH NUMBERS --------
  if (q.data === 'refresh_numbers') {
    numbersCache = {};
    return bot.answerCallbackQuery(q.id, {
      text: '♻️ Numbers refreshed'
    });
  }

  // -------- BACK --------
  if (q.data === 'back') {
    return sendMenu(chatId);
  }
});

// ---------------- START ----------------
bot.onText(/\/start/, msg => {
  sendMenu(msg.chat.id);
});
