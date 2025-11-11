const chatInput = document.getElementById('chat-input');
const runButton = document.getElementById('chat-send');
const chatThread = document.getElementById('chat-thread');
const chatForm = document.getElementById('chat-bar');
const toggleTableBtn = document.getElementById('toggleTable');
const tableContainer = document.getElementById('tableContainer');
const tableEl = document.getElementById('customerTable');
const toggleCaseBtn = document.getElementById('toggleCase');
const caseContainer = document.getElementById('caseContainer');

function scrollChatToBottom(options = {}) {
  if (!chatThread) return;
  const { smooth = false } = options;
  const canSmoothScroll = typeof chatThread.scrollTo === 'function';
  if (canSmoothScroll) {
    chatThread.scrollTo({
      top: chatThread.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  } else {
    chatThread.scrollTop = chatThread.scrollHeight;
  }
}

const ROLE_INFO = {
  agent1: {
    name: 'Sales Agent 1',
    role: 'Recommender',
    badgeClass: 'blue',
    avatar: 'A1',
    alignment: 'left',
    bubbleClass: 'agent'
  },
  controller: {
    name: 'Sales Controller',
    role: 'Reviewer',
    badgeClass: 'purple',
    avatar: 'SC',
    alignment: 'right',
    bubbleClass: 'controller'
  },
  system: {
    name: 'System',
    role: null,
    badgeClass: 'system',
    avatar: 'SYS',
    alignment: 'left',
    bubbleClass: 'system'
  },
  user: {
    name: 'Sales Strategist',
    role: 'Case Prompt',
    badgeClass: 'blue',
    avatar: 'You',
    alignment: 'left',
    bubbleClass: 'user'
  }
};

let turnSnapshots = { initial: '', revised: '' };

async function fetchCustomers() {
  try {
    const res = await fetch('/api/customers');
    if (!res.ok) throw new Error('Failed to load dataset');
    const data = await res.json();
    renderTable(data.columns, data.records);
  } catch (err) {
    tableContainer.innerHTML = '<p class="error">Unable to load customer dataset.</p>';
  }
}

function renderTable(columns, records) {
  if (!Array.isArray(columns) || !Array.isArray(records)) return;
  const thead = `<thead><tr>${columns.map((col) => `<th>${col}</th>`).join('')}</tr></thead>`;
  const rows = records
    .map((row) => {
      const cells = columns.map((col) => `<td>${row[col]}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  tableEl.innerHTML = `${thead}<tbody>${rows}</tbody>`;
}

toggleTableBtn.addEventListener('click', () => {
  const hidden = tableContainer.classList.toggle('hidden');
  toggleTableBtn.textContent = hidden ? 'View Customer Dataset' : 'Hide Customer Dataset';
  if (!hidden && !tableEl.innerHTML) {
    fetchCustomers();
  }
});

if (toggleCaseBtn && caseContainer) {
  toggleCaseBtn.addEventListener('click', () => {
    const hidden = caseContainer.classList.toggle('hidden');
    toggleCaseBtn.textContent = hidden ? 'View Case Text' : 'Hide Case Text';
  });
}

if (chatInput) {
  autoSizeChatInput();
  chatInput.addEventListener('input', autoSizeChatInput);
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (runButton.disabled) return;
  await executeFlow();
});

function autoSizeChatInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  const maxHeight = 140;
  const next = Math.min(chatInput.scrollHeight, maxHeight);
  chatInput.style.height = `${next}px`;
}

async function executeFlow() {
  const question = chatInput.value.trim();

  if (!question) {
    addSystemMessage('Please provide a question to run the flow.');
    return;
  }

  chatInput.value = '';
  autoSizeChatInput();

  resetChat();
  const clearValidation = addSystemMessage('Validating question…', { ephemeral: true });
  runButton.disabled = true;
  chatInput.disabled = true;
  chatThread.setAttribute('aria-busy', 'true');
  turnSnapshots = { initial: '', revised: '' };

  try {
    const validateRes = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });

    const validateData = await validateRes.json();

    if (!validateRes.ok || !validateData.allowed) {
      clearValidation();
      addSystemMessage(validateData.message || 'Validation failed.');
      return;
    }

    clearValidation();
    const typing1Done = showTyping('agent1', 1);
    const agent1 = await postJSON('/api/agent1', { question });
    typing1Done();
    const cappedInitialSummary = applyWordCap(agent1.summary, 80);
    turnSnapshots.initial = getTextBlock(cappedInitialSummary, agent1.bullets);
    addMessage({
      role: 'agent1',
      turn: 1,
      heading: 'Initial Recommendation',
      reply: null,
      summary: cappedInitialSummary,
      bullets: agent1.bullets
    });

    const typing2Done = showTyping('controller', 2);
    const controller = await postJSON('/api/controller', {
      question,
      agentSummary: agent1.summary,
      agentBullets: agent1.bullets,
      agentFields: agent1.fields
    });
    typing2Done();
    const cappedControllerSummary = applyWordCap(controller.overall, 80);
    const controllerBullets = Array.isArray(controller.bullets) ? controller.bullets.slice() : [];
    if (controller.replacementCustomer) {
      const replacementNote = controller.customerToReplace
        ? `Replace ${controller.customerToReplace} with ${controller.replacementCustomer}.`
        : `Add ${controller.replacementCustomer} to the outreach list.`;
      controllerBullets.unshift(replacementNote);
    }
    addMessage({
      role: 'controller',
      turn: 2,
      heading: 'Feedback',
      reply: 'Responding to Turn 1',
      summary: cappedControllerSummary,
      bullets: controllerBullets
    });

    const typing3Done = showTyping('agent1', 3);
    const revision = await postJSON('/api/agent1/revise', {
      question,
      agentSummary: agent1.summary,
      agentBullets: agent1.bullets,
      controllerBullets: controller.bullets,
      controllerFields: controller.fields,
      customerToReplace: controller.customerToReplace,
      replacementCustomer: controller.replacementCustomer
    });
    typing3Done();
    const cappedRevisionSummary = applyWordCap(revision.summary, 80);
    turnSnapshots.revised = getTextBlock(cappedRevisionSummary, revision.bullets);
    addMessage({
      role: 'agent1',
      turn: 3,
      heading: 'Revised Recommendation',
      reply: 'Addressing Controller Feedback',
      summary: cappedRevisionSummary,
      bullets: revision.bullets,
      showDelta: true
    });
    addSystemMessage('Flow completed successfully.');
  } catch (err) {
    console.error(err);
    clearValidation();
    addSystemMessage('An error occurred while running the flow.');
  } finally {
    runButton.disabled = false;
    chatInput.disabled = false;
    chatThread.setAttribute('aria-busy', 'false');
  }
}

function resetChat() {
  chatThread.innerHTML = '';
  chatThread.setAttribute('aria-busy', 'false');
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'Run the flow to see the agents collaborate.';
  chatThread.appendChild(placeholder);
}

function ensureChatReady() {
  const placeholder = chatThread.querySelector('.placeholder');
  if (placeholder) {
    placeholder.remove();
  }
}

function showTyping(role, turn) {
  ensureChatReady();
  chatThread.setAttribute('aria-busy', 'true');
  const info = ROLE_INFO[role];
  const row = document.createElement('div');
  row.className = ['msg', info ? info.bubbleClass : 'system', info ? info.alignment : 'left', 'typing']
    .filter(Boolean)
    .join(' ');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = info?.avatar || '…';
  row.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const descriptor = [];
  if (info?.name) descriptor.push(info.name);
  if (turn) descriptor.push(`Turn ${turn}`);
  const label = descriptor.length ? descriptor.join(' · ') : 'Agent';
  bubble.textContent = `${label} is drafting`;

  const dots = document.createElement('span');
  dots.className = 'typing-dots';
  for (let i = 0; i < 3; i += 1) {
    dots.appendChild(document.createElement('span'));
  }
  bubble.appendChild(dots);

  row.appendChild(bubble);
  chatThread.appendChild(row);
  scrollChatToBottom();

  return () => {
    row.remove();
    if (!chatThread.querySelector('.typing')) {
      chatThread.setAttribute('aria-busy', 'false');
    }
  };
}

function addMessage({ role, turn, heading, reply, summary, bullets = [], showDelta = false }) {
  ensureChatReady();
  const info = ROLE_INFO[role] || ROLE_INFO.agent1;

  const row = document.createElement('div');
  const isCompactMessage = (role === 'agent1' && turn === 1) || (role === 'controller' && turn === 2);
  row.className = ['msg', info.bubbleClass || '', info.alignment || 'left', isCompactMessage ? 'compact' : '']
    .filter(Boolean)
    .join(' ');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = info.avatar || info.name.charAt(0);
  row.appendChild(avatar);

  const bubble = document.createElement('article');
  bubble.className = ['bubble', isCompactMessage ? 'compact' : ''].filter(Boolean).join(' ');

  const header = document.createElement('header');
  const badge = document.createElement('span');
  badge.className = ['badge', info.badgeClass || ''].join(' ').trim();
  badge.textContent = info.name;
  header.appendChild(badge);

  const descriptors = [];
  if (info.role) descriptors.push(info.role);
  if (turn) descriptors.push(`Turn ${turn}`);
  if (heading) descriptors.push(heading);
  if (descriptors.length) {
    const meta = document.createElement('span');
    meta.textContent = descriptors.join(' · ');
    header.appendChild(meta);
  }

  if (reply) {
    const replySpan = document.createElement('span');
    replySpan.textContent = reply;
    header.appendChild(replySpan);
  }

  bubble.appendChild(header);

  const body = buildMessageBody(summary, bullets);
  bubble.appendChild(body);

  if (showDelta) {
    const deltaEl = renderDelta();
    if (deltaEl) {
      bubble.appendChild(deltaEl);
    }
  }

  row.appendChild(bubble);
  chatThread.appendChild(row);
  scrollChatToBottom({ smooth: role === 'agent1' && turn === 3 });

  if (role === 'agent1' && turn === 3) {
    attachCopyAction(bubble, summary, bullets);
  }
}

function buildMessageBody(summary = '', bullets = []) {
  const container = document.createElement('div');
  container.className = 'body';
  const safeSummary = summary && summary.trim().length > 0 ? summary.trim() : 'No summary provided.';
  const paragraph = document.createElement('p');
  paragraph.textContent = safeSummary;
  container.appendChild(paragraph);

  const bulletList = Array.isArray(bullets) ? bullets.filter(Boolean) : [];
  if (bulletList.length) {
    const ul = document.createElement('ul');
    bulletList.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  return container;
}

function getTextBlock(summary = '', bullets = []) {
  const safeSummary = summary && summary.trim().length > 0 ? summary.trim() : 'No summary provided.';
  const bulletList = Array.isArray(bullets) ? bullets.filter(Boolean) : [];
  return [safeSummary, ...bulletList].join(' ');
}

function renderDelta() {
  const { added, removed, reordered } = computeChanges(turnSnapshots.initial, turnSnapshots.revised);
  if (!added.length && !removed.length && !reordered.length) {
    return null;
  }

  const list = document.createElement('ul');
  list.className = 'deltas';

  added.forEach((name) => {
    const li = document.createElement('li');
    li.className = 'added';
    li.textContent = `Added ${name}`;
    list.appendChild(li);
  });

  removed.forEach((name) => {
    const li = document.createElement('li');
    li.className = 'removed';
    li.textContent = `Removed ${name}`;
    list.appendChild(li);
  });

  reordered.forEach((name) => {
    const li = document.createElement('li');
    li.className = 'reordered';
    li.textContent = `Reordered ${name}`;
    list.appendChild(li);
  });

  return list;
}

function computeChanges(initialText = '', revisedText = '') {
  const initial = extractCustomers(initialText);
  const revised = extractCustomers(revisedText);

  const added = revised.filter((name) => !initial.includes(name));
  const removed = initial.filter((name) => !revised.includes(name));

  const shared = revised.filter((name) => initial.includes(name));
  const reordered = shared.filter((name) => initial.indexOf(name) !== revised.indexOf(name));

  return {
    added: Array.from(new Set(added)),
    removed: Array.from(new Set(removed)),
    reordered: Array.from(new Set(reordered))
  };
}

function extractCustomers(text = '') {
  const ids = new Set();
  const matches = text.match(/C\d{1,4}/gi) || [];
  matches.forEach((item) => ids.add(item.toUpperCase()));

  const namePattern = /(?:Customer|Client|Account)\s+([A-Z][A-Za-z0-9&-]{2,}(?:\s+[A-Z][A-Za-z0-9&-]{2,})?)/g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(text)) !== null) {
    ids.add(nameMatch[1]);
  }

  return Array.from(ids);
}

async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.message || `Request to ${url} failed.`);
  }

  return res.json();
}

function addSystemMessage(message, { ephemeral = false } = {}) {
  ensureChatReady();
  const info = ROLE_INFO.system;
  const row = document.createElement('div');
  row.className = ['msg', info.bubbleClass, info.alignment, 'system-message'].filter(Boolean).join(' ');
  if (ephemeral) {
    row.dataset.ephemeral = 'true';
  }

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = info.avatar;
  row.appendChild(avatar);

  const bubble = document.createElement('article');
  bubble.className = 'bubble';

  const header = document.createElement('header');
  const badge = document.createElement('span');
  badge.className = ['badge', info.badgeClass].join(' ');
  badge.textContent = info.name;
  header.appendChild(badge);
  bubble.appendChild(header);

  const body = document.createElement('div');
  body.className = 'body';
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  body.appendChild(paragraph);
  bubble.appendChild(body);

  row.appendChild(bubble);
  chatThread.appendChild(row);
  scrollChatToBottom();

  if (ephemeral) {
    return () => {
      row.remove();
    };
  }

  return () => {};
}

function applyWordCap(text = '', limit = 80) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length <= limit) {
    return text.trim();
  }
  const truncated = words.slice(0, limit).join(' ');
  return `${truncated}…`;
}

function attachCopyAction(container, summary = '', bullets = []) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-action';
  button.textContent = 'Copy Final Recommendation';
  button.addEventListener('click', async () => {
    const list = Array.isArray(bullets) ? bullets.filter(Boolean) : [];
    const joined = [summary.trim(), ...list].filter(Boolean).join('\n');
    const copied = await copyToClipboard(joined);
    if (copied) {
      addSystemMessage('Final recommendation copied to clipboard.');
    } else {
      addSystemMessage('Unable to copy recommendation.');
    }
  });
  container.appendChild(button);
}

async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      // fall back to legacy copy
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  let success = false;
  try {
    success = document.execCommand('copy');
  } catch (error) {
    success = false;
  }

  document.body.removeChild(textarea);
  return success;
}

resetChat();
