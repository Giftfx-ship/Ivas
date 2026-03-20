require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS.split(',');
const IVAS_USERNAME = process.env.IVAS_USERNAME;
const IVAS_PASSWORD = process.env.IVAS_PASSWORD;
const MENU_IMAGE = process.env.MENU_IMAGE;
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL;
const OTP_REFRESH = 5000;
const NUMBERS_PER_PAGE = 10;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const client = wrapper(axios.create({ jar: new tough.CookieJar(), withCredentials: true }));

let userStates = {};
let numbersCache = {};

// ---------------- HELPERS ----------------
function isAdmin(id) { return ADMIN_IDS.includes(id.toString()); }

async function loginIvas() {
  const page = await client.get('http://ivas.tempnum.qzz.io/login');
  const $ = cheerio.load(page.data);
  const token = $('input[name="_token"]').val();
  const form = new URLSearchParams();
  form.append('email', IVAS_USERNAME);
  form.append('password', IVAS_PASSWORD);
  form.append('_token', token);
  await client.post('http://ivas.tempnum.qzz.io/login', form, { headers:{'Content-Type':'application/x-www-form-urlencoded'} });
}

async function fetchNumbers() {
  if(Object.keys(numbersCache).length>0) return numbersCache;
  await loginIvas();
  const page = await client.get('http://ivas.tempnum.qzz.io/portal/numbers');
  const $ = cheerio.load(page.data);
  const data = {};
  $('table tbody tr').each((i, row) => {
    const tds = $(row).find('td');
    const number = $(tds[1]).text().trim();
    const country = $(tds[2]).text().trim();
    if(!data[country]) data[country]=[];
    data[country].push(number);
  });
  numbersCache = data;
  return data;
}

async function fetchOtp(number) {
  const page = await client.get(`http://ivas.tempnum.qzz.io/portal/sms/${number}`);
  const $ = cheerio.load(page.data);
  let otp = $('table tbody tr td').first().text().match(/\b\d{4,8}\b/);
  return otp ? otp[0] : 'No OTP yet';
}

// ---------------- MENU ----------------
async function sendMenu(chatId) {
  const keyboard = { inline_keyboard: [
    [{ text:'🌍 Select Country', callback_data:'select_country' }],
    [{ text:'📞 Contact Dev', callback_data:'contact_dev' }],
    [{ text:'💬 Chat Admin', callback_data:'chat_admin' }]
  ]};
  await bot.sendPhoto(chatId, MENU_IMAGE, { caption:'Welcome! Select a country to get number & OTP.', reply_markup:keyboard });
}

// ---------------- CALLBACK HANDLER ----------------
bot.on('callback_query', async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id.toString();
  if(!userStates[userId]) userStates[userId] = { page:0, adminChat:false };

  // --------- CHANNEL CHECK ---------
  if(REQUIRED_CHANNEL){
    try{
      const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
      if(!member || member.status==='left'){
        return bot.answerCallbackQuery(q.id, { text:`❌ Join ${REQUIRED_CHANNEL} first!` });
      }
    } catch(e){}
  }

  // --------- CONTACT DEV ---------
  if(q.data==='contact_dev'){
    return bot.sendMessage(chatId, '💡 Contact Dev:\nTelegram: @YourUsername\nReplace links as needed!');
  }

  // --------- CHAT ADMIN ---------
  if(q.data==='chat_admin'){
    userStates[userId].adminChat = true;
    return bot.sendMessage(chatId, '💬 You can now chat with admin. Send your message:');
  }

  // --------- COUNTRY SELECT ---------
  if(q.data==='select_country'){
    const countriesData = await fetchNumbers();
    userStates[userId].countries = Object.keys(countriesData);
    userStates[userId].numbersData = countriesData;
    const keyboard = userStates[userId].countries.map(c=>[{text:c, callback_data:`country_${c}_0`}]);
    keyboard.push([{text:'🔙 Back', callback_data:'back_menu'}]);
    return bot.editMessageText('Select Country:', { chat_id:chatId, message_id:q.message.message_id, reply_markup:{inline_keyboard:keyboard} });
  }

  // --------- COUNTRY NUMBERS ---------
  if(q.data.startsWith('country_')){
    const [_, country, page] = q.data.split('_');
    const numbers = userStates[userId].numbersData[country];
    const pageNum = parseInt(page)||0;
    userStates[userId].selectedCountry = country;
    userStates[userId].page = pageNum;

    const pagedNumbers = numbers.slice(pageNum*NUMBERS_PER_PAGE, (pageNum+1)*NUMBERS_PER_PAGE);
    const keyboard = pagedNumbers.map(n=>[{text:n, callback_data:`number_${n}`}]);
    const nav = [];
    if(pageNum>0) nav.push({text:'⬅️ Prev', callback_data:`country_${country}_${pageNum-1}`});
    if((pageNum+1)*NUMBERS_PER_PAGE < numbers.length) nav.push({text:'Next ➡️', callback_data:`country_${country}_${pageNum+1}`});
    if(nav.length>0) keyboard.push(nav);
    keyboard.push([{text:'🔙 Change Country', callback_data:'select_country'}]);
    return bot.editMessageText(`Select Number for ${country}:`, { chat_id:chatId, message_id:q.message.message_id, reply_markup:{inline_keyboard:keyboard} });
  }

  // --------- NUMBER SELECT ---------
  if(q.data.startsWith('number_')){
    const number = q.data.split('_')[1];
    userStates[userId].selectedNumber = number;

    let otp = await fetchOtp(number);
    const keyboard = [
      [{text:'🔄 Change Number', callback_data:'change_number'}],
      [{text:'🌍 Change Country', callback_data:'select_country'}],
      [{text:'📋 Copy OTP', callback_data:`copy_otp_${number}`}]
    ];

    const otpMsg = await bot.editMessageText(`Number: ${number}\nOTP: ${otp}`, { chat_id:chatId, message_id:q.message.message_id, reply_markup:{inline_keyboard:keyboard} });
    
    // Auto refresh OTP
    const interval = setInterval(async ()=>{
      const newOtp = await fetchOtp(number);
      if(newOtp !== otp){
        otp = newOtp;
        try{
          await bot.editMessageText(`Number: ${number}\nOTP: ${otp}`, { chat_id:chatId, message_id:q.message.message_id, reply_markup:{inline_keyboard:keyboard} });
        }catch(e){}
      }
    }, OTP_REFRESH);
    userStates[userId].interval = interval;
  }

  if(q.data==='change_number'){
    const country = userStates[userId].selectedCountry;
    const numbers = userStates[userId].numbersData[country];
    const keyboard = numbers.slice(0,NUMBERS_PER_PAGE).map(n=>[{text:n, callback_data:`number_${n}`}]);
    keyboard.push([{text:'🔙 Change Country', callback_data:'select_country'}]);
    return bot.editMessageText(`Select new number for ${country}:`, { chat_id:chatId, message_id:q.message.message_id, reply_markup:{inline_keyboard:keyboard} });
  }

  if(q.data.startsWith('copy_otp_')){
    const number = q.data.split('_')[2];
    return bot.answerCallbackQuery(q.id, { text:`OTP for ${number} copied! ✅` });
  }

  if(q.data==='back_menu'){
    return sendMenu(chatId);
  }
});

// ---------------- ADMIN CHAT ----------------
bot.on('message', async msg=>{
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  // Ignore bot messages
  if(msg.from.is_bot) return;

  // Admin chat
  if(userStates[userId]?.adminChat){
    for(const admin of ADMIN_IDS){
      await bot.sendMessage(admin, `💬 Message from ${msg.from.first_name} (@${msg.from.username||'NoUsername'}):\n${msg.text}`);
    }
    await bot.sendMessage(chatId, '✅ Your message has been sent to admin!');
    userStates[userId].adminChat = false;
  }
});

// ---------------- START ----------------
bot.onText(/^\/start$/, async msg=>{
  const chatId = msg.chat.id;
  await sendMenu(chatId);
});
