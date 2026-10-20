const DEFAULTS = {
  template: 'Hi {firstName}, I came across your profile and would love to connect!',
  minDelay: 20,
  maxDelay: 45,
  maxPerRun: 20,
  dailyLimit: 40,
  autoPaginate: true
};
const NUM_KEYS = ['minDelay', 'maxDelay', 'maxPerRun', 'dailyLimit'];
const $ = (id) => document.getElementById(id);

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  $('template').value = s.template;
  NUM_KEYS.forEach((k) => ($(k).value = s[k]));
  $('autoPaginate').checked = s.autoPaginate;
  refresh();
}

function collect() {
  const num = (id, min) => Math.max(min, parseInt($(id).value, 10) || DEFAULTS[id]);
  const minDelay = num('minDelay', 5);
  return {
    template: $('template').value.trim() || DEFAULTS.template,
    minDelay,
    maxDelay: Math.max(minDelay, num('maxDelay', 5)),
    maxPerRun: num('maxPerRun', 1),
    dailyLimit: num('dailyLimit', 1),
    autoPaginate: $('autoPaginate').checked
  };
}

const save = () => chrome.storage.local.set({ settings: collect() });
document.querySelectorAll('input, textarea').forEach((el) => el.addEventListener('change', save));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https:\/\/([a-z0-9-]+\.)*cofounderslab\.com\//i.test(tab.url || '') ? tab : null;
}

async function send(type) {
  const tab = await activeTab();
  if (!tab) {
    addLocalLog('Open CoFoundersLab (logged in) in this tab first.', 'error');
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    addLocalLog('Bot not loaded on this page yet — refresh the CoFoundersLab tab and try again.', 'error');
    return null;
  }
}

$('start').addEventListener('click', async () => {
  if (!/^[A-Za-z0-9{]/.test($('template').value.trim())) {
    addLocalLog('The note must start with a letter or number (site rule).', 'error');
    return;
  }
  await save();
  send('start');
});
$('stop').addEventListener('click', () => send('stop'));
$('clearLogs').addEventListener('click', (e) => { e.preventDefault(); chrome.storage.local.set({ logs: [] }); });
$('resetHistory').addEventListener('click', (e) => {
  e.preventDefault();
  if (confirm('Forget which profiles were already messaged or skipped? (Profiles without a Connect button are still skipped.)')) {
    chrome.storage.local.set({ sentKeys: [], skippedKeys: [], countryCache: {} });
  }
});

function addLocalLog(msg, level) {
  const div = document.createElement('div');
  div.className = level;
  div.textContent = msg;
  $('logs').appendChild(div);
  $('logs').scrollTop = $('logs').scrollHeight;
}

async function refresh() {
  const { logs = [], stats = {}, running } = await chrome.storage.local.get(['logs', 'stats', 'running']);
  const d = new Date();
  const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  $('sentToday').textContent = stats.day === today ? stats.sentToday : 0;
  $('total').textContent = stats.total || 0;
  $('status').textContent = running ? 'Running' : 'Idle';
  $('status').classList.toggle('running', !!running);
  $('start').disabled = !!running;
  $('logs').innerHTML = '';
  logs.forEach((l) => addLocalLog(`${new Date(l.t).toLocaleTimeString()}  ${l.msg}`, l.level));
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.logs || changes.stats || changes.running) refresh();
});

load();
